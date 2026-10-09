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
    """返回 (confidence 模糊成立的可信度, reason)。偏向召回：低阈值多标"""
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
    # 二次验证：高频能量占比（FFT 上半区能量）
    hp = _highpass_ratio(gray)
    # 标定：方差 <30 明显糊，30-80 灰区，>120 清晰
    conf = _sigmoid((60.0 - ref) / 22.0) * 0.7 + _sigmoid((0.012 - hp) / 0.006) * 0.3
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
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2Lab)
    L = lab[:, :, 0].astype(np.float32) * (100.0 / 255.0)
    mean = float(L.mean())
    std = float(L.std())
    hi_ratio = float((L >= 96).mean())
    lo_ratio = float((L <= 6).mean())
    over = _sigmoid((hi_ratio - 0.14) / 0.05) * _sigmoid((mean - 74) / 8)
    under = _sigmoid((lo_ratio - 0.22) / 0.07) * _sigmoid((32 - mean) / 8)
    flat = _sigmoid((8.5 - std) / 3.0) * 0.6  # 对比度塌缩
    conf = float(np.clip(max(over, under, flat), 0, 0.99))
    direction = "过曝" if over == max(over, under, flat) else ("欠曝" if under == max(over, under, flat) else "对比度异常")
    return conf, "亮度均值 %.1f std %.1f 高光 %.2f 暗部 %.2f -> %s" % (mean, std, hi_ratio, lo_ratio, direction)


def mean_brightness(bgr):
    """Lab 的 L 通道均值（0-100），供上层判断画面是否整体偏暗（人脸漏检风险）。"""
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2Lab)
    return float(lab[:, :, 0].astype(np.float32).mean() * (100.0 / 255.0))


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
    """半截头多信号：
    - 人脸框上缘贴近画面顶部（额头出框）
    - 人脸框左/右/下贴边（侧向或下方裁切，阈值随脸尺寸自适应）
    - 有躯干但无完整头部
    """
    H, W = bgr_shape[:2]
    edge = int(20 / scale) if scale and scale < 1 else 20
    reasons = []
    conf = 0.0
    for f in faces:
        x, y, w, h = f["box"]
        # 贴边阈值随人脸尺寸自适应：小脸需更贴边才判半截，大脸预留额头余量
        mx = max(2, int(w * 0.12))
        my = max(2, int(h * 0.12))
        if y <= edge + my:
            c = 0.95 if y <= 2 else 0.90
            if c > conf:
                conf = c
                reasons.append("人脸框上缘距顶 %dpx(≤%d)→额头被裁" % (y, edge + my))
        if x <= mx or x + w >= W - mx:
            if 0.88 > conf:
                conf = 0.88
                reasons.append("人脸框左右贴边→头部横向被裁")
        if y + h >= H - my:
            if 0.80 > conf:
                conf = 0.80
                reasons.append("人脸框下缘贴边→下巴以下被裁")
    if not faces and upper_bodies:
        # 有身子没头：躯干框上缘必须在画面上部才说明是"人头出框"
        for ub in upper_bodies:
            if ub[1] < H * 0.5:
                conf = max(conf, 0.88)
                reasons.append("检出躯干但无完整头部")
                break
    # 躯干多于人脸：部分人头被裁/未入镜
    if faces and upper_bodies and len(upper_bodies) > len(faces):
        if 0.72 > conf:
            conf = 0.72
            reasons.append("躯干 %d 但人脸 %d→疑有人头未完整入镜" % (len(upper_bodies), len(faces)))
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
