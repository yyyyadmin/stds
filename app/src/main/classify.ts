/**
 * 分类体系核心（第三、四章）
 * - 置信度三级分档：高 >high 直接标记 / 中 [mid,high] 待确认 / 低 <mid 不标记
 * - 交付库 = 未被任何坏维度（高置信）标记 且 不在待确认/废弃库
 * - 用户手动放置（categoryBy = 'user'）优先，AI 不覆盖
 */
import type { AppSettings, CategoryKey, DimResult, DimensionKey, ImageRecord, TierKey } from '../shared/types'
import { BAD_DIMENSIONS, NEUTRAL_DIMENSIONS, STRUCTURAL_DIMENSIONS, CAT_LIBRARY, CAT_REVIEW, CAT_TRASH, CAT_DUP_TRASH, PERSON_DIMS, FACT_DIMENSIONS, isTrashLike, levelOf, flawLevel, SCENE_PRESETS, BASELINE_THRESHOLDS, DEFAULT_MID_THRESHOLD, DEFAULT_HIGH_THRESHOLD, SHARP_ANCHORS, SHARP_VAR_WEIGHT, TIER_SHARP_TRUST, TIER_SHARP_OK, TIER_SHARP_UNKNOWN } from '../shared/types'

/**
 * 取某维度生效阈值，优先级：事实/结构结论（刚性）> 自学习微调 > （场景覆盖 或 该维度的台阶基线）+ 力度平移 > 全局一对数。
 * 进了基线表的维度已不再直接用全局阈值——全局值只负责给出“比默认宽了多少 / 严了多少”。
 */
export function effectiveThresholds(dim: DimensionKey, s: AppSettings): [number, number] {
  // 事实/结构维度（人数四分类 + 黑白 + 重复）刀枪不入：不吃力度平移，也不吃自学习。
  // 它们回答的是“这张图是什么 / 是不是冗余”，不是“这张图好不好”；随力度档改口会直接
  // 换掉主分类与标签可见性（3185 张实测：宽松档误将 139 张合拍照、105 张黑白照拽进待确认；
  // high 滑到 0.99 时 739 张单人照 + 1295 张重复图整段变成“未检出”而从视图消失）。
  if (FACT_DIMENSIONS.includes(dim)) return [DEFAULT_MID_THRESHOLD, DEFAULT_HIGH_THRESHOLD]
  const tuned = s.tunedThresholds[dim]
  if (tuned) return tuned
  const preset = SCENE_PRESETS.find((p) => p.key === s.scene)
  const scene = preset?.overrides[dim]
  const anchor = scene || BASELINE_THRESHOLDS[dim]
  if (!anchor) return [s.midThreshold, s.highThreshold]
  // 力度档 / 滑条当“整体平移”用：它们相对默认（严格）档的偏移量，叠加到该维度自己的台阶基线上。
  // 以前直接把 0.8/0.55 当阈值用，对 blur（饱和在 0.85）等于“只要报了就直接标瑕疵”，
  // 对 eyes（台阶 0.75/1.0）又等于“1.0 才算铁证”，同一档位在不同维度上语义相反。
  // mid 与 high 用**同一个**偏移量刚性平移（3185 张实测：分开平移会让“宽松”档的
  // 可疑带整体上移接住顶部台阶，待确认从 439 张涨到 1269 张，与“宽松=少打扰”恰好相反）。
  const d = ((s.midThreshold - DEFAULT_MID_THRESHOLD) + (s.highThreshold - DEFAULT_HIGH_THRESHOLD)) / 2
  let mid = anchor[0] + d
  let high = anchor[1] + d
  high = Math.min(0.99, Math.max(0.5, high))
  mid = Math.min(high - 0.05, Math.min(0.95, Math.max(0.3, mid)))
  return [Number(mid.toFixed(3)), Number(high.toFixed(3))]
}

/** 原始 dims（引擎返回 confidence）-> 打级别后的 tags */
export function gradeDims(
  dims: Partial<Record<string, { confidence: number; reason?: string; method?: string }>>,
  settings: AppSettings
): { tags: Partial<Record<DimensionKey, DimResult>>; anyMid: boolean; badHigh: DimensionKey[] } {
  const tags: Partial<Record<DimensionKey, DimResult>> = {}
  let anyMid = false
  const badHigh: DimensionKey[] = []
  for (const [key, d] of Object.entries(dims || {})) {
    const dim = key as DimensionKey
    if (!d) continue
    if (!(BAD_DIMENSIONS.includes(dim) || NEUTRAL_DIMENSIONS.includes(dim) || STRUCTURAL_DIMENSIONS.includes(dim))) continue
    const [mid, high] = effectiveThresholds(dim, settings)
    const level = levelOf(d.confidence, high, mid)
    tags[dim] = { confidence: d.confidence, level, reason: d.reason, method: d.method }
    if (BAD_DIMENSIONS.includes(dim)) {
      if (level === 'high') badHigh.push(dim)
      else if (level === 'mid') anyMid = true
    } else if (NEUTRAL_DIMENSIONS.includes(dim) && level === 'mid') {
      // 中性维度不确定性也进待确认，让用户顺手确认分类
      anyMid = true
    }
    // 结构维度（重复/连拍 v2.0.67）：只写标签。它既不算瑕疵（不入 badHigh，否则回瑕疵片），
    // 也不算“AI 拿不准”（不入 anyMid，否则 860 张冗余帧会把待确认顶爆）；
    // 它只通过 isDeliverable 里的冗余闸门影响“这张要不要默认交出去”。
  }
  return { tags, anyMid, badHigh }
}

