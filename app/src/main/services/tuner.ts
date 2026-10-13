/**
 * 修正记录与阈值微调（第五章 5.4）
 * 不重训练模型，只基于用户修正反馈调整各维度置信度阈值：
 * - 全局累计 >= TUNE_MIN_CORRECTIONS 条，且单维度 >= TUNE_MIN_PER_DIM 才动该维度
 * - 误检比例高（用户频繁放行回交付库）-> 上调该维度 high 阈值（少标）
 * - 漏检信号（用户从交付库/其他分类主动移入该坏维度）-> 下调 mid 阈值（更早召回）
 *
 * 关键约束（一次性标定后新增）：学习结果只能在该维度基线的 ±一个台阶空隙内移动。
 * 不锁这个范围，“误检率高→+0.02 反复累加”会把阈值顶到 0.97，对 eyes（铁证档 1.0）
 * 和 blur（饱和 0.85）这类码内台阶维度等于直接关掉该检测项——静默漏检比误报严重。
 */
import { correctionStats, getSettings, saveSettings, getDb } from '../db'
import { effectiveThresholds } from '../classify'
import type { DimensionKey } from '../../shared/types'
import { BAD_DIMENSIONS, BASELINE_THRESHOLDS, FACT_DIMENSIONS, isBadDim } from '../../shared/types'

/**
 * 门槛从 200 降到 60：旧值在真实使用中几乎不可达（标定当时全库只有 17 条修正记录，
 * 自学习从未真跑过一次），名义上存在等于没有。降低带来的噪声由上面的 ±一个台阶
 * 锁范已接住：最坏情况也只是“少标一档”，不会把维度整体关掉。
 */
export const TUNE_MIN_CORRECTIONS = 60
/** 单维度至少这么多条才允许动它 */
export const TUNE_MIN_PER_DIM = 12
/** 学习可移动的最大幅度（相对基线）：一个台阶空隙 */
const TUNE_MAX_DRIFT = 0.05

export interface TuneReport {
  tuned: Array<{ dim: string; from: [number, number]; to: [number, number]; reason: string }>
  totalCorrections: number
  skippedReason?: string
}

/** 统计"用户把图移入坏维度"次数 = 漏检信号 */
function movedInCounts(): Record<string, number> {
  const rows = getDb()
    .prepare(`SELECT new_category c, COUNT(*) n FROM corrections WHERE action = 'wrong' AND new_category IN (${BAD_DIMENSIONS.map((d) => `'${d}'`).join(',')}) GROUP BY new_category`)
    .all() as Array<{ c: string; n: number }>
  const out: Record<string, number> = {}
  for (const r of rows) out[r.c] = r.n
  return out
}

export function autoTune(): TuneReport {
  const stats = correctionStats()
  const movedIn = movedInCounts()
  const settings = getSettings()
  const tuned: TuneReport['tuned'] = []
  let total = 0
  for (const s of Object.values(stats)) total += s.total
  if (total < TUNE_MIN_CORRECTIONS) {
    return { tuned, totalCorrections: total, skippedReason: `修正记录累计 ${total} 次，达到 ${TUNE_MIN_CORRECTIONS} 次后自动微调阈值` }
  }
  const next = { ...settings.tunedThresholds }
  for (const [dim, s] of Object.entries(stats)) {
    // 只调“缺陷维度”的阈值。人数四分类的合影/混合分界不在阈值上——它是冻结引擎里
    // 五道几何闸的硬结论，引擎给出的置信度是码内常量（0.86 / 0.88+score*0.1 等）。
    // 给人数维度写 tunedThresholds 只会把这些常量静默推过 high 线，
    // 标签降为 mid/low 后从视图与导出里凭空消失（之前就在 review 桶里发生过）。
    if (!isBadDim(dim)) continue
    // 重复图也在事实/结构名单里（分数常量 0.99）：写 tuned 只会把“全开”误调成“全关”。
    if (FACT_DIMENSIONS.includes(dim as DimensionKey)) continue
    const fpRate = s.falsePositive / Math.max(1, s.truePositive + s.falsePositive)
    const miss = movedIn[dim] || 0
    // 起点用“该维度此刻真正在用的阈值”（已含基线/场景/力度平移），
    // 以前直接拿全局 mid/high 当起点，一微调就把卡好的台阶推歪。
    const base = effectiveThresholds(dim as DimensionKey, settings)
    let [mid, high] = base
    // 以基线为锚的学习护栏：只能在一个台阶空隙内来回
    const bl = BASELINE_THRESHOLDS[dim as DimensionKey]
    const clampHigh = (v: number): number =>
      bl ? Math.min(Math.min(0.99, bl[1] + TUNE_MAX_DRIFT), Math.max(Math.max(0.5, bl[1] - TUNE_MAX_DRIFT), v)) : Math.min(0.99, Math.max(0.5, v))
    if (fpRate > 0.35 && s.total >= TUNE_MIN_PER_DIM) {
      high = clampHigh(high + 0.02 * Math.ceil(fpRate * 5))
      mid = Math.min(high - 0.05, mid + 0.01)
      tuned.push({ dim, from: base, to: [mid, high], reason: `误检率 ${(fpRate * 100).toFixed(0)}%，上调阈值减少误标` })
    } else if (miss >= 15) {
      mid = bl ? Math.max(Math.min(mid, bl[0] + TUNE_MAX_DRIFT), Math.max(0.3, bl[0] - TUNE_MAX_DRIFT)) : Math.max(0.5, mid - 0.02)
      tuned.push({ dim, from: base, to: [mid, high], reason: `用户手动移入 ${miss} 次（漏检信号），下调召回阈值` })
    } else continue
    // 只写“真的动了”的维度。以前无条件回写 base：那等于把用户当时那一档的平移结果
    // 当快照永久锁死，tuned 优先级高于力度平移，之后切档对这些维度就再也不生效了。
    next[dim as DimensionKey] = [Number(mid.toFixed(3)), Number(high.toFixed(3))]
  }
  if (tuned.length) saveSettings({ tunedThresholds: next })
  return { tuned, totalCorrections: total }
}

/** 手动重置学习到的阈值 */
export function resetTuned(): void {
  saveSettings({ tunedThresholds: {} })
}
