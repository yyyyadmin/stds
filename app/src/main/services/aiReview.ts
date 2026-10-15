/**
 * AI 复审后台服务（会员专属·千问 VL）
 * - 全局后台任务：不冻结软件。EventEmitter 单例，仿 scanner。
 * - 领 key / 报用量走 authManager（用户 PHP 后端）；图片压小后客户端直连 DashScope（图片不过用户后端）。
 * - 只写 images.ai_review（只读建议），绝不碰 tags/category。api_key 仅存内存，不落盘/不写日志。
 * - stub 模式（AI_REVIEW_STUB=1）：后端未就绪时用四类 canned 结论喂解析，验证全管线，不调外网不领 key。
 */
import { EventEmitter } from 'events'
import { basename } from 'path'
import { getSettings, getImage, listPendingAiReviewIds, setAiReview } from '../db'
import { authManager } from './auth'
import { engineManager } from '../engine'
import { orientedSharp } from './rawPreview'
import { buildReviewMessages, parseModelVerdict, type AiReviewVerdict } from './aiReviewPrompt'
import { logError } from '../logger'
import type { AiReviewSuggestion, AiReviewScope, CategoryKey } from '../../shared/types'
import { CAT_FLAWS, CAT_REVIEW } from '../../shared/types'
import type { AiReviewProgress } from '../../shared/ipc'

const IMG_MAX_SIDE = 1024
const IMG_QUALITY = 82
const FETCH_TIMEOUT_MS = 15000
const REPORT_EVERY = 5 // 每成功 5 张回写一次用量
const STUB = process.env.AI_REVIEW_STUB === '1'

/** stub 四类结论循环：改人数 / 加瑕疵 / 删瑕疵 / 与现状一致，覆盖对比界面四形态 */
const STUB_VERDICTS: AiReviewVerdict[] = [
  { person: 'group_photo', flaws: { eyes_closed: false, half_head: false, expression: false }, reason: '多人面向镜头摆拍，应判合拍照' },
  { person: 'single_person', flaws: { eyes_closed: true, half_head: false, expression: false }, reason: '单人且明显闭眼' },
  { person: 'mixed_photo', flaws: { eyes_closed: false, half_head: true, expression: false }, reason: '接亲抓拍非摆拍，主体头部被裁' },
  { person: 'no_person', flaws: { eyes_closed: false, half_head: false, expression: false }, reason: '画面无人物主体' }
]

interface KeyCache {
  apiKey: string
  endpoint: string
  model: string
  sessionId: string
  expiresAt: number
  dailyLimit: number
  usedToday: number
}

class AiReview extends EventEmitter {
  private running = false
  private stopRequested = false
  private queue: number[] = []
  private cursor = 0
  private key: KeyCache | null = null
  /** 本会话累计成功出建议、但尚未上报的张数 */
  private pendingDelta = 0
  /** 上报批次序号（接口 B 幂等去重用）：同一 session 内必须严格递增，见 seqSession */
  private seq = 0
  /** seq 当前归属的会话：换会话才归零。同一会话内重复的 (session,seq) 会被服务端当幂等重发丢掉 */
  private seqSession: string | null = null
  private advancing: Promise<boolean> | null = null
  /** 领 key 失败的真实阻塞原因，供 start() 如实回传渲染层（不再折叠成 not_member） */
  private lastBlockReason: string | null = null
  /** 本轮复审作用域（待确认 / 瑕疵片）；进度回传与采纳校验靠它区分两栏 */
  private scope: AiReviewScope = 'review'
  private progress: AiReviewProgress = {
    running: false,
    total: 0,
    done: 0,
    current: '',
    phase: 'preparing',
    message: '',
    failCount: 0,
    quotaExceeded: false,
    usedToday: 0,
    dailyLimit: 0,
    scope: 'review'
  }

  getProgress(): AiReviewProgress {
    return this.progress
  }

  isRunning(): boolean {
    return this.running
  }

