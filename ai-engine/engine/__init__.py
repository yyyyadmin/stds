# -*- coding: utf-8 -*-
"""DetectEngine：12 维度检测编排。模型缺失时全部维度自动降级为规则/传统算法，保证离线可跑。"""
from .imaging import load_work_image, to_original, LoadError
from .face import FaceDetector
from .eyes import EyesAnalyzer
from .expression import ExpressionAnalyzer
from .landmarks import FaceLandmarkEnhancer
from .person import PersonDetector, merge_overlaps
from . import quality as Q
from .models import detect_device, _HAS_ORT


class DetectEngine:
    def __init__(self, device=None, log=None):
        self.log = log or (lambda *a, **k: None)
        self.device = detect_device(device or "auto")
        self.faces = FaceDetector()
        self.eyes = EyesAnalyzer()
        self.expr = ExpressionAnalyzer()
        self.landmarker = FaceLandmarkEnhancer(log=self.log)
        self.person = PersonDetector(log=self.log)
        self.embed = Q.EmbeddingModel()
        self.log("engine ready: device=%s face_backend=%s eyes=%s embedding=%s ort=%s landmarker=%s person=%s" % (
            self.device, self.faces.backend, self.eyes.method, self.embed.available, _HAS_ORT, self.landmarker.available, self.person.available))

    def capabilities(self):
        return {
            "faceBackend": (self.faces.backend + "+mediapipe") if self.landmarker.available else self.faces.backend,  # yunet/haar/none
            "landmarker": self.landmarker.available,
            "person": self.person.available,      # MediaPipe ObjectDetector 人体计数（人数分类权威）
            "personOnnx": self.person.available,  # 人体模型 efficientdet_lite0.tflite 是否就位
            "eyes": self.eyes.method,           # ocec+mobilegaze / heuristic
            "emotion": self.expr.emotion.available,
            "embedding": self.embed.available,
            "onnxruntime": _HAS_ORT,
            "faceOnnx": self.faces.backend == "yunet",  # YuNet 启用（cv2.FaceDetectorYN，不经 ORT）
            "gazeOnnx": self.eyes.gaze.available,
            "ocecOnnx": self.eyes.ocec.available,
        }

    def warmup(self):
        pass

    def close(self):
        pass

    def detect(self, path, image_id=None):
        try:
            bgr, scale = load_work_image(path)
        except LoadError as e:
            return {"imageId": image_id, "dims": {}, "faces": [], "faceCount": 0, "error": str(e)}
        h, w = bgr.shape[:2]
        orig_size = None  # imaging 已映射回原图坐标时不需要
        faces = self.faces.detect(bgr)
        # MediaPipe 增强：把 478 点/blendshape 挂到 YuNet 脸上供后续维度消费。
        # 绝不改变 faces 数量/顺序（计数仍归 YuNet）；任何异常内部吞掉、回落启发式。
        try:
            if self.landmarker.available and faces:
                self.landmarker.enhance(bgr, faces)
        except Exception:  # noqa: BLE001
            self.log("landmarker enhance skipped (guarded)", level="warn")
        face_count = len(faces)
        upper = self.faces.detect_upper_bodies(bgr) if face_count <= 2 else []

        dims = {}

        # 暗光下眼睛分析改用提亮副本：闭眼/斜眼靠眼睛 ROI 纹理，暗部会压低信号；
        # 增强副本与原图同尺寸，脸框坐标可直接复用。画质维度（模糊/曝光/黑白）仍用原图。
        bright = Q.mean_brightness(bgr)
        eye_bgr = self.faces.enhance_lowlight(bgr) if (face_count and bright < 25) else bgr

        # --- 闭眼 / 斜眼 ---
        closed_conf, closed_reason = self.eyes.closed_eye(eye_bgr, faces)
        gaze_conf, gaze_off, gaze_reason = self.eyes.gaze_offset(eye_bgr, faces)
        if face_count:
            dims["eyes_closed"] = {"confidence": round(closed_conf, 4), "reason": closed_reason, "method": self.eyes.method}
            dims["eyes_side"] = {"confidence": round(gaze_conf, 4), "reason": gaze_reason, "method": self.eyes.method}

        # --- 面部狰狞（子特征综合） ---
        closed_probs = []
        for f in faces[:6]:
            for roi in _eye_rois_safe(self.eyes, eye_bgr, f):
                closed_probs.append(roi)
        trig, ugly_conf, ugly_reason = self.expr.subfeatures(bgr, faces, closed_probs)
        if face_count:
            dims["face_ugly"] = {
                "confidence": round(ugly_conf, 4),
                "reason": ugly_reason + (("，触发: " + "/".join(trig)) if trig else ""),
                "method": "subfeatures",
            }

        # --- 模糊 / 曝光 / 黑白 ---
        blur_conf, blur_reason = Q.blur_score(bgr, faces)
        dims["blur"] = {"confidence": round(blur_conf, 4), "reason": blur_reason, "method": "laplacian+fft"}
        exp_conf, exp_reason = Q.exposure_score(bgr)
        dims["exposure"] = {"confidence": round(exp_conf, 4), "reason": exp_reason, "method": "lab-histogram"}
        bw_conf, bw_reason = Q.black_white_score(bgr)
        dims["black_white"] = {"confidence": round(bw_conf, 4), "reason": bw_reason, "method": "saturation"}

        # --- 半截头 ---
        hh_conf, hh_reason = Q.half_head_score(bgr.shape, faces, upper, scale)
        dims["half_head"] = {"confidence": round(hh_conf, 4), "reason": hh_reason, "method": "box+body"}

        # --- 人数分类（人体计数权威 + 人脸交叉校验；模型缺失时逐字回落人脸计数，零回归）---
        # v2.0.62 实测三组结构性误判的修法（用户口径：单人=有且只有一人；无人物=零人物证据）：
        # - 人脸数是硬下限：检到≥2张脸就绝不是单人照（修 245 张"互动照人体漏检→单人"）
        # - 人体框先重叠/包含合并再计数（修 211 张"同一人拆 2 框→多人"）
        # - 远景小框也算人：只要检出任何人体框就不是无人物，≥2 直接判多人合照（修全景照误判无人物）
        person_count, bodies = self.person.count(bgr)
        if person_count is not None:
            main = merge_overlaps([b for b in bodies if b.get("filtered", True)])
            n_eff = max(len(main), face_count)
            if n_eff >= 2:
                avg_score = sum(b["score"] for b in main) / len(main) if main else 0.5
                conf = min(0.98, 0.88 + avg_score * 0.1)
                dims["group_photo"] = {"confidence": round(conf, 4), "reason": "检出 %d 人（人体 %d、人脸 %d）" % (n_eff, len(main), face_count), "method": "body-count"}
            elif n_eff == 1:
                if main:
                    b0 = main[0]
                    conf = min(0.99, 0.88 + b0["h_ratio"] * 0.4 + b0["score"] * 0.05)
                    why = "检出 1 人体（占图高%.0f%%），人脸 %d" % (b0["h_ratio"] * 100.0, face_count)
                else:
                    # 人体零检出但检到 1 脸：逐字沿用旧 face-count 单人判据
                    conf, why = 0.985, "检出 1 张人脸（人体未检出）"
                dims["single_person"] = {"confidence": round(conf, 4), "reason": why, "method": "body-count"}
            else:
                raw_n = len(bodies)
                if raw_n >= 2:
                    dims["group_photo"] = {"confidence": 0.86, "reason": "检出 %d 个远景/小尺寸人影" % raw_n, "method": "body-count"}
                elif raw_n == 1:
                    dims["single_person"] = {"confidence": 0.83, "reason": "检出 1 个远景/小尺寸人影", "method": "body-count"}
                elif upper:
                    dims["group_photo"] = {"confidence": 0.80, "reason": "检出 %d 个躯干但无完整人体/人脸，近景边缘人物" % len(upper), "method": "body-count"}
                elif bright < 25:
                    # 暗光安全网：画面整体偏暗时人体/人脸同样易漏检，不拉满，降为中置信并标注可能漏检。
                    dims["no_person"] = {"confidence": 0.70, "reason": "未检出人体，但画面偏暗(亮度%.0f)，可能漏检" % bright, "method": "body-count"}
                else:
                    dims["no_person"] = {"confidence": 0.95, "reason": "人体/人脸/躯干零检出", "method": "body-count"}
        elif face_count == 0:
            if bright < 25:
                # 暗光安全网：画面整体偏暗时人脸极易漏检，不把 no_person 拉满，
                # 降为中置信（待确认）并标注可能漏检，避免暗部人像被误判为无人物。
                dims["no_person"] = {"confidence": 0.55, "reason": "未检出人脸（检出 %d 躯干），但画面偏暗(亮度%.0f)，可能漏检" % (len(upper), bright), "method": "face-count"}
            else:
                dims["no_person"] = {"confidence": 0.97 if not upper else 0.80, "reason": "未检出人脸（检出 %d 躯干）" % len(upper), "method": "face-count"}
        elif face_count == 1:
            dims["single_person"] = {"confidence": 0.985, "reason": "检出 1 张人脸", "method": "face-count"}
        else:
            # >=2 人统一归多人合照（"双人照"类型已按产品决策并入多人）
            dims["group_photo"] = {"confidence": 0.975, "reason": "检出 %d 张人脸" % face_count, "method": "face-count"}

        # 重复/连拍在跨图层面处理：返回 phash + embedding，由主进程聚类
        out_faces = []
        for f in faces[:12]:
            box = to_original(f["box"], scale, orig_size)
            info = {"box": box, "score": round(f["score"], 3)}
            if f.get("landmarks5"):
                info["landmarks"] = [[round(px / scale), round(py / scale)] for px, py in f["landmarks5"]]
            out_faces.append(info)
        result = {
            "imageId": image_id,
            "dims": dims,
            "faces": out_faces,
            "faceCount": face_count,
            "phash": Q.phash(bgr),
            "embedding": self.embed.embed(bgr) if self.embed.available else None,
        }
        return result


def _eye_rois_safe(eyes_analyzer, bgr, face):
    """复用眼睛闭合概率给狰狞子特征（眼睛状态异常）：返回每只眼的闭合概率列表"""
    from .face import eye_rois
    probs = []
    for roi in eye_rois(face, bgr):
        side, x, y, w, h, _, _ = roi
        patch = bgr[y:y + h, x:x + w]
        p = eyes_analyzer._ocec_prob(patch) if eyes_analyzer.ocec.available else None
        if p is None:
            from .eyes import _eye_stats
            open_score, _, _ = _eye_stats(bgr, roi)
            p = 1.0 - open_score
        probs.append(p)
    return probs
