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
import { logError } from '../logger'
import { dumpCalibration } from './calib'
import { ensureNormalizedJpeg } from './rawPreview'
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
  /** 连续检测失败计数：用于引擎健康熔断（连续过多失败自动停止，避免长时间假死） */
  private consecFail = 0
  private engineAborted = false
  /** 最近一次检测失败的原因：熔断时展示到进度消息，便于安装包内定位（console 在打包版不可见） */
  private lastError = ''
  /** 本会话哈希表：id -> phash，聚类用 */
  private hashes = new Map<number, string>()

  getProgress(): ScanProgress {
    return this.progress
  }

  isRunning(): boolean {
    return this.running
  }

  /** 开始/继续筛选（断点续跑：只处理 pending/error 状态图片）
   *  关键：本方法立即返回，引擎初始化与检测在 startAsync 异步进行，
   *  避免引擎启动卡住时阻塞 scanStart IPC 导致停止/清空等全部无响应。 */
  async start(): Promise<{ started: boolean; message: string }> {
    if (this.running) return { started: false, message: '筛选已在进行中' }
    const pending = pendingImages()
    if (!pending.length) {
      const total = (getDb().prepare('SELECT COUNT(*) c FROM images WHERE status != \'skip\'').get() as { c: number }).c
      if (!total) return { started: false, message: '请先导入照片' }
      return { started: false, message: '所有照片已完成筛选' }
    }
    this.progress = { running: true, done: 0, total: pending.length, current: '', phase: 'init', message: '正在启动 AI 引擎...' }
    this.emit('progress', this.progress)
    this.running = true
    this.stopRequested = false
    this.consecFail = 0
    this.engineAborted = false
    void this.startAsync(pending)
    return { started: true, message: '正在启动 AI 引擎...' }
  }

  /** 异步：启动引擎（失败/超时降级 Node）→ 跑队列。全程不阻塞 IPC。 */
  private async startAsync(pending: ImageRecord[]): Promise<void> {
    const settings = getSettings()
    try {
      await engineManager.init(settings.enginePreference, settings.devicePreference)
    } catch (e) {
      // 自带/系统引擎启动异常：降级到内置 Node 基础引擎，保证筛选不卡死
      console.error('engine init failed, fallback to node:', e)
      try {
        await engineManager.init('node', 'cpu')
      } catch (e2) {
        this.running = false
        this.progress = { ...this.progress, running: false, phase: 'error', message: '引擎启动失败：' + String(e2) }
        this.emit('progress', this.progress)
        return
      }
    }
    if (this.stopRequested) {
      this.running = false
      this.progress = { ...this.progress, running: false, phase: 'stopped', message: '已停止' }
      this.emit('progress', this.progress)
      return
    }
    const status = engineManager.getStatus()
    this.progress = { ...this.progress, message: status.message }
    this.emit('progress', this.progress)
    await this.run(pending)
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
    // 校准数据静默落盘（开发者诊断，无 UI）：完成/停止都写；退出前还会再写一次，带上这期间用户的手动纠错
    dumpCalibration()
    this.progress = {
      ...this.progress,
      running: false,
      phase: this.engineAborted ? 'error' : this.stopRequested ? 'stopped' : 'done',
      message: this.engineAborted
        ? `AI 引擎连续检测失败，已自动停止（${done}/${this.progress.total}）。最后错误：${this.lastError || '未知'}。请把此行截图发给开发者；或到设置里切换为“内置基础引擎”后重试`
        : this.stopRequested
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
        // RAW/HEIC/AVIF 先归一化为“已按 EXIF 转正”的 JPEG 缓存再检测：冻结 Python 引擎解不开这些格式，
        // 而 sharp 链路（含 RAW 内嵌预览兜底）已被验证可用；普通格式原路返回无额外开销。
        const detectPath = await ensureNormalizedJpeg(rec.path)
        const raw = (await engineManager.detect(detectPath, rec.id)) as unknown as DetectResult & { phash?: string; nodeEngine?: boolean; error?: string }
        // 引擎以 in-band error 返回（如无法解码：中文路径/RAW/HEIC）且无任何维度结果时，
        // 绝不能当成“正常但无坏维度”静默判进成品库——必须走失败路径，让状态可见并计入熔断。
        if (raw && raw.error && (!raw.dims || Object.keys(raw.dims).length === 0)) {
          throw new Error(String(raw.error))
        }
        this.handleResult(rec, raw)
        this.consecFail = 0
      } catch (e) {
        const errMsg = String((e as Error)?.message || e)
        this.lastError = errMsg
        // 逐张落盘“文件名 + 具体错误”：否则单张失败只写 DB status，错误文本随风消散，无法定位真因
        logError('detect-fail', `${basename(rec.path)} :: ${errMsg}`)
        updateDetectResult(rec.id, rec.tags, rec.details, rec.dupGroup, rec.category, rec.categoryBy, 'error')
        this.emit('image', { ...rec, status: 'error' })
        this.consecFail++
        // 熔断：连续 6 张检测失败（引擎卡死/崩溃），停止本轮并给出可操作提示，不再逐张空等
        if (this.consecFail >= 6) {
          this.engineAborted = true
          this.stopRequested = true
          console.error('engine circuit-break after consecutive failures:', e)
        }
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