  /** 领 key（含 ttl 续期 / 并发去路）。stub 模式跳过。返回是否可用。 */
  private async ensureKey(): Promise<boolean> {
    if (STUB) return true
    if (this.key && Date.now() < this.key.expiresAt) return true
    // 并发保护：多 worker 同时到点续期时，共享同一个领 key 请求
    if (this.advancing) return this.advancing
    this.advancing = (async () => {
      const r = await authManager.getReviewKey()
      this.advancing = null
      if (!r.ok || !r.data?.api_key) {
        this.finishForReason(r.reason, r.data?.used_today, r.data?.daily_limit)
        return false
      }
      this.key = {
        apiKey: r.data.api_key,
        endpoint: r.data.endpoint,
        model: r.data.model,
        sessionId: r.data.session_id,
        expiresAt: Date.now() + Math.max(30, r.data.ttl - 30) * 1000, // 提前 30s 续期
        dailyLimit: r.data.daily_limit,
        usedToday: r.data.used_today
      }
      this.progress.dailyLimit = r.data.daily_limit
      this.progress.usedToday = r.data.used_today
      // 批次号只在“换了会话”时归零：ttl 未到时 ensureKey 会直接复用旧 key，上一版的 start() 无条件
      // seq=0，第 2 轮上报的 (session,1) 与第 1 轮同键 → 服务端按幂等去重丢掉，复审了 11 张只记上 2 张
      //（用户 10-15 实测：跑完顶栏与个人中心都不扣次数，后端实查 used_today 远小于本地已判张数）。
      if (this.seqSession !== this.key.sessionId) {
        this.seqSession = this.key.sessionId
        this.seq = 0
      }
      return true
    })()
    return this.advancing
  }

  /** 领 key 失败按 reason 收尾（会员闸门/额度/限频/服务不可用各走不同终止态） */
  private finishForReason(reason: string, usedToday?: number, dailyLimit?: number): void {
    this.key = null
    this.lastBlockReason = reason
    if (reason === 'quota_exceeded') {
      this.progress.quotaExceeded = true
      this.progress.message = '今日 AI 复审额度已用完，明天再来'
      if (usedToday != null) this.progress.usedToday = usedToday
      if (dailyLimit != null) this.progress.dailyLimit = dailyLimit
    } else if (reason === 'not_member') {
      this.progress.message = 'AI 复审为会员专属功能'
    } else if (reason === 'rate_limited') {
      this.progress.message = '操作过于频繁，请稍后再试'
    } else if (reason === 'service_unavailable') {
      // 总开关关闭 / 后台尚未配置千问 key：软降级，不引导开通会员、不标额度尽
      this.progress.message = 'AI 复审服务暂不可用，请稍后再试'
    } else if (reason === 'unauthorized') {
      this.progress.message = '登录已失效，请重新登录'
    } else if (reason === 'network') {
      this.progress.message = '需联网，AI 复审已跳过'
    } else {
      this.progress.message = '无法开始 AI 复审'
    }
  }

