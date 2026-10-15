/**
 * 导出模块（第六章）
 * - 废弃库自动排除（任何模式）；待确认默认排除（可勾选包含）
 * - 模式：include 包含式 / exclude 排除式 / library 交付库 / all 全部（废弃库除外）
 * - 交付库档位（D4 用户规则）：library 模式统一落 交付库/<档位名>/ 二级子目录，
 *   不再按人数主分类分 folder；包含/排除式勾选档位子类目时同口径
 * - 选项：目标目录、格式转换（sharp）、按分类建子文件夹、保留原名、重名处理、物理移动
 * - 进度事件 + 取消
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs'
import { basename, extname, join } from 'path'
import { EventEmitter } from 'events'
import sharp from 'sharp'
import { getDb, getSettings } from '../db'
import {
  BAD_DIMENSIONS,
  CAT_LIBRARY,
  CAT_FLAWS,
  CAT_REVIEW,
  CAT_TRASH,
  CAT_DUP_TRASH,
  isTrashLike,
  isDeliverable,
  isDupRedundant,
  flawLevel,
  tierOfCat,
  DEFAULT_TIER_NAMES,
  DIMENSION_LABELS,
  STRUCTURAL_DIMENSIONS,
  NEUTRAL_DIMENSIONS
} from '../../shared/types'
import type { CategoryKey } from '../../shared/types'

export interface ExportOptions {
  mode: 'include' | 'exclude' | 'library' | 'all'
  categories: CategoryKey[]
  includeReview: boolean
  targetDir: string
  format: 'original' | 'jpg' | 'png'
  subfolders: boolean
  keepNames: boolean
  physicalMove: boolean
  conflict: 'number' | 'skip' | 'overwrite'
  /** 仅 library 模式：勾选要导的档位，空/undefined = 全部 */
  tiers?: import('../../shared/types').TierKey[]
  /** 仅 library 模式：flat = 合并到一个目录，subdirs = 按档位建子目录 */
  tierLayout?: 'flat' | 'subdirs'
  /** 仅 library + flat：输出文件夹名（默认“交付库”） */
  folderName?: string
}

export interface ExportProgress {
  running: boolean
  done: number
  total: number
  current: string
  finished?: { success: number; skipped: number; failed: number; target: string }
}

class Exporter extends EventEmitter {
  private cancelRequested = false
  private running = false

  /** 构建待导出文件清单（第六章 6.5）
   *  关键：包含/排除式对"维度分类"采用与侧栏一致的标签并集口径——一张图只要带了该维度
   *  的中/高置信标签就算命中该分类（即使它的主 category 是别的），使"分类里多少张就导多少张"。
   *  一图命中多个勾选分类时，按分类各产出一条 → 各自进对应子目录（多分类=多目录+各自真实数量）。 */
  buildList(opts: ExportOptions): Array<{ id: number; path: string; category: CategoryKey; filename: string; tier: number | null; fileSize: number }> {
    const rows = getDb()
      .prepare(`SELECT id, path, category, filename, tags, tier, status, file_size FROM images WHERE category NOT IN ('trash','dup_trash') AND status != 'skip'`)
      .all() as Array<{ id: number; path: string; category: string; filename: string; tags: string | null; tier: number | null; status: string; file_size: number }>
    const selected = new Set(opts.categories)
    const out: Array<{ id: number; path: string; category: CategoryKey; filename: string; tier: number | null; fileSize: number }> = []
    for (const r of rows) {
      if (isTrashLike(r.category)) continue // 双保险：废弃库/重复废弃桶永不导出
      // 待确认门槛只作用于“泛取”模式（all/exclude/library 会顺带扫进主分类为待确认的图）。
      // include（只导出勾选分类）模式下用户已显式选中该分类，其标签并集成员里主分类恰为
      // 待确认的图必须一并导出，否则导出数会小于侧栏徽章数（“数量对不上”）。
      if (!opts.includeReview && opts.mode !== 'include' && r.category === CAT_REVIEW) continue
      const tags = this.parseTags(r)
      const mk = (cat: CategoryKey) => out.push({ id: r.id, path: r.path, category: cat, filename: r.filename, tier: r.tier, fileSize: r.file_size || 0 })
      switch (opts.mode) {
        case 'library':
          // 交付库导出统一按 CAT_LIBRARY 落盘；新版支持只导指定档位
          if (isDeliverable(r.category, tags)) {
            if (opts.tiers && opts.tiers.length > 0 && r.tier != null && !opts.tiers.includes(r.tier as 1 | 2 | 3)) break
            mk(CAT_LIBRARY)
          }
          break
        case 'all':
          mk(r.category)
          break
        case 'include':
          for (const c of selected) {
            // 同时勾了交付库和某档位时跳过档位：library 已覆盖全部档位，否则同一张图
            // 会在 交付库/<档位>/ 里重复落两份（档位是交付库的真子集，不同于维度重叠口径）
            if (selected.has(CAT_LIBRARY) && tierOfCat(c)) continue
            if (this.matchesCat(r, tags, c)) mk(c)
          }
          break
        case 'exclude': {
          let excluded = false
          for (const c of selected) if (this.matchesCat(r, tags, c)) { excluded = true; break }
          if (!excluded) mk(r.category)
          break
        }
      }
    }
    return out
  }

