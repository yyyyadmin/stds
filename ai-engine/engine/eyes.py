# -*- coding: utf-8 -*-
"""眼睛维度：闭眼（OCEC ONNX 可选，否则眼闭合度启发式）+ 斜眼（MobileGaze 可选，否则虹膜偏移启发式）。
闭眼和斜视必须拆开做（第八章 8.2）。"""
import math

import cv2
import numpy as np

from .models import OnnxSession
from .face import eye_rois


# MediaPipe FaceLandmarker 478 点：左右眼各 6 点（Soukupova & Cech EAR 变体，索引对应 FaceLandmarker 拓扑）
# v2.0.111（2026-10）：右眼下睑第 5 点由 374 改为 373。374 是下睑靠外侧的点，用它算出的
# |P2-P5| 系统性偏大：全库 42 张实测，左眼 ear 中位 0.056，右眼用 374 是 0.146（2.6 倍），
# 换成标准 373 后降到 0.060，与左眼对齐。后果是右眼 ear 永远高过 _EAR_DECISIVE 总闸、
# 从未参与过一次闭眼判定 —— 「两只眼都要闭」的口径实际上从来没生效过，全靠左眼单打独斗。
_EYE_L = [33, 160, 158, 133, 153, 144]
_EYE_R = [362, 385, 387, 263, 373, 380]
# "完全闭合"标定（v2.0.108，2026-10 重标）。旧依据是 3190 张库，用户已明确该库无参考价值，
# 一律废弃；改在 E:\1016测试 245 张真值库上逐眼反查（app/.superpowers/tmp/eye-fix/calib-check.py，
# 1388 只可测眼）：其余 201 张里"ear≤_EAR_FULL 且 blink≥_BLINK_FULL"的满分眼为 0 只 —— 这两条
# 满分线在新库上零误判反例，故数值维持。闭眼照片 380 只眼的 ear 中位 0.178 / blink 中位 0.437，
# 与其余照片（0.222 / 0.335）大面积重叠，说明"完全闭合"只能靠双信号同时到顶来确认，不能靠单一低 EAR。
# CI fixture 闭眼(0.014,0.71)仍 ~1.0。
_EAR_FULL = 0.06    # EAR 低于此满分（全闭/眯成一条线）
_EAR_OPEN = 0.13    # EAR 高于此零分。闭眼判定看的是"眼睛闭没闭"(EAR + eyeBlink 双信号互证)，
                    # 绝不按低头/侧看这类头部动作跳过——姿态只是会污染 EAR 的干扰源：低头/侧脸
                    # 把眼睛在图上投影压扁、让 EAR 虚降(眼睛其实没闭)，是主要误判源。
                    # 本条旧依据(旧库"删除误检 minEar 中位 0.134")已随旧库作废；新库 245 张只反查到
                    # "不产生满分误判"这条下界，零分点本身未重标，故沿用。真闭眼(含低头/侧脸时闭眼)
                    # 靠"姿态鲁棒"的 eyeBlink 双信号互证照样判，不会因低头而漏判。
_BLINK_ZERO = 0.52  # eyeBlink 低于此零分（旧库"眯眼误判 ≤0.59"的依据随旧库作废；新库 245 张
                    # 复验下本条与 _EAR_FULL 组成的满分条件在非闭眼照片里命中 0 只眼，数值沿用）
