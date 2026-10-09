# -*- coding: utf-8 -*-
"""DetectEngine：12 维度检测编排。模型缺失时全部维度自动降级为规则/传统算法，保证离线可跑。"""
from .imaging import load_work_image, to_original, LoadError
from .face import FaceDetector
from .eyes import EyesAnalyzer
from .expression import ExpressionAnalyzer
from .landmarks import FaceLandmarkEnhancer
from .person import PersonDetector
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

        # --- 人数分类（Phase 3：人体计数为唯一权威；模型缺失或漏检安全网时逐字回落人脸计数，零回归）---
        # 权威切换：婚礼背对/侧脸/面纱会漏检人脸导致 undercount（多人→无人物、两人→单人）。
        # 人体框召回远好于人脸，故以 PersonDetector 数人体作为 single/group/no_person 判定依据。
        # 安全网：人体判 0 但人脸/躯干存在时，多半是人体模型漏检（紧贴/裁切），逐字回落 face-count，
        # 绝不因换了权威反而把"有人"判成"无人"。人脸维度（闭眼/斜眼/半截头/狰狞）不受此分支影响。
        person_count, bodies = self.person.count(bgr)
        use_body = person_count is not None and not (person_count == 0 and (face_count or upper))
        if use_body:
            if person_count == 0:
                if bright < 25:
                    # 暗光安全网：画面整体偏暗时人体同样易漏检，不拉满，降为中置信并标注可能漏检。
                    dims["no_person"] = {"confidence": 0.70, "reason": "未检出人体，但画面偏暗(亮度%.0f)，可能漏检" % bright, "method": "body-count"}
                else:
                    dims["no_person"] = {"confidence": 0.95, "reason": "未检出人体", "method": "body-count"}
            elif person_count == 1:
                b0 = bodies[0]
                conf = min(0.99, 0.88 + b0["h_ratio"] * 0.4 + b0["score"] * 0.05)
                dims["single_person"] = {"confidence": round(conf, 4), "reason": "检出 1 人体（占图高%.0f%%）" % (b0["h_ratio"] * 100.0), "method": "body-count"}
            else:
                avg_score = sum(b["score"] for b in bodies) / len(bodies)
                conf = min(0.98, 0.88 + avg_score * 0.1)
                # >=2 人统一归多人合照（"双人照"类型已按产品决策并入多人）
                dims["group_photo"] = {"confidence": round(conf, 4), "reason": "检出 %d 人体" % person_count, "method": "body-count"}
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
