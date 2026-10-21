# -*- coding: utf-8 -*-
"""画质/规则维度：
- 画面模糊：Laplacian 方差初筛 + 分区域二次验证（双验证思想），纯 CPU
- 曝光异常：Lab 色彩空间亮度/高光/暗部/对比度规则，毫秒级
- 黑白照：饱和度规则（绝大多数像素 R≈G≈B）
- 半截头：人脸框贴边 + 躯干有头无 + 关键点完整性三验证思想
- 重复/连拍：DCT 感知哈希（供主进程跨图聚类），可选人脸/图像嵌入 ONNX
"""
import math

import cv2
import numpy as np

from .models import OnnxSession


def _sigmoid(z):
    return 1.0 / (1.0 + math.exp(-z))


# ---------- 画面模糊 ----------

def blur_score(bgr, faces):
    """只判大面积、完全看不清的模糊（用户口径：占图一半以上、完全看不清才算；局部晕光/
    小部分聚焦模糊/背景虚化不算）。v2.0.64 真值：旧版用"最差脸 ROI 方差"，一张脸稍糊就标，
    用户删除(FP 476) vs 保留(TP 322)两群的方差分布完全重叠(min 都 0、中位 4~6)，调阈值无解——
    本版换信号维度：整图 4x4 分块统计"有内容但糊"的面积占比，并要求主体(脸)也不清晰：
    - 背景虚化(大光圈人像)：脸区清晰 → 封顶待确认，不进模糊分类
    - 局部失焦/晕光：糊块占比低 → sigmoid 压到不标
    - 整图糊到看不清：糊块过半且脸也糊 → 高置信
    v2.0.74 口径回正（用户："占一半以上、完全看不清就算"）：旧中心 0.55/宽 0.12 下
    62% 糊面积只得 0.59——低于档位线不标，90%+ 也永不到 high（0.90 封顶）。实测 6127 条流水账
    用户从未修正过模糊维度（零 FP 证据），改中心 0.52/宽 0.08/封顶 0.95：50%≈不标（临界），
    62%→0.79（标），75%+→0.89（确定档）。"脸清晰封顶"门保留，背景虚化仍不误伤。"""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    if max(h, w) > 900:
        s = 900.0 / max(h, w)
        gray = cv2.resize(gray, None, fx=s, fy=s)
    H, W = gray.shape
    full_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    # 4x4 分块：每块测 Laplacian 方差 + 灰度动态范围，区分"糊"与"平坦无纹理"(天空/纯色墙)
    GRID = 4
    bh, bw = max(1, H // GRID), max(1, W // GRID)
    blurry_blocks = detail_blocks = 0
    for gy in range(GRID):
        for gx in range(GRID):
            blk = gray[gy * bh:(gy + 1) * bh, gx * bw:(gx + 1) * bw]
            if blk.size < 100:
                continue
            if float(blk.max()) - float(blk.min()) < 12:  # 平坦块：无内容，不计入分母
                continue
            detail_blocks += 1
            if float(cv2.Laplacian(blk, cv2.CV_64F).var()) < 25.0:  # 有内容但糊
                blurry_blocks += 1
    blur_ratio = blurry_blocks / detail_blocks if detail_blocks else 0.0
    # 主体门：有脸取脸区平均方差（非最差），脸清晰=背景虚化不是废片
    face_var = None
    if faces:
        fv = []
        for f in faces[:4]:
            x, y, fw, fh = f["box"]
            crop = gray[int(y):int(y + fh), int(x):int(x + fw)]
            if crop.size > 200:
                fv.append(float(cv2.Laplacian(crop, cv2.CV_64F).var()))
        if fv:
            face_var = sum(fv) / len(fv)
    # v2.0.76 主体感知门槛：默认仍按用户口径"糊了大半（>52%）才算"。但"有脸且脸很软"
    # （face_var<30，主体本身没对上焦/运动糊）时，把起分线降到 35%——这样 7G1A9042 这类
    # "糊块 44% + 脸区方差 25"的偏糊片置信度升到 0.72，能越过自学习抬高后的实际模糊门槛
    # （tunedThresholds.blur 中档 0.62）进待确认打上模糊标签；无脸/背景虚化的照片仍走 52%
    # 保守线（实测对当前库零误伤：唯一 40~52% 区间的干净片都是无脸的 7G1A7374/7376，不受影响）。
    center = 0.35 if (face_var is not None and face_var < 30.0) else 0.52
    conf = 0.95 * _sigmoid((blur_ratio - center) / 0.08)
    if face_var is not None and face_var > 30.0:
        conf = min(conf, 0.50)  # 主体清晰（背景虚化）：封顶只进待确认，不直接判模糊
    # ---- 整幅运动糊兜底分支（修 1.jpg 类漏判）----
    # 分块法对"相机抖动把整幅拖影"是反向失效的：拖影是高对比边缘，块方差 >25 不被计为糊块
    # （实测 1.jpg 只数出 3/16 糊块=19%），且清晰片的暗背景块反而数出更多糊块。运动糊的本质
    # 签名是"有方向的拖影"——梯度方向高度集中(相干度高)；而艺术柔焦/失焦是各向同性软(相干度低)、
    # 背景虚化有清晰主体。故本分支要求五个条件同时成立才判糊，任一不满足即不触发（保守零误伤）：
    #   ① 画面有内容(detail_blocks≥12) ② 无清晰主体(face_var 为空或≤60) ③ 全图偏软(full_var)
    #   ④ FFT 高频占比低(hp) ⑤ 梯度相干度高(coh)——这条是关键闸门，把柔焦/暗场/线性构图全排除。
    if detail_blocks >= 12 and (face_var is None or face_var <= 60.0):
        hp = _highpass_ratio(gray.astype(np.float32))
        coh = _coherence(gray)
        gate_var = _sigmoid((140.0 - full_var) / 22.0)   # 全图方差越低越像糊（1.jpg=107→0.82）
        gate_hp = _sigmoid((0.58 - hp) / 0.02)            # 高频越少越像糊（1.jpg hp=0.531→0.92）
        gate_coh = _sigmoid((coh - 0.50) / 0.04)         # 拖影方向越一致越像运动糊（1.jpg coh=0.598→0.92；柔焦百合 coh=0.026→~0）
        soft_conf = 0.95 * min(gate_var, gate_hp, gate_coh)
        conf = max(conf, soft_conf)
    conf = float(np.clip(conf, 0, 0.99))
    return conf, "模糊面积占比 %.0f%%(%d/%d块) 全图方差 %.0f 脸区方差 %s" % (
        blur_ratio * 100.0, blurry_blocks, detail_blocks, full_var,
        ("%.0f" % face_var) if face_var is not None else "无脸")


def _highpass_ratio(gray):
    f = np.fft.fftshift(np.fft.fft2(gray.astype(np.float32)))
    mag = np.abs(f)
    h, w = mag.shape
    cy, cx = h // 2, w // 2
    r = int(min(h, w) * 0.12)
    yy, xx = np.ogrid[:h, :w]
    center = ((yy - cy) ** 2 + (xx - cx) ** 2) <= r * r
    total = mag.sum() + 1e-6
    return float((mag[~center].sum()) / total)


def _coherence(gray):
    """梯度相干度（结构张量主方向一致性），0~1。运动糊把边缘拉成同向拖影 → 高；
    散景/失焦/艺术柔焦是各向同性软 → 低；清晰片纹理方向分散 → 低。只反映"方向"不反映
    "清不清"，故须与全图方差/高频占比联合使用。"""
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    Jxx = float((gx * gx).mean())
    Jyy = float((gy * gy).mean())
    Jxy = float((gx * gy).mean())
    return float(np.sqrt((Jxx - Jyy) ** 2 + 4 * Jxy * Jxy) / (Jxx + Jyy + 1e-6))


# ---------- 曝光异常 ----------

# MediaPipe FaceMesh 外轮廓（闭合环），用来把人脸从背景里抠出来
_FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365,
              379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93,
              234, 127, 162, 21, 54, 103, 67, 109]