_BLINK_FULL = 0.85  # eyeBlink 高于此满分（同上：新库反查零反例）
# v2.0.75（用户实测 7G1A9206/DHT12474/CHEN1075/DHT24834 后修正）：EAR 与 blink 两把尺子
# “打架”（一个说闭死、另一个明确说睁）时，等于没有任何可靠证据支持“闭眼”这个一票否决的重判，
# 一律不计闭眼（旧版封顶 0.82 塞进待确认，全库误伤的都是低头/妆容/眼睛不可见的假闭眼）。
# 真闭眼必然两信号同时说闭（走下面的双信号互证分支），不受本规则影响；故收紧不违反“低头/侧看
# 只要眼睛真闭仍算闭眼”的口径。_CONFLICT_CAP 已废弃，保留仅为兼容历史 reason 文案。
_CONFLICT_CAP = 0.82
# v2.0.106（用户实测 7G1A7955 大笑闭眼 / CHEN1083 举杯闭眼 后修正）：冲突归零分支有个反例——
# 大笑挤眼、举杯抿眼这类【真闭眼】里，eyeBlink 反而欠读（卡在 _BLINK_ZERO 下边界 0.49~0.52），
# 于是 EAR 说闭死、blink 说睁 → 走冲突分支被清零，把真闭眼漏判。判据：当“说闭”的一方是 EAR
# 且原始 ear 低于 _EAR_CONFLICT_TRUST 时，眼睑在几何上已几乎贴死，这是妆容/低头/虚焦都造不出的硬证据，
# blink 卡在低边界只是欠读、不足以反证“睁”，故【豁免归零】。
# v2.0.111（2026-10，修右眼索引后收紧）：豁免线从 _EAR_DECISIVE(0.10) 收到 0.04。
# 374→373 让右眼终于能参与判定，同时也把右眼点贴歪的噪声放了出来：全库实测 7 张新冒出来的
# 全是“左眼 ear 正常(0.11~0.27)、右眼 ear 刚过线(0.046~0.068)、右眼 blink 也低(0.21~0.50)”
# —— 这是右边那只眼的点没贴在眼睛上（侧眺/低头），不是闭眼。真正需要本豁免救的只有
# 7G1A7955（ear 0.029、blink 0.52 卡边界），它的 ear 比全闭标定线 0.06 还低一半。
# 取 0.04：上面 7 张（0.046~0.091）全部弃权，7G1A7955（0.029）保留。
# v2.0.112（2026-10-21，全库 148 张真实输入逐张复核）：0.04 这条线单卡 ear，会看错一种“单眼贴歪”。
# 实测 7G1A9619/CHEN9728/CHEN9787 三张被误标，特征都是“一只眼 ear 低到 0.06、另一只眼 ear 0.11~0.27 正常”，
# 而真闭眼的双眼上下睑是同时贴死的。故豁免加一条交叉核对：另一只眼必须也低于 _EAR_DECISIVE，
# 否则说明这只是一只眼的点没贴正，不是闭眼。该条同时压掉 CHEN0141/CHEN1084（肉眼核对：一张低头递茶杯、
# 一张举杯眯眼，都不是闭眼）。
_EAR_CONFLICT_TRUST = 0.04
# v2.0.112：冲突拦截线从 0.85 降到 0.72。
# 0.72~0.85 这段是“EAR 说闭、blink 说睁”的弱证据区：p_ear 在 0.72 只对应 ear≈0.080，
# 离全闭标定线 0.06 还有距离，原本靠单眼 EAR 就能拿到 mid 档。全库 148 张实测：
# 降到 0.72 只压掉 CHEN9619（伴娘低头说话，眼睛睁着）、CHEN9728（闭的是低头背景小女孩）、
# CHEN9787（虚焦加眼镜），该闭的 22 张一张没掉、其余误标零新增。
# 再降（0.70/0.65/0.60）结果完全相同，说明这三张的 p_ear 都落在 0.72~0.75 之间，0.72 是它们的上界。
_CONFLICT_AT = 0.72
_CONFLICT_GAP = 0.15
# v2.0.113（2026-10-21，用户指出 7G1A7958 是明确的闭眼）：给“笑到挤眼”这类真闭眼单开一条通道。
# 7G1A7958 是婚礼上大笑，上下眼睑被挤成一条缝，EAR 只有 0.0625/0.0572（比全闭标定线 0.06 还低），
# 但 MediaPipe 的 blink 读数反而只有 0.368/0.390 → 两个信号“打架” → 走冲突归零，漏判。
# 全库 148 张把所有“ear 贴死但被归零”的眼睛按 blink 原始值排开，发现一条干净的界线：
#   真挤眼（blink 欠读）：7G1A7958 = 0.368/0.390
#   低头假闭眼（blink 落在半闭区）：7G1A9584 face1 = 0.491/0.540、CHEN0141 = 0.473、CHEN1084 = 0.542
# 即“眼睑贴死 + blink 比 _BLINK_ZERO 还低 0.10 以上”= 挤眼；blink 卡在 0.42~0.55 的才是低头被压扁。
# 取 ear 0.07 / blink 0.42 + 另一只眼也必须贴死（< _EAR_DECISIVE，双眼同时挤才是闭眼）：
# 全库 148 张实测 不该闭 11 / 该闭 22 / 其余 8→9（多出来的正是 7G1A7958），
# 新增误标 0，7G1A9584 保持 0。再放宽 blink 到 0.45 会多救 7G1A8076，但那不是本轮目标，不做。
_SQUEEZE_EAR = 0.07
_SQUEEZE_BLINK = 0.42
# v2.0.107（用户实测 7G1A8242/CHEN0143 低头含羞、CHEN9976 低头看戒指 后修正）：_EAR_DECISIVE 升级为
# 闭眼判定的【总闸】——不只在冲突分支里当豁免线。理由：EAR 是“上下眼皮贴没贴死”的直接几何量，
# ear 超过本线说明眼里还留着缝，那就是“往下看/含羞/侧脸”而非“闭眼”（婚礼摆拍里低头看戒指、看捧花、
# 含羞低头是大量造型，用户明确：这类不该算闭眼缺陷）。而 eyeBlink 对【低头】方向并不鲁棒——低头把
# 上眼皮压得很低，eyeBlink 会虚高（实测 9976 低头看戒指 blink=0.86 却明显是睁眼往下看），故 blink 高
# 不能翻 EAR“有缝”的案。仅当 EAR 量不到（None，侧脸/虚焦）时才退回 blink 兜底判闭。
# v2.0.108（2026-10 重建真值：E:\1016测试 245 张 9 类；用户明确旧 3190 张库无参考价值，本线整体重标）：
# 0.04 这条线自己在砍真闭眼——7G1A9768 的 478 点经放大逐像素核对是准的、两眼确实闭着，被量成 ear=0.046，
# 差 0.006 就被判成“睁”；7G1A8037 同样 0.050 被砍。用户拍板口径改为“宁多勿漏”。全库 7 档扫描
# （0.04→0.13，全跑真实引擎）：每抬一档“丢掉的闭眼”恒为 0，是纯增益；44 张闭眼里命中 12→31，
# 201 张其余里被标出 32→68，0.10 起完全饱和（0.13 结果一模一样）。故取 0.10，比 _EAR_OPEN 留 0.03 余量，
# 避免把总闸做成“等于睁眼线”的空壳。
# 本闸救不回的（与闭眼算法无关，是 478 点压根没生成 / 贴错位）：CHEN9808、CHEN9802 的接吻新人属极端
# 侧脸且相互遮挡，MediaPipe 在那块裁图里 det=0（换 15 种取景都只能认出旁边的脸）；CHEN9841 脸过大
# （占图高 26%）导致点贴到额头，ear 量出 0.43 的假值。
_EAR_DECISIVE = 0.10
# v2.0.105（用户实测 CHEN1020 后修正）：启发式（看纹理）只在 MediaPipe 量不到眼睛的脸上兜底，
# 而兜底脸多是合影/婚宴里【又小又虚又暗的背景人】。工作图恒定缩到最长边 1280，眼 ROI 高≈0.18×脸高；
# 当眼区高度低于此像素下限时，那块眼睛只有几个像素，"闭眼=一条低对比横线"与"看不清的黑/虚糊块"
# 在纹理上根本无法区分——此时启发式没有可靠证据，应【弃权】而不是硬给 0.75 把整张图拖进闭眼待确认。
# 真实分布校准（全库 44 张闭眼、其中 7 张走启发式）：判对的两张（7G1A7427 躺姿闭眼、7G1A9900 拥吻闭眼）
# 眼区高分别 95、18px；判错的 4 张（CHEN1020/0606/1085/9841 均为虚焦/侧背/贴顶的背景小脸）眼区高仅 7~14px。
# 取 15 干净切开（≥15 保留、<15 弃权），且此门控只作用于无 mp 的兜底路径，绝不触碰 mp 判定的真闭眼。
_HEUR_MIN_EYE_H = 15
# v2.0.111：眼区被画面边缘切掉时同样弃权（治“后脑勺/背景被当成脸，还给 0.75”）。
# 用户实测 7G1A8029「都没有人脸，何来闭眼一说」：YuNet 在右上角贴边处检出一个 104x105 的框，
# 478 点一个都没贴出来，眼区 29x18、离右边界 0px、离上边界 6px——那是被裁断的半张“脸”，
# 里头的“眼睛”根本看不到，纹理判断却按 dyn=21（几乎无明暗差）给了闭眼 0.75。
# 语义与 _HEUR_MIN_EYE_H 完全同族：眼区太小是“看不清”，被画面切掉是“看不见”，两者都不该下结论。
# 全库 7 张启发式给分的图实测：判错的 7G1A8029 眼区离边界 6px/0px、CHEN0505 0px/22px、
# 7G1A9837 0px/86px；判对的三张真闭眼（7G1A7427 躺姿 / 7G1A9900 拥吻 / CHEN0848）
# 眼区离边界最小 91/226/12px，取 10 干净切开，不碰任何一张真闭眼。
_HEUR_MIN_MARGIN = 10

