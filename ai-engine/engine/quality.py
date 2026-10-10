# -*- coding: utf-8 -*-
"""画质/规则维度：
- 画面模糊：Laplacian 方差初筛 + 分区域二次验证（双验证思想），纯 CPU
- 曝光异常：Lab 色彩空间亮度/高光/暗部/对比度规则，毫秒级
- 黑白照：饱和度规则（绝大多数像素 R≈G≈B）
- 半截头：人脸框贴边 + 躯干有头无 + 关键点完整性三验证思想
- 重复/连拍：DCT 感知哈希（供主进程跨图聚类），可选人脸/图像嵌入 ONNX
"""
import math

import cv2
import numpy as np

from .models import OnnxSession


def _sigmoid(z):
    return 1.0 / (1.0 + math.exp(-z))


# ---------- 画面模糊 ----------

def blur_score(bgr, faces):
    """返回 (confidence 模糊成立的可信度, reason)。只认严重模糊（用户口径：大面积糊/
    看不清人脸/严重虚化才算）——v2.0.62 真实 3190 张中旧曲线在方差 30~60 灰区就给 0.6~0.85，
    741 张不糊的片被标进模糊视图；新曲线拐点下推：脸区最差方差 <15 才进高置信，>35 不标。"""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    if max(h, w) > 900:
        s = 900.0 / max(h, w)
        gray = cv2.resize(gray, None, fx=s, fy=s)
    full_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    # 人脸 ROI 单独测（背景虚化是常见创作手法，脸糊才是坏片）
    roi_vars = []
    for f in faces[:4]:
        x, y, fw, fh = f["box"]
        crop = gray[int(y):int(y + fh), int(x):int(x + fw)]
        if crop.size > 200:
            roi_vars.append(float(cv2.Laplacian(crop, cv2.CV_64F).var()))
    if roi_vars:
        ref = min(roi_vars)  # 最差的脸
        mode = "face"
    else:
        ref = full_var
        mode = "full"
    # 二次验证：高频能量占比（FFT 上半区能量），降为辅助权重
    hp = _highpass_ratio(gray)
    # 标定：方差 <10 严重糊→0.85+；15~25 中度→待确认；>35 清晰→不标
    conf = 0.88 * _sigmoid((24.0 - ref) / 7.0) + 0.12 * _sigmoid((0.010 - hp) / 0.004)
    conf = float(np.clip(conf, 0, 0.99))
    return conf, "清晰度方差 %.0f(%s) 高频占比 %.4f" % (ref, mode, hp)


def _highpass_ratio(gray):
    f = np.fft.fftshift(np.fft.fft2(gray.astype(np.float32)))
    mag = np.abs(f)
    h, w = mag.shape
    cy, cx = h // 2, w // 2
    r = int(min(h, w) * 0.12)
    yy, xx = np.ogrid[:h, :w]
    center = ((yy - cy) ** 2 + (xx - cx) ** 2) <= r * r
    total = mag.sum() + 1e-6
    return float((mag[~center].sum()) / total)


# ---------- 曝光异常 ----------

def exposure_score(bgr):
    """只判严重曝光异常（用户口径：灯光/太阳/光晕大面积影响整幅画面感才算）。
    v2.0.62 真实分布：旧规则"画面偏暗→欠曝"在婚礼暗环境里高置信 682 张中 452 张被用户
    判掉（TP/FP 亮度分布完全重叠不可分），本版彻底删掉"偏暗即曝光"：
    - 过曝：高光爆掉面积 ≥~30% 且整体极亮（光晕洗白全图）才起高分
    - 欠曝：只认死黑丢细节（均值≤~6 且暗部占比≥~90%），普通夜景/室内暗光不标
    - 对比度塌缩：封顶 0.5，永不直接进分类"""
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2Lab)
    L = lab[:, :, 0].astype(np.float32) * (100.0 / 255.0)
    mean = float(L.mean())
    std = float(L.std())
    hi_ratio = float((L >= 96).mean())
    lo_ratio = float((L <= 6).mean())
    over = _sigmoid((hi_ratio - 0.30) / 0.07) * _sigmoid((mean - 80) / 6)
    under = _sigmoid((6.0 - mean) / 1.8) * _sigmoid((lo_ratio - 0.88) / 0.05)
    flat = _sigmoid((6.5 - std) / 2.0) * 0.5  # 对比度塌缩只作参考，封顶 0.5 低于各档 mid 阈值附近
    conf = float(np.clip(max(over, under, flat), 0, 0.99))
    direction = "过曝" if over == max(over, under, flat) else ("欠曝" if under == max(over, under, flat) else "对比度异常")
    return conf, "亮度均值 %.1f std %.1f 高光 %.2f 暗部 %.2f -> %s" % (mean, std, hi_ratio, lo_ratio, direction)


