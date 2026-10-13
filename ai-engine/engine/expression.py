# -*- coding: utf-8 -*-
"""面部狰狞：按第八章 8.2 采用四个可量化子特征综合判定，不使用单一"狰狞"分类。
1) 张嘴过大（几何）  2) 五官不对称（几何）  3) 眼睛状态异常（复用闭眼结果）  4) 面部肌肉紧张（Emotion ONNX 可选）
综合逻辑：任一子特征触发 -> 建议复核（中等置信度）；两个以上触发 -> 面部狰狞（高置信度）。"""
import math

import cv2
import numpy as np

from .models import OnnxSession
from .face import eye_rois

EMOTION_LABELS_NEG = ("angry", "disgust", "contempt", "fear")

# ===== 表情崩坏（v2.0.67 用户真值标定，基于 MediaPipe blendshape）=====
# 主信号 = 眼睛挤没(eyeSquint)，与嘴大无关：全库嘴最大的 CHEN0046(jaw0.49、eyeSq0.32) 是
# 幸福笑=留；三张"因表情而弃"（CHEN9541/9715/9567）eyeSquint 全 ≥0.65；所有"眼没挤"的
# （≤0.37）无论去留都不误伤。拍照眼睛本就微眯（基线 p50≈0.39），故 0.50 以下零分。
# 佐证只认"丑"的嘴型（大张嘴/横拉/龇牙）与仰头——【嘴咧着笑(mouthSmile) 故意不算佐证】：
# 幸福笑脸也挤眼（CHEN9951 eyeSq0.74 但只是咧嘴笑=正常留），只有"挤眼+嘴张开/横拉/仰头"才是崩坏。
# 仅"挤眼"而无嘴/仰头佐证 → 封顶待确认(0.78)；侧脸（|yaw|>35°）降权——表情维度必配姿态门控。
ESQ_ZERO = 0.50    # eyeSquint 低于此零分（微眯基线）
ESQ_FULL = 0.68    # eyeSquint 高于此满分（挤没）
_YAW_CAP_DEG = 35.0  # 侧脸阈值：超过则置信封顶待确认（blendshape 在侧脸不稳）


def _clip01(v):
    return max(0.0, min(1.0, v))


def _avg2(b, k1, k2):
    v = [b[k] for k in (k1, k2) if k in b]
    return sum(v) / len(v) if v else 0.0


def _pose_from_matrix(matrix):
    """从 MediaPipe 4x4 姿态矩阵解 (yaw, pitch) 度；取不出返回 (0,0)。
    matrix 是嵌套 list，必须 np.array(matrix)[:3,:3]（不能 matrix[:3,:3]）。"""
    if not matrix:
        return 0.0, 0.0
    try:
        R = np.array(matrix, dtype=float)[:3, :3]
        pitch = math.degrees(math.atan2(R[2, 1], R[2, 2]))
        yaw = math.degrees(math.atan2(-R[2, 0], max(1e-6, math.hypot(R[0, 0], R[1, 0]))))
        return float(yaw), float(pitch)
    except Exception:  # noqa: BLE001
        return 0.0, 0.0


