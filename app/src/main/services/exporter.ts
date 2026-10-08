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

  /** 构建待导出文件清单（第六章 6.5 SQL 查询） */
  buildList(opts: ExportOptions): Array<{ id: number; path: string; category: CategoryKey; filename: string }> {
    const rows = getDb()
      .prepare(`SELECT id, path, category, filename FROM images WHERE category != 'trash' AND status != 'skip'`)
      .all() as Array<{ id: number; path: string; category: string; filename: string }>
    const selected = new Set(opts.categories)
    return rows.filter((r) => {
      if (r.category === CAT_TRASH) return false // 双保险
      if (!opts.includeReview && r.category === CAT_REVIEW) return false
      switch (opts.mode) {
        case 'library':
          return this.isLibrary(r.category)
        case 'all':
          return true
        case 'include': {
          if (selected.has(CAT_LIBRARY) && this.isLibrary(r.category)) return true
          return selected.has(r.category)
        }
        case 'exclude': {
          if (selected.has(CAT_LIBRARY) && this.isLibrary(r.category)) return false
          return !selected.has(r.category)
        }
      }
    })
  }

  private isLibrary(cat: string): boolean {
    return !(BAD_DIMENSIONS as string[]).includes(cat) && cat !== CAT_REVIEW && cat !== CAT_TRASH
  }

  previewCount(opts: ExportOptions): { will: number; total: number } {
    const total = (getDb().prepare(`SELECT COUNT(*) c FROM images WHERE category != 'trash' AND status != 'skip'`).get() as { c: number }).c
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