# v2.0.110：关键点贴歪时弃权（治“眼睛根本没找到，却给到 1.00”）。478 点在侧脸/低头/虚焦/脸过大/
# 躺姿旋转时会整片贴到额头、耳朵、虚化皮肤上，那些位置照样能算出极低的 EAR，一路给到 1.00。
# 试过“按原图 1:1 看眼区里有没有眼睛”（Sobel 横向边缘），在软件真实输入（2000px 临时图）上量出来
# 睁眼 0.0~3.2、闭眼 0.0~2.4，完全重叠，分不开——已作废（ab.log/calib-gy.log）。
# 改用人脸网格自身是否自洽，两个量都不看像素，与分辨率、妆容、光线无关：
#   iou     YuNet 脸框 与 478 点外接框 的重合度。实测正常脸 0.61~0.88；点整片漂走的 CHEN9559=0.00、
#           CHEN9550=0.06、CHEN9649=0.25。取 0.45：低于此值说明这团点根本不是这张脸。
#   eyeCy   给分那只眼的中心在脸框里的纵向位置。正常脸（含侧脸）实测 0.37~0.51；点贴到额头的
#           CHEN9631=0.135、CHEN0142=0.261，贴到下巴外的 CHEN9649=0.748、CHEN9559=0.852。取 0.28~0.62。
# 两条都过线才采信；任一条不过线 = 这只“眼睛”是点算出来的幻觉，弃权（既不判闭，也不判睁）。
# 全库 127 张实测：误标 16 → 14，已判对的闭眼 23 → 22（掉的是 CHEN9550，它的点重合度只有 0.06，
# 本来就不是这张脸的眼睛）。
_MESH_MIN_IOU = 0.45
_MESH_EYE_CY = (0.28, 0.62)

