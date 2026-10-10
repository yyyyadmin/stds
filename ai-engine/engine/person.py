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
# 合并护栏（v2.0.64）：两个框横向中心距 / 较小框宽 的上限。同一个人被拆开的框必然同列，
# 不同的人（并排/拥抱/前后景站位）必然分列。
_MERGE_MAX_DX_RATIO = 0.35


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
                max_results=-1,  # 官方文档定义：-1 = 返回全部结果（内部已 NMS）；0 为未定义行为，可能静默截断为 0
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
        """返回 (过滤后人体数, 全部人体框)。不可用/异常返回 (None, []) 让调用方逐字回落人脸计数。
        bodies[i] = {"box":[x,y,w,h], "score":float, "h_ratio":float, "area_ratio":float, "filtered":bool}
        filtered=False 的远景小框不参与单/多人计数，但仍作为"画面里有人"的证据供无人物判定使用
        ——v2.0.62 实测：旧版把小框直接丢弃后零检出→全景婚礼照 80% 被误判无人物（用户口径：
        只要检出任何人体框就不是无人物）。"""
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
                bodies.append({
                    "box": [int(bb.origin_x), int(bb.origin_y), int(bw), int(bh)],
                    "score": round(float(cats[0].score), 3),
                    "h_ratio": round(h_ratio, 3),
                    "area_ratio": round(area_ratio, 4),
                    "filtered": not (h_ratio < _BODY_MIN_H_RATIO or area_ratio < _BODY_MIN_AREA_RATIO),
                })
            return sum(1 for b in bodies if b["filtered"]), bodies
        except Exception as e:  # noqa: BLE001
            self.log("person detect failed (%s)" % e)
            return None, []


def _box_inter(a, b):
    ix = max(0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    return ix * iy


def merge_overlaps(bodies):
    """把同一个人被拆开的框合并（礼服/局部遮挡/上下半身双框）：IoU≥0.4 或
    包含度（交集/较小框面积）≥0.65 视为同一人，贪心保留大框。
    v2.0.62 实测：211 张 group 高置信但 YuNet 仅≤1脸，即拆框致"单人判多人"。

    垂直对齐护栏（v2.0.64）：光看重叠度会把两个人合成一个人——新人拥抱、亲子前后站位、
    一排伴娘侧身相接时，矮个子的框能整体落进高个子的框里，包含度轻松过 0.65，合并后
    len(main)==1 而人脸又只拍到 1 张（其余侧脸/背身），于是“多人合照”被判成置信度
    0.9+ 的“单人照”——用户头号抱怨。因此再加一条：只有两框 x 中心几乎同列
    （|dx| ≤ 0.35×较小框宽）才允许合并；不同列就是两个人，重叠再多也不合。
    被护栏挡住不合并不会影响原本的拆框修复（上下半身/礼服拆框天然同列）。"""
    kept = []
    for b in sorted(bodies, key=lambda x: -x["box"][2] * x["box"][3]):
        dup = False
        for k in kept:
            inter = _box_inter(b["box"], k["box"])
            if inter <= 0:
                continue
            small = min(b["box"][2] * b["box"][3], k["box"][2] * k["box"][3])
            union = b["box"][2] * b["box"][3] + k["box"][2] * k["box"][3] - inter
            if not ((inter / union if union > 0 else 0) >= 0.4 or (inter / small if small > 0 else 1) >= 0.65):
                continue
            # 同列护栏：拆框（上半身/下半身/礼服）x 中心基本对齐，并排/拥抱的两人必然分列
            bx, bw = float(b["box"][0]), float(b["box"][2])
            kx, kw = float(k["box"][0]), float(k["box"][2])
            dx = abs((bx + bw / 2.0) - (kx + kw / 2.0))
            if dx > _MERGE_MAX_DX_RATIO * min(bw, kw):
                continue
            dup = True
            break
        if not dup:
            kept.append(b)
    return kept
