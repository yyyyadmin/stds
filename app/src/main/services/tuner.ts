/**
 * 修正记录与阈值微调（第五章 5.4）
 * 不重训练模型，只基于用户修正反馈调整各维度置信度阈值：
 * - 某维度累计修正 >= TUNE_MIN_CORRECTIONS 次后触发
 * - 误检比例高（用户频繁"判定错误"移回成品库）-> 上调该维度 high 阈值（少标）
 * - 漏检信号（用户从成品库/其他分类主动移入该坏维度）-> 下调 mid 阈值（更早召回）
 */
import { correctionStats, getSettings, saveSettings, getDb } from '../db'
import type { DimensionKey } from '../../shared/types'
import { BAD_DIMENSIONS } from '../../shared/types'

export const TUNE_MIN_CORRECTIONS = 200

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
    const fpRate = s.falsePositive / Math.max(1, s.truePositive + s.falsePositive)
    const miss = movedIn[dim] || 0
    const base = next[dim as DimensionKey] || [settings.midThreshold, settings.highThreshold]
    let [mid, high] = base
    if (fpRate > 0.35 && s.total >= 20) {
      high = Math.min(0.97, high + 0.02 * Math.ceil(fpRate * 5))
      mid = Math.min(high - 0.05, mid + 0.01)
      tuned.push({ dim, from: base, to: [mid, high], reason: `误检率 ${(fpRate * 100).toFixed(0)}%，上调阈值减少误标` })
    } else if (miss >= 15) {
      mid = Math.max(0.5, mid - 0.02)
      tuned.push({ dim, from: base, to: [mid, high], reason: `用户手动移入 ${miss} 次（漏检信号），下调召回阈值` })
    }
    next[dim as DimensionKey] = [Number(mid.toFixed(3)), Number(high.toFixed(3))]
  }
  if (tuned.length) saveSettings({ tunedThresholds: next })
  return { tuned, totalCorrections: total }
}

/** 手动重置学习到的阈值 */
export function resetTuned(): void {
  saveSettings({ tunedThresholds: {} })
}
