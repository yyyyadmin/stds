# -*- coding: utf-8 -*-
"""眼睛维度：闭眼（OCEC ONNX 可选，否则眼闭合度启发式）+ 斜眼（MobileGaze 可选，否则虹膜偏移启发式）。
闭眼和斜视必须拆开做（第八章 8.2）。"""
import math

import cv2
import numpy as np

from .models import OnnxSession
from .face import eye_rois


# MediaPipe FaceLandmarker 478 点：左右眼各 6 点（Soukupova & Cech EAR 变体，索引对应 FaceLandmarker 拓扑）
_EYE_L = [33, 160, 158, 133, 153, 144]
_EYE_R = [362, 385, 387, 263, 374, 380]
_EAR_CLOSED = 0.18    # EAR 低于此视为几何全闭（spec 起点，待真实照校准）
_BLINK_CLOSED = 0.60  # eyeBlink blendshape 概率达到此视为闭合


def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _eye_ear(lms, idx):
    """6 点 EAR = (|p1-p5| + |p2-p4|) / (2|p0-p3|)。像素坐标即可（比值尺度无关）。异常/点不足返回 None。"""
    try:
        p = [lms[i] for i in idx]
    except Exception:  # noqa: BLE001
        return None
    h = _dist(p[0], p[3])
    if h <= 1e-6:
        return None
    return (_dist(p[1], p[5]) + _dist(p[2], p[4])) / (2.0 * h)


def _mp_closed_prob(face):
    """有 mp 时返回 (闭合概率, 诊断串)；无 mp / 数据不足返回 None（交调用方回落启发式）。
    单眼闭合度 = max(EAR 几何闭合度, eyeBlink blendshape 概率)；取两眼较大——任一闭合即计，偏召回。"""
    mpd = face.get("mp")
    if not mpd:
        return None
    lms = mpd.get("landmarks")
    blend = mpd.get("blend") or {}
    if not lms or len(lms) < 478:
        return None
    best = None
    diag = []
    for idx, blink_key in ((_EYE_L, "eyeBlinkLeft"), (_EYE_R, "eyeBlinkRight")):
        ear = _eye_ear(lms, idx)
        p_ear = None if ear is None else max(0.0, min(1.0, 1.0 - ear / _EAR_CLOSED))
        blink = blend.get(blink_key)
        p_blink = None if blink is None else max(0.0, min(1.0, float(blink) / _BLINK_CLOSED))
        cand = [x for x in (p_ear, p_blink) if x is not None]
        if not cand:
            continue
        pe = max(cand)
        best = pe if best is None else max(best, pe)
        diag.append("%s(ear=%s blink=%s)" % (
            "L" if blink_key.endswith("Left") else "R",
            ("%.3f" % ear) if ear is not None else "NA",
            ("%.2f" % blink) if blink is not None else "NA"))
    if best is None:
        return None
    return float(best), "mp:%.2f[%s]" % (best, " ".join(diag))


def _eye_stats(bgr, roi):
    """单个眼 ROI 的开启度统计：返回 (open_score 0~1, iris_offset -1~1 or None, detail)"""
    side, x, y, w, h, cx, cy = roi
    patch = bgr[y:y + h, x:x + w]
    raw = cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY)
    # 均衡版仅用于边缘检测(Canny)与虹膜定位；对比度/纵向方差必须在【原始灰度】上测——
    # equalizeHist 会把任意 patch 拉到满量程，使 dyn 恒≈255、vert_var 虚高，闭眼的低对比信号被抹掉。
    gray = cv2.equalizeHist(raw)
    # 闭合眼睛特征：水平暗线 / 边缘集中在一条横线、纵向方差低
    edges = cv2.Canny(gray, 60, 160)
    row_energy = edges.sum(axis=1).astype(float)
    col_energy = edges.sum(axis=0).astype(float)
    row_peak = row_energy.max() / (row_energy.mean() + 1e-6)  # 单一横线 -> 峰值比高
    vert_var = float(raw.var(axis=1).mean())  # 原图纵向方差：闭眼(一条横线)低、睁眼(上下眼睑+瞳孔)高
    # 亮度带：睁眼有明显暗瞳孔 + 亮虹膜/白睛
    dyn = float(raw.max() - raw.min())  # 原图动态范围：闭眼/低对比时小
    open_score = 1.0
    if vert_var < 12 or dyn < 40:
        open_score = 0.25
    elif row_peak > 6.0 and vert_var < 26:
        open_score = 0.45
    elif vert_var < 22:
        open_score = 0.62
    # 虹膜偏移：取眼区中部竖直带内最暗连通块质心
    iris_offset = None
    if open_score >= 0.55:
        band = gray[int(h * 0.2):int(h * 0.8), :]
        thr = float(np.percentile(band, 18))
        mask = (band <= thr).astype(np.uint8)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        m = cv2.moments(mask)
        if m["m00"] > 6:
            ix = m["m10"] / m["m00"]
            iris_offset = float((ix - w / 2.0) / (w / 2.0))
    return open_score, iris_offset, {"vert_var": round(vert_var, 1), "row_peak": round(row_peak, 1), "dyn": round(dyn, 1)}