def _face_region(shape, face):
    """脸区掩膜：有 478 点用外轮廓，没有就退回脸框中央（避开头发和背景）。"""
    h, w = shape
    mask = np.zeros((h, w), np.uint8)
    pts = (face.get("mp") or {}).get("landmarks")
    if pts and len(pts) >= 468:
        poly = np.array([pts[i] for i in _FACE_OVAL if i < len(pts)], np.float32)
        if len(poly) >= 3:
            cv2.fillPoly(mask, [cv2.convexHull(poly).astype(np.int32)], 1)
    if int(mask.sum()) < 50:
        x, y, fw, fh = [int(v) for v in face["box"]]
        x0 = int(max(0, x + 0.18 * fw))
        y0 = int(max(0, y + 0.22 * fh))
        x1 = int(min(w, x + 0.82 * fw))
        y1 = int(min(h, y + 0.80 * fh))
        if x1 > x0 and y1 > y0:
            mask[y0:y1, x0:x1] = 1
    return mask.astype(bool)


def _face_exposure(L, faces):
    """主脸（面积最大）的亮度、死白/死黑占比。

    死白/死黑取“够大的脸”（≥0.2% 图面积）里最严重的一张：迎光那张脸爆掉就说明整组
    人像的曝光有问题，不能只看主脸。

    v2.0.107：额外返回主脸的“脸轮廓掩膜占比”和“是否有 478 点”。脸框(box)大小会随输入
    分辨率/压缩而变——同一张图原图直跑与 2000px 缓存（软件真实输入，竖拍图必经）能差 30%，
    真目标 7G1A9045/9046 在真实口径下框占比只有 0.085/0.090，而车窗过曝误报 CHEN0035 是
    0.112，用框占比判会判反。轮廓凸包面积是真实脸面积，与分辨率无关。"""
    if not faces:
        return None
    h, w = L.shape
    rows = []
    boxes = sorted(faces, key=lambda f: -float(f["box"][2]) * float(f["box"][3]))[:6]
    for f in boxes:
        m = _face_region((h, w), f)
        n = int(m.sum())
        if n < 30:
            continue
        vals = L[m]
        x, y, fw, fh = [float(v) for v in f["box"]]
        has_mp = bool((f.get("mp") or {}).get("landmarks"))
        rows.append((fw * fh / float(w * h), float(np.median(vals)),
                     float((vals >= 95).mean()), float((vals <= 12).mean()),
                     n / float(w * h), has_mp))
    if not rows:
        return None
    rows.sort(key=lambda r: -r[0])
    main = rows[0]
    big = [r for r in rows if r[0] >= 0.002] or [main]
    return (main[0], main[1], max(r[2] for r in big), max(r[3] for r in big),
            main[4], main[5])


