# -*- coding: utf-8 -*-
"""人体检测：MediaPipe ObjectDetector（复用已冻结 mediapipe 运行时，零新依赖、不碰 torch）。
仅用于"单人/多人/无人物"人数分类，绝不参与人脸维度。模型缺失/异常 → available=False，
count() 返回 (None, []) 让调用方逐字回落人脸计数（零回归）。

设计裁决见 docs/superpowers/specs/2026-10-09-person-count-body-detection-design.md：
EfficientDet-Lite0 系 COCO 预训练，person 类含大量背身/遮挡人体，召回远好于人脸。
若真实照校准发现 Lite 召回不足，只需替换本文件切到 ONNX(NanoDet/PicoDet)，接入点不动。"""
import numpy as np

from .models import person_model_path

# 背景路人过滤（婚礼实测：主角占图高通常 ≥30%，远景宾客约 3-6%）：二者任一不达标即剔除。
# 以下为 CI 合成图起点值，待真实婚礼照校准（Task 6）。
_BODY_MIN_H_RATIO = 0.10      # 人体框高 / 图高 下限
_BODY_MIN_AREA_RATIO = 0.006  # 人体框面积 / 图面积 下限
_SCORE_MIN = 0.35             # ObjectDetector 置信下限
_PERSON_LABEL = "person"      # COCO class 0


class PersonDetector:
    def __init__(self, log=None):
        self.log = log or (lambda *a, **k: None)
        self.available = False
        self._det = None
        self._mp = None
        try:
            import mediapipe as mp
            from mediapipe.tasks import python as mp_python
            from mediapipe.tasks.python import vision
            model = person_model_path()
            if not model:
                self.log("person: efficientdet model not found, body-count off")
                return
            from .face import _ascii_model_path
            ascii_model = _ascii_model_path(model)
            opts = vision.ObjectDetectorOptions(
                base_options=mp_python.BaseOptions(model_asset_path=ascii_model),
                running_mode=vision.RunningMode.IMAGE,
                score_threshold=_SCORE_MIN,
                max_results=0,  # 0 = 返回全部（内部已 NMS）
            )
            self._mp = mp
            self._det = vision.ObjectDetector.create_from_options(opts)
            self.available = True
            self.log("person: mediapipe ObjectDetector ready")
        except Exception as e:  # noqa: BLE001
            self.available = False
            self._det = None
            self.log("person off (%s: %s)" % (type(e).__name__, e))

    def count(self, bgr):
        """返回 (过滤后人体数, 人体框详情)。不可用/异常返回 (None, []) 让调用方回落。
        bodies[i] = {"box":[x,y,w,h], "score":float, "h_ratio":float, "area_ratio":float}"""
        if not self.available or self._det is None:
            return None, []
        try:
            H, W = bgr.shape[:2]
            area = float(H * W) or 1.0
            rgb = np.ascontiguousarray(bgr[:, :, ::-1])
            mp_img = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)
            res = self._det.detect(mp_img)
            bodies = []
            for d in (res.detections or []):
                cats = d.categories or []
                if not cats or (cats[0].category_name or "") != _PERSON_LABEL:
                    continue
                bb = d.bounding_box
                bw, bh = float(bb.width), float(bb.height)
                h_ratio = bh / H
                area_ratio = (bw * bh) / area
                if h_ratio < _BODY_MIN_H_RATIO or area_ratio < _BODY_MIN_AREA_RATIO:
                    continue  # 背景路人/碎框
                bodies.append({
                    "box": [int(bb.origin_x), int(bb.origin_y), int(bw), int(bh)],
                    "score": round(float(cats[0].score), 3),
                    "h_ratio": round(h_ratio, 3),
                    "area_ratio": round(area_ratio, 4),
                })
            return len(bodies), bodies
        except Exception as e:  # noqa: BLE001
            self.log("person detect failed (%s)" % e)
            return None, []