class EyesAnalyzer:
    def __init__(self):
        # OCEC 闭眼专用模型（MIT，可直接商用）：放入 models/ 即自动启用
        self.ocec = OnnxSession(["ocec*.onnx", "*eyes_closed*.onnx", "ufec*.onnx"], 24)
        self.gaze = OnnxSession(["mobilegaze*.onnx", "*gaze*.onnx"], 224)
        self.method = "ocec+mobilegaze" if (self.ocec.available and self.gaze.available) else "heuristic"

    # ---------- 闭眼 ----------

    def _ocec_prob(self, patch_bgr):
        """OCEC: 输入眼睛图块，输出 [NCL, CL, SR] 概率；类别顺序未知时按均值兜底不可行，故要求标准顺序"""
        try:
            p = cv2.resize(patch_bgr, (24, 24))
            blob = p.astype(np.float32)
            if self.ocec.session.get_inputs()[0].shape[1] == 3:  # CHW
                blob = blob.transpose(2, 0, 1)[None, ...]
            else:
                blob = blob[None, ...]
            out = self.ocec.run(blob)
            probs = np.array(out).flatten()
            if probs.size >= 3:
                if probs.size > 3:
                    probs = np.exp(probs - probs.max())
                    probs = probs / probs.sum()
                return float(probs[1]) + float(probs[2]) * 0.5  # 完全闭合 + 半闭折半
        except Exception:  # noqa: BLE001
            pass
        return None

    def closed_eye(self, bgr, faces):
        """返回 (confidence 闭眼成立的可信度, reason)。偏向召回：任一 eyes 半闭即计"""
        if not faces:
            return 0.0, ""
        worst = 0.0
        worst_detail = None
        parts = []
        worst_from_mp = False
        for face in faces[:6]:
            mp = _mp_closed_prob(face)
            if mp is not None:
                prob, d = mp
                parts.append(d)
                if prob >= worst:
                    worst = prob
                    worst_detail = None  # mp 路径无启发式 vv/dyn/rp，清掉避免错拼非最坏脸的诊断
                    worst_from_mp = True
                continue
            for roi in eye_rois(face, bgr):
                side, x, y, w, h, _, _ = roi
                patch = bgr[y:y + h, x:x + w]
                prob = self._ocec_prob(patch) if self.ocec.available else None
                if prob is None:
                    open_score, _, dd = _eye_stats(bgr, roi)
                    prob = 1.0 - open_score
                    parts.append("%s:%.2f" % (side, prob))
                    if prob >= worst:
                        worst_detail = dd
                        worst_from_mp = False
                else:
                    parts.append("%s:ocec%.2f" % (side, prob))
                    if prob >= worst:
                        worst_from_mp = False
                worst = max(worst, prob)
        method = "mediapipe" if worst_from_mp else ("ocec" if self.ocec.available else "heuristic")
        reason = "眼闭合度 %.2f (%s) [%s]" % (worst, ", ".join(parts), method)
        if worst_detail:
            reason += " vv=%.0f dyn=%.0f rp=%.1f" % (
                worst_detail.get("vert_var", 0), worst_detail.get("dyn", 0), worst_detail.get("row_peak", 0))
        return float(worst), reason

    # ---------- 斜眼 ----------

    def gaze_offset(self, bgr, faces):
        """返回 (confidence 斜眼成立的可信度, max_offset, reason)。判定：瞳孔偏离眼中心超过阈值"""
        if not faces:
            return 0.0, 0.0, ""
        max_off = 0.0
        details = []
        for face in faces[:6]:
            offs = []
            for roi in eye_rois(face, bgr):
                open_score, offset, _ = _eye_stats(bgr, roi)
                if offset is not None and open_score >= 0.55:
                    offs.append(offset)
                    max_off = max(max_off, abs(offset))
            if len(offs) == 2 and all(o > 0.35 for o in offs):
                # 双眼同向偏移：侧视/斜眼强信号
                max_off = max(max_off, min(abs(offs[0]), abs(offs[1])) * 1.25)
            details.append("%.2f" % (max(abs(o) for o in offs) if offs else 0))
        # 启发式偏移 -> 置信度：0.35 起升，0.7 饱和（约对应视线偏 15-20 度）
        conf = _sigmoid((max_off - 0.52) / 0.10)
        reason = "瞳孔偏移 %.2f (%s)" % (max_off, ", ".join(details))
        return float(conf if max_off > 0.25 else 0.0), max_off, reason


def _sigmoid(z):
    return 1.0 / (1.0 + math.exp(-z))