/**
 * 依据 tags 计算归属分类桶。D2 主分类=人数身份（与瑕疵正交）：
 * - 用户手动放置的状态（废弃库/重复废弃/自定义/手动停泊待确认）最高优先，AI 不覆盖；
 * - 否则恒返回人数四维里“非 low”的那一个（enforcePersonMutex 保证至多一个）；
 * - 拿不到可用人数标签（缺口/未识别）→ 停待确认，等重筛补。
 * 瑕疵（闭眼/模糊/表情崩坏…）不再充当主分类，只作为标签驱动导出闸门与瑕疵片/待确认虚视图。
 */
export function computeCategory(tags: ImageRecord['tags'], settings: AppSettings, current?: ImageRecord): CategoryKey {
  // 用户手动放置的状态优先（废弃库/重复废弃桶/自定义/手动停泊待确认）——AI 不拉回、不改写
  if (current?.categoryBy === 'user') {
    if (isTrashLike(current.category) || current.category === CAT_REVIEW || current.category.startsWith('custom:')) {
      return current.category
    }
  }
  // 主分类恒为人数：从互斥的人数四维里取唯一非 low 的标签（PERSON_DIMS 顺序即并列优先序）
  for (const dim of PERSON_DIMS) {
    const t = tags[dim]
    if (!t) continue
    const [tm, th] = effectiveThresholds(dim, settings)
    if (levelOf(t.confidence, th, tm) !== 'low') return dim
  }
  // 无可用人数标签（597 缺口 / 未识别）→ 停待确认，重筛自动补；瑕疵绝不充当主分类
  return CAT_REVIEW
}

/**
 * 交付库档位（D4，第三条轴）：只在交付库内部分层，与 category/tags 两根轴正交。
 *
 * v2（2026-10-13）改用引擎原始锐度实测。旧版算的是“离瑕疵线的安全距离”：对
 * 交付库里的图恒等于最大档（3185 张实测：优质 829 / 良好 23 / 一般 17，三档形同虚设），
 * 因为它拿的 blur/eyes 置信度在“全部干净”这个子集里几乎全是 0，不反映“有多锐”。
 * 现版从 blur 的 reason 里解析 清晰度方差 + 高频占比（它们才是连续量，方差跨 200 倍），
 * 按 face/full 口径各自 log 归一后加权混合，见 shared/types SHARP_ANCHORS。
 *
 * 曝光不再参与：实测高光溢出 p95 只有 0.07（几乎无区分度），而暗部死黑中位 0.21、
 * p75 0.44 在婚礼暗场里是风格不是缺陷；真正严重的曝光事故本来就被 exposure 维度拦进
 * 瑕疵/待确认，到这里已经筛过一轮。
 *
 * 拿不到实测的图（用户放行时 clearBadTags 会物理删掉 blur 标签，全库 543 张；或 node
 * 降级引擎只给“模糊面积占比”）一律归良好：不奖不罚，也不假装它们经过测量。
 * settings 保留在签名里（五个调用方均已持有），当前算法不吃阈值。
 */
const RE_SHARP = /清晰度方差\s*(-?\d+(?:\.\d+)?)\((full|face)\)\s*高频占比\s*(-?\d+(?:\.\d+)?)/
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))

/** 从 reason 解析原始测量值 -> 0~1 锐度分；解析不出返回 null */
export function sharpScore(tags: ImageRecord['tags']): number | null {
  const m = (tags.blur?.reason || '').match(RE_SHARP)
  if (!m) return null
  const a = SHARP_ANCHORS[(m[2] as 'face' | 'full')] || SHARP_ANCHORS.face
  const v = Math.max(1, Number(m[1]))
  const lv = (Math.log10(v) - Math.log10(a.varLo)) / (Math.log10(a.varHi) - Math.log10(a.varLo))
  const lh = (Number(m[3]) - a.hfLo) / (a.hfHi - a.hfLo)
  return Number((SHARP_VAR_WEIGHT * clamp01(lv) + (1 - SHARP_VAR_WEIGHT) * clamp01(lh)).toFixed(4))
}

export function scoreTier(tags: ImageRecord['tags'], settings?: AppSettings): TierKey | null {
  void settings
  // 不在交付库（有中/高瑕疵）→ 无档位：瑕疵照片/待确认不需要分级
  if (flawLevel(tags) !== 'none') return null
  const s = sharpScore(tags)
  if (s === null) return TIER_SHARP_UNKNOWN
  if (s >= TIER_SHARP_TRUST) return 1
  if (s >= TIER_SHARP_OK) return 2
  return 3
}

/** 判断分类桶含义 */
export function isBadCategory(cat: string): boolean {
  return (BAD_DIMENSIONS as string[]).includes(cat)
}

export function isNeutralCategory(cat: string): boolean {
  return (NEUTRAL_DIMENSIONS as string[]).includes(cat)
}

/** 是否属于交付库视图（导出"只导出交付库"的判定） */
export function inLibrary(cat: string): boolean {
  return !isBadCategory(cat) && cat !== CAT_REVIEW && !isTrashLike(cat)
}
