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
import { gradeDims, computeCategory, effectiveThresholds, scoreTier } from '../classify'
import { engineManager } from '../engine'
import { logError } from '../logger'
import { dumpCalibration } from './calib'
import { harmonizePersonCount } from './personHarmony'
import { ensureNormalizedJpeg } from './rawPreview'
import type { DetectResult, DimensionKey, ImageRecord } from '../../shared/types'
import { isTrashLike, isDupRedundant, flawLevel, CAT_REVIEW, BAD_DIMENSIONS, NEUTRAL_DIMENSIONS, STRUCTURAL_DIMENSIONS, levelOf, dupKeepWeight } from '../../shared/types'

export interface ScanProgress {
  running: boolean
  done: number
  total: number
  current: string
  phase: 'init' | 'scanning' | 'dup-cluster' | 'done' | 'stopped' | 'error'
  message?: string
  /** 本轮筛选开始时间戳（ms），用于整体速率估算 */
  startedAt?: number
  /** 当前阶段进入时间戳（ms），用于阶段倒计时 */
  phaseStartedAt?: number
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
    this.progress = { running: true, done: 0, total: pending.length, current: '', phase: 'init', message: '正在启动 AI 引擎...', startedAt: Date.now(), phaseStartedAt: Date.now() }
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
    this.progress = { ...this.progress, phase: 'scanning', phaseStartedAt: Date.now() }
    this.emit('progress', this.progress)

    const workers: Promise<void>[] = []
    for (let i = 0; i < concurrency; i++) {
      workers.push(this.workerLoop())
    }
    await Promise.all(workers)

