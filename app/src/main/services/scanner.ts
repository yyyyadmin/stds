/**
 * 筛选调度（第九章 9.1 + 第十章）
 * - 队列 = 数据库中 status pending/error 的图片（天然支持断点续跑）
 * - 并发 = 引擎 worker 数（Python 多进程池 / Node 2 并发）
 * - 检测一张入库一张，实时向渲染层推送进度与结果
 * - 重复/连拍为跨图后置聚类：DCT 感知哈希 Hamming 距离 -> 相似度（>0.95 重复高置信；0.85-0.95 连拍待确认）
 */
import { EventEmitter } from 'events'
import { basename } from 'path'
import {
  getImage,
  getDb,
  listImages,
  pendingImages,
  updateDetectResult,
  getSettings
} from '../db'
import { gradeDims, computeCategory } from '../classify'
import { engineManager } from '../engine'
import type { DetectResult, DimensionKey, ImageRecord } from '../../shared/types'
import { CAT_TRASH } from '../../shared/types'

export interface ScanProgress {
  running: boolean
  done: number
  total: number
  current: string
  phase: 'init' | 'scanning' | 'dup-cluster' | 'done' | 'stopped' | 'error'
  message?: string
}

export interface DetectDimsRaw {
  [k: string]: { confidence: number; reason?: string; method?: string }
}

class Scanner extends EventEmitter {
  private queue: number[] = []
  private running = false
  private stopRequested = false
  private progress: ScanProgress = { running: false, done: 0, total: 0, current: '', phase: 'done' }
  /** 本会话哈希表：id -> phash，聚类用 */
  private hashes = new Map<number, string>()

  getProgress(): ScanProgress {
    return this.progress
  }

  isRunning(): boolean {
    return this.running
  }

  /** 开始/继续筛选（断点续跑：只处理 pending/error 状态图片） */
  async start(): Promise<{ started: boolean; message: string }> {
    if (this.running) return { started: false, message: '筛选已在进行中' }
    const pending = pendingImages()
    if (!pending.length) {
      const total = (getDb().prepare('SELECT COUNT(*) c FROM images WHERE status != \'skip\'').get() as { c: number }).c
      if (!total) return { started: false, message: '请先导入照片' }
      return { started: false, message: '所有照片已完成筛选' }
    }
    const settings = getSettings()
    this.progress = { running: true, done: 0, total: pending.length, current: '', phase: 'init', message: '正在启动 AI 引擎...' }
    this.emit('progress', this.progress)
    this.running = true
    this.stopRequested = false
    try {
      await engineManager.init(settings.enginePreference, settings.devicePreference)
    } catch (e) {
      this.running = false
      this.progress = { ...this.progress, running: false, phase: 'error', message: '引擎启动失败：' + String(e) }
      this.emit('progress', this.progress)
      return { started: false, message: this.progress.message || '引擎启动失败' }
    }
    const status = engineManager.getStatus()
    this.progress.message = status.message
    this.emit('progress', this.progress)
    // 异步执行，不阻塞 IPC 返回
    void this.run(pending)
    return { started: true, message: status.message }
  }

  stop(): void {
    this.stopRequested = true
  }

  private async run(pending: ImageRecord[]): Promise<void> {
    this.queue = pending.map((p) => p.id)
    const concurrency = Math.max(1, Math.min(engineManager.getStatus().workers || 1, 4))
    this.progress = { ...this.progress, phase: 'scanning' }
    this.emit('progress', this.progress)

    const workers: Promise<void>[] = []
    for (let i = 0; i < concurrency; i++) {
      workers.push(this.workerLoop())
    }
    await Promise.all(workers)

    if (!this.stopRequested) {
      // 重复/连拍后置聚类
      this.progress = { ...this.progress, phase: 'dup-cluster', message: '正在进行重复/连拍聚类...' }
      this.emit('progress', this.progress)
      try {
        await this.clusterDuplicates()
      } catch (e) {
        console.error('dup cluster failed', e)
      }
      // 补跑聚类阶段新产生 pending 的图（导入时未解码后补等场景保险）
    }

    const done = this.progress.done
    this.running = false
    this.progress = {
      ...this.progress,
      running: false,
      phase: this.stopRequested ? 'stopped' : 'done',
      message: this.stopRequested
        ? `已停止（${done}/${this.progress.total}），下次开始将自动续跑`
        : `筛选完成：${done} 张`
    }
    this.emit('progress', this.progress)
  }

  private async workerLoop(): Promise<void> {
    while (this.queue.length) {
      if (this.stopRequested) break
      const id = this.queue.shift()
      if (id == null) break
      const rec = getImage(id)
      if (!rec) continue
      this.progress = { ...this.progress, current: basename(rec.path) }
      this.emit('progress', this.progress)
      try {
        const raw = (await engineManager.detect(rec.path, rec.id)) as unknown as DetectResult & { phash?: string; nodeEngine?: boolean }
        this.handleResult(rec, raw)
      } catch (e) {
        updateDetectResult(rec.id, rec.tags, rec.details, rec.dupGroup, rec.category, rec.categoryBy, 'error')
        this.emit('image', { ...rec, status: 'error' })
      }
      this.progress.done++
      if (this.progress.done % 5 === 0 || !this.queue.length) this.emit('progress', this.progress)
    }
  }

  private handleResult(rec: ImageRecord, raw: DetectResult & { phash?: string }): void {
    const settings = getSettings()
    const { tags } = gradeDims(raw.dims as DetectDimsRaw, settings)
    if (raw.phash) this.hashes.set(rec.id, raw.phash)
    // 垃圾桶中的图片：标签更新但不改分类
    let category: string = rec.category
    if (rec.category === CAT_TRASH) {
      category = CAT_TRASH
    } else {
      category = computeCategory(tags, settings, rec)
    }
    const details = {
      faces: raw.faces || [],
      faceCount: raw.faceCount ?? (raw.faces || []).length,
      engine: engineManager.getStatus().type,
      phash: raw.phash
    }
    updateDetectResult(rec.id, tags, details, null, category, rec.category === CAT_TRASH ? 'user' : 'ai', 'done')
    const updated = getImage(rec.id)
    this.emit('image', updated)
  }

