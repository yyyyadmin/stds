/**
 * 导出模块（第六章）
 * - 垃圾桶自动排除（任何模式）；待确认默认排除（可勾选包含）
 * - 模式：include 包含式 / exclude 排除式 / library 成品库 / all 全部（垃圾桶除外）
 * - 选项：目标目录、格式转换（sharp）、按分类建子文件夹、保留原名、重名处理、物理移动
 * - 进度事件 + 取消
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs'
import { basename, extname, join } from 'path'
import { EventEmitter } from 'events'
import sharp from 'sharp'
import { getDb } from '../db'
import {
  BAD_DIMENSIONS,
  CAT_LIBRARY,
  CAT_REVIEW,
  CAT_TRASH,
  CAT_DUP_TRASH,
  isTrashLike,
  DIMENSION_LABELS,
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
  buildList(opts: ExportOptions): Array<{ id: number; path: string; category: CategoryKey; filename: string }> {
    const rows = getDb()
      .prepare(`SELECT id, path, category, filename, tags, status FROM images WHERE category NOT IN ('trash','dup_trash') AND status != 'skip'`)
      .all() as Array<{ id: number; path: string; category: string; filename: string; tags: string | null; status: string }>
    const selected = new Set(opts.categories)
    const out: Array<{ id: number; path: string; category: CategoryKey; filename: string }> = []
    for (const r of rows) {
      if (isTrashLike(r.category)) continue // 双保险：垃圾桶/重复废弃桶永不导出
      // 待确认门槛只作用于“泛取”模式（all/exclude/library 会顺带扫进主分类为待确认的图）。
      // include（只导出勾选分类）模式下用户已显式选中该分类，其标签并集成员里主分类恰为
      // 待确认的图必须一并导出，否则导出数会小于侧栏徽章数（“数量对不上”）。
      if (!opts.includeReview && opts.mode !== 'include' && r.category === CAT_REVIEW) continue
      const tags = this.parseTags(r)
      const mk = (cat: CategoryKey) => out.push({ id: r.id, path: r.path, category: cat, filename: r.filename })
      switch (opts.mode) {
        case 'library':
          if (this.isLibrary(r.category)) mk(r.category)
          break
        case 'all':
          mk(r.category)
          break
        case 'include':
          for (const c of selected) if (this.matchesCat(r, tags, c)) mk(c)
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

  /** 图片是否属于分类 cat（复刻 listByCategory 的并集视图语义，垃圾桶除外） */
  private matchesCat(r: { category: string; status: string }, tags: Record<string, { level?: string }>, cat: CategoryKey): boolean {
    if (isTrashLike(cat) || isTrashLike(r.category)) return false
    if (cat === CAT_REVIEW) return r.category === CAT_REVIEW
    if (cat === CAT_LIBRARY) return this.isLibrary(r.category)
    if ((BAD_DIMENSIONS as string[]).includes(cat) || (NEUTRAL_DIMENSIONS as string[]).includes(cat)) {
      const t = tags[cat]
      return r.category === cat || (!!t && t.level !== 'low')
    }
    return r.category === cat // 自定义分类等按归属
  }

  private isLibrary(cat: string): boolean {
    return !(BAD_DIMENSIONS as string[]).includes(cat) && cat !== CAT_REVIEW && !isTrashLike(cat)
  }

  previewCount(opts: ExportOptions): { will: number; total: number } {
    const total = (getDb().prepare(`SELECT COUNT(*) c FROM images WHERE category NOT IN ('trash','dup_trash') AND status != 'skip'`).get() as { c: number }).c
    return { will: this.buildList(opts).length, total }
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
    item: { id: number; path: string; category: CategoryKey; filename: string },
    opts: ExportOptions,
    usedNames: Set<string>
  ): Promise<void> {
    let dir = opts.targetDir
    if (opts.subfolders) {
      const label = this.categoryLabel(item.category)
      dir = join(dir, label)
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

  categoryLabel(cat: CategoryKey): string {
    if ((BAD_DIMENSIONS as string[]).includes(cat) || (NEUTRAL_DIMENSIONS as string[]).includes(cat)) {
      return DIMENSION_LABELS[cat as keyof typeof DIMENSION_LABELS] || cat
    }
    if (cat === CAT_LIBRARY) return '成品库'
    if (cat === CAT_REVIEW) return '待确认'
    if (cat === CAT_TRASH) return '垃圾桶'
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