def _white_blob(L):
    """最大死白块（L≥97）的面积占比、块内纹理、外环亮度。"""
    white = (L >= 97).astype(np.uint8)
    white = cv2.morphologyEx(white, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    num, labels, stats, _ = cv2.connectedComponentsWithStats(white, 8)
    if num <= 1:
        return 0.0, 0.0, 0.0
    i = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    frac = float(stats[i, cv2.CC_STAT_AREA]) / float(L.size)
    if frac < 0.01:
        return frac, 0.0, 0.0
    m = labels == i
    gx = cv2.Sobel(L, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(L, cv2.CV_32F, 0, 1, ksize=3)
    tex = float(cv2.magnitude(gx, gy)[m].mean())
    ring = cv2.dilate(m.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool) & ~m
    return frac, tex, float(L[ring].mean()) if ring.any() else 0.0


def exposure_score(bgr, faces=None):
    """只判严重曝光异常（用户口径：灯光/太阳/光晕大面积影响整幅画面感才算）。
    v2.0.62 真实分布：旧规则"画面偏暗→欠曝"在婚礼暗环境里高置信 682 张中 452 张被用户
    判掉（TP/FP 亮度分布完全重叠不可分），本版彻底删掉"偏暗即曝光"：
    - 过曝：两条证据任一即可——①光晕洗白全图（高光≥~30% 且整体极亮）；②大面积爆掉本身
      （高光≥~26%，亮度均值只做轻门控防死黑误入）——v2.0.74 新增：旧版只认①，
      婚礼现场大面积光晕+下半身深色（均值被拖到 ~73）整批漏判，实测零 FP 证据后放宽
    - 欠曝：只认死黑丢细节（均值≤~6 且暗部占比≥~90%），普通夜景/室内暗光不标
    - 对比度塔缩：封顶 0.5，永不直接进分类

    v2.0.75 婚礼跟拍补充（只动本维度；人脸/白块信号不被其他维度读取）——全库 3190 张
    成品图校准，新增判据全部取在“正常白纱/夜景/暗调人像”分布之外：
    - 过曝：①全图死白（L≥98 占≥20% 且均值≥70）；②逆光/大面积光晕（高光≥4%、均值 55~70，
      且最大纯白块 1.5%~8%、块内纹理≤0.70、外环≥85）。纹理与块面积两门是分开“光晕”与
      “白纱/白桌布/百合”的关键：光晕内部极平滑，织物/花瓣有明显褶边梯度。全库只命中 16 张，
      其中 4 张是用户曝光标签帧的同场景连拍，无一张正常交付片；③特写里的小块纯白
      （花冠/灯串：1.5%~3.5%、块内纹理≤1.2、外环≥85，且脸本身正常、主脸占画面≥10%）
    - ③的“主脸≥10%”闸门是必须的：全库 3190 张实测，真事故 7G1A9045/9046 是 12.8%/13.1%，
      下一个候选断崖跌到 8.8%，中景/群拍的白衬衫(CHEN9464)、闪光灯白纱(CHEN1088)、
      秀禾服亮片反光(CHEN0012) 全在 5% 以下；不卡这道门，11 张命中里 9 张是误报
    - 已知不做：人脸偏暗、整脸死白、无脸暗主体三条都试过并放弃——全库实测它们与
      “用户保留下来的暗调人像 / 撒花盖脸 / 暗场艺术照”分布完全重叠（撒花瓣误报 10+ 张、
      暗主体误报 7 张 library），收紧阈值会同时丢掉真问题，不是可调参数问题

    v2.0.107 ③的闸门改为“脸轮廓占比”：旧版用脸框(box)占比≥0.10，而框大小随输入分辨率/
    压缩波动很大——同一张图原图直跑与 2000px 缓存（竖拍图必经，EXIF 旋转才会产生缓存）
    能差 30%。真实链路复测：真目标 7G1A9045/9046 的框占比只有 0.090/0.085（旧版 0.10 闸门
    直接漏掉），而误报 CHEN0035（新娘抱上婚车，右下车窗大片过曝）是 0.112——旧闸门在
    真实输入下恰好判反。改用 FaceMesh 478 点凸包占图面积（真实脸面积，与分辨率无关）：
    真目标 0.081/0.083，有 478 点的下一名只有 0.032，断崖 2 倍，取几何中点 0.05 做闸门。
    无 478 点时 _face_region 只能退回脸框中央一小块，面积不可比 → 保守不判（不标）。"""
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2Lab)
    L = lab[:, :, 0].astype(np.float32) * (100.0 / 255.0)
    mean = float(L.mean())
    std = float(L.std())
    hi_ratio = float((L >= 96).mean())
    hi98 = float((L >= 98).mean())
    lo_ratio = float((L <= 6).mean())
    over = _sigmoid((hi_ratio - 0.30) / 0.07) * _sigmoid((mean - 80) / 6)
    # 大面积光晕独立成判：爆掉像素≥~26% 就是"大面积"本身，不再要求全图极亮
    # （深色礼服/暗背景会把均值拖低，旧版因此漏判整批光晕片）；均值轻门控防死黑图误入
    over = max(over, _sigmoid((hi_ratio - 0.26) / 0.06) * _sigmoid((mean - 40) / 8))
    # 欠曝极严（v2.0.64 真值）：旧版 lo_ratio≥0.88 即判欠曝，误杀 72 张夜景/暗场（它们 mean 1~4
    # 但 std 5~15 有灯光细节）。用户口径"夜晚灯光/舞台/正常环境光不算"——新增"无任何高光
    # (hi_ratio≈0) 且对比塔缩(std 低)"两门，只留真·死黑丢光废片。
    under = _sigmoid((3.0 - mean) / 1.0) * _sigmoid((0.01 - hi_ratio) / 0.005) * _sigmoid((4.0 - std) / 1.5)
    flat = _sigmoid((6.5 - std) / 2.0) * 0.5  # 对比度塔缩只作参考，封顶 0.5 低于各档 mid 阈值附近

    notes = []
    if hi98 >= 0.20 and mean >= 70:
        over = max(over, 0.92)
        notes.append("全图死白%.0f%%" % (hi98 * 100))
    elif hi98 >= 0.04 and 55.0 <= mean <= 70.0:
        # 逆光/光晕：必须同时满足“块够平滑 + 块不铺满画面”，否则白纱/白桌布/百合会混进来
        frac, tex, ring = _white_blob(L)
        if 0.015 <= frac <= 0.08 and tex <= 0.70 and ring >= 85:
            over = max(over, 0.66)
            notes.append("逆光光晕%.0f%%" % (hi98 * 100))

    face = _face_exposure(L, faces or [])
    if face:
        _face_area, face_med, _face_blow, _face_black, face_mask, face_mp = face
        # 特写里的小块纯白（头花/灯串）：脸本身正常也要标。必须是真特写（脸轮廓≥5% 画面），
        # 否则白衬衫、闪光灯白纱、亮片反光都会被当成“头花”——实测它们全在 3.3% 以下。
        if face_mp and face_mask >= 0.05 and hi98 >= 0.015 and face_med >= 45 and mean <= 40:
            frac, tex, ring = _white_blob(L)
            if 0.015 <= frac <= 0.035 and tex <= 1.2 and ring >= 85:
                over = max(over, 0.72)
                notes.append("特写死白块%.1f%%" % (frac * 100))

    conf = float(np.clip(max(over, under, flat), 0, 0.99))
    direction = "过曝" if over == max(over, under, flat) else ("欠曝" if under == max(over, under, flat) else "对比度异常")
    reason = "亮度均值 %.1f std %.1f 高光 %.2f 暗部 %.2f -> %s" % (mean, std, hi_ratio, lo_ratio, direction)
    if notes:
        reason += "（%s）" % "/".join(notes)
    return conf, reason


def mean_brightness(bgr):
    """Lab 的 L 通道均值（0-100），供上层判断画面是否整体偏暗（人脸漏检风险）。"""
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2Lab)
    return float(lab[:, :, 0].astype(np.float32).mean() * (100.0 / 255.0))


