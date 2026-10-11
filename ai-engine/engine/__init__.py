# -*- coding: utf-8 -*-
"""DetectEngine：12 维度检测编排。模型缺失时全部维度自动降级为规则/传统算法，保证离线可跑。"""
from .imaging import load_work_image, to_original, LoadError
from .face import FaceDetector
from .eyes import EyesAnalyzer
from .expression import ExpressionAnalyzer
from .landmarks import FaceLandmarkEnhancer
from .person import PersonDetector, merge_overlaps, frontal_faces, body_has_face, posed_group
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
        # 正面主体（新口径的计数单位，用户拍板 2026-10-11）：正脸露脸、头部完整、双眼睁开可判
        frontal = frontal_faces(faces, h)
        # 规整摆拍主群（合影 vs 混合照的分界）：只算一次，人数分支与返回体共用同一结论
        posed, posed_n, posed_fails = posed_group(frontal, w, h)
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

        # --- 人数分类（四分类，用户拍板 2026-10-11：人数看正面主体，合影看摆拍结构）---
        # 版本号沿用注释惯例记为 v2.0.66，但 app/package.json 目前仍是 2.0.64 —— 发版时要一并抬版本。
        # V=正面主体数（正面露脸、头部完整、身躯大部分可见）；G=规整摆拍主群；
        # B=在场旁人（后脑勺/半截身/侧脸/低头/虚焦前景）；T=在场总人数。
        # 判定表：
        #   V≥2 且 G=V  → 多人合拍照（高置信）  —— 人人在同一排、紧挨着、共同看镜头
        #   V≥2 且 G<V  → 多人混合照（高置信）  —— 扎堆 / 前后多层 / 各干各的（接亲、做游戏）
        #   V=1 且 B=0  → 单人照（高置信）
        #   V=1 且 B≥1  → 单人照（中置信→待确认）—— 只有 1 人清晰，其余是旁观者
        #   V=0 且 T≥2  → 多人混合照（高置信）  —— 全是后脑勺/低头，逻辑上不可能是摆拍合影
        #   V=0 且 T=1  → 单人照（中置信→待确认）
        #   无人在场     → 无人物（保留远景小框直判/躯干/暗光/肤色旧安全网）
        # 混合照与合拍照同为中性维度、同属交付库：接亲这类情节片是要交片的，任何时候不进瑕疵。
        # v2.0.62 三组结构性误判的修法保留：拆框合并、人体漏检时脸作硬下限、远景小框不算无人物；
        # “远景小框≥2”（用户旧拍板）仍不进无人物，但不再算合影——没人在摆拍，只是环境里的观众。
        person_count, bodies = self.person.count(bgr)
        if person_count is not None:
            full_bodies = [b for b in bodies if b.get("filtered", True)]
            main = merge_overlaps(full_bodies)
            # 把“合并发生了几个框”写进 reason：下一轮校准能直接量化拆框频率与护栏是否过紧/过松
            merge_note = (
                "，人体 %d 框同列合并为 %d 人" % (len(full_bodies), len(main))
                if len(full_bodies) - len(main) > 0
                else ""
            )
            n_front = len(frontal)
            n_bystander = sum(1 for b in main if not body_has_face(b, frontal))
            n_present = max(len(main), face_count)
            others = max(n_present - n_front, n_bystander)
            if n_front >= 2:
                avg_score = sum(f["score"] for f in frontal) / n_front
                base = 0.88 + avg_score * 0.1
                who = "正面主体 %d、规整主群 %d、共在场 %d（人体 %d、脸 %d）%s" % (
                    n_front, posed_n, n_present, len(main), face_count, merge_note
                )
                if posed:
                    dims["group_photo"] = {"confidence": round(min(0.98, base), 4), "reason": "摆拍合影主群：%s" % who, "method": "body-count+posed"}
                else:
                    dims["mixed_photo"] = {"confidence": round(min(0.96, base), 4), "reason": "多人但非摆拍合影（%s）：%s" % ("/".join(posed_fails), who), "method": "body-count+posed"}
            elif n_front == 1 and others == 0:
                if main:
                    b0 = main[0]
                    conf = min(0.99, 0.88 + b0["h_ratio"] * 0.4 + b0["score"] * 0.05)
                    # 附带人体框宽高比：抱在一起/并肩的两常被检成一个大框，旧 reason 里看不到
                    # 这个形状信号，下轮校准无法量化“一个框装两个人”。本版本只做观测不改判。
                    bw0, bh0 = float(b0["box"][2]), float(b0["box"][3]) or 1.0
                    why = "正面主体 1、无旁人（人体占图高%.0f%%、框宽高比%.2f，脸 %d）%s" % (
                        b0["h_ratio"] * 100.0, bw0 / bh0, face_count, merge_note
                    )
                else:
                    # 人体零检出但检到 1 张正面脸：沿用旧 face-count 单人判据
                    conf, why = 0.985, "检出 1 张正面人脸（人体未检出）"
                dims["single_person"] = {"confidence": round(conf, 4), "reason": why, "method": "body-count"}
            elif n_front == 1:
                # 图1 那类：新娘正脸清晰 + 宾客后脑/半截前景——不够合照也不够单人，进待确认
                dims["single_person"] = {"confidence": 0.62, "reason": "仅 1 个正面主体，另有 %d 个在场者非正面（后脑/半截/侧脸/低头）" % others, "method": "body-count"}
            elif n_present >= 1:
                if n_present >= 2:
                    # 用户拍板：全是后脑勺/低头的多人画面走混合照（不再卡待确认，这类情节片可交付）
                    dims["mixed_photo"] = {"confidence": 0.86, "reason": "%d 人在场但无正面主体（全后脑/半截/低头），不可能是摆拍合影" % n_present, "method": "body-count"}
                else:
                    dims["single_person"] = {"confidence": 0.62, "reason": "1 人在场但无正面主体（后脑/半截/低头）", "method": "body-count"}
            else:
                raw_n = len(bodies)
                if raw_n >= 2:
                    dims["mixed_photo"] = {"confidence": 0.86, "reason": "检出 %d 个远景/小尺寸人影（环境观众，无人摆拍）" % raw_n, "method": "body-count"}
                elif raw_n == 1:
                    dims["single_person"] = {"confidence": 0.83, "reason": "检出 1 个远景/小尺寸人影", "method": "body-count"}
                elif upper:
                    dims["mixed_photo"] = {"confidence": 0.80, "reason": "检出 %d 个躯干但无完整人体/人脸，近景边缘人物" % len(upper), "method": "body-count"}
                elif bright < 25:
                    # 暗光安全网：画面整体偏暗时人体/人脸同样易漏检，不拉满，降为中置信并标注可能漏检。
                    dims["no_person"] = {"confidence": 0.70, "reason": "未检出人体，但画面偏暗(亮度%.0f)，可能漏检" % bright, "method": "body-count"}
                else:
                    # 肤色连通块兜底：模型零检出不等于画面里没有人（背身/侧脸/近景局部会让
                    # 人体与人脸同时失效）。取到“像人的一块皮肤”证据时不再拉满 0.95，
                    # 降为 0.62（中置信 → 待确认），把自信的错误变成看得见的可疑。
                    has_skin, skin_why = Q.skin_person_score(bgr)
                    if has_skin:
                        dims["no_person"] = {"confidence": 0.62, "reason": "人体/人脸/躯干零检出，但%s，可能漏检" % skin_why, "method": "body-count+skin"}
                    else:
                        dims["no_person"] = {"confidence": 0.95, "reason": "人体/人脸/躯干零检出（%s）" % skin_why, "method": "body-count"}
        elif face_count == 0:
            if bright < 25:
                # 暗光安全网：画面整体偏暗时人脸极易漏检，不把 no_person 拉满，
                # 降为中置信（待确认）并标注可能漏检，避免暗部人像被误判为无人物。
                dims["no_person"] = {"confidence": 0.55, "reason": "未检出人脸（检出 %d 躯干），但画面偏暗(亮度%.0f)，可能漏检" % (len(upper), bright), "method": "face-count"}
            else:
                if upper:
                    dims["no_person"] = {"confidence": 0.80, "reason": "未检出人脸（检出 %d 躯干）" % len(upper), "method": "face-count"}
                else:
                    # 人体模型不可用时的同一兜底：零人脸 + 有肤色块 = 可能漏检，不拉满
                    skin_ok, skin_why = Q.skin_person_score(bgr)
                    if skin_ok:
                        dims["no_person"] = {"confidence": 0.62, "reason": "未检出人脸，但%s，可能漏检" % skin_why, "method": "face-count+skin"}
                    else:
                        dims["no_person"] = {"confidence": 0.97, "reason": "未检出人脸（检出 0 躯干）", "method": "face-count"}
        else:
            # 人体模型不可用 → 人脸计数回落，合影/混合的分界同样走 posed_group
            n_front = len(frontal)
            if n_front >= 2:
                if posed:
                    dims["group_photo"] = {"confidence": 0.975, "reason": "检出 %d 张正面人脸且构成摆拍主群（共 %d 脸）" % (posed_n, face_count), "method": "face-count+posed"}
                else:
                    dims["mixed_photo"] = {"confidence": 0.93, "reason": "检出 %d 张正面人脸但非摆拍合影（%s，共 %d 脸）" % (n_front, "/".join(posed_fails), face_count), "method": "face-count+posed"}
            elif n_front == 1 and face_count == 1:
                dims["single_person"] = {"confidence": 0.985, "reason": "检出 1 张正面人脸", "method": "face-count"}
            elif n_front == 1:
                dims["single_person"] = {"confidence": 0.62, "reason": "1 张正面脸，另有 %d 张侧脸/低头在场" % (face_count - 1), "method": "face-count"}
            elif face_count >= 2:
                dims["mixed_photo"] = {"confidence": 0.86, "reason": "检出 %d 张脸但均非正面（低头/大角度），不可能是摆拍合影" % face_count, "method": "face-count"}
            else:
                dims["single_person"] = {"confidence": 0.62, "reason": "检出 1 张脸但非正面（低头/大角度）", "method": "face-count"}

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
            # 正面主体数：连拍一致化（personHarmony）与校准重放的计数单位，旧版主进程无此字段时自动忽略
            "frontalCount": len(frontal),
            # 规整摆拍主群人数：≥2 时引擎才给出合影/混合的结构判定，供校准重放量化阈值切点
            "posedCount": posed_n,
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