    if (!this.stopRequested) {
      // 重复/连拍后置聚类
      this.progress = { ...this.progress, phase: 'dup-cluster', message: '重复照片 聚类整理中...', phaseStartedAt: Date.now() }
      this.emit('progress', this.progress)
      try {
        await this.clusterDuplicates()
      } catch (e) {
        console.error('dup cluster failed', e)
      }
      // 连拍组人数一致化：同一个瞬间不可能既是单人照又是多人照，组内看到过的最多脸数就是现场人数下界
      try {
        const fixed = harmonizePersonCount()
        for (const id of fixed) this.emit('image', getImage(id))
        if (fixed.length) console.log(`[person-harmony] 本轮连拍人数一致化修正 ${fixed.length} 张`)
      } catch (e) {
        console.error('person harmony failed', e)
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
        // 绝不能当成“正常但无坏维度”静默判进交付库——必须走失败路径，让状态可见并计入熔断。
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
    // 人工标注必须活过重筛：用户手动标过的维度（method:'user'）不被引擎结果覆盖。
    // 不这样做的话，用户拿“手动标多人混合照 / 合拍照”攒出来的真值集会被下一次重筛全部磨掉，
    // 阈值校准就永远拿不到“人怎么看 vs 引擎怎么看”的对照。重筛也不该抹掉人的判定，道理同 resetForRescan。
    for (const [dim, tag] of Object.entries(rec.tags || {})) {
      if (tag && tag.method === 'user') tags[dim as DimensionKey] = tag
    }
    if (raw.phash) this.hashes.set(rec.id, raw.phash)
    // 废弃库/重复废弃桶中的图片：标签更新但不改分类
    let category: string = rec.category
    if (isTrashLike(rec.category)) {
      category = rec.category
    } else {
      category = computeCategory(tags, settings, rec)
    }
    const details = {
      faces: raw.faces || [],
      faceCount: raw.faceCount ?? (raw.faces || []).length,
      // 正面主体数（v2.0.65 新口径）：连拍一致化与校准重放的计数单位；旧版引擎无此字段存 null
      frontalCount: raw.frontalCount ?? null,
      // 规整摆拍主群人数（v2.0.66）：连拍一致化靠它区分合拍照 / 混合照；旧版引擎无此字段存 null
      posedCount: raw.posedCount ?? null,
      engine: engineManager.getStatus().type,
      phash: raw.phash
    }
    updateDetectResult(rec.id, tags, details, null, category, isTrashLike(rec.category) ? 'user' : 'ai', 'done')
    const updated = getImage(rec.id)
    this.emit('image', updated)
  }

  /** 重复/连拍聚类（扫描末尾）：具体算法在 reclusterDuplicates，这里只接上本会话哈希表与停止信号 */
  private async clusterDuplicates(): Promise<void> {
    const r = await reclusterDuplicates({
      hashes: this.hashes,
      isStopped: () => this.stopRequested,
      onImage: (id) => this.emit('image', getImage(id))
    })
    console.log(`[dup-cluster] 共 ${r.groups} 组，改动 ${r.changed} 张（代表帧按权重挑）`)
  }
}

/** reclusterDuplicates 的可选依赖 */
export interface ReclusterDeps {
  /** 本会话内存里刚算好的 id->phash（扫描末尾传这个省一次 JSON 解析）；缺省回落库里 details.phash */
  hashes?: Map<number, string>
  /** 停止判定（扫描中途中断用） */
  isStopped?: () => boolean
  /** 每张改动后回调（扫描时推给渲染层实时刷新） */
  onImage?: (id: number) => void
}

/**
 * 重复/连拍聚类：按目录分桶 -> 感知哈希 Hamming 距离成组（>=0.85 同组）。
 *
 * v2.0.67 两处改动（用户 10-13 口述规则的直接落地）：
 * ① 每组代表帧不再取“最早导入的那张”，改为按 dupKeepWeight 挑最好的一张（不闭眼、不半截头、
 *    表情不崩、档位高）。旧规则让 69 组把烂帧留在了交付库里。
 * ② 代表帧必须把身上残留的 duplicate 标签摘掉：标签是“同组已有代表帧、我这张是多余的”的意思，
 *    留在代表帧身上会把整组拦在交付库外（实测 246 组一张都进不了库）。
 *
 * 人工决定永远优先：用户手动放过位置的帧（categoryBy='user'）先当候选池，组内全是 AI 判的才纯按权重；
 * 废弃库/重复废弃桶里的帧永不选成代表帧（那是用户明确说“这张不要”），也不给它补冗余标签。
 *
 * 幂等：只写“组号变了 / 该有标签却没有 / 代表帧还带着标签”的行，重复跑不刷 scanned_at、不动 cat_changed_at。
 */
export async function reclusterDuplicates(deps: ReclusterDeps = {}): Promise<{ groups: number; changed: number }> {
  const settings = getSettings()
  const sessionHashes = deps.hashes || new Map<number, string>()
  const stopped = deps.isStopped || (() => false)
  const rows = getDb()
    .prepare(`SELECT id, path, details FROM images WHERE status = 'done'`)
    .all() as Array<{ id: number; path: string; details: string | null }>
  const items: Array<{ id: number; dir: string; hash: string | null }> = []
  const hashById = new Map<number, string>()
  for (const r of rows) {
    let hash: string | null = sessionHashes.get(r.id) || null
    if (!hash && r.details) {
      try {
        hash = (JSON.parse(r.details).phash as string) || null
      } catch {
        /* ignore */
      }
    }
    if (hash) hashById.set(r.id, hash)
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
      if (stopped()) return { groups: 0, changed: 0 }
      for (let j = i + 1; j < list.length; j++) {
        const sim = similarity(list[i].hash!, list[j].hash!)
        if (sim >= 0.85) union(list[i].id, list[j].id)
      }
      if (i % 200 === 0) await new Promise((r) => setImmediate(r))
    }
  }
  // 成组：每组先按权重选代表帧，其余成员挂上 duplicate 标签
  const groupsMap = new Map<number, number[]>()
  for (const it of items) {
    if (!it.hash || !parent.has(it.id)) continue
    const root = find(it.id)
    const g = groupsMap.get(root) || []
    g.push(it.id)
    groupsMap.set(root, g)
  }
  let groups = 0
  let changed = 0
  /** 进了“≥ 2 张组”的图：收尾时靠它区分“真冗余”与“旧聚类残留的孤帧标签” */
  const inMulti = new Set<number>()
  for (const [, ids] of groupsMap) {
    if (ids.length < 2) continue
    groups++
    for (const id of ids) inMulti.add(id)
    ids.sort((a, b) => a - b)
    // 组号固定用组内最小 id（= 历史上第一帧）：拿“权重最好的那张”当组号会让 gid 随重跑漂移，
    // 进而把全库 dup_group 刷一遍（等于白写一次盘）
    const gid = `dup:${ids[0]}`
    const recs = ids.map((id) => getImage(id)).filter((r): r is ImageRecord => !!r)
    // 用户亲手标为冗余的帧（method='user' 的 duplicate 标签）永久不当代表帧：那是他明确说过
    // “这组里这张多出来了”（换一张保留 / 拖进重复多余都走这条），AI 不能替他把话收回去。
    const willing = recs.filter((r) => !(isDupRedundant(r.tags) && r.tags.duplicate?.method === 'user'))
    // 废弃库 / 重复废弃桶里的图是用户明确“这张不要”，不能替他把整组代表安在它身上
    const keepable = willing.filter((r) => !isTrashLike(r.category))
    // 整组都被人工否掉了：尊重，不替用户塞一个代表进库（他自己一张都不要也是合法诉求）
    if (!keepable.length) continue
    // 人工优先：用户手动放过位置的帧先构成候选池（他那次决定比 AI 权重大）
    const human = keepable.filter((r) => r.categoryBy === 'user')
    // 候选池分两层（用户原话：“不管多少张重复的，必须得有一张是直接入交付库里”）：
    // 第一层 = 本身干净、又没被人工搁在待确认的图 → 选它当代表，摘掉冗余标签后它就是真的能导出的那张；
    // 整组都找不到这种图时（全组不是闭眼就是半截头）才退到第二层，按权重选“不那么坏”的一张——
    // 它仍会被瑕疵闸门拦在库外，但这只是事实：这组确实没一张能交。
    // （不分层的后果：人工停在待确认、或本身带着闭眼标签的那张会凭“人工优先”抢走代表帧，
    // 结果整组仍然一张都进不了库，用户“每组必须有一张直接入库”的要求就落空）
    const cleanPool = keepable.filter((r) => flawLevel(r.tags) === 'none' && r.category !== CAT_REVIEW)
    const poolClean = cleanPool.filter((r) => r.categoryBy === 'user')
    const pool = poolClean.length ? poolClean : cleanPool.length ? cleanPool : human.length ? human : keepable
    const keep = pool.reduce((a, b) => (dupKeepWeight(a.tags, a.tier) <= dupKeepWeight(b.tags, b.tier) ? a : b))
    // ---------- 代表帧：挂上组号，并把自己身上的冗余标签摘掉 ----------
    const keepTag = keep.tags.duplicate
    const keepDirty = keep.dupGroup !== gid || (!!keepTag && keepTag.method !== 'user')
    if (keepDirty) {
      const cleanTags = { ...keep.tags }
      if (keepTag && keepTag.method !== 'user') delete cleanTags.duplicate
      updateDetectResult(keep.id, cleanTags, { ...(keep.details || {}), dupGroup: gid }, gid, keep.category, keep.categoryBy, keep.status)
      changed++
      deps.onImage && deps.onImage(keep.id)
    }
    // ---------- 其余成员：带“与保留帧相似度”的冗余标签 ----------
    for (const rec of recs) {
      if (rec.id === keep.id) continue
      // 两个桶（废弃库 / 重复废弃桶）与人工放过位置的帧都不补冗余标签
      if (isTrashLike(rec.category) || rec.categoryBy === 'user') continue
      const tag = rec.tags.duplicate
      if (rec.dupGroup === gid && tag && tag.level !== 'low') continue // 已是本组冗余帧，不重复写
      // 组内两两相似度决定置信度：与代表帧的最高相似度
      const fh = hashById.get(keep.id) || hashOf(keep)
      let best = 0
      for (const other of ids) {
        if (other === rec.id) continue
        const oh = hashById.get(other)
        if (oh && fh) best = Math.max(best, similarity(fh, oh))
      }
      const conf = Math.min(0.99, Math.max(best, 0.85))
      const dims = { duplicate: { confidence: conf, reason: `与同场景照片相似度 ${(conf * 100).toFixed(0)}%，是同一瞬间多拍的重复照片`, method: 'phash-cluster' } }
      const { tags } = gradeDims(dims, settings)
      const mergedTags = { ...rec.tags, ...tags }
      const category = computeCategory(mergedTags, getSettings(), rec)
      updateDetectResult(rec.id, mergedTags, { ...(rec.details || {}), dupGroup: gid }, gid, category, 'ai', rec.status)
      changed++
      deps.onImage && deps.onImage(rec.id)
    }
  }
  // ---------- 收尾：摘掉“已经不成组却还带着冗余标签”的孤帧标签 ----------
  // 不摘的后果：这种图会被侧栏算进“重复多余”，而分组视图里它一个组都开不出来（计数算着、界面找不到）。
  // 聚类算法会随力度/图库变化，旧一轮的残留必须跟着清，否则成一堆永远出不去的隐形拦下。
  if (!stopped()) {
    const stale = getDb()
      .prepare(`SELECT id FROM images WHERE status = 'done' AND tags LIKE '%"duplicate":{%'`)
      .all() as Array<{ id: number }>
    for (const { id } of stale) {
      if (inMulti.has(id)) continue
      const rec = getImage(id)
      const t = rec?.tags.duplicate
      if (!rec || !t || t.method === 'user' || t.level === 'low') continue
      const cleanTags = { ...rec.tags }
      delete cleanTags.duplicate
      const category = computeCategory(cleanTags, settings, rec)
      updateDetectResult(id, cleanTags, { ...(rec.details || {}), dupGroup: undefined }, null, category, rec.categoryBy, rec.status)
      changed++
      deps.onImage && deps.onImage(id)
    }
  }
  return { groups, changed }
}