  private parseTags(r: { tags: string | null; status: string }): Record<string, { level?: string }> {
    if (r.status !== 'done' || !r.tags) return {}
    try {
      return JSON.parse(r.tags) as Record<string, { level?: string }>
    } catch {
      return {}
    }
  }

  /** 图片是否属于分类 cat（与 db.matchesView 同一口径，废弃库除外）：D2 三档状态视图看“主分类+瑕疵等级”，内容维度看标签并集，档位看 tier 列 */
  private matchesCat(r: { category: string; status: string; tier?: number | null }, tags: Record<string, { level?: string }>, cat: CategoryKey): boolean {
    if (isTrashLike(cat) || isTrashLike(r.category)) return false
    // 档位子类目（D4）：与 db.matchesView 同口径 = 交付库成员且 tier 相等
    const tierN = tierOfCat(cat)
    if (tierN) return isDeliverable(r.category, tags) && r.tier === tierN
    if (cat === CAT_LIBRARY) return isDeliverable(r.category, tags)
    // 与 db.matchesView 逐条同口径（否则 include 模式导出数与侧栏徽章对不上）：
    // 停在待确认拍板位的（重复组“整组没一张能交”的代表帧）算待确认、不再同时算瑕疵片；
    // 冗余帧也不占待确认（它属于重复照片那一栏，由用户在组里决定去留）。
    if (cat === CAT_FLAWS) return r.category !== CAT_REVIEW && flawLevel(tags) === 'high'
    if (cat === CAT_REVIEW) return !isDupRedundant(tags) && (r.category === CAT_REVIEW || flawLevel(tags) === 'mid')
    // 结构维度（重复/连拍 v2.0.67）也是可导出的分类：与 db.matchesView 同口径走标签并集（勾它导出的是组里被判定多余的那几张）
    if ((BAD_DIMENSIONS as string[]).includes(cat) || (NEUTRAL_DIMENSIONS as string[]).includes(cat) || (STRUCTURAL_DIMENSIONS as string[]).includes(cat)) {
      const t = tags[cat]
      return r.category === cat || (!!t && t.level !== 'low')
    }
    return r.category === cat // 自定义分类等按归属
  }

  previewCount(opts: ExportOptions): { will: number; total: number; byTier: Record<1 | 2 | 3, number>; sizeMB: number | null } {
    const total = (getDb().prepare(`SELECT COUNT(*) c FROM images WHERE category NOT IN ('trash','dup_trash') AND status != 'skip'`).get() as { c: number }).c
    const list = this.buildList(opts)
    const byTier: Record<1 | 2 | 3, number> = { 1: 0, 2: 0, 3: 0 }
    for (const it of list) {
      if (it.tier === 1 || it.tier === 2 || it.tier === 3) byTier[it.tier] += 1
    }
    // 容量估算只在原格式下给出（转码后大小不可预知）：同一张因多分类落多目录会重复计入，与实际磁盘占用一致
    const sizeMB = opts.format === 'original' ? list.reduce((s, it) => s + it.fileSize, 0) / 1048576 : null
    return { will: list.length, total, byTier, sizeMB }
  }

  cancel(): void {
    this.cancelRequested = true
  }

  isRunning(): boolean {
    return this.running
  }

  async run(opts: ExportOptions): Promise<ExportProgress['finished']> {
    if (this.running) throw new Error('导出正在进行中')
    const list = this.buildList(opts)
    if (!list.length) throw new Error('没有符合条件的图片可导出')
    if (!opts.targetDir) throw new Error('请选择目标目录')
    mkdirSync(opts.targetDir, { recursive: true })
    this.running = true
    this.cancelRequested = false
    const progress: ExportProgress = { running: true, done: 0, total: list.length, current: '' }
    let success = 0
    let skipped = 0
    let failed = 0
    const usedNames = new Set<string>()
    try {
      for (const item of list) {
        if (this.cancelRequested) break
        progress.current = item.filename
        this.emit('progress', { ...progress })
        try {
          await this.exportOne(item, opts, usedNames)
          success++
        } catch (e) {
          if ((e as Error).message === 'conflict-skip') skipped++
          else failed++
        }
        progress.done++
        if (progress.done % 5 === 0) await new Promise((r) => setImmediate(r))
      }
    } finally {
      this.running = false
      progress.running = false
      progress.finished = { success, skipped, failed, target: opts.targetDir }
      this.emit('progress', { ...progress })
    }
    return progress.finished
  }