def mean_brightness(bgr):
    """Lab 的 L 通道均值（0-100），供上层判断画面是否整体偏暗（人脸漏检风险）。"""
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2Lab)
    return float(lab[:, :, 0].astype(np.float32).mean() * (100.0 / 255.0))


# ---------- 肤色连通块（"无人物"零检出兜底） ----------

_SKIN_MIN_BLOB = 0.02   # 最大肤色连通块 ≥2% 图面积，才算"那块地方站着个人"
_SKIN_MAX_BLOB = 0.45   # 超过 45% 是木地板/米色墙/桌布这类大面积同色背景，不是人
_SKIN_MIN_EXTENT = 0.45  # 块面积 / 外接矩形面积：脸+颈+手是实心团块，散碎纹理达不到


def skin_person_score(bgr):
    """YCrCb 肤色阈值 → 开/闭运算 → 连通块统计，返回 (是否有人肤色证据, 说明)。

    为什么需要：v2.0.62 取证 157 张 no_person 高置信里大量实为漏检——背身/侧脸/近景只拍到
    身体局部时，人体框与人脸会同时零检出，旧分支直接给 0.95 把图钉死在"无人物场景"相册。
    肤色块是比神经网络更"笨"但更难被骗的证据。用途被严格限制：只把自信的 0.95 降为
    0.62（中置信 → 待确认），永不反向断言"这里有人"，也不参与人数判定。"""
    try:
        h, w = bgr.shape[:2]
        if h <= 0 or w <= 0:
            return False, "图像尺寸异常"
        s = 320.0 / max(h, w)
        small = cv2.resize(bgr, (max(2, int(w * s)), max(2, int(h * s)))) if s < 1.0 else bgr
        ycrcb = cv2.cvtColor(small, cv2.COLOR_BGR2YCrCb)
        mask = cv2.inRange(ycrcb, (0, 133, 77), (255, 173, 127))
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
        num, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        tot = float(small.shape[0] * small.shape[1]) or 1.0
        if num <= 1:
            return False, "无肤色块"
        areas = stats[1:, cv2.CC_STAT_AREA].astype(np.float32)
        i = int(np.argmax(areas))
        ratio = float(areas[i]) / tot
        box_area = float(stats[1 + i, cv2.CC_STAT_WIDTH] * stats[1 + i, cv2.CC_STAT_HEIGHT]) or 1.0
        extent = float(areas[i]) / box_area
        if ratio < _SKIN_MIN_BLOB or ratio > _SKIN_MAX_BLOB or extent < _SKIN_MIN_EXTENT:
            return False, "肤色块 %.1f%%/紧实度 %.2f 不成形" % (ratio * 100.0, extent)
        return True, "肤色连通块占图 %.1f%%（紧实度 %.2f）" % (ratio * 100.0, extent)
    except Exception as e:  # noqa: BLE001
        return False, "肤色检测不可用(%s)" % type(e).__name__


# ---------- 黑白照 ----------

def black_white_score(bgr):
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    S = hsv[:, :, 1].astype(np.float32)
    small = S.shape
    if max(small) > 700:
        s = 700.0 / max(small)
        S = cv2.resize(S, None, fx=s, fy=s)
    mean_s = float(S.mean())
    low_ratio = float((S <= 18).mean())
    conf = _sigmoid((0.92 - low_ratio) / -0.035) * _sigmoid((22 - mean_s) / 5)
    conf = float(np.clip(conf, 0, 0.995)) if low_ratio > 0.8 else float(np.clip(_sigmoid((0.90 - low_ratio) / -0.02) * 0.5, 0, 0.4))
    return conf, "饱和度均值 %.1f，低饱和像素占比 %.3f" % (mean_s, low_ratio)


# ---------- 半截头 ----------