  /** 重复/连拍聚类：按目录分桶，Hamming 距离，首张保留，其余标 duplicate */
  private async clusterDuplicates(): Promise<void> {
    const settings = getSettings()
    const rows = getDb()
      .prepare(`SELECT id, path, details FROM images WHERE status = 'done'`)
      .all() as Array<{ id: number; path: string; details: string | null }>
    const items: Array<{ id: number; dir: string; hash: string | null }> = []
    for (const r of rows) {
      let hash: string | null = this.hashes.get(r.id) || null
      if (!hash && r.details) {
        try {
          hash = (JSON.parse(r.details).phash as string) || null
        } catch {
          /* ignore */
        }
      }
      items.push({ id: r.id, dir: r.path.replace(/[\\/][^\\/]*$/, ''), hash })
    }
    // 并查集
    const parent = new Map<number, number>()
    const find = (x: number): number => {
      while (parent.get(x) !== x) x = parent.get(x)!
      return x
    }
    const union = (a: number, b: number) => {
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) parent.set(rb, ra)
    }
    const byDir = new Map<string, typeof items>()
    for (const it of items) {
      if (!it.hash) continue
      parent.set(it.id, it.id)
      const list = byDir.get(it.dir) || []
      list.push(it)
      byDir.set(it.dir, list)
    }
    for (const [, list] of byDir) {
      for (let i = 0; i < list.length; i++) {
        if (this.stopRequested) return
        for (let j = i + 1; j < list.length; j++) {
          const sim = similarity(list[i].hash!, list[j].hash!)
          if (sim >= 0.85) union(list[i].id, list[j].id)
        }
        if (i % 200 === 0) await new Promise((r) => setImmediate(r))
      }
    }
    // 组内除"第一张"（id 最小 = 最早导入）外全部打 duplicate 标签
    const groups = new Map<number, number[]>()
    for (const it of items) {
      if (!it.hash || !parent.has(it.id)) continue
      const root = find(it.id)
      const g = groups.get(root) || []
      g.push(it.id)
      groups.set(root, g)
    }
    const groupIdOf = new Map<number, string>()
    for (const [root, ids] of groups) {
      if (ids.length < 2) continue
      ids.sort((a, b) => a - b)
      const gid = `dup:${root}`
      for (const id of ids) groupIdOf.set(id, gid)
      const first = ids[0]
      // 首张也记录组，但只有它保持原分类（作为保留帧）
      const rest = ids.filter((i) => i !== first)
      for (const id of rest) {
        const rec = getImage(id)
        if (!rec || rec.category === CAT_TRASH || rec.categoryBy === 'user') continue
        // 组内两两相似度决定置信度：与保留帧的最高相似度
        const fh = this.hashes.get(first) || hashOf(rec)
        let best = 0
        for (const other of ids) {
          if (other === id) continue
          const oh = this.hashes.get(other)
          if (oh && fh) best = Math.max(best, similarity(fh, oh))
        }
        const conf = Math.min(0.99, best)
        const dims = { duplicate: { confidence: conf, reason: `与同场景照片相似度 ${(conf * 100).toFixed(0)}%，属于连拍/重复帧`, method: 'phash-cluster' } }
        const { tags } = gradeDims(dims, settings)
        const mergedTags = { ...rec.tags, ...tags }
        const category = computeCategory(mergedTags, getSettings(), rec)
        updateDetectResult(id, mergedTags, { ...(rec.details || {}), dupGroup: gid }, gid, category, 'ai', rec.status)
        this.emit('image', getImage(id))
      }
      const firstRec = getImage(first)
      if (firstRec) {
        updateDetectResult(first, firstRec.tags, { ...(firstRec.details || {}), dupGroup: gid }, gid, firstRec.category, firstRec.categoryBy, firstRec.status)
      }
    }
  }
}

function hashOf(rec: ImageRecord): string | null {
  const d = rec.details as { phash?: string } | null
  return d?.phash || null
}

/** Hamming -> 相似度 */
export function similarity(h1: string, h2: string): number {
  if (!h1 || !h2 || h1.length !== h2.length) return 0
  let dist = 0
  for (let i = 0; i < h1.length; i++) {
    let x = parseInt(h1[i], 16) ^ parseInt(h2[i], 16)
    while (x) {
      dist += x & 1
      x >>= 1
    }
  }
  return 1 - dist / (h1.length * 4)
}

/** 阈值等设置变化后，无需重新检测，直接用现存 tags 重算分类 */
export function reclassifyAll(): void {
  const settings = getSettings()
  const images = listImages()
  const setCat = getDb().prepare('UPDATE images SET category = ? WHERE id = ?')
  for (const img of images) {
    if (img.status !== 'done') continue
    if (img.category === CAT_TRASH) continue
    if (img.categoryBy === 'user' && img.category.startsWith('custom:')) continue
    const cat = computeCategory(img.tags, settings, img)
    setCat.run(cat, img.id)
  }
}

/** 单图分类重算（一键修正 / 手动移动后动态更新成品库归属） */
export function reclassifyImage(id: number): ImageRecord | null {
  const rec = getImage(id)
  if (!rec) return null
  const cat = computeCategory(rec.tags, getSettings(), rec)
  getDb().prepare('UPDATE images SET category = ? WHERE id = ?').run(cat, id)
  return getImage(id)
}

export const scanner = new Scanner()