# v2.0.109：接吻兜底（不依赖眼睛信号的一路证据）。婚礼跟拍里接吻/亲额头时两人必然闭眼，但这类姿态是
# 极端侧脸 + 相互遮挡，MediaPipe 在两张脸上一个点都贴不出来（实测 CHEN9802/9804/9806/9808 四张接吻照，
# 新人的脸全是 det=0），EAR / eyeBlink 全拿不到 → 闭眼分 0。实测代价：CHEN9804 整张漏判（0.00）、
# CHEN9808 只剩旁边一位男士凑的 0.51；CHEN9802 的 1.00 和 CHEN9806 的 0.85 也是旁人给的，纯属运气。
# 换模型、放大裁切（1x/2x/3x）、加 pad（0.1/0.6/0.8）都试过，救不回来（kiss-diag*.log），遮挡是物理的。
# 所以要换一路不依赖眼睛的证据：接吻时画面最大的两张脸必然贴在一起。
_KISS_PAIR_RATIO = 1.30   # 上限：两张脸中心距 / 平均脸宽。实测三张真接吻 1.16~1.21；合影里挨着的路人远大于此。
_KISS_MIN_RATIO = 1.10    # 下限：低于 1.1 说明两框大面积叠在一起。实测 CHEN0041（新郎低头看新娘的手，两人眼睛都睁着）
                         # 是 0.84、CHEN9787（凑近说话）是 1.00——这类“凑近但没亲上”的瞬间都落在这个区间里。
_KISS_MIN_SUBJECT = 0.12  # 两张脸都得是主体（脸高 >= 图高 12%），排除合影里挨在一起的背景路人。
_KISS_PROB = 0.98


