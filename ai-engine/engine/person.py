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


def face_pose(f):
    """用五点关键点算尺度不变的两个姿态比，返回 (yaw, pitch)；关键点不够或双眼重合时返回 None。
    - 偏航 yaw = |鼻尖x - 眼中点x| / 眼距：正脸≈0，明显侧脸 >0.30
    - 俯角 pitch = (鼻尖y - 眼中点y) / 脸框高：正脸≈0.12~0.35，低头时鼻尖压向眼睛 <0.06
    frontal_faces 与 posed_group 共用，避免同一套几何在两处各算一遍、阈值飘移。"""
    lm = f.get("landmarks5")
    x, y, w, h = f["box"]
    if not lm or len(lm) < 3 or h < 1:
        return None
    le, re, nose = lm[0], lm[1], lm[2]
    eye_dist = abs(re[0] - le[0])
    if eye_dist < max(2.0, w * 0.12):
        return None
    yaw = abs(nose[0] - (le[0] + re[0]) / 2.0) / eye_dist
    pitch = (nose[1] - (le[1] + re[1]) / 2.0) / h
    return yaw, pitch


def frontal_faces(faces, img_h):
    """从人脸检出结果里筛“正面主体”（用户拍板 2026-10-11 的新口径）：
    人数只数正面露脸的人——后脑勺/半截身/虚焦前景/低头侧脸都算“在场”
    但不进人数。判据：
    - 脸占图高 <3%：关键点不可靠，不算主体（仍算在场）；脸框贴顶：头部不完整（半截头）不算
    - 姿态比见 face_pose：yaw ≤ 0.30 且 pitch ≥ 0.06
    返回原 face dict 的子集列表，不改任何字段。"""
    out = []
    if img_h <= 0:
        return out
    for f in faces or []:
        x, y, w, h = f["box"]
        if h / float(img_h) < 0.03 or y < 0.005 * img_h:
            continue
        pose = face_pose(f)
        if pose is None:
            continue
        if pose[0] <= 0.30 and pose[1] >= 0.06:
            out.append(f)
    return out


# 规整摆拍主群的五道几何闸（阈值按用户真实婚礼样图反推）。它们是冻结引擎里的码内常量，
# 改动必须重建引擎并全库重筛才生效；reason 里会带出“未通过哪一道闸”，
# 校准时直接按它统计各闸的拦截量就知道该松哪一道，不必猜。
POSED_H_RATIO = 2.0     # 1 同纵深：簇内最大脸高 / 最小脸高
# （原"2 成一排"POSED_ROW_STD 已在 v2.0.78 移除：合影允许前排蹲后排站的错落站位，用户实测 7G1A8818）
POSED_GAP_RATIO = 1.5   # 3 紧挨着：按 x 排序后净间距中位数 / 平均脸宽（v2.0.77 由 1.3 放宽到 1.5：
                        #   新人并肩自然站位中间常留 ~1.4 个脸宽的缝，1.3 会把这些正常合影误降级成混合照）
POSED_MAX_YAW = 0.24    # 4 共同面向：簇内最大 yaw（比正面主体闸 0.30 更严——看镜头是摆拍的强信号）
POSED_DOMINANT = 0.55   # 5 主群即主体：簇内最大脸高 / 全图最大脸高
POSED_FRONT_RATIO = 0.6 # 7 合影得绝大多数人朝镜头（v2.0.78 用户拍板 2026-10-14，在 __init__.py 判定）：
                        #   正面主体数 / 在场总人数 < 此线 → 是抓拍不是摆拍合影（DHT12399 敬茶仅 2/4 朝镜头）


