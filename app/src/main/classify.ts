/**
 * 分类体系核心（第三、四章）
 * - 置信度三级分档：高 >high 直接标记 / 中 [mid,high] 待确认 / 低 <mid 不标记
 * - 成品库 = 未被任何坏维度（高置信）标记 且 不在待确认/垃圾桶
 * - 用户手动放置（categoryBy = 'user'）优先，AI 不覆盖
 */
import type { AppSettings, CategoryKey, DimResult, DimensionKey, ImageRecord } from '../shared/types'
import { BAD_DIMENSIONS, NEUTRAL_DIMENSIONS, CAT_LIBRARY, CAT_REVIEW, CAT_TRASH, levelOf, SCENE_PRESETS } from '../shared/types'

/** 取某维度生效阈值：全局 > 微调 > 场景预设 */
export function effectiveThresholds(dim: DimensionKey, s: AppSettings): [number, number] {
  const tuned = s.tunedThresholds[dim]
  if (tuned) return tuned
  const preset = SCENE_PRESETS.find((p) => p.key === s.scene)
  const scene = preset?.overrides[dim]
  if (scene) return scene
  return [s.midThreshold, s.highThreshold]
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
    if (!(BAD_DIMENSIONS.includes(dim) || NEUTRAL_DIMENSIONS.includes(dim))) continue
    const [mid, high] = effectiveThresholds(dim, settings)
    const level = levelOf(d.confidence, high, mid)
    tags[dim] = { confidence: d.confidence, level, reason: d.reason, method: d.method }
    if (BAD_DIMENSIONS.includes(dim)) {
      if (level === 'high') badHigh.push(dim)
      else if (level === 'mid') anyMid = true
    } else if (level === 'mid') {
      // 中性维度不确定性也进待确认，让用户顺手确认分类
      anyMid = true
    }
  }
  return { tags, anyMid, badHigh }
}

/** 依据 tags 计算 AI 归属分类桶（坏维度优先，取置信度最高者） */
export function computeCategory(tags: ImageRecord['tags'], settings: AppSettings, current?: ImageRecord): CategoryKey {
  // 垃圾桶与用户手动放置具有最高优先
  if (current?.categoryBy === 'user' && current.category === CAT_TRASH) return CAT_TRASH
  if (current?.categoryBy === 'user' && current.category.startsWith('custom:')) return current.category

  let bestBad: { dim: DimensionKey; conf: number } | null = null
  let anyMid = false
  for (const [dim, t] of Object.entries(tags) as Array<[DimensionKey, DimResult]>) {
    const [tm, th] = effectiveThresholds(dim, settings)
    const lv = levelOf(t.confidence, th, tm)
    if (BAD_DIMENSIONS.includes(dim)) {
      if (lv === 'high' && (!bestBad || t.confidence > bestBad.conf)) bestBad = { dim, conf: t.confidence }
      if (lv === 'mid') anyMid = true
    }
  }
  if (bestBad) return bestBad.dim
  if (anyMid) return CAT_REVIEW
  // 中性维度高置信 -> 对应分类（同时属于成品库视图）
  const neutrals = NEUTRAL_DIMENSIONS.filter((d) => {
    const t = tags[d]
    if (!t) return false
    const [tm, th] = effectiveThresholds(d, settings)
    return levelOf(t.confidence, th, tm) === 'high'
  })
  if (neutrals.length) {
    // 黑白照与人数正交：优先人数（更符合交付习惯），黑白作为标签
    const byCount = neutrals.filter((d) => d !== 'black_white')
    return byCount.length ? byCount[0] : neutrals[0]
  }
  return CAT_LIBRARY
}

/** 判断分类桶含义 */
export function isBadCategory(cat: string): boolean {
  return (BAD_DIMENSIONS as string[]).includes(cat)
}

export function isNeutralCategory(cat: string): boolean {
  return (NEUTRAL_DIMENSIONS as string[]).includes(cat)
}

/** 是否属于成品库视图（导出"只导出成品库"的判定） */
export function inLibrary(cat: string): boolean {
  return !isBadCategory(cat) && cat !== CAT_REVIEW && cat !== CAT_TRASH
}