def _clip01(v):
    return max(0.0, min(1.0, v))


def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _eye_ear(lms, idx):
    """6 点 EAR = (|p1-p5| + |p2-p4|) / (2|p0-p3|)。像素坐标即可（比值尺度无关）。异常/点不足返回 None。"""
    try:
        p = [lms[i] for i in idx]
    except Exception:  # noqa: BLE001
        return None
    h = _dist(p[0], p[3])
    if h <= 1e-6:
        return None
    return (_dist(p[1], p[5]) + _dist(p[2], p[4])) / (2.0 * h)


def _mp_closed_prob(face):
    """有 mp 时返回 (闭合概率, 诊断串, 给分那只眼的点索引)；无 mp / 数据不足返回 None（交调用方回落启发式）。
    只认完全闭合：EAR/blink 两信号各自按严格标定映射，双信号互证才给拉满；
    单信号强但另一信号明显相反（睁）→ 视为无可靠证据，不计闭眼（v2.0.75，详见 _CONFLICT_CAP 注释）。
    逐眼独立算 pe，最终取最强的那只眼（调用方据此判「这张图有没有人闭眼」）。
    v2.0.111 口径修正：用户 2026-10 明确「两只眼睛都必须真正闭上；低头看/眯眼/背景路人都不算」，
    但实测这批真值里 29 张真闭眼有 28 张是一眼 ear 极低、另一眼 ear 0.10~0.15（闭眼时两名角度
    不同造成的固有不对称），强制两眼同时达标会把真闭眼从 21/29 砍到 1/29，故此处仍逐眼判、
    取强者，由上游按「同一张脸的强弱是否一致」再做取舍。
    """
    mpd = face.get("mp")
    if not mpd:
        return None
    lms = mpd.get("landmarks")
    blend = mpd.get("blend") or {}
    if not lms or len(lms) < 478:
        return None
    # v2.0.112：两眼 ear 先一起量好 —— 冲突豁免要交叉核对「另一只眼是不是也贴死了」。
    ears = {"L": _eye_ear(lms, _EYE_L), "R": _eye_ear(lms, _EYE_R)}
    best = None
    best_idx = None
    diag = []
    for side, idx, blink_key in (("L", _EYE_L, "eyeBlinkLeft"), ("R", _EYE_R, "eyeBlinkRight")):
        ear = ears[side]
        other = ears["R" if side == "L" else "L"]
        p_ear = None if ear is None else _clip01((_EAR_OPEN - ear) / (_EAR_OPEN - _EAR_FULL))
        blink = blend.get(blink_key)
        p_blink = None if blink is None else _clip01((float(blink) - _BLINK_ZERO) / (_BLINK_FULL - _BLINK_ZERO))
        cand = [x for x in (p_ear, p_blink) if x is not None]
        if not cand:
            continue
        pe = max(cand)
        if p_ear is not None and p_blink is not None:
            if min(p_ear, p_blink) >= 0.5:  # 双信号互证：真实全闭，叠加拉满
                pe = min(1.0, pe + 0.30 * min(p_ear, p_blink))
            elif pe >= _CONFLICT_AT and min(p_ear, p_blink) < _CONFLICT_GAP:  # 两信号打架：一个说闭死一个说睁
                # v2.0.106 例外 + v2.0.111 收紧 + v2.0.112 交叉核对：闭证据来自 EAR、耳高已低到眼睑贴死，
                # 且【另一只眼也低于总闸】—— 双眼同时贴死才是闭眼，单眼贴死是那只眼的点没贴正。
                # 条件不满足 = 没有可靠证据支持「闭眼」这个一票否决的重判，不计闭眼。
                if (ear is not None and ear < _EAR_CONFLICT_TRUST and p_ear >= p_blink
                        and other is not None and other < _EAR_DECISIVE):
                    pass
                # v2.0.113 挤眼通道：眼睑贴死 + blink 反而明确说“没闭”（比 _BLINK_ZERO 低 0.10 以上）
                # + 另一只眼也贴死 —— 大笑挤眼时眨眼角，眼睑挤死但 MediaPipe 读不到闭合。
                # 低头假闭眼的 blink 落在 0.42~0.55 的半闭区，不会被本通道放进来。
                elif (ear is not None and ear < _SQUEEZE_EAR and float(blink) < _SQUEEZE_BLINK
                        and other is not None and other < _EAR_DECISIVE):
                    pass
                else:
                    pe = 0.0
        # v2.0.107/v2.0.108 总闸：EAR 可测且眼里还留着缝（ear≥_EAR_DECISIVE）→ 眼睑没贴死，是“往下看/含羞/侧脸”
        # 而非闭眼，blink 再高（低头虚高）也不能翻案，本眼不计闭。仅 EAR 低于 _EAR_DECISIVE 或量不到(None)才可能判闭。
        if ear is not None and ear >= _EAR_DECISIVE:
            pe = 0.0
        if best is None or pe > best:
            best = pe
            best_idx = idx
        diag.append("%s(ear=%s blink=%s)" % (
            "L" if blink_key.endswith("Left") else "R",
            ("%.3f" % ear) if ear is not None else "NA",
            ("%.2f" % blink) if blink is not None else "NA"))
    if best is None:
        return None
    return float(best), "mp:%.2f[%s]" % (best, " ".join(diag)), best_idx