def posed_group(frontal, img_w, img_h):
    """在“≥2 个正面主体”的前提下，回答“这是不是一张摆拍合影”。
    用户拍板 2026-10-11：合影 = 人人在同一纵深平面、横向并排紧贴、共同面向镜头（沙发全家福、
    伴娘团、双人摆拍）；接亲/做游戏那种人物扎堆、前后多层、各干各的 = 多人混合照。

    先选“同纵深主群”：以每张脸为种子，取脸高落在种子 0.5~2 倍内的同伴数，选同伴最多的那簇。
    这样“后排一排伴娘”不会被前排一张虚焦大脸带偏（巨脸零同伴，当不了种子）。
    然后这簇要五道闸全过才算合影，任一不过返回未通过的闸名（写进 reason 供下轮校准量化）。
    返回 (is_posed, 主群人数, 未通过的闸名列表)。"""
    if len(frontal or []) < 2 or img_w <= 0 or img_h <= 0:
        return False, 0, ["正面主体不足2"]
    hs = [float(f["box"][3]) for f in frontal]
    best = []
    for i in range(len(frontal)):
        if hs[i] <= 0:
            continue
        peers = [j for j in range(len(frontal)) if 0.5 <= hs[j] / hs[i] <= 2.0]
        if len(peers) > len(best):
            best = peers
    group = [frontal[j] for j in best]
    if len(group) < 2:
        return False, len(group), ["无同纵深主群"]

    gh = [float(f["box"][3]) for f in group]
    gw = [float(f["box"][2]) for f in group]
    cx = [f["box"][0] + f["box"][2] / 2.0 for f in group]
    mean_h = sum(gh) / len(gh)
    mean_w = sum(gw) / len(gw)
    fails = []
    if max(gh) / max(1e-6, min(gh)) > POSED_H_RATIO:
        fails.append("纵深差异大")
    # （原"成一排"闸已移除：脸的竖直中心方差会把前排蹲后排站的正常合影误杀，用户实测 7G1A8818）
    order = sorted(range(len(group)), key=lambda k: cx[k])
    xs = [cx[k] for k in order]
    ws = [gw[k] for k in order]
    if len(xs) > 1:
        # 用相邻间距的“中位数”而非“最大值”（v2.0.74 修）：规矩合影常两两凑近、中间留一道缝
        # （全家福里父母与子女各抱一团、伴娘团贴一侧），旧版取最大缝会把这种一票否决成
        # “人物散落”（实测流水账 3 张纯合影只栽这一道闸）。中位数只认典型邻里间距，一道离群
        # 大缝不影响；真·四散（接亲游戏多数间距都大）中位数仍高，照样拦。v2.0.77 阈值由 1.3 放宽到 1.5
        # （用户实测 DHT12489：新人并肩自然站位净距 1.38 脸宽，被 1.3 一票否决成"散落不成群"）。
        gaps = sorted(
            ((xs[k + 1] - xs[k]) - (ws[k] + ws[k + 1]) / 2.0) / max(1e-6, mean_w)
            for k in range(len(xs) - 1)
        )
        mid = len(gaps) // 2
        gap_ratio = gaps[mid] if len(gaps) % 2 else (gaps[mid - 1] + gaps[mid]) / 2.0
        if gap_ratio > POSED_GAP_RATIO:
            fails.append("人物散落不成群")
    yaws = []
    for f in group:
        p = face_pose(f)
        if p is not None:
            yaws.append(p[0])
    if yaws and max(yaws) > POSED_MAX_YAW:
        fails.append("未共同面向镜头")
    if max(gh) / max(1e-6, max(hs)) < POSED_DOMINANT:
        fails.append("画面主体在簇外")
    return (not fails), len(group), fails


def body_has_face(body, faces):
    """正面脸是否属于这个人体框：脸中心落在框内（垂直允许在框上方一张脸的高度——
    头常常在人体框外），且不超过框顶往下 70%（脸不会在膝盖以下）。"""
    bx, by, bw, bh = body["box"]
    for f in faces:
        fx, fy, fw, fh = f["box"]
        cx, cy = fx + fw / 2.0, fy + fh / 2.0
        if bx <= cx <= bx + bw and by - fh <= cy <= by + bh * 0.7:
            return True
    return False


POSED_FOREGROUND_RATIO = 1.2  # 6 无背身前景抢镜：某个"不含正脸的人体"(背身/侧身没拍到脸) 的占图高，
                              #   超过对着镜头那群人最大占图高的 1.2 倍时，说明真正的主角是这个背影，不算摆拍合影。
                              #   倍数 1.2 留缓冲（用户实测 DHT24780：黑西装背影占图高 0.77、后面 3 个伴娘最大 0.51、
                              #   比值 1.50 → 降级混合照；而正常合影边角宾客背影最大比值仅 0.69，不误伤）。


def foreground_bystander(main, frontal):
    """是否存在"抢镜的背身前景人"：有一个不含正脸的人体框，其占图高 > 含正脸人体最大占图高 × POSED_FOREGROUND_RATIO。
    合影五道闸只评判对着镜头的那群人，看不见前景一个背对镜头的大块头；当这个背影比整群正脸人都明显更大
    （更靠前）时，画面真正的主角是那个背影，这张是抓拍现场而非摆拍合影（用户 2026-10-14 拍板：抢镜才降级）。"""
    group_h = [b["h_ratio"] for b in main if body_has_face(b, frontal)]
    bys_h = [b["h_ratio"] for b in main if not body_has_face(b, frontal)]
    if not group_h or not bys_h:
        return False
    return max(bys_h) > max(group_h) * POSED_FOREGROUND_RATIO


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
