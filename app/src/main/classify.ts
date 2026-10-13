/**
 * 分类体系核心（第三、四章）
 * - 置信度三级分档：高 >high 直接标记 / 中 [mid,high] 待确认 / 低 <mid 不标记
 * - 交付库 = 未被任何坏维度（高置信）标记 且 不在待确认/废弃库
 * - 用户手动放置（categoryBy = 'user'）优先，AI 不覆盖
 */
import type { AppSettings, CategoryKey, DimResult, DimensionKey, ImageRecord, TierKey } from '../shared/types'
import { BAD_DIMENSIONS, NEUTRAL_DIMENSIONS, STRUCTURAL_DIMENSIONS, CAT_LIBRARY, CAT_REVIEW, CAT_TRASH, CAT_DUP_TRASH, PERSON_DIMS, FACT_DIMENSIONS, isTrashLike, levelOf, flawLevel, BASELINE_THRESHOLDS, DEFAULT_MID_THRESHOLD, DEFAULT_HIGH_THRESHOLD, SHARP_ANCHORS, SHARP_VAR_WEIGHT, TIER_SHARP_TRUST, TIER_SHARP_OK, TIER_SHARP_UNKNOWN } from '../shared/types'

/**
 * 取某维度生效阈值。v7（2026-10-14）阈值锁定：事实/结构维度用固定默认值，其余维度一律只认
 * 下面这张专家逐维度标定的 BASELINE_THRESHOLDS——自学习微调、场景预设、力度档平移全部不再参与
 * （客户设置里这些旋钮已撤除，判定线由开发者在代码里统一维护）。历史上“自学习悄悄把模糊抬到
 * 0.62 盖过严格档、导致偏糊片漏标”正是多层覆盖互相打架的坑，收口成单层。
 */
export function effectiveThresholds(dim: DimensionKey, _s: AppSettings): [number, number] {
  // 事实/结构维度（人数四分类 + 黑白 + 重复）刀枪不入：它们是“这张图是什么 / 是不是冗余”的
  // 硬结论，不随任何松紧变化（3185 张实测：一旦随力度/自学习改口，会把成百张图静默挪出分类视图）。
  if (FACT_DIMENSIONS.includes(dim)) return [DEFAULT_MID_THRESHOLD, DEFAULT_HIGH_THRESHOLD]
  // 其余维度只认基线表；不在表里的（理论已被上面拦截）回落固定的严格档默认值，绝不吃滑条/自学习。
  return BASELINE_THRESHOLDS[dim] || [DEFAULT_MID_THRESHOLD, DEFAULT_HIGH_THRESHOLD]
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
// 当前引擎（v2.0.64 分块重写后）的 blur reason 不再产出“清晰度方差/高频占比”，改成
// “…全图方差 N 脸区方差 M”（M 可能为“无脸”）。旧解析器认不出新格式 → sharpScore 恒 null
// → scoreTier 恒 TIER_SHARP_UNKNOWN(2)，导致“优质”自 v2.0.64 起再没被 AI 发出去过（实测当前库
// 23 张 AI 档位全塌在良好）。v2.0.74 修：解析新格式的拉普拉斯方差（与旧“清晰度方差”同一指标，
// 量级一致，锚点直接复用），优先脸区方差（主体清晰度）、无脸回落全图方差；旧格式保留兼容历史入库 reason。
const RE_FACE_VAR = /脸区方差\s*(\d+(?:\.\d+)?)/
const RE_FULL_VAR = /全图方差\s*(-?\d+(?:\.\d+)?)/
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))

/** 拉普拉斯方差 -> 0~1 归一锐度（按锚点 log 归一，压制跨 200 倍的量纲） */
function normVar(v: number, a: { varLo: number; varHi: number }): number {
  const lv = (Math.log10(Math.max(1, v)) - Math.log10(a.varLo)) / (Math.log10(a.varHi) - Math.log10(a.varLo))
  return clamp01(lv)
}

/** 从 reason 解析原始测量值 -> 0~1 锐度分；解析不出返回 null */
export function sharpScore(tags: ImageRecord['tags']): number | null {
  const reason = tags.blur?.reason || ''
  const fm = RE_FACE_VAR.exec(reason)
  if (fm) return Number(normVar(Number(fm[1]), SHARP_ANCHORS.face).toFixed(4))
  const gm = RE_FULL_VAR.exec(reason)
  if (gm) return Number(normVar(Number(gm[1]), SHARP_ANCHORS.full).toFixed(4))
  const old = RE_SHARP.exec(reason) // 兼容 v2.0.64 前的旧格式（高频占比同向混用）
  if (old) {
    const a = SHARP_ANCHORS[(old[2] as 'face' | 'full')] || SHARP_ANCHORS.face
    const lh = (Number(old[3]) - a.hfLo) / (a.hfHi - a.hfLo)
    return Number((SHARP_VAR_WEIGHT * normVar(Math.max(1, Number(old[1])), a) + (1 - SHARP_VAR_WEIGHT) * clamp01(lh)).toFixed(4))
  }
  return null
}

export function scoreTier(tags: ImageRecord['tags'], settings?: AppSettings): TierKey | null {
  void settings
  // 瑕疵闸门（用户 2026-10-14 明确口径）：任何中/高瑕疵标签 → 无档位。
  // 既进不了优质也进不了良好（而且瑕疵图本就不在交付库，落在瑕疵片/待确认）。
  // “只能勉强进一般”指最坏也只能待在交付库最低档，绝不因“够锐”被提到优质/良好。
  // 人工干预不受此限：用户手动改档走 tier_by='user'，updateDetectResult/setDimTag 都不覆盖它。
  if (flawLevel(tags) !== 'none') return null
  const s = sharpScore(tags)
  const base: TierKey = s === null ? TIER_SHARP_UNKNOWN : s >= TIER_SHARP_TRUST ? 1 : s >= TIER_SHARP_OK ? 2 : 3
  // 高置信合拍照保底（用户拍板 2026-10-14，“修锐度+合影保底”）：规整摆拍合影是客户必交的交付主体，
  // 只要本身够“良好”就顶到优质；但太软（一般档）的合影不硬抬，避免把优质档稀释成一堆虚拍。能走到
  // 这里已确认无任何瑕疵（上一行闸门）。
  if (tags.group_photo?.level === 'high' && base <= 2) return 1
  return base
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