# ---------- 肤色连通块（"无人物"零检出兜底） ----------

_SKIN_MIN_BLOB = 0.02   # 最大肤色连通块 ≥2% 图面积，才算"那块地方站着个人"
_SKIN_MAX_BLOB = 0.45   # 超过 45% 是木地板/米色墙/桌布这类大面积同色背景，不是人
_SKIN_MIN_EXTENT = 0.45  # 块面积 / 外接矩形面积：脸+颈+手是实心团块，散碎纹理达不到


def skin_person_score(bgr):
    """YCrCb 肤色阈值 → 开/闭运算 → 连通块统计，返回 (是否有人肤色证据, 说明)。

    为什么需要：v2.0.62 取证 157 张 no_person 高置信里大量实为漏检——背身/侧脸/近景只拍到
    身体局部时，人体框与人脸会同时零检出，旧分支直接给 0.95 把图钉死在"无人物场景"相册。
    肤色块是比神经网络更"笨"但更难被骗的证据。用途被严格限制：只把自信的 0.95 降为
    0.62（中置信 → 待确认），永不反向断言"这里有人"，也不参与人数判定。"""
    try:
        h, w = bgr.shape[:2]
        if h <= 0 or w <= 0:
            return False, "图像尺寸异常"
        s = 320.0 / max(h, w)
        small = cv2.resize(bgr, (max(2, int(w * s)), max(2, int(h * s)))) if s < 1.0 else bgr
        ycrcb = cv2.cvtColor(small, cv2.COLOR_BGR2YCrCb)
        mask = cv2.inRange(ycrcb, (0, 133, 77), (255, 173, 127))
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
        num, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        tot = float(small.shape[0] * small.shape[1]) or 1.0
        if num <= 1:
            return False, "无肤色块"
        areas = stats[1:, cv2.CC_STAT_AREA].astype(np.float32)
        i = int(np.argmax(areas))
        ratio = float(areas[i]) / tot
        box_area = float(stats[1 + i, cv2.CC_STAT_WIDTH] * stats[1 + i, cv2.CC_STAT_HEIGHT]) or 1.0
        extent = float(areas[i]) / box_area
        if ratio < _SKIN_MIN_BLOB or ratio > _SKIN_MAX_BLOB or extent < _SKIN_MIN_EXTENT:
            return False, "肤色块 %.1f%%/紧实度 %.2f 不成形" % (ratio * 100.0, extent)
        return True, "肤色连通块占图 %.1f%%（紧实度 %.2f）" % (ratio * 100.0, extent)
    except Exception as e:  # noqa: BLE001
        return False, "肤色检测不可用(%s)" % type(e).__name__


