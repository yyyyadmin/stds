# -*- coding: utf-8 -*-
"""人脸/人体检测：优先 ONNX（YuNet/SCRFD/RetinaFace 权重），否则退回 OpenCV 自带 Haar 级联。
另提供上半身检测（半截头维度：躯干存在但头部缺失）。"""
import cv2
import numpy as np

from .models import OnnxSession, haar_path, yunet_path

ONNX_INPUT = 320


def _nms(boxes, iou_thr=0.35):
    """简单非极大值抑制：去重正面/侧面多重检测的重叠框。boxes=[[x,y,w,h,score],...]"""
    if not boxes:
        return []
    boxes = sorted(boxes, key=lambda b: b[4] * (b[2] * b[3]), reverse=True)
    keep = []
    for b in boxes:
        x1, y1, w1, h1 = b[0], b[1], b[2], b[3]
        suppressed = False
        for k in keep:
            x2, y2, w2, h2 = k[0], k[1], k[2], k[3]
            ix = max(0, min(x1 + w1, x2 + w2) - max(x1, x2))
            iy = max(0, min(y1 + h1, y2 + h2) - max(y1, y2))
            inter = ix * iy
            union = w1 * h1 + w2 * h2 - inter
            if union > 0 and inter / union > iou_thr:
                suppressed = True
                break
        if not suppressed:
            keep.append(b)
    return keep


class FaceDetector:
    def __init__(self):
        self.onnx_model = None
        weight = yunet_path()
        if weight:
            self.onnx_model = OnnxSession([weight], ONNX_INPUT)
            if not self.onnx_model.available:
                self.onnx_model = None
        has_haar = bool(haar_path("haarcascade_frontalface_default.xml"))
        self.backend = "yunet" if self.onnx_model else ("haar" if has_haar else "none")
        self._detector = None
        self._haar = None
        self._haar_profile = None
        if self.backend == "haar":
            self._haar = cv2.CascadeClassifier(haar_path("haarcascade_frontalface_default.xml"))
            # 侧脸级联：提升斜眼/侧身/半侧人头脸召回（⑤⑧）
            pf = haar_path("haarcascade_profileface.xml")
            if pf:
                self._haar_profile = cv2.CascadeClassifier(pf)
        self._upper = None
        ub = haar_path("haarcascade_upperbody.xml")
        if ub:
            self._upper = cv2.CascadeClassifier(ub)

    # ---------- 主入口 ----------

    def detect(self, bgr, min_face=24):
        """返回 [{box:[x,y,w,h](工作图坐标), score, landmarks(可选5点)}]，按面积降序"""
        if self.backend == "yunet":
            faces = self._detect_onnx(bgr)
        elif self.backend == "haar":
            faces = self._detect_haar(bgr, min_face)
        else:
            faces = []
        faces.sort(key=lambda f: f["box"][2] * f["box"][3], reverse=True)
        return faces

    def detect_upper_bodies(self, bgr):
        if self._upper is None:
            return []
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)
        rects = self._upper.detectMultiScale(gray, scaleFactor=1.15, minNeighbors=4, minSize=(60, 80))
        return [[int(x), int(y), int(w), int(h)] for x, y, w, h in rects]

    # ---------- 后端实现 ----------

    def _detect_onnx(self, bgr):
        if self._detector is None:
            self._detector = cv2.FaceDetectorYN.create(self.onnx_model.path, "", (ONNX_INPUT, ONNX_INPUT), 0.6, 0.3, 5000)
        h, w = bgr.shape[:2]
        # YuNet 需要宽高为 32 的倍数
        nw, nh = max(32, (w // 32) * 32), max(32, (h // 32) * 32)
        canvas = cv2.resize(bgr, (nw, nh))
        self._detector.setInputSize((nw, nh))
        try:
            _, faces = self._detector.detect(canvas)
        except cv2.error:
            return []
        out = []
        sx, sy = w / float(nw), h / float(nh)
        if faces is None:
            return out
        for f in faces:
            x, y, fw, fh = f[0:4]
            pts = [(f[6 + i * 2] , f[7 + i * 2]) for i in range(5)]
            pts = [(px * sx, py * sy) for px, py in pts]
            out.append({
                "box": [int(x * sx), int(y * sy), int(fw * sx), int(fh * sy)],
                "score": float(f[14]),
                "landmarks5": pts,
            })
        return out

    def _detect_haar(self, bgr, min_face):
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)
        scale = 1.0
        if max(gray.shape) > 1000:
            scale = 1000.0 / max(gray.shape)
            gray = cv2.resize(gray, None, fx=scale, fy=scale)
        ms = (int(min_face * scale),) * 2
        boxes = []
        if self._haar is not None:
            for x, y, w, h in self._haar.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=4, minSize=ms):
                boxes.append([x, y, w, h, 0.85])
        if self._haar_profile is not None:
            # 正向与水平翻转各检一次，覆盖左/右侧脸
            for x, y, w, h in self._haar_profile.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=ms):
                boxes.append([x, y, w, h, 0.72])
            flipped = cv2.flip(gray, 1)
            gw = gray.shape[1]
            for x, y, w, h in self._haar_profile.detectMultiScale(flipped, scaleFactor=1.1, minNeighbors=5, minSize=ms):
                boxes.append([gw - x - w, y, w, h, 0.72])
        boxes = _nms(boxes, 0.35)
        out = []
        for x, y, w, h, sc in boxes:
            bx, by, bw, bh = [int(v / scale) for v in (x, y, w, h)]
            out.append({"box": [bx, by, bw, bh], "score": sc, "landmarks5": self._pseudo_landmarks(bx, by, bw, bh)})
        return out

    @staticmethod
    def _pseudo_landmarks(x, y, w, h):
        """Haar 无关键点时的近似五点（用于眼睛 ROI 裁剪与几何子特征）"""
        return [
            (x + w * 0.32, y + h * 0.38),  # 左眼
            (x + w * 0.68, y + h * 0.38),  # 右眼
            (x + w * 0.50, y + h * 0.55),  # 鼻尖
            (x + w * 0.36, y + h * 0.75),  # 左嘴角
            (x + w * 0.64, y + h * 0.75),  # 右嘴角
        ]


def eye_rois(face, bgr):
    """依据五点/近似五点裁剪左右眼 ROI，返回 [(left|right, x, y, w, h, cx, cy)]"""
    lm = face["landmarks5"]
    x, y, w, h = face["box"]
    leh, lew = int(h * 0.18), int(w * 0.28)
    rois = []
    for side, (lx, ly) in (("left", lm[0]), ("right", lm[1])):
        ex, ey = int(lx - lew / 2), int(ly - leh / 2)
        ex, ey = max(0, ex), max(0, ey)
        ew, eh = min(lew, bgr.shape[1] - ex), min(leh, bgr.shape[0] - ey)
        if ew >= 8 and eh >= 6:
            rois.append((side, ex, ey, ew, eh, float(lx), float(ly)))
    return rois
