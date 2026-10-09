# -*- coding: utf-8 -*-
"""图像加载与预处理：统一解码（含 HEIC/RAW 尽力支持）、缩放、坐标映射"""
import os

import cv2
import numpy as np

MAX_SIDE = 1280  # 检测工作分辨率：兼顾精度与速度


class LoadError(Exception):
    pass


def imread_any(path):
    """读取任意受支持图像为 BGR ndarray；RAW/HEIC 尽力解码

    关键：cv2.imread 在 Windows 上无法处理含中文/非 ASCII 的路径，会直接抛
    "OpenCV(-5:Bad argument) in function 'imread' ... Conversion error: filename"，
    导致每张图检测失败并触发引擎熔断。统一改用 np.fromfile + cv2.imdecode
    （numpy 走宽字符文件 API，支持中文路径），RAW/HEIC 则用二进制文件对象喂入。
    """
    ext = os.path.splitext(path)[1].lower()
    # 常规格式（JPEG/PNG/BMP/WebP...）：Unicode 安全读取
    try:
        buf = np.fromfile(path, dtype=np.uint8)
        if buf.size:
            img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
            if img is not None:
                return img
    except Exception:  # noqa: BLE001
        pass
    # HEIC
    if ext in (".heic", ".heif"):
        try:
            import pillow_heif  # type: ignore
            from PIL import Image

            pillow_heif.register_heif_opener()
            with open(path, "rb") as f:
                pil = Image.open(f).convert("RGB")
            return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
        except Exception:  # noqa: BLE001
            pass
    # RAW：尝试 rawpy -> 内嵌 JPEG（用二进制文件对象喂入，绕开中文路径）
    if ext in (".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf", ".rw2", ".dng"):
        try:
            import rawpy  # type: ignore

            with open(path, "rb") as f:
                with rawpy.imread(f) as raw:
                    rgb = raw.postprocess(use_camera_wb=True)
            return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        except Exception:  # noqa: BLE001
            pass
        # 退而求其次：libjpeg-turbo 读取内嵌预览
        try:
            import imageio  # type: ignore

            with open(path, "rb") as f:
                rgb = imageio.imread(f)
            if rgb.ndim == 3 and rgb.shape[2] >= 3:
                return cv2.cvtColor(rgb[:, :, :3], cv2.COLOR_RGB2BGR)
        except Exception:  # noqa: BLE001
            pass
    raise LoadError("cannot decode: %s" % path)


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
