# -*- coding: utf-8 -*-
"""MediaPipe FaceLandmarker 增强层：不改 YuNet 计数，把 478 点/blendshape/姿态矩阵挂到
face["mp"] 供后续维度（闭眼/表情）消费。采用【逐脸裁切检测】而非全图一次：对每个 YuNet 框
裁一个带边距的紧块单独跑 FaceLandmarker——因为 MediaPipe 自带检测器在全图上对侧脸/遮挡/暗场/
人群召回极低（真实婚礼库仅 ~3% 脸挂得上），而单主脸特写的检出让率接近 100%。
mediapipe 缺失或异常时 available=False，全流程回落启发式。"""
import numpy as np

from .models import mediapipe_task_path


def _iou(a, b):
    """a,b=[x,y,w,h]。返回交并比。"""
    ax1, ay1, aw, ah = a
    bx1, by1, bw, bh = b
    ax2, ay2 = ax1 + aw, ay1 + ah
    bx2, by2 = bx1 + bw, by1 + bh
    ix = max(0, min(ax2, bx2) - max(ax1, bx1))
    iy = max(0, min(ay2, by2) - max(ay1, by1))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


# 逐脸裁切的两个下限，权衡"检得出 + blendshape 可靠" vs "CPU 开销"：
# _MIN_CROP：裁块短边低于此像素不送 MediaPipe（小脸关键点/表情不可靠，交启发式兜底）。
# _MAX_CROPS：每张图最多裁几脸单独跑（人群照限流），超出时优先最大的脸。
_MIN_CROP = 32
_MAX_CROPS = 15


class FaceLandmarkEnhancer:
    def __init__(self, log=None):
        self.log = log or (lambda *a, **k: None)
        self.available = False
        self._lm = None
        self._mp = None
        self.last_diag = {}  # 最近一次 enhance() 的诊断：ml/cands/faces/ious，供 selfcheck 定位挂载失败
        try:
            import mediapipe as mp
            from mediapipe.tasks import python as mp_python
            from mediapipe.tasks.python import vision
            task = mediapipe_task_path()
            if not task:
                self.log("landmarker: face_landmarker.task not found, enhancement off")
                return
            from .face import _ascii_model_path
            ascii_task = _ascii_model_path(task)
            opts = vision.FaceLandmarkerOptions(
                base_options=mp_python.BaseOptions(model_asset_path=ascii_task),
                running_mode=vision.RunningMode.IMAGE,
                num_faces=6,
                output_face_blendshapes=True,
                output_facial_transformation_matrixes=True,
                # 逐脸紧裁块里目标脸占主导，可放低检测置信度换召回（侧脸/暗脸也能出关键点）。
                min_face_detection_confidence=0.3,
                min_face_presence_confidence=0.3,
            )
            self._mp = mp
            self._vision = vision
            self._lm = vision.FaceLandmarker.create_from_options(opts)
            self.available = True
            self.log("landmarker: mediapipe FaceLandmarker ready")
        except Exception as e:  # noqa: BLE001
            self.available = False
            self.log("landmarker off (%s: %s)" % (type(e).__name__, e))

    def enhance(self, bgr, faces):
        """逐脸裁切检测：对每个 YuNet 框裁一个带边距的紧块单独跑 FaceLandmarker，取离该
        框中心最近的检出让，landmarks 映射回原图坐标后附加 face['mp']。返回增强脸数。
        不改变 faces 数量/顺序（计数仍归 YuNet）；单脸异常逐张吞掉、不中断其他脸。"""
        if not self.available or not faces:
            self.last_diag = {"ml": 0, "cands": 0, "faces": len(faces or []), "ious": [], "crops": 0}
            return 0
        H, W = bgr.shape[:2]
        # 人群照限流：脸数超上限时只处理最大的若干张（表情/闭眼只对主体有意义）。
        idxs = list(range(len(faces)))
        if len(idxs) > _MAX_CROPS:
            idxs = sorted(idxs, key=lambda i: -float(faces[i]["box"][3]))[:_MAX_CROPS]
        enhanced = 0
        total_det = 0
        ious = [0.0] * len(faces)
        for i in idxs:
            face = faces[i]
            x, y, w, h = face["box"]
            pad = int(0.35 * max(w, h))
            x0 = max(0, int(x) - pad)
            y0 = max(0, int(y) - pad)
            x1 = min(W, int(x + w) + pad)
            y1 = min(H, int(y + h) + pad)
            if x1 - x0 < _MIN_CROP or y1 - y0 < _MIN_CROP:
                continue
            crop = bgr[y0:y1, x0:x1]
            ch, cw = crop.shape[:2]
            try:
                rgb = np.ascontiguousarray(crop[:, :, ::-1])
                mp_img = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)
                res = self._lm.detect(mp_img)
            except Exception as e:  # noqa: BLE001
                self.log("landmarker crop detect failed on face %d (%s)" % (i, e))
                continue
            ml = res.face_landmarks or []
            if not ml:
                continue
            total_det += len(ml)
            # 取 landmark 外接框中心离"原脸框中心"最近的检出让（裁块混入邻脸时选对主体）。
            fcx = (float(x) + float(w) / 2.0) - x0
            fcy = (float(y) + float(h) / 2.0) - y0
            best_j, best_d = -1, None
            for j, lms in enumerate(ml):
                xs = [lm.x * cw for lm in lms]
                ys = [lm.y * ch for lm in lms]
                dcx = ((min(xs) + max(xs)) / 2.0) - fcx
                dcy = ((min(ys) + max(ys)) / 2.0) - fcy
                d = dcx * dcx + dcy * dcy
                if best_d is None or d < best_d:
                    best_d, best_j = d, j
            if best_j < 0:
                continue
            mb = res.face_blendshapes or []
            blend = {}
            if best_j < len(mb) and mb[best_j]:
                blend = {c.category_name: float(c.score) for c in mb[best_j]}
            if not blend:
                continue
            pts = [(lm.x * cw + x0, lm.y * ch + y0) for lm in ml[best_j]]
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            mx0, mx1, my0, my1 = min(xs), max(xs), min(ys), max(ys)
            mp_bbox = [mx0, my0, max(1, mx1 - mx0), max(1, my1 - my0)]
            ious[i] = round(_iou(face["box"], mp_bbox), 3)
            mm = res.facial_transformation_matrixes or []
            matrix = None
            if best_j < len(mm):
                try:
                    matrix = np.array(mm[best_j]).reshape(4, 4).tolist()
                except Exception:  # noqa: BLE001
                    matrix = None
            face["mp"] = {
                "landmarks": pts,
                "blend": blend,
                "bbox": [int(round(v)) for v in mp_bbox],
                "matrix": matrix,
                "score": ious[i],
            }
            enhanced += 1
        self.last_diag = {"ml": total_det, "cands": total_det, "faces": len(faces), "ious": ious, "crops": len(idxs)}
        return enhanced