/**
 * 启动补跑（REGRADE_VERSION=4 的一次性迁移）：存量库不必重跑 AI，只用库里已存的 phash 重新
 * 成组一遍，让“代表帧按权重挑 + 代表帧摘掉自身冗余标签”两条新规则对 3185 张旧数据立即生效。
 * 不补跑的后果：旧库里每张冗余帧的 duplicate 标签仍是旧规则产出的，改判口径在界面上看不出来。 */
export async function reclusterStored(): Promise<{ groups: number; changed: number }> {
  if (scanner.isRunning()) return { groups: 0, changed: 0 }
  return reclusterDuplicates()
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

/**
 * 阈值 / 场景 / 台阶基线变更后，按库里已存的 confidence 把三样东西全部重算一遍（不重跑引擎）：
 * ① 每个维度的 level（high/mid/low）② 主分类 category ③ 交付库档位 tier。
 *
 * 为什么必须有这一步：level 是检测时由 gradeDims 写死进 tags JSON 的，而瑕疵片/待确认/交付库
 * 三档视图、侧栏徽章、导出闸门全都读 flawLevel(tags)＝看那个存下来的 level。以前设置保存只调
 * reclassifyAll（仅重算 category），于是「切换力度档立即重新分桶」这句话对瑕疵维度其实是假的——
 * 用户不整库重筛就看不到新阈值生效，改参数等于白改。
 *
 * 人工标签（method:'user'）一律不降级：那是人的判定，不该被阈值改口。
 */
export function regradeAll(): number {
  const settings = getSettings()
  const images = listImages()
  const stmtTags = getDb().prepare('UPDATE images SET tags = ? WHERE id = ?')
  const stmtCat = getDb().prepare('UPDATE images SET category = ?, tier = ? WHERE id = ?')
  let written = 0
  const tx = getDb().transaction(() => {
    for (const img of images) {
      if (img.status !== 'done') continue
      const next: ImageRecord['tags'] = {}
      let tagsChanged = false
      for (const [key, t] of Object.entries(img.tags || {})) {
        const dim = key as DimensionKey
        if (!t) continue
        const gradeable = BAD_DIMENSIONS.includes(dim) || NEUTRAL_DIMENSIONS.includes(dim) || STRUCTURAL_DIMENSIONS.includes(dim)
        if (!gradeable || t.method === 'user') {
          next[dim] = t
          continue
        }
        const [mid, high] = effectiveThresholds(dim, settings)
        const level = levelOf(t.confidence, high, mid)
        if (level !== t.level) {
          next[dim] = { ...t, level }
          tagsChanged = true
        } else next[dim] = t
      }
      const rec = tagsChanged ? { ...img, tags: next } : img
      // 主分类：沿用 reclassifyAll 的跳过规则（废弃库/重复废弃/手动自定义相册归人，AI 不顶）
      let category = img.category
      const keepCategory = isTrashLike(img.category) || (img.categoryBy === 'user' && img.category.startsWith('custom:'))
      if (!keepCategory) category = computeCategory(rec.tags, settings, rec)
      // 档位：人工改过的档位（tier_by='user'）永不被重算覆盖
      const tier = img.tierBy === 'user' ? img.tier ?? null : scoreTier(rec.tags, settings) ?? null
      const catTierChanged = category !== img.category || tier !== (img.tier ?? null)
      if (!tagsChanged && !catTierChanged) continue
      if (tagsChanged) stmtTags.run(JSON.stringify(next), img.id)
      if (catTierChanged) stmtCat.run(category, tier, img.id)
      written += 1
    }
  })
  tx()
  return written
}

/** 阈值等设置变化后，无需重新检测，直接用现存 tags 重算分类（含 level/tier，见 regradeAll） */
export function reclassifyAll(): void {
  regradeAll()
}

/** 单图分类重算（一键修正 / 手动移动后动态更新交付库归属） */
export function reclassifyImage(id: number): ImageRecord | null {
  const rec = getImage(id)
  if (!rec) return null
  const cat = computeCategory(rec.tags, getSettings(), rec)
  getDb().prepare('UPDATE images SET category = ? WHERE id = ?').run(cat, id)
  return getImage(id)
}

export const scanner = new Scanner()
