# -*- coding: utf-8 -*-
"""DetectEngine：12 维度检测编排。模型缺失时全部维度自动降级为规则/传统算法，保证离线可跑。"""
from .imaging import load_work_image, to_original, LoadError
from .face import FaceDetector
from .eyes import EyesAnalyzer
from .expression import ExpressionAnalyzer
from .landmarks import FaceLandmarkEnhancer
from .person import PersonDetector, merge_overlaps, frontal_faces, body_has_face, posed_group, foreground_bystander, POSED_FRONT_RATIO
from . import quality as Q
from .models import detect_device, _HAS_ORT

# 引擎签名（engine signature）：凡改动了会改变检测输出的公式/阈值/分支（eyes / person /
# quality / landmarks / expression 等），就把这个整数 +1。软件据此判断“库里这张结果是哪个
# 版本的引擎扫出来的”，开发版据此提示“有 N 张旧引擎结果需重扫”。它与发版号解耦：
# 纯注释性版本标签的改动不必 +1，只有真正影响检测结果的变化才动。历史 bump：
#   1 = 引入签名（此时闭眼冲突修正 + 人数数身体框已在码内，存量库首次按此值回填为“最新”）。
#   2 = 人数存疑→待确认：无人体框只凭人脸、或判单人却有≥2个够大主体时压成 low 进待确认
#       （修 7G1A7593 柯基 / 7G1A7833 百合 / 7G1A9900 拥吻 / CHEN0611 / 7G1A8030 被自信当成单人）。
#   3 = 半截头兜底不再被假脸挡掉：人体框贴顶且无 MediaPipe 确认脸→高置信半截头（修 7G1A9669 香槟塔）。
#   4 = 回退 sig3：真实转正输入复核发现 sig3 净负（只误标 4 张 faceCount=1 的手部特写/边角残脸，未修好 9669），
#       半截头兜底门槛改回 `if not faces`。全库仅那 4 张掉标，其余不动。
#   5 = “主群即主体”几何闸（POSED_DOMINANT）分母改看全图任意最大脸（含侧脸/背影）：修接亲/亲嘴
#       抓拍被当成合拍照（CHEN9581/9794/9806——全图最大的脸是背对镜头的新人，旧分母只看最大正脸以故看不见）。30 张真合影回归零误伤。
#   6 = 模糊新增“整幅运动糊”兜底分支（低全图方差 AND 低高频占比 AND 高梯度相干度 AND 无清晰主体）：
#       修 1.jpg 类相机抖动整幅拖影被分块法漏判（拖影是高对比边缘不触发“糊块”，实测只数出 3/16）。相干度闸门
#       把艺术柔焦（百合 coh=0.026）/线性构图清晰片（7G1A7374 coh=0.454）全部排除，保守零误伤。
ENGINE_SIG = 6


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
            "engineSig": ENGINE_SIG,  # 引擎签名：软件据此判定存量结果是否需用新引擎重扫
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
        # 传入全图任意最大脸高（含侧脸/背影），供“主群即主体”闸识破“真主角背对镜头”的抓拍
        _global_face_h = max((float(f["box"][3]) for f in faces), default=0.0)
        posed, posed_n, posed_fails = posed_group(frontal, w, h, _global_face_h)
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

        # --- 表情崩坏（blendshape：眼睛挤没为主，嘴/仰头佐证，侧脸降权）---
        # 不再用旧像素启发式 subfeatures（"五官不对称"正是当年侧脸误判成狰狞的元凶）。
        ugly_conf, ugly_reason = self.expr.expression_breakdown(faces)
        if face_count:
            dims["face_ugly"] = {
                "confidence": round(ugly_conf, 4),
                "reason": ugly_reason or "眼睛未挤没",
                "method": "blendshape+pose",
            }

        # --- 模糊 / 曝光 / 黑白 ---
        blur_conf, blur_reason = Q.blur_score(bgr, faces)
        dims["blur"] = {"confidence": round(blur_conf, 4), "reason": blur_reason, "method": "laplacian+fft"}
        exp_conf, exp_reason = Q.exposure_score(bgr)
        dims["exposure"] = {"confidence": round(exp_conf, 4), "reason": exp_reason, "method": "lab-histogram"}
        bw_conf, bw_reason = Q.black_white_score(bgr)
        dims["black_white"] = {"confidence": round(bw_conf, 4), "reason": bw_reason, "method": "saturation"}

        # --- 人体检测框前置：人数分类与半截头"检不到脸"安全网共用同一份结果，只跑一次 ---
        person_count, bodies = self.person.count(bgr)
        full_bodies = [b for b in bodies if b.get("filtered", True)] if person_count is not None else []
        main = merge_overlaps(full_bodies)

        # --- 半截头 ---
        hh_conf, hh_reason = Q.half_head_score(bgr.shape, faces, upper, scale, person_boxes=main)
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
        if person_count is not None:
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
            # 在场"主体人数"以人体框数为准（v2.0.78 用户实测 CHEN1192 后修正）：上一版数"够大的脸"，
            # 但人脸检测器 YuNet 会把墙上的投影、地上的宠物脸误检成一张大气质脸（CHEN1192 一张单人
            # 写真被数成 2 人 → 误判多人），而人体检测器不会被一团影子或一只狗骗到——单人照只有 1 个
            # 身体框。仅当人体整体漏检（0 框）时才退回脸数兜底，避免"两个人体全漏"被误判单人。侧身/低头都算在场。
            n_faces_big = sum(1 for f in (faces or []) if h > 0 and float(f["box"][3]) / float(h) >= 0.03)
            n_subjects = len(main) if main else n_faces_big
            if n_front >= 2:
                avg_score = sum(f["score"] for f in frontal) / n_front
                base = 0.88 + avg_score * 0.1
                who = "正面主体 %d、规整主群 %d、共在场 %d（人体 %d、脸 %d）%s" % (
                    n_front, posed_n, n_present, len(main), face_count, merge_note
                )
                # 第六道合影闸（v2.0.77 用户拍板 2026-10-14）：五道闸只评判对着镜头的那群人，看不见前景
                # 一个背对镜头的大块头。当前景背身者比整群正脸人都明显更大（更靠前）时，画面真正的主角
                # 是那个背影，这张是抓拍现场不是摆拍合影 → 降级混合照（如 DHT24780 黑西装背影占半屏）。
                fg = foreground_bystander(main, frontal)
                # 合影得在场的人里绝大多数都朝着镜头（v2.0.78 用户拍板 2026-10-14）：只数正脸会把
                # "低头办仪式/旁边有人侧身"的抓拍误判合影（DHT12399 敬茶 4 人仅 2 人朝镜头）。
                front_ratio = (n_front / n_present) if n_present else 0.0
                few_facing = front_ratio < POSED_FRONT_RATIO
                if posed and not fg and not few_facing:
                    dims["group_photo"] = {"confidence": round(min(0.98, base), 4), "reason": "摆拍合影主群：%s" % who, "method": "body-count+posed"}
                else:
                    if posed and fg:
                        fails = "前景有背身主体抢镜"
                    elif posed and few_facing:
                        fails = "在场 %d 人仅 %d 人朝镜头" % (n_present, n_front)
                    else:
                        fails = "/".join(posed_fails)
                    dims["mixed_photo"] = {"confidence": round(min(0.96, base), 4), "reason": "多人但非摆拍合影（%s）：%s" % (fails, who), "method": "body-count+posed"}
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
            elif n_front == 1 and n_subjects >= 2:
                # 检到 ≥2 个在场人体、但只有 1 张正脸（其余侧身/低头/背身）：现场至少 2 人，是多人不是单人。
                # 只有 1 张正脸 → 合影五道闸需 ≥2 正脸，过不了 → 归多人混合照（同属交付库、不进瑕疵）。
                dims["mixed_photo"] = {"confidence": 0.86, "reason": "检出 %d 个在场人体、仅 1 个正面主体（其余侧身/低头/背身），现场至少 %d 人" % (n_subjects, n_subjects), "method": "body-count"}
            elif n_front == 1:
                # 仅 1 张够大的正脸，其余是"没检到脸"的后脑/半截身（n_subjects<2）——真·单人带旁人，进待确认
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

        # 存疑→待确认（用户拍板 2026-10-14：拿不准是单人/多人/无人，一律进待确认，绝不自信误判）。
        # 命中任一即把人数维度置信压到 low(<0.55)，主进程 computeCategory 取不到可用人数标签 → 停待确认：
        #  ① 人体模型可用却一个人体框都没框到、只凭人脸喊“有人”——YuNet 会把狗脸/花蕊/器物误检成脸
        #     （实测 7G1A7593 柯基、7G1A7833 百合、7G1A9900 拥吻只拍到后脑，全被自信当成单人交付）；
        #  ② 判成单人但画面里有 ≥2 个够大的主体——贴脸/拥抱的新人常被人体框合成一大块，2 人被数成 1 人
        #     （实测 CHEN0611、7G1A8030）。这类“到底 1 个还是多个”的正是该让人过目的，交出去风险太大。
        if person_count is not None:
            _uncertain = (not main and face_count > 0) or ("single_person" in dims and n_faces_big >= 2)
            if _uncertain:
                for _pk in ("single_person", "group_photo", "mixed_photo"):
                    if _pk in dims:
                        dims[_pk]["confidence"] = 0.5
                        dims[_pk]["reason"] += "；人数存疑(无人体框/多个够大主体)→待确认"
                        break

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