def _kiss_pair_prob(bgr, faces):
    """「画面最大的两张脸都贴不上 478 点、且几乎贴在一起」→ 判接吻，返回 (0.98, 诊断串)；否则 None。

    为什么把「都贴不上点」当必要条件：贴脸合影（两人脸挨着看镜头）是正脸，MediaPipe 能贴点，不该触发；
    只有亲上去时两张脸侧到互相遮挡，才会两张都 det=0。这条闸正好避开「低头看东西」——CHEN0043 里
    新郎低头看新娘的手，两张脸也挨得近（中心距/脸宽=1.11），但新娘那张贴得上点，故不触发。
    """
    if not faces or bgr is None:
        return None
    H, W = bgr.shape[:2]
    if H <= 0 or W <= 0:
        return None
    sub = []
    for f in faces:
        box = f.get("box")
        if not box or len(box) < 4:
            continue
        x, y, w, h = [float(v) for v in box[:4]]
        if w <= 1 or h <= 1 or h / float(H) < _KISS_MIN_SUBJECT:
            continue
        sub.append({"x": x, "y": y, "w": w, "h": h,
                    "cx": x + w / 2.0, "cy": y + h / 2.0,
                    "mp": bool((f.get("mp") or {}).get("landmarks"))})
    if len(sub) < 2:
        return None
    a, b = sorted(sub, key=lambda z: -(z["w"] * z["h"]))[:2]
    if a["mp"] or b["mp"]:
        return None
    ratio = math.hypot(a["cx"] - b["cx"], a["cy"] - b["cy"]) / max(1e-6, (a["w"] + b["w"]) / 2.0)
    if ratio < _KISS_MIN_RATIO or ratio > _KISS_PAIR_RATIO:
        return None
    return _KISS_PROB, "kiss:%.2f[nomp2 ratio=%.2f]" % (_KISS_PROB, ratio)


def _eye_stats(bgr, roi):
    """单个眼 ROI 的开启度统计：返回 (open_score 0~1, iris_offset -1~1 or None, detail)"""
    side, x, y, w, h, cx, cy = roi
    patch = bgr[y:y + h, x:x + w]
    raw = cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY)
    # 均衡版仅用于边缘检测(Canny)与虹膜定位；对比度/纵向方差必须在【原始灰度】上测——
    # equalizeHist 会把任意 patch 拉到满量程，使 dyn 恒≈255、vert_var 虚高，闭眼的低对比信号被抹掉。
    gray = cv2.equalizeHist(raw)
    # 闭合眼睛特征：水平暗线 / 边缘集中在一条横线、纵向方差低
    edges = cv2.Canny(gray, 60, 160)
    row_energy = edges.sum(axis=1).astype(float)
    col_energy = edges.sum(axis=0).astype(float)
    row_peak = row_energy.max() / (row_energy.mean() + 1e-6)  # 单一横线 -> 峰值比高
    vert_var = float(raw.var(axis=1).mean())  # 原图纵向方差：闭眼(一条横线)低、睁眼(上下眼睑+瞳孔)高
    # 亮度带：睁眼有明显暗瞳孔 + 亮虹膜/白睛
    dyn = float(raw.max() - raw.min())  # 原图动态范围：闭眼/低对比时小
    open_score = 1.0
    if vert_var < 12 or dyn < 40:
        open_score = 0.25
    elif row_peak > 6.0 and vert_var < 26:
        open_score = 0.45
    elif vert_var < 22:
        open_score = 0.62
    # 虹膜偏移：取眼区中部竖直带内最暗连通块质心
    iris_offset = None
    if open_score >= 0.55:
        band = gray[int(h * 0.2):int(h * 0.8), :]
        thr = float(np.percentile(band, 18))
        mask = (band <= thr).astype(np.uint8)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        m = cv2.moments(mask)
        if m["m00"] > 6:
            ix = m["m10"] / m["m00"]
            iris_offset = float((ix - w / 2.0) / (w / 2.0))
    return open_score, iris_offset, {"vert_var": round(vert_var, 1), "row_peak": round(row_peak, 1), "dyn": round(dyn, 1)}