# ---------- 黑白照 ----------

def black_white_score(bgr):
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    S = hsv[:, :, 1].astype(np.float32)
    small = S.shape
    if max(small) > 700:
        s = 700.0 / max(small)
        S = cv2.resize(S, None, fx=s, fy=s)
    mean_s = float(S.mean())
    low_ratio = float((S <= 18).mean())
    conf = _sigmoid((0.92 - low_ratio) / -0.035) * _sigmoid((22 - mean_s) / 5)
    conf = float(np.clip(conf, 0, 0.995)) if low_ratio > 0.8 else float(np.clip(_sigmoid((0.90 - low_ratio) / -0.02) * 0.5, 0, 0.4))
    return conf, "饱和度均值 %.1f，低饱和像素占比 %.3f" % (mean_s, low_ratio)


# ---------- 半截头 ----------

def half_head_score(bgr_shape, faces, upper_bodies, scale, person_boxes=None):
    """半截头：头部被画面边缘裁掉。
    模型（按用户提供的"贴边检测"实现，替换掉原"头部余量反推"）：以 478 landmark 外接框
    （归一化 0~1）判是否触碰画面边缘，并用脸高/脸宽占比过滤背景小脸，避免远景路人误报。
    - FACE_MIN_SIZE：脸高归一化低于此值视为背景人物，完全跳过（不参与任何判定）
    - CROP_MIN_FACE：脸高/脸宽占比低于此值即使贴边也不算半截头（单人特写里小脸贴边是正常构图）
    - EDGE_MARGIN：贴边阈值（归一化，约占图 1.2%）
    置信度按"越贴边越高"：crop_conf = 1 - edge_dist/(EDGE_MARGIN*3)，clamp 到 [0,0.98]。
    输入优先用 face["mp"]["bbox"]（478 外接框，像素）；mediapipe 关闭/未挂载时回落 YuNet 脸框作代理。
    另保留两条与"贴边"正交的躯干安全网（有身子无头 / 躯干多于人脸）——它们不属于被替换的余量反推，
    且覆盖"头完全出框只剩躯干"的真实半截场景；如需 100% 字面移植可去掉。
    人脸检不到时的身体安全网（用户拍板 2026-10-14："半脸也算半截头"）：花束遮挡/侧头/低头导致
    YuNet 检不到脸时，贴边主模型没有原料；改用人体检测框（mediapipe，比 HOG 躯干可靠）——
    主体人身框够大且上缘贴画布顶边 → 头顶必已出框，判半截头。
    person_boxes 为 merge_overlaps 后的主框列表（工作图坐标 dict，含 "box"/"h_ratio"），None/空则跳过。
    本函数只读 faces/upper/person_boxes，不改任何人脸维度输入。
    """
    H, W = bgr_shape[:2]
    EDGE_MARGIN = 0.012    # 贴边阈值（归一化，约占图宽 1.2%）
    CROP_MIN_FACE = 0.12   # 脸高/脸宽占图低于此值不算半截头（防小脸误报）
    FACE_MIN_SIZE = 0.06   # 脸高低于此值视为背景人物，完全跳过
    FACE_MAX_SUBJECT = 0.28  # 脸占图高超过此值=近景特写：贴边多为构图（框到边≠头被裁）。
                             # v2.0.64 真值：用户删除的半截头误检脸占比中位 30%，保留的判对中位 18%，
                             # 分离清晰——大脸特写贴边降为待确认，不直接判半截头（不改动贴边主模型）。
    FACE_TRUST = 0.72        # 无 478 关键点确认的脸，YuNet 分数低于此视为不可信（多为运动糊块/花束/手被误当脸）
    UNTRUSTED_CAP = 0.60     # 不可信脸能把半截头顶到的上限（压在 mid 线 0.7 以下 → 落 low，不算半截头）
    reasons = []
    conf = 0.0

    def bump(c, msg):
        nonlocal conf
        if c > conf:
            conf = c
            reasons[:] = [msg]

    if W <= 0 or H <= 0:
        return 0.0, "头部完整"
    for f in faces:
        mp = f.get("mp") or {}
        bbox = mp.get("bbox") or f.get("box")  # 优先 478 外接框(像素)，回落 YuNet 脸框
        if not bbox:
            continue
        x = bbox[0] / W
        y = bbox[1] / H
        bw = bbox[2] / W
        bh = bbox[3] / H
        if bh < FACE_MIN_SIZE:
            continue  # 背景路人：完全跳过，不参与任何判定
        is_large = (bh > CROP_MIN_FACE or bw > CROP_MIN_FACE)
        touch = (
            x < EDGE_MARGIN or
            y < EDGE_MARGIN or
            x + bw > 1 - EDGE_MARGIN or
            y + bh > 1 - EDGE_MARGIN
        )
        if not (is_large and touch):
            continue
        edge_dist = min(x, y, 1 - x - bw, 1 - y - bh)  # 到最近边缘距离（贴边时 < EDGE_MARGIN）
        crop_conf = max(0.0, min(0.98, 1.0 - edge_dist / (EDGE_MARGIN * 3)))
        # 假脸闸门（v2.0.112，用户实测 7G1A9042 / 7G1A7410）：一张脸若【没有 478 关键点确认】
        # 且【YuNet 弱检出（score<FACE_TRUST）】，它多半是运动糊块 / 花束 / 手被误认成的"脸"
        # （7G1A9042 左下角那张 score=0.669、与真新娘 IoU=0 的假脸把半截头顶到 0.98），
        # 或躺姿大特写里额头刚擦到边的检测噪声（7G1A7410 score=0.646）。这类不可信脸不足以单独
        # 把照片判成半截头，压到 mid 线以下。真被裁的边缘头（1083=0.898/9657=0.891/1073=0.812…
        # 及一切有 MediaPipe 关键点确认的裁脸）不受此闸门影响，照常判。
        if not mp.get("bbox") and float(f.get("score", 0)) < FACE_TRUST:
            crop_conf = min(crop_conf, UNTRUSTED_CAP)
        if bh > FACE_MAX_SUBJECT and crop_conf > 0.78:
            crop_conf = 0.78  # 大脸特写贴边：封顶到待确认区（mid），不直接标高置信半截头
        sides = []
        if y < EDGE_MARGIN:
            sides.append("上/头顶")
        if x < EDGE_MARGIN:
            sides.append("左")
        if x + bw > 1 - EDGE_MARGIN:
            sides.append("右")
        if y + bh > 1 - EDGE_MARGIN:
            sides.append("下/下巴")
        bump(crop_conf, "头部贴边出框（%s），脸框占图高%.0f%%" % ("/".join(sides) or "边缘", bh * 100))
    if not faces and upper_bodies:
        # 有身子没头：躯干框上缘必须贴着画幅顶边才说明“人头出框”（ENGINE_SIG 13 收紧）。
        # 旧版只要框落在上半幅（y<50%）就给 0.88，实测喜字贴画/花艺背景板/婚车车头上误检的
        # 躯干矩（y=14%/19%/48%）全被当成“检出躯干但无完整头部”，与人数维度一起误判。
        for ub in upper_bodies:
            if ub[1] <= H * 0.02:
                bump(0.88, "检出躯干但无完整头部")
                break
    # 躯干多于人脸：部分人头被裁/未入镜
    if faces and upper_bodies and len(upper_bodies) > len(faces):
        bump(0.72, "躯干 %d 但人脸 %d→疑有人头未完整入镜" % (len(upper_bodies), len(faces)))
    # 脸检不到时的身体安全网：主体人身框上缘贴画布顶边 → 头顶已出框。
    # 门槛只看 len(faces)：一个脸都没检到才走兜底。
    # （ENGINE_SIG 3 曾把门槛放宽成 `not _head_in_frame`——“有假脸也兜底”，本意修 7G1A9669 香槟塔；
    #   实测在软件真实转正输入上净负：只给 4 张 faceCount=1 的手部特写/边角残脸误贴半截头，且没修好目标，
    #   故 ENGINE_SIG 4 回退。详见 __init__.py 签名注释。）
    if not faces and person_boxes:
        for b in person_boxes:
            pb = b.get("box")
            if not pb:
                continue
            bx, by, bw2, bh2 = [float(v) for v in pb[:4]]
            if bh2 < H * 0.30:
                continue  # 远景小人身不算（用户口径：远景小后脑勺/背景人不参与）
            if by <= H * 0.02:
                bump(0.85, "未检到人脸且人身框贴画面顶边（半脸被遮或头顶出框）")
                break
    return float(conf), "; ".join(reasons) if reasons else "头部完整"


