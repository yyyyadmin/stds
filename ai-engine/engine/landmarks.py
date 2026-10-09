# -*- coding: utf-8 -*-
"""MediaPipe FaceLandmarker 增强层：不改 YuNet 计数，仅把 478 点/blendshape 按 IoU
匹配回 YuNet 脸并附加到 face["mp"]。mediapipe 缺失或异常时 available=False，全流程回落。"""
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


# YuNet 脸框与 FaceLandmarker 478 点外接框的最小匹配 IoU。闭眼时 landmark 点集纵向内缩、
# 外接框变紧，IoU 会系统性掉到 ~0.27（CI 实测：闭眼 0.269 vs 睁眼 0.489），0.30 会恰好漏掉
# 最该检测的闭眼脸并回落到弱启发式。不同人之间脸框几乎不重叠（IoU≈0），0.20 既跨过 0.269
# 又远高于任何邻脸误配，安全区分"同一张脸"与"串到邻脸"。待真实合照数据再校。
_IOU_MATCH_MIN = 0.20


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
        """对全图跑一次，按 IoU 匹配到 YuNet 脸并附加 face['mp']。返回增强脸数。"""
        if not self.available or not faces:
            return 0
        H, W = bgr.shape[:2]
        try:
            rgb = np.ascontiguousarray(bgr[:, :, ::-1])
            mp_img = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)
            res = self._lm.detect(mp_img)
        except Exception as e:  # noqa: BLE001
            self.log("landmarker detect failed (%s)" % e)
            return 0
        ml = res.face_landmarks or []
        mb = res.face_blendshapes or []
        mm = res.facial_transformation_matrixes or []
        cands = []  # (mp_bbox, landmarks_px, blend_dict, matrix_list)
        for i, lms in enumerate(ml):
            pts = [(lm.x * W, lm.y * H) for lm in lms]
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            x0, x1 = min(xs), max(xs)
            y0, y1 = min(ys), max(ys)
            mp_bbox = [x0, y0, max(1, x1 - x0), max(1, y1 - y0)]
            blend = {}
            if i < len(mb) and mb[i]:
                blend = {c.category_name: float(c.score) for c in mb[i]}
            matrix = None
            if i < len(mm):
                try:
                    matrix = np.array(mm[i]).reshape(4, 4).tolist()
                except Exception:  # noqa: BLE001
                    matrix = None
            cands.append((mp_bbox, pts, blend, matrix))
        enhanced = 0
        used = set()
        ious = []
        for face in faces:
            best_j, best_iou = -1, 0.0
            for j, (mp_bbox, _pts, _blend, _m) in enumerate(cands):
                if j in used:
                    continue
                v = _iou(face["box"], mp_bbox)
                if v > best_iou:
                    best_iou, best_j = v, j
            ious.append(round(best_iou, 3))
            if best_j >= 0 and best_iou >= _IOU_MATCH_MIN:
                _bbox, pts, blend, matrix = cands[best_j]
                used.add(best_j)
                face["mp"] = {
                    "landmarks": pts,
                    "blend": blend,
                    "bbox": [int(round(v)) for v in _bbox],
                    "matrix": matrix,
                    "score": round(best_iou, 3),
                }
                enhanced += 1
        self.last_diag = {"ml": len(ml), "cands": len(cands), "faces": len(faces), "ious": ious}
        return enhanced
