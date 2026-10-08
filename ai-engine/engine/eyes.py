# -*- coding: utf-8 -*-
"""眼睛维度：闭眼（OCEC ONNX 可选，否则眼闭合度启发式）+ 斜眼（MobileGaze 可选，否则虹膜偏移启发式）。
闭眼和斜视必须拆开做（第八章 8.2）。"""
import math

import cv2
import numpy as np

from .models import OnnxSession
from .face import eye_rois


def _eye_stats(bgr, roi):
    """单个眼 ROI 的开启度统计：返回 (open_score 0~1, iris_offset -1~1 or None, detail)"""
    side, x, y, w, h, cx, cy = roi
    patch = bgr[y:y + h, x:x + w]
    gray = cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)
    # 闭合眼睛特征：水平暗线 / 边缘集中在一条横线、纵向方差低
    edges = cv2.Canny(gray, 60, 160)
    row_energy = edges.sum(axis=1).astype(float)
    col_energy = edges.sum(axis=0).astype(float)
    row_peak = row_energy.max() / (row_energy.mean() + 1e-6)  # 单一横线 -> 峰值比高
    vert_var = float(gray.var(axis=1).mean())  # 上下眼睑对比 -> 睁眼时更高
    # 亮度带：睁眼有明显暗瞳孔 + 亮虹膜/白睛
    dyn = float(gray.max() - gray.min())
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
        parts = []
        for face in faces[:6]:
            for roi in eye_rois(face, bgr):
                side, x, y, w, h, _, _ = roi
                patch = bgr[y:y + h, x:x + w]
                prob = self._ocec_prob(patch) if self.ocec.available else None
                if prob is None:
                    open_score, _, d = _eye_stats(bgr, roi)
                    prob = 1.0 - open_score
                    parts.append("%s:%.2f" % (side, prob))
                else:
                    parts.append("%s:ocec%.2f" % (side, prob))
                worst = max(worst, prob)
        method = "ocec" if self.ocec.available else "heuristic"
        reason = "眼闭合度 %.2f (%s) [%s]" % (worst, ", ".join(parts), method)
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