  /**
   * 启动后台复审。非会员/未授权/该栏无待判图均不真跑。立即返回，任务在后台进行。
   * scope='review' 复审待确认栏，'flaws' 复审瑕疵片栏。
   * 默认只跑「尚无建议 + 被不采纳」的图（不采纳不算结案，用户 10-15 实测拍板）；opts.force（页内橙色
   * 「再次AI复审」）在此基础上多跑“已判过但用户还没表态”的那批，避开它们永远无人再提交的死胡同。
   * 两种跑法都不重跑已结案（confirmed：采纳过或确认采纳）的图——同一张烧两次额度。
   * 集合口径完全在 db.listPendingAiReviewIds，这里不再叠一层判断。
   * 返回 started 与原因，供渲染层决定跳会员中心 / toast。
   */
  async start(scope: AiReviewScope = 'review', opts?: { force?: boolean }): Promise<{ started: boolean; reason?: string; usedToday?: number; dailyLimit?: number }> {
    if (this.running) return { started: false, reason: 'already_running' }
    const s = getSettings()
    if (!STUB && !s.aiReviewConsent) return { started: false, reason: 'no_consent' }
    if (!STUB && !authManager.isMember()) return { started: false, reason: 'not_member' }
    this.scope = scope
    const cat: CategoryKey = scope === 'flaws' ? CAT_FLAWS : CAT_REVIEW
    const ids = listPendingAiReviewIds(cat, !!opts?.force)
    if (!ids.length) return { started: false, reason: 'empty' }

    // 先领 key（stub 跳过）；拿到额度信息后若 remaining<=0 直接不开始
    this.lastBlockReason = null
    const ok = await this.ensureKey()
    if (!ok) {
      // 领 key 失败：以 error/stopped 收尾一次，让渲染层能拿到 message/quota 态
      this.progress = { ...this.progress, running: false, phase: this.progress.quotaExceeded ? 'stopped' : 'error' }
      this.emit('progress', this.progress)
      return {
        started: false,
        reason: this.lastBlockReason || (this.progress.quotaExceeded ? 'quota_exceeded' : 'not_member'),
        usedToday: this.progress.usedToday,
        dailyLimit: this.progress.dailyLimit
      }
    }

    this.queue = ids
    this.cursor = 0
    this.stopRequested = false
    this.pendingDelta = 0
    // seq 不在这里归零（它跟会话走，见 ensureKey）：归零会让复用同一 session 的第二轮上报被服务端幂等丢弃
    this.running = true
    this.progress = {
      running: true,
      total: ids.length,
      done: 0,
      current: '',
      phase: 'reviewing',
      message: '',
      failCount: 0,
      quotaExceeded: false,
      usedToday: this.key?.usedToday ?? 0,
      dailyLimit: this.key?.dailyLimit ?? 0,
      scope: this.scope
    }
    this.emit('progress', this.progress)
    void this.run()
    return { started: true }
  }

  /** 请求停止：停在当前张，已完成建议保留、未跑不再跑 */
  stop(): void {
    this.stopRequested = true
  }

  private emitProgress(patch: Partial<AiReviewProgress>): void {
    this.progress = { ...this.progress, ...patch }
    this.emit('progress', this.progress)
  }

  /** 后台主循环：并发 2 的 worker 池，逐张复审 */
  private async run(): Promise<void> {
    const CONC = 2
    const workers = Array.from({ length: Math.min(CONC, this.queue.length) }, () => this.worker())
    await Promise.all(workers)
    // 收尾：上报剩余用量
    await this.flushUsage(true)
    const phase: AiReviewProgress['phase'] = this.stopRequested ? 'stopped' : 'done'
    this.running = false
    this.emitProgress({ running: false, phase, current: '' })
  }

  private async worker(): Promise<void> {
    while (!this.stopRequested) {
      const i = this.cursor++
      if (i >= this.queue.length) break
      // ttl 到点续期；续期失败（额度尽/会员失效）则停止在途
      if (!(await this.ensureKey())) break
      await this.reviewOne(this.queue[i])
    }
  }

  private async reviewOne(id: number): Promise<void> {
    const rec = getImage(id)
    if (!rec) return
    this.emitProgress({ current: basename(rec.path || rec.filename) })
    const modelText = STUB ? null : await this.callDashScope(id)
    let verdict: AiReviewVerdict | null
    let model = STUB ? 'stub' : this.key?.model || 'qwen3-vl-plus'
    if (STUB) {
      verdict = STUB_VERDICTS[id % STUB_VERDICTS.length]
    } else {
      verdict = modelText ? parseModelVerdict(modelText) : null
      // 首次解析失败重试一次（模型偶尔不吐合法 JSON）
      if (!verdict) {
        const retry = await this.callDashScope(id)
        verdict = retry ? parseModelVerdict(retry) : null
      }
    }
    if (this.stopRequested) return
    if (!verdict) {
      // 解码/网络/非法 JSON：记失败，绝不写猜测建议、不计费
      this.emitProgress({ done: this.progress.done + 1, failCount: this.progress.failCount + 1 })
      return
    }
    const suggestion: AiReviewSuggestion = {
      sig: engineManager.getEngineSig() ?? 0,
      model,
      at: Date.now(),
      person: verdict.person,
      flaws: verdict.flaws,
      reason: verdict.reason,
      scope: this.scope
    }
    try {
      setAiReview(id, suggestion)
    } catch (e) {
      logError('aiReview', 'setAiReview failed id=' + id + ': ' + String(e))
      this.emitProgress({ done: this.progress.done + 1, failCount: this.progress.failCount + 1 })
      return
    }
    this.pendingDelta++
    this.emitProgress({ done: this.progress.done + 1 })
    if (this.pendingDelta >= REPORT_EVERY) await this.flushUsage(false)
  }