def half_head_score(bgr_shape, faces, upper_bodies, scale):
    """半截头：头部被画面边缘裁掉。
    模型（按用户提供的"贴边检测"实现，替换掉原"头部余量反推"）：以 478 landmark 外接框
    （归一化 0~1）判是否触碰画面边缘，并用脸高/脸宽占比过滤背景小脸，避免远景路人误报。
    - FACE_MIN_SIZE：脸高归一化低于此值视为背景人物，完全跳过（不参与任何判定）
    - CROP_MIN_FACE：脸高/脸宽占比低于此值即使贴边也不算半截头（单人特写里小脸贴边是正常构图）
    - EDGE_MARGIN：贴边阈值（归一化，约占图 1.2%）
    置信度按"越贴边越高"：crop_conf = 1 - edge_dist/(EDGE_MARGIN*3)，clamp 到 [0,0.98]。
    输入优先用 face["mp"]["bbox"]（478 外接框，像素）；mediapipe 关闭/未挂载时回落 YuNet 脸框作代理。
    另保留两条与"贴边"正交的躯干安全网（有身子无头 / 躯干多于人脸）——它们不属于被替换的余量反推，
    且覆盖"头完全出框只剩躯干"的真实半截场景；如需 100% 字面移植可去掉。
    本函数只读 faces/upper，不改任何人脸维度输入；调用签名不变，其余检测逻辑零影响。
    """
    H, W = bgr_shape[:2]
    EDGE_MARGIN = 0.012    # 贴边阈值（归一化，约占图宽 1.2%）
    CROP_MIN_FACE = 0.12   # 脸高/脸宽占图低于此值不算半截头（防小脸误报）
    FACE_MIN_SIZE = 0.06   # 脸高低于此值视为背景人物，完全跳过
    reasons = []
    conf = 0.0

    def bump(c, msg):
        nonlocal conf
        if c > conf:
            conf = c
            reasons[:] = [msg]

    if W <= 0 or H <= 0:
        return 0.0, "头部完整"
    for f in faces:
        mp = f.get("mp") or {}
        bbox = mp.get("bbox") or f.get("box")  # 优先 478 外接框(像素)，回落 YuNet 脸框
        if not bbox:
            continue
        x = bbox[0] / W
        y = bbox[1] / H
        bw = bbox[2] / W
        bh = bbox[3] / H
        if bh < FACE_MIN_SIZE:
            continue  # 背景路人：完全跳过，不参与任何判定
        is_large = (bh > CROP_MIN_FACE or bw > CROP_MIN_FACE)
        touch = (
            x < EDGE_MARGIN or
            y < EDGE_MARGIN or
            x + bw > 1 - EDGE_MARGIN or
            y + bh > 1 - EDGE_MARGIN
        )
        if not (is_large and touch):
            continue
        edge_dist = min(x, y, 1 - x - bw, 1 - y - bh)  # 到最近边缘距离（贴边时 < EDGE_MARGIN）
        crop_conf = max(0.0, min(0.98, 1.0 - edge_dist / (EDGE_MARGIN * 3)))
        sides = []
        if y < EDGE_MARGIN:
            sides.append("上/头顶")
        if x < EDGE_MARGIN:
            sides.append("左")
        if x + bw > 1 - EDGE_MARGIN:
            sides.append("右")
        if y + bh > 1 - EDGE_MARGIN:
            sides.append("下/下巴")
        bump(crop_conf, "头部贴边出框（%s），脸框占图高%.0f%%" % ("/".join(sides) or "边缘", bh * 100))
    if not faces and upper_bodies:
        # 有身子没头：躯干框上缘必须在画面上部才说明是"人头出框"
        for ub in upper_bodies:
            if ub[1] < H * 0.5:
                bump(0.88, "检出躯干但无完整头部")
                break
    # 躯干多于人脸：部分人头被裁/未入镜
    if faces and upper_bodies and len(upper_bodies) > len(faces):
        bump(0.72, "躯干 %d 但人脸 %d→疑有人头未完整入镜" % (len(upper_bodies), len(faces)))
    return float(conf), "; ".join(reasons) if reasons else "头部完整"


# ---------- 重复/连拍 ----------

def phash(bgr):
    """64bit DCT 感知哈希（16 位十六进制）"""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    small = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA)
    dct = cv2.dct(np.float32(small))
    low = dct[:8, :8]
    med = np.median(low[1:, 1:]) if low.size > 1 else 0
    bits = (low > med).astype(np.uint8)
    hexs = []
    for row in bits.reshape(8, 8):
        v = 0
        for b in row:
            v = (v << 1) | int(b)
        hexs.append("%x" % v)
    return "".join(hexs)


def hamming(h1, h2):
    if not h1 or not h2 or len(h1) != len(h2):
        return 64
    return sum(bin(int(a, 16) ^ int(b, 16)).count("1") for a, b in zip(h1, h2))


class EmbeddingModel:
    """可选图像嵌入（DINOv2/SigLIP/ArcFace onnx）：放入 models/ 自动启用，用于更准的重复聚类"""

    def __init__(self):
        self.model = OnnxSession(["*dinov2*.onnx", "*siglip*.onnx", "*arcface*.onnx", "ufas*.onnx", "mobileface*.onnx"], 224)

    @property
    def available(self):
        return self.model.available

    def embed(self, bgr, box=None):
        if not self.available:
            return None
        try:
            img = bgr
            if box:
                x, y, w, h = [int(v) for v in box]
                img = bgr[max(0, y):y + h, max(0, x):x + w]
            p = cv2.resize(img, (224, 224)).astype(np.float32)
            inp = self.model.session.get_inputs()[0].shape
            if len(inp) == 4 and inp[1] == 3:
                blob = p[:, :, ::-1].transpose(2, 0, 1)[None, ...] / 255.0
            else:
                blob = p[:, :, ::-1][None, ...] / 255.0
            v = np.array(self.model.run(blob)).flatten()
            n = np.linalg.norm(v)
            return (v / (n + 1e-9)).tolist() if n > 0 else None
        except Exception:  # noqa: BLE001
            return None