  private async exportOne(
    item: { id: number; path: string; category: CategoryKey; filename: string; tier: number | null; fileSize: number },
    opts: ExportOptions,
    usedNames: Set<string>
  ): Promise<void> {
    let dir = opts.targetDir
    if (opts.subfolders) {
      // 目录落点（D4 用户规则）：档位相关的一律是 交付库/<档位名>/ 二级——
      // library 模式的图（tier 列驱动）和 include 模式直接勾选的档位子类目都走这一条；
      // 其余分类保持一层目录不变
      const tierN = tierOfCat(item.category)
      if (tierN) {
        // 勾选的就是档位：categoryLabel 只会给出档位名，一级得手动补上“交付库”
        dir = join(dir, this.categoryLabel(CAT_LIBRARY), this.tierDirName(tierN))
      } else {
        dir = join(dir, this.categoryLabel(item.category))
        if (item.category === CAT_LIBRARY && item.tier) dir = join(dir, this.tierDirName(item.tier))
      }
      mkdirSync(dir, { recursive: true })
    }
    const convert = opts.format !== 'original'
    const ext = convert ? (opts.format === 'jpg' ? '.jpg' : '.png') : extname(item.path) || '.jpg'
    const stem = opts.keepNames ? basename(item.path, extname(item.path)) : `${labelSafe(this.categoryLabel(item.category))}_${item.id}`
    const target = join(dir, stem + ext)
    const finalName = this.resolveConflict(target, opts.conflict, usedNames)
    if (finalName === null) throw new Error('conflict-skip')

    if (convert) {
      const pipeline = () => sharp(item.path, { failOn: 'none' }).rotate()
      try {
        if (opts.format === 'png') await pipeline().png().toFile(finalName)
        else await pipeline().jpeg({ quality: 92 }).toFile(finalName)
      } catch {
        copyFileSync(item.path, finalName) // 转换失败按原样复制兜底
      }
    } else if (opts.physicalMove) {
      renameSync(item.path, finalName)
    } else {
      copyFileSync(item.path, finalName)
    }
    usedNames.add(finalName)
  }

  private resolveConflict(target: string, strategy: ExportOptions['conflict'], usedNames: Set<string>): string | null {
    const dir = target.replace(/[\\/][^\\/]*$/, '')
    const name = basename(target)
    const ext = extname(name)
    const stem = name.slice(0, name.length - ext.length)
    if (!existsSync(target) && !usedNames.has(target)) return target
    if (strategy === 'skip') return null
    if (strategy === 'overwrite') return target
    for (let i = 1; i < 10000; i++) {
      const cand = join(dir, `${stem}_${i}${ext}`)
      if (!existsSync(cand) && !usedNames.has(cand)) return cand
    }
    return null
  }

  /** 档位目录名：设置可改（tierNames），与侧栏子行共用同一单源 */
  private tierDirName(n: number): string {
    const names = getSettings().tierNames ?? DEFAULT_TIER_NAMES
    return names[n - 1] || String(n)
  }

  categoryLabel(cat: CategoryKey): string {
    // 档位子视图（D4）：导出目录名用“交付库/档位名”里的档位名
    const tierN = tierOfCat(cat)
    if (tierN) return this.tierDirName(tierN)
    if ((BAD_DIMENSIONS as string[]).includes(cat) || (NEUTRAL_DIMENSIONS as string[]).includes(cat) || (STRUCTURAL_DIMENSIONS as string[]).includes(cat)) {
      return DIMENSION_LABELS[cat as keyof typeof DIMENSION_LABELS] || cat
    }
    if (cat === CAT_LIBRARY) return '交付库'
    if (cat === CAT_FLAWS) return '瑕疵片'
    if (cat === CAT_REVIEW) return '待确认'
    if (cat === CAT_TRASH) return '废弃库'
    if (cat === CAT_DUP_TRASH) return '重复废弃'
    if (cat.startsWith('custom:')) {
      const row = getDb().prepare('SELECT name FROM custom_categories WHERE id = ?').get(Number(cat.slice(7))) as { name: string } | undefined
      return row?.name || '自定义'
    }
    return cat
  }
}

function labelSafe(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_')
}

void statSync
export const exporter = new Exporter()