# ---------- 重复/连拍 ----------

def phash(bgr):
    """64bit DCT 感知哈希（16 位十六进制）"""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    small = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA)
    dct = cv2.dct(np.float32(small))
    low = dct[:8, :8]
    med = np.median(low[1:, 1:]) if low.size > 1 else 0
    bits = (low > med).astype(np.uint8)
    hexs = []
    for row in bits.reshape(8, 8):
        v = 0
        for b in row:
            v = (v << 1) | int(b)
        hexs.append("%x" % v)
    return "".join(hexs)


def hamming(h1, h2):
    if not h1 or not h2 or len(h1) != len(h2):
        return 64
    return sum(bin(int(a, 16) ^ int(b, 16)).count("1") for a, b in zip(h1, h2))


class EmbeddingModel:
    """可选图像嵌入（DINOv2/SigLIP/ArcFace onnx）：放入 models/ 自动启用，用于更准的重复聚类"""

    def __init__(self):
        self.model = OnnxSession(["*dinov2*.onnx", "*siglip*.onnx", "*arcface*.onnx", "ufas*.onnx", "mobileface*.onnx"], 224)

    @property
    def available(self):
        return self.model.available

    def embed(self, bgr, box=None):
        if not self.available:
            return None
        try:
            img = bgr
            if box:
                x, y, w, h = [int(v) for v in box]
                img = bgr[max(0, y):y + h, max(0, x):x + w]
            p = cv2.resize(img, (224, 224)).astype(np.float32)
            inp = self.model.session.get_inputs()[0].shape
            if len(inp) == 4 and inp[1] == 3:
                blob = p[:, :, ::-1].transpose(2, 0, 1)[None, ...] / 255.0
            else:
                blob = p[:, :, ::-1][None, ...] / 255.0
            v = np.array(self.model.run(blob)).flatten()
            n = np.linalg.norm(v)
            return (v / (n + 1e-9)).tolist() if n > 0 else None
        except Exception:  # noqa: BLE001
            return None