  /** 取图压小 base64 → 直连 DashScope chat/completions，返回 message.content 文本；任何失败返回 null */
  private async callDashScope(id: number): Promise<string | null> {
    const key = this.key
    const rec = getImage(id)
    if (!key || !rec) return null
    let base64: string
    try {
      const buf = await (await orientedSharp(rec.path))
        .resize({ width: IMG_MAX_SIDE, height: IMG_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: IMG_QUALITY })
        .toBuffer()
      base64 = buf.toString('base64')
    } catch {
      return null // 解码失败：无法复审
    }
    const { system, userText } = buildReviewMessages()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    try {
      const resp = await fetch(`${key.endpoint}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.apiKey}` },
        body: JSON.stringify({
          model: key.model,
          temperature: 0,
          // 强制闸门：联网搜索一律关死（用户 10-15 定）。判定只看图本身，联网只会更慢更贵；
          // DashScope 默认不开，但默认值是平台说了算——换模型/平台改默认后这里兜底。
          // 千问系不认识这个参数的模型会忽略它、不报错，所以未来换任何 qwen VL 模型都不用动。
          enable_search: false,
          messages: [
            { role: 'system', content: system },
            {
              role: 'user',
              content: [
                { type: 'text', text: userText },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }
              ]
            }
          ]
        }),
        signal: ctrl.signal
      })
      clearTimeout(timer)
      if (resp.status === 401 || resp.status === 403) {
        // key 失效/被吊销：清内存、停止在途（换 key 后由用户重开）
        this.key = null
        this.stopRequested = true
        this.emitProgress({ message: '复审凭证已失效，已停止' })
        return null
      }
      if (!resp.ok) return null
      const json = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> }
      return json.choices?.[0]?.message?.content ?? null
    } catch (e) {
      clearTimeout(timer)
      logError('aiReview', 'callDashScope failed id=' + id + ': ' + String(e))
      return null
    }
  }

  /** 回写本会话成功张数到接口 B；若服务端回 used>=limit 即停止并标额度尽 */
  private async flushUsage(final: boolean): Promise<void> {
    if (STUB) return
    if (this.pendingDelta <= 0) return
    if (!this.key) {
      if (final) this.pendingDelta = 0
      return
    }
    const delta = this.pendingDelta
    this.pendingDelta = 0
    const r = await authManager.reportReviewUsage(this.key.sessionId, ++this.seq, delta)
    if (r.ok) {
      if (r.usedToday != null) this.key.usedToday = r.usedToday
      this.progress.usedToday = this.key.usedToday
      if (this.key.usedToday >= this.key.dailyLimit && this.key.dailyLimit > 0) {
        this.progress.quotaExceeded = true
        this.stopRequested = true
      }
      return
    }
    if (r.reason === 'bad_session') {
      // 会话失效/不属本用户：丢弃本次上报、清 key 触发下次重领（新会话）；本批 delta 回滚待重报
      this.key = null
      this.seqSession = null // 新会话的批次号从 1 重起，否则接着旧会话的号往上报，旧会话里那些号服务端没见过→白丢
      this.pendingDelta += delta
    } else if (r.reason === 'quota_exceeded') {
      // 后端日/会话累计超限：额度尽，停止复审（本批已计入后端，不回滚）
      this.progress.quotaExceeded = true
      this.stopRequested = true
      if (r.usedToday != null) this.progress.usedToday = r.usedToday
    } else if (r.reason === 'rate_limited' || r.reason === 'network' || r.reason === 'service_unavailable') {
      // 可重试的瞬时失败：回滚本批 delta 并退回 seq，下次以同一 (session,seq) 幂等重报，不丢计数
      this.seq--
      this.pendingDelta += delta
    }
  }
}

export const aiReview = new AiReview()