class ExpressionAnalyzer:
    def __init__(self):
        self.emotion = OnnxSession(["*emotion*.onnx", "fer2013*.onnx", "ufeee*.onnx"], 224)

    def expression_breakdown(self, faces):
        """表情崩坏置信度：眼睛挤没(eyeSquint)为主、大张嘴/龇牙/横拉/仰头佐证（嘴咧着笑不算）、侧脸降权。
        取各脸最坏值（任一张脸崩坏即整图瑕疵，与闭眼同逻辑）。无任何脸带 blendshape 时返回 0（保守）。"""
        best = 0.0
        best_why = ""
        for f in faces[:6]:
            mp = f.get("mp") or {}
            b = mp.get("blend") or {}
            if not b:
                continue
            esq = _avg2(b, "eyeSquintLeft", "eyeSquintRight")
            if esq < ESQ_ZERO:
                continue
            p = _clip01((esq - ESQ_ZERO) / (ESQ_FULL - ESQ_ZERO))
            cor = []
            if b.get("jawOpen", 0.0) >= 0.22:
                cor.append("大张嘴")
            # mouthSmile 故意不作佐证：幸福笑也挤眼，只有"挤眼+嘴张开/横拉/仰头"才是崩坏。
            if b.get("noseSneerLeft", 0.0) + b.get("noseSneerRight", 0.0) >= 0.30:
                cor.append("龇牙")
            if _avg2(b, "mouthStretchLeft", "mouthStretchRight") >= 0.15:
                cor.append("横拉")
            yaw, pitch = _pose_from_matrix(mp.get("matrix"))
            if abs(pitch) >= 18.0:
                cor.append("仰头")
            conf = p if cor else min(p, 0.78)        # 只挤眼、无嘴/头佐证 → 最多待确认
            side = abs(yaw) > _YAW_CAP_DEG
            if side:
                conf = min(conf, 0.82)               # 侧脸：blendshape 不稳，降权封顶
            if conf > best:
                best = conf
                best_why = "眼挤%.2f%s%s" % (
                    esq,
                    ("＋" + "/".join(cor)) if cor else "（无佐证→待确认）",
                    ("｜侧脸%.0f°降权" % yaw) if side else "")
        return float(best), best_why

    def subfeatures(self, bgr, faces, closed_probs):
        """返回 (triggered: list[str], confidence, reason)"""
        if not faces:
            return [], 0.0, ""
        triggered = []
        reasons = []
        mouth_scores = []
        asym_scores = []
        for face in faces[:6]:
            x, y, w, h = face["box"]
            lm = face["landmarks5"]
            # -- 1. 张嘴过大：嘴部 ROI 暗区竖向高度 / 脸宽 --
            m = self._mouth_open_ratio(bgr, x, y, w, h)
            mouth_scores.append(m)
            # -- 2. 五官不对称：左右眼/嘴角垂直差（仅当有真实关键点时有意义）--
            a = self._asymmetry(lm, w)
            asym_scores.append(a)
        if mouth_scores and max(mouth_scores) > 0.30:
            triggered.append("张嘴过大")
            reasons.append("嘴高/脸宽 %.2f>0.30" % max(mouth_scores))
        if asym_scores and max(asym_scores) > 0.45:
            triggered.append("五官不对称")
            reasons.append("垂直不对称度 %.2f" % max(asym_scores))
        if closed_probs and 0.35 < max(closed_probs) < 0.8 and len(closed_probs) >= 2:
            hi, lo = max(closed_probs), min(closed_probs)
            if hi - lo > 0.4:
                triggered.append("眼睛状态异常")
                reasons.append("单眼闭合 %.2f/%.2f" % (hi, lo))
        emo = self._emotion_neg(bgr, faces)
        if emo is not None and emo > 0.6:
            triggered.append("面部肌肉紧张")
            reasons.append("负面情绪概率 %.2f" % emo)
        n = len(triggered)
        if n >= 2:
            conf = min(0.97, 0.80 + 0.06 * n)  # 两以上 -> 高置信度直接标记
        elif n == 1:
            conf = 0.78  # 单一子特征 -> 落入待确认区（建议复核）
        else:
            conf = float(np.clip(max(mouth_scores or [0]) * 1.2, 0, 0.5))
        return triggered, conf, "; ".join(reasons) if reasons else "无狰狞子特征"

    # ---------- 子特征实现 ----------

    @staticmethod
    def _mouth_open_ratio(bgr, x, y, w, h):
        """嘴部区域（脸框下半）暗色连续竖向块高度 / 脸宽。近似 嘴高/脸宽 > 0.35 判据"""
        x1, x2 = int(x + w * 0.28), int(x + w * 0.72)
        y1, y2 = int(y + h * 0.60), int(y + h * 0.98)
        if x2 - x1 < 12 or y2 - y1 < 12:
            return 0.0
        roi = bgr[y1:y2, x1:x2]
        gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (3, 3), 0)
        thr = float(np.percentile(gray, 30))
        dark = (gray <= thr).astype(np.uint8)
        colsum = dark.sum(axis=1)
        if colsum.max() < (x2 - x1) * 0.30:
            return 0.0
        # 最长连续暗行段（中部 70% 列范围）
        mid = dark[:, int((x2 - x1) * 0.15):int((x2 - x1) * 0.85)]
        rows = (mid.sum(axis=1) > (mid.shape[1] * 0.35)).astype(int)
        best = cur = 0
        for r in rows:
            cur = cur + 1 if r else 0
            best = max(best, cur)
        return (best / float(w)) * 2.2  # 标定：张开大嘴 ~0.18w 暗高 -> ratio ~0.4

    @staticmethod
    def _asymmetry(lm, face_w):
        le, re = lm[0], lm[1]
        lc, rc = lm[3], lm[4]
        eye_dist = abs(re[0] - le[0]) + 1e-6
        eye_dy = abs(re[1] - le[1]) / eye_dist
        mouth_dy = abs(rc[1] - lc[1]) / (abs(rc[0] - lc[0]) + 1e-6)
        return max(eye_dy, mouth_dy)

    def _emotion_neg(self, bgr, faces):
        if not self.emotion.available:
            return None
        try:
            shape = self.emotion.session.get_inputs()[0].shape
            # 自适应输入契约：NCHW(1,C,H,W) 或 NHWC(1,H,W,C)；C=1 灰度 / C=3 彩色；尺寸取空间维。
            # 兼容 ONNX Model Zoo emotion-ferplus(1,1,64,64 灰度 8 类) 与常见 FER2013(48 灰度)/224 RGB 模型，
            # 避免按错形状喂数据产出垃圾置信度。
            if len(shape) == 4 and shape[1] in (1, 3):
                ch, size, nhwc = shape[1], shape[2], False
            elif len(shape) == 4 and shape[3] in (1, 3):
                ch, size, nhwc = shape[3], shape[1], True
            else:
                ch, size, nhwc = 3, 224, False
            size = int(size) if isinstance(size, int) and size > 0 else 224
            x, y, w, h = faces[0]["box"]
            crop = bgr[max(0, y):y + h, max(0, x):x + w]
            if crop.size == 0:
                return None
            p = cv2.resize(crop, (size, size))
            if ch == 1:
                g = (cv2.cvtColor(p, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0)
                blob = g[:, :, None][None, ...] if nhwc else g[None, None, :, :]
            else:
                rgb = p[:, :, ::-1].astype(np.float32) / 255.0
                blob = rgb[None, ...] if nhwc else rgb.transpose(2, 0, 1)[None, ...]
            out = self.emotion.run(blob).flatten()
            probs = np.exp(out - out.max())
            probs = probs / probs.sum()
            names = getattr(self.emotion, "labels", None)
            if names and len(names) == probs.size:
                return float(sum(probs[i] for i, nm in enumerate(names) if str(nm).lower() in EMOTION_LABELS_NEG))
            # ONNX Model Zoo emotion-ferplus：8 类 angry,contempt,disgust,fear,happy,neutral,sad,surprise
            if probs.size == 8:
                return float(probs[0] + probs[1] + probs[2] + probs[3])
            # 常见 FER2013 顺序: angry,disgust,fear,happy,sad,surprise,neutral
            if probs.size == 7:
                return float(probs[0] + probs[1] + probs[2])
        except Exception:  # noqa: BLE001
            return None
        return None
