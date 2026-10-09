# -*- coding: utf-8 -*-
"""图像加载与预处理：统一解码（含 HEIC/RAW 尽力支持）、缩放、坐标映射"""
import io
import os

import cv2
import numpy as np

MAX_SIDE = 1280  # 检测工作分辨率：兼顾精度与速度


class LoadError(Exception):
    pass


def _apply_exif_orientation(buf, img):
    """按 EXIF Orientation 标签(274) 把 cv2 解码出的像素转正。

    cv2.imdecode 与 cv2.imread 不同，**不读 EXIF 方向**。手机/相机竖拍的照片像素常以
    横向存储 + EXIF Orientation 标记旋转，浏览器 <img> 会自动转正，但引擎拿到的是侧躺
    像素 → 人脸检测(Haar 只覆盖正脸/左右侧脸，不含 90°/270°)全部落空 → 半截头/双人/闭眼
    等依赖人脸的维度不触发，照片被静默判进成品库。这里只解析头部元数据(不重复解码像素)，
    按方向把像素转正，使引擎视角与浏览器一致。无 EXIF / 异常时原样返回。
    """
    try:
        from PIL import Image  # 延迟导入，随包捆绑

        exif = Image.open(io.BytesIO(buf.tobytes())).getexif()
        o = exif.get(274) if exif else None
        if not o or o == 1:
            return img
        if o == 2:
            return cv2.flip(img, 1)
        if o == 3:
            return cv2.rotate(img, cv2.ROTATE_180)
        if o == 4:
            return cv2.flip(img, 0)
        if o == 5:
            return cv2.transpose(img)
        if o == 6:
            return cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
        if o == 7:
            return cv2.flip(cv2.transpose(img), 1)
        if o == 8:
            return cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
    except Exception:  # noqa: BLE001
        pass
    return img


def _pil_decode(buf):
    """PIL 兜底解码：注册 heif/avif 插件后从内存缓冲打开并应用 EXIF 方向。
    覆盖 JPEG/PNG/WebP/BMP 以及 OpenCV 解不了的 HEIC/AVIF（sharp/libvips 能解、
    冻结 OpenCV 不能解的格式），使 Python 引擎解码能力与 Node(sharp) 对齐。"""
    from PIL import Image, ImageOps

    try:
        import pillow_heif  # type: ignore

        pillow_heif.register_heif_opener()
    except Exception:  # noqa: BLE001
        pass
    try:
        import pillow_avif  # type: ignore  # noqa: F401  导入即注册 AVIF opener
    except Exception:  # noqa: BLE001
        pass
    with Image.open(io.BytesIO(buf.tobytes())) as pil:
        pil = ImageOps.exif_transpose(pil)
        arr = np.asarray(pil.convert("RGB"))
    return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)


def imread_any(path):
    """读取任意受支持图像为 BGR ndarray；RAW/HEIC 尽力解码

    关键：cv2.imread 在 Windows 上无法处理含中文/非 ASCII 的路径，会直接抛
    "OpenCV(-5:Bad argument) in function 'imread' ... Conversion error: filename"，
    导致每张图检测失败并触发引擎熔断。统一改用 np.fromfile + cv2.imdecode
    （numpy 走宽字符文件 API，支持中文路径），RAW/HEIC 则用二进制文件对象喂入。
    """
    ext = os.path.splitext(path)[1].lower()
    reasons = []
    # 常规格式（JPEG/PNG/BMP/WebP...）：Unicode 安全读取
    buf = None
    try:
        buf = np.fromfile(path, dtype=np.uint8)
    except Exception as e:  # noqa: BLE001
        reasons.append("fromfile:%s" % e)
        buf = None
    if buf is not None and buf.size:
        # 1) OpenCV 解码（快）
        try:
            img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
            if img is not None:
                return _apply_exif_orientation(buf, img)
            reasons.append("cv2.imdecode=None")
        except Exception as e:  # noqa: BLE001
            reasons.append("cv2:%s" % e)
        # 2) PIL 兜底（含 heif/avif 插件）：冻结 exe 缺 OpenCV 编解码器或遇到 HEIC/AVIF 时仍可解
        try:
            return _pil_decode(buf)
        except Exception as e:  # noqa: BLE001
            reasons.append("pil:%s" % e)
    elif buf is not None:
        reasons.append("empty file")
    # HEIC
    if ext in (".heic", ".heif"):
        try:
            import pillow_heif  # type: ignore
            from PIL import Image

            pillow_heif.register_heif_opener()
            from PIL import ImageOps

            with open(path, "rb") as f:
                pil = ImageOps.exif_transpose(Image.open(f)).convert("RGB")
            return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
        except Exception as e:  # noqa: BLE001
            reasons.append("heic:%s" % e)
    # RAW：尝试 rawpy -> 内嵌 JPEG（用二进制文件对象喂入，绕开中文路径）
    if ext in (".cr2", ".cr3", ".crw", ".nef", ".nrw", ".arw", ".srf", ".sr2", ".raf", ".rw2",
               ".raw", ".orf", ".pef", ".ptx", ".rwl", ".dng", ".srw", ".x3f"):
        try:
            import rawpy  # type: ignore

            with open(path, "rb") as f:
                with rawpy.imread(f) as raw:
                    rgb = raw.postprocess(use_camera_wb=True)
            return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        except Exception as e:  # noqa: BLE001
            reasons.append("rawpy:%s" % e)
        # 退而求其次：libjpeg-turbo 读取内嵌预览
        try:
            import imageio  # type: ignore

            with open(path, "rb") as f:
                rgb = imageio.imread(f)
            if rgb.ndim == 3 and rgb.shape[2] >= 3:
                return cv2.cvtColor(rgb[:, :, :3], cv2.COLOR_RGB2BGR)
        except Exception as e:  # noqa: BLE001
            reasons.append("imageio:%s" % e)
    # 带上各解码器失败原因，便于安装版定位（而不是只报 cannot decode）
    raise LoadError("cannot decode: %s [%s]" % (path, "; ".join(reasons) if reasons else "no decoder matched"))


def load_work_image(path):
    """返回 (work_bgr, scale)。scale = 工作图 / 原图，用于把检测框映射回原图坐标"""
    img = imread_any(path)
    h, w = img.shape[:2]
    scale = 1.0
    if max(h, w) > MAX_SIDE:
        scale = MAX_SIDE / float(max(h, w))
        img = cv2.resize(img, (int(round(w * scale)), int(round(h * scale))), interpolation=cv2.INTER_AREA)
    return img, scale


def to_original(box, scale, orig_size=None):
    """[x,y,w,h] 工作图坐标 -> 原图坐标"""
    out = [int(round(box[0] / scale)), int(round(box[1] / scale)), int(round(box[2] / scale)), int(round(box[3] / scale))]
    if orig_size:
        ow, oh = orig_size
        out[0] = max(0, min(out[0], ow))
        out[1] = max(0, min(out[1], oh))
        out[2] = max(0, min(out[2], ow - out[0]))
        out[3] = max(0, min(out[3], oh - out[1]))
    return out