def _mesh_plausible(face, eye_idx):
    """这张脸的 478 点到底是不是贴在它自己脸上？返回 (可信?, 诊断串)。
    测量不依赖分辨率/光线：只比“点阵外接框”和“YuNet 脸框”的重合度，以及给分那只眼的纵向位置。"""
    mpd = face.get("mp") or {}
    lms = mpd.get("landmarks")
    box = face.get("box")
    if not lms or len(lms) < 468 or not box:
        return False, "无点"
    bx, by, bw, bh = [float(v) for v in box]
    if bw <= 1 or bh <= 1:
        return False, "框异常"
    iou = float(mpd.get("score") or 0.0)
    if iou < _MESH_MIN_IOU:
        return False, "iou=%.2f" % iou
    pts = [lms[i] for i in eye_idx]
    ys = [p[1] for p in pts]
    cy = (((max(ys) + min(ys)) / 2.0) - by) / bh
    if not (_MESH_EYE_CY[0] <= cy <= _MESH_EYE_CY[1]):
        return False, "眼位%.2f" % cy
    return True, ""


class EyesAnalyzer:
    def __init__(self):
        # OCEC 闭眼专用模型（MIT，可直接商用）：放入 models/ 即自动启用
        self.ocec = OnnxSession(["ocec*.onnx", "*eyes_closed*.onnx", "ufec*.onnx"], 24)
        self.gaze = OnnxSession(["mobilegaze*.onnx", "*gaze*.onnx"], 224)
        self.method = "ocec+mobilegaze" if (self.ocec.available and self.gaze.available) else "heuristic"

    # ---------- 闭眼 ----------

    def _ocec_prob(self, patch_bgr):
        """OCEC: 输入眼睛图块，输出 [NCL, CL, SR] 概率；类别顺序未知时按均值兜底不可行，故要求标准顺序"""
        try:
            p = cv2.resize(patch_bgr, (24, 24))
            blob = p.astype(np.float32)
            if self.ocec.session.get_inputs()[0].shape[1] == 3:  # CHW
                blob = blob.transpose(2, 0, 1)[None, ...]
            else:
                blob = blob[None, ...]
            out = self.ocec.run(blob)
            probs = np.array(out).flatten()
            if probs.size >= 3:
                if probs.size > 3:
                    probs = np.exp(probs - probs.max())
                    probs = probs / probs.sum()
                return float(probs[1]) + float(probs[2]) * 0.5  # 完全闭合 + 半闭折半
        except Exception:  # noqa: BLE001
            pass
        return None

    def closed_eye(self, bgr, faces):
        """返回 (confidence 闭眼成立的可信度, reason)。偏向召回：任一 eyes 半闭即计"""
        if not faces or bgr is None:
            return 0.0, ""
        H, W = bgr.shape[:2]
        worst = 0.0
        worst_detail = None
        parts = []
        worst_from_mp = False
        from_kiss = False
        for face in faces[:6]:
            mp = _mp_closed_prob(face)
            if mp is not None:
                prob, d, eye_idx = mp
                # v2.0.110：只有“点确实贴在这张脸上”才采信。不贴 = 这只眼是幻觉，弃权。
                if prob >= 0.5:
                    ok, why = _mesh_plausible(face, eye_idx)
                    if not ok:
                        parts.append("眼点贴歪(%s)弃权[%s]" % (why, d))
                        continue
                parts.append(d)
                if prob >= worst:
                    worst = prob
                    worst_detail = None  # mp 路径无启发式 vv/dyn/rp，清掉避免错拼非最坏脸的诊断
                    worst_from_mp = True
                continue
            for roi in eye_rois(face, bgr):
                side, x, y, w, h, _, _ = roi
                # 眼睛区域太小（背景虚焦/侧背/贴顶小脸）→ 纹理无法分辨睁闭，启发式弃权（不计入本脸闭眼证据）。
                if h < _HEUR_MIN_EYE_H:
                    parts.append("%s:skip(h=%d)" % (side, h))
                    continue
                # 眼区被画面边缘切掉同样弃权（v2.0.111）：看不见的眼睛不能当“闭着”算。
                # 注意负坐标：bgr[y:y+h] 遇到负数切片会从图尾取，不拦住会拿错像素判分。
                margin = min(x, y, W - (x + w), H - (y + h))
                if margin < _HEUR_MIN_MARGIN:
                    parts.append("%s:skip(贴边%d)" % (side, margin))
                    continue
                patch = bgr[y:y + h, x:x + w]
                prob = self._ocec_prob(patch) if self.ocec.available else None
                if prob is None:
                    open_score, _, dd = _eye_stats(bgr, roi)
                    prob = 1.0 - open_score
                    # 启发式只当粗筛：纹理法分不开"全闭"与"低对比眯眼"，封顶 0.82 只进待确认，
                    # 不再直接标成闭眼分类（打包版主路径是 mediapipe，不受影响）。
                    prob = min(prob, 0.82)
                    parts.append("%s:%.2f" % (side, prob))
                    if prob >= worst:
                        worst_detail = dd
                        worst_from_mp = False
                else:
                    parts.append("%s:ocec%.2f" % (side, prob))
                    if prob >= worst:
                        worst_from_mp = False
                worst = max(worst, prob)
        kiss = _kiss_pair_prob(bgr, faces)
        if kiss is not None and kiss[0] > worst:
            worst, worst_detail, worst_from_mp, from_kiss = kiss[0], None, False, True
            parts.append(kiss[1])
        if from_kiss:
            method = "kiss"
        else:
            method = "mediapipe" if worst_from_mp else ("ocec" if self.ocec.available else "heuristic")
        reason = "眼闭合度 %.2f (%s) [%s]" % (worst, ", ".join(parts), method)
        if worst_detail:
            reason += " vv=%.0f dyn=%.0f rp=%.1f" % (
                worst_detail.get("vert_var", 0), worst_detail.get("dyn", 0), worst_detail.get("row_peak", 0))
        return float(worst), reason

    # ---------- 斜眼 ----------

    def gaze_offset(self, bgr, faces):
        """返回 (confidence 斜眼成立的可信度, max_offset, reason)。判定：瞳孔偏离眼中心超过阈值"""
        if not faces:
            return 0.0, 0.0, ""
        max_off = 0.0
        details = []
        for face in faces[:6]:
            offs = []
            for roi in eye_rois(face, bgr):
                open_score, offset, _ = _eye_stats(bgr, roi)
                if offset is not None and open_score >= 0.55:
                    offs.append(offset)
                    max_off = max(max_off, abs(offset))
            if len(offs) == 2 and all(o > 0.35 for o in offs):
                # 双眼同向偏移：侧视/斜眼强信号
                max_off = max(max_off, min(abs(offs[0]), abs(offs[1])) * 1.25)
            details.append("%.2f" % (max(abs(o) for o in offs) if offs else 0))
        # 启发式偏移 -> 置信度：0.35 起升，0.7 饱和（约对应视线偏 15-20 度）
        conf = _sigmoid((max_off - 0.52) / 0.10)
        reason = "瞳孔偏移 %.2f (%s)" % (max_off, ", ".join(details))
        return float(conf if max_off > 0.25 else 0.0), max_off, reason


def _sigmoid(z):
    return 1.0 / (1.0 + math.exp(-z))
