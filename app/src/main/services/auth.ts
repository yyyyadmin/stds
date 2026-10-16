/**
 * 账号 / 会员 / 积分服务（主进程）
 * - 对接后台 API（见 API接口文档.md）：登录/注册/验证码/用户信息/套餐/订单/系统配置/积分消费
 * - Token 本地持久化（userData/auth.json），启动时自动恢复并刷新用户信息
 * - 统一把 login（扁平字段）与 user_info（嵌套字段）归一化为 AuthUser
 */
import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { isVip } from '../../shared/membership'
import type {
  AuthState,
  AuthUser,
  ConsumeResult,
  MembershipInfo,
  MembershipLevel,
  PlanInfo,
  RedeemResult,
  SysConfig,
  PointsHistoryItem,
  PointsHistoryResult,
  UpdateInfo
} from '../../shared/ipc'

const API_BASE = 'https://st.uxuuu.cn/api/client'

function authFile(): string {
  return join(app.getPath('userData'), 'auth.json')
}

/**
 * 等级代号只做“空值兜底”，绝不按写死名单收口。
 * 后台可自建动态套餐（custom3d 这类），一旦被判成不认识的代号归为 free，
 * 体验卡用户就会被误当成普通会员（2026-10-15 真实账号实测抓到）。
 * 是不是会员一律走 isVip()（后端 is_vip 优先，见 shared/membership.ts）。
 */
function normLevel(v: unknown): MembershipLevel {
  return String(v || 'free')
}

/** 归一化 login.user 与 user_info 两种结构 */
function toUser(raw: Record<string, unknown>): AuthUser {
  const membership: MembershipInfo =
    raw.membership && typeof raw.membership === 'object'
      ? (raw.membership as MembershipInfo)
      : {
          level: normLevel(raw.membership_level),
          // 身份名（如「年卡会员」）：嵌套走 membership.name，老接口扁平字段叫 membership_name
          name: ((raw.membership as MembershipInfo | null)?.name ?? raw.membership_name as string | undefined) || null,
          expire_at: (raw.membership_expire_at as string) || null,
          is_expired: false
        }
  const points =
    raw.points && typeof raw.points === 'object'
      ? (raw.points as AuthUser['points'])
      : {
          balance: Number(raw.points_balance) || 0,
          total_earned: 0,
          total_consumed: 0
        }
  // 今日 AI 复审额度（user_info.php 会员返回 data.ai_review）：缺省时不挂该字段
  const ar = raw.ai_review && typeof raw.ai_review === 'object' ? (raw.ai_review as Record<string, unknown>) : null
  const aiReview = ar
    ? {
        daily_limit: Number(ar.daily_limit) || 0,
        used_today: Number(ar.used_today) || 0,
        remaining: Number(ar.remaining) || 0
      }
    : undefined
  return {
    id: Number(raw.id) || 0,
    phone: (raw.phone as string) || null,
    email: (raw.email as string) || null,
    nickname: (raw.nickname as string) || null,
    avatar_url: (raw.avatar_url as string) || null,
    membership: { ...membership, level: normLevel(membership.level) },
    points,
    ai_review: aiReview
  }
}

async function request<T = Record<string, unknown>>(
  endpoint: string,
  body: Record<string, unknown> | null,
  token?: string | null
): Promise<{ code: number; message: string; data: T }> {
  const url = `${API_BASE}/${endpoint}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20000)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  try {
    const resp = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    })
    // 402/401 等错误 body 仍是 JSON，统一解析
    let json: { code?: number; message?: string; data?: T }
    try {
      json = (await resp.json()) as typeof json
    } catch {
      return { code: resp.status, message: `HTTP ${resp.status}`, data: {} as T }
    }
    return { code: json.code ?? resp.status, message: json.message || '', data: (json.data ?? {}) as T }
  } catch (e) {
    return { code: 0, message: '网络请求失败：' + String(e), data: {} as T }
  } finally {
    clearTimeout(timer)
  }
}

class AuthManager {
  private token: string | null = null
  private user: AuthUser | null = null

  state(): AuthState {
    return { loggedIn: !!this.token, token: this.token, user: this.user }
  }

  isMember(): boolean {
    return isVip(this.user)
  }

  private persist(): void {
    try {
      writeFileSync(authFile(), JSON.stringify({ token: this.token, user: this.user }), 'utf-8')
    } catch {
      /* ignore */
    }
  }

  /** 启动恢复：读本地 token，若存在则刷新用户信息（失败保留缓存） */
  async bootstrap(): Promise<AuthState> {
    try {
      if (existsSync(authFile())) {
        const raw = JSON.parse(readFileSync(authFile(), 'utf-8')) as { token?: string; user?: AuthUser }
        if (raw.token) {
          this.token = raw.token
          this.user = raw.user || null
          const r = await request<Record<string, unknown>>('user_info.php', null, this.token)
          if (r.code === 200) {
            this.user = toUser(r.data)
            this.persist()
          } else if (r.code === 401) {
            // token 过期，清除
            this.token = null
            this.user = null
            this.persist()
          }
        }
      }
    } catch {
      /* ignore */
    }
    return this.state()
  }

  async sendCaptcha(req: { phone?: string; email?: string; type: string }): Promise<{ ok: boolean; message: string }> {
    const body: Record<string, unknown> = { type: req.type }
    if (req.email) body.email = req.email
    else body.phone = req.phone
    const r = await request('send_captcha.php', body)
    return { ok: r.code === 200, message: r.message || (r.code === 200 ? '验证码已发送' : '发送失败') }
  }

  /** 注册（只返回 user_id），成功后立即登录取 token */
  async register(req: { phone?: string; email?: string; password: string; code: string }): Promise<{ ok: boolean; message: string }> {
    const body: Record<string, unknown> = { password: req.password, code: req.code }
    if (req.email) body.email = req.email
    else body.phone = req.phone
    const r = await request('register.php', body)
    if (r.code !== 200) return { ok: false, message: r.message || '注册失败' }
    // 注册不返回 token，用账号（phone 字段）自动登录
    const account = req.email || req.phone || ''
    const login = await this.login(account, req.password)
    return login.loggedIn ? { ok: true, message: '注册成功，已自动登录' } : { ok: false, message: '注册成功，请手动登录' }
  }

  /** 登录：账号统一放 phone 字段（后台设计） */
  async login(account: string, password: string): Promise<AuthState> {
    const r = await request<{ token?: string; user?: Record<string, unknown> }>('login.php', { phone: account, password })
    if (r.code === 200 && r.data.token) {
      this.token = r.data.token
      this.user = r.data.user ? toUser(r.data.user) : null
      this.persist()
      // 补齐完整信息
      void this.me()
    }
    return this.state()
  }

  /**
   * 验证码登录（手机号或邮箱 + 验证码，不要密码）。
   * 契约见 docs/superpowers/specs/2026-10-15-login-captcha-api.md：同一个 login.php，
   * 只带 code 不带 password 时走验证码分支，成功返回与密码登录同结构的 { token, user }。
   * 2026-10-15 后端已上验证码分支（他那边 curl 实测表逐条过了），客户端这边只把旧版
   * 那句会让人误会的原文挡一下，其余错误一律原样回显。
   */
  async loginWithCode(req: { phone?: string; email?: string; code: string }): Promise<{ ok: boolean; message: string; state: AuthState }> {
    const body: Record<string, unknown> = { code: req.code }
    if (req.email) body.email = req.email
    else body.phone = req.phone
    const r = await request<{ token?: string; user?: Record<string, unknown> }>('login.php', body)
    if (r.code === 200 && r.data.token) {
      this.token = r.data.token
      this.user = r.data.user ? toUser(r.data.user) : null
      this.persist()
      // 与密码登录拿同样的完整信息（积分余额、会员到期、复审额度），不等后台补拉就上屏
      await this.me()
      return { ok: true, message: '登录成功', state: this.state() }
    }
    // 只挡住旧版那一句原文：用户明明填了验证码，
    // 把“账号和密码不能为空”原样甩回去只会让他以为自己填错。新版缺参文案是“请填写密码或验证码”，
    // 那条我们走不到（必带 code），所以不做模糊匹配，免得把真错误盖成假说明。
    const msg = r.message === '账号和密码不能为空'
      ? '验证码登录暂未开放：服务端只接受密码，请先用密码登录'
      : r.code === 200
        ? '登录失败：服务端没返回登录凭证'
        : r.message || '登录失败'
    return { ok: false, message: msg, state: this.state() }
  }

  async me(): Promise<AuthState> {
    if (!this.token) return this.state()
    const r = await request<Record<string, unknown>>('user_info.php', null, this.token)
    if (r.code === 200) {
      this.user = toUser(r.data)
      this.persist()
    } else if (r.code === 401) {
      this.token = null
      this.user = null
      this.persist()
    }
    return this.state()
  }

  logout(): AuthState {
    this.token = null
    this.user = null
    this.persist()
    return this.state()
  }

  async plans(): Promise<PlanInfo[]> {
    const r = await request<unknown[]>('plans.php', null)
    const list = Array.isArray(r.data) ? r.data : []
    return (list as Array<Record<string, unknown>>).map((p) => {
      let features: string[] = []
      try {
        const f = p.features
        features = typeof f === 'string' ? (JSON.parse(f) as string[]) : Array.isArray(f) ? (f as string[]) : []
      } catch {
        features = []
      }
      return {
        code: String(p.code || ''),
        name: String(p.name || ''),
        duration_days: Number(p.duration_days) || 0,
        price: String(p.price || ''),
        original_price: String(p.original_price || ''),
        points_gift: Number(p.points_gift) || 0,
        features,
        is_recommended: Number(p.is_recommended) || 0
      }
    })
  }

  async createOrder(
    productType: string,
    productId: string
  ): Promise<{ ok: boolean; message: string; order_no?: string; amount?: string; product_name?: string; service_qrcode?: string }> {
    if (!this.token) return { ok: false, message: '请先登录' }
    const r = await request<{
      order_no?: string
      amount?: string
      product_name?: string
      service_qrcode?: string
    }>('create_order.php', { product_type: productType, product_id: productId }, this.token)
    const d = r.data || {}
    return {
      ok: r.code === 200,
      message: r.message,
      order_no: d.order_no,
      amount: d.amount,
      product_name: d.product_name,
      service_qrcode: d.service_qrcode
    }
  }

  async config(): Promise<SysConfig> {
    const r = await request<Record<string, unknown>>('config.php', null)
    const d = r.data || {}
    return {
      wechat_qrcode: (d.wechat_qrcode as string) || null,
      customer_service_qrcode: (d.customer_service_qrcode as string) || null,
      site_name: (d.site_name as string) || null,
      // 可选字段：后台没回就是 null，会员中心会改说“每天有上限”而不是编一个数
      ai_review_daily_limit: d.ai_review_daily_limit != null ? Number(d.ai_review_daily_limit) || 0 : null
    }
  }

  /** 筛选完成后扣积分（会员免扣）。1 张 = 1 积分 */
  async consume(imageCount: number): Promise<ConsumeResult> {
    if (!this.token) return { ok: false, consumed: 0, remaining: null, insufficient: false, message: '未登录' }
    const r = await request<Record<string, unknown>>('consume_points.php', { image_count: imageCount }, this.token)
    if (r.code === 200) {
      const d = r.data || {}
      const consumed = Number(d.consumed_points) || 0
      const memberFree = !!d.membership_level && d.membership_level !== 'free'
      if (d.remaining_points != null && this.user) {
        this.user = { ...this.user, points: { ...this.user.points, balance: Number(d.remaining_points) } }
        this.persist()
      }
      return { ok: true, consumed, remaining: d.remaining_points != null ? Number(d.remaining_points) : null, insufficient: false, memberFree, message: String(d.message || '') }
    }
    if (r.code === 402) {
      const d = r.data || {}
      return {
        ok: false,
        consumed: 0,
        remaining: null,
        insufficient: true,
        required: Number(d.required_points) || imageCount,
        balance: Number(d.current_balance) || this.user?.points.balance || 0,
        message: r.message || '积分不足，请充值'
      }
    }
    return { ok: false, consumed: 0, remaining: null, insufficient: false, message: r.message || '积分扣费失败' }
  }

  /** 积分变动记录（points_history.php）。type 空=全部，consume=仅扣费 */
  async pointsHistory(
    type: string,
    page: number,
    pageSize: number
  ): Promise<PointsHistoryResult> {
    const empty = { list: [] as PointsHistoryItem[], page, page_size: pageSize, total: 0, total_pages: 0 }
    if (!this.token) return { ok: false, message: '未登录', ...empty }
    const r = await request<{ list?: unknown[]; pagination?: Record<string, unknown> }>(
      'points_history.php',
      { type, page, page_size: pageSize },
      this.token
    )
    if (r.code === 200) {
      const d = r.data || {}
      const rawList = Array.isArray(d.list) ? d.list : []
      const list = (rawList as Array<Record<string, unknown>>).map((it) => ({
        consume_time: String(it.consume_time || ''),
        consume_points: Number(it.consume_points) || 0,
        status: String(it.status || ''),
        remaining_points: Number(it.remaining_points) || 0,
        reason: String(it.reason || ''),
        remark: String(it.remark || '')
      }))
      const pg = d.pagination || {}
      return {
        ok: true,
        message: r.message || '',
        list,
        page: Number(pg.page) || page,
        page_size: Number(pg.page_size) || pageSize,
        total: Number(pg.total) || 0,
        total_pages: Number(pg.total_pages) || 0
      }
    }
    return { ok: false, message: r.message || '获取消费记录失败', ...empty }
  }

  /**
   * 兑换码（redeem_code.php，后端 2026-10-15 对接单）：会员码 / 积分码同一个接口，
   * 码的类型由后端定，前端只负责展示。后端对大小写、首尾空格都不敏感，客户端只 trim。
   * 401（token 失效）时清登录态，让界面自然回到「登录 / 注册」。
   */
  async redeemCode(rawCode: string): Promise<{ ok: boolean; message: string; result?: RedeemResult }> {
    const code = String(rawCode || '').trim()
    if (!code) return { ok: false, message: '请填写兑换码' }
    if (!this.token) return { ok: false, message: '登录已失效，请重新登录' }
    const r = await request<Record<string, unknown>>('redeem_code.php', { code }, this.token)
    if (r.code === 200) {
      const d = r.data || {}
      return {
        ok: true,
        message: r.message || '兑换成功',
        result: {
          type: d.type === 'points' ? 'points' : 'membership',
          level: (d.level as string) || null,
          expire_at: (d.expire_at as string) || null,
          points: Number(d.points) || 0,
          balance: Number(d.balance) || 0
        }
      }
    }
    if (r.code === 401) {
      this.token = null
      this.user = null
      this.persist()
    }
    return { ok: false, message: r.message || '兑换失败，请稍后再试' }
  }

  async checkUpdate(): Promise<UpdateInfo | null> {
    // 后台契约：platform=windows（Windows）/ mac（macOS Intel x64）/ arm（macOS Apple 芯片），自动判断
    const platform = process.platform === 'darwin' ? (process.arch === 'arm64' ? 'arm' : 'mac') : 'windows'
    const current = app.getVersion()
    const r = await request<Record<string, unknown>>(`check_update.php?platform=${platform}&current=${encodeURIComponent(current)}`, null)
    if (r.code === 200 && r.data) {
      return {
        has_update: !!r.data.has_update,
        latest_version: (r.data.latest_version as string) || undefined,
        current_version: (r.data.current_version as string) || current,
        notes: (r.data.notes as string) || undefined,
        download_url: (r.data.download_url as string) || undefined,
        file_size_mb: Number(r.data.file_size_mb) || undefined,
        platform
      }
    }
    return null
  }

  // ---------- AI 复审（会员专属）：领 key + 上报用量 ----------
  // 契约见 docs/superpowers/specs/2026-10-14-ai-review-api-contract.md 接口 A/B。
  // 铁律：拿到的 api_key 仅由调用方存内存，本服务绝不落盘/写日志/进 error message。

  /**
   * 接口 A：领取复审 Key。服务端是唯一会员闸门（403 not_member）。
   * 把 HTTP 风格 code + data.reason 归一成机器可判的 reason 枚举。
   */
  async getReviewKey(): Promise<{
    ok: boolean
    reason: 'ok' | 'unauthorized' | 'not_member' | 'quota_exceeded' | 'rate_limited' | 'bad_request' | 'network' | 'service_unavailable'
    data?: { api_key: string; endpoint: string; model: string; ttl: number; session_id: string; daily_limit: number; used_today: number; remaining: number }
    retry_after?: number
  }> {
    if (!this.token) return { ok: false, reason: 'unauthorized' }
    const r = await request<Record<string, unknown>>('ai_review_key.php', { scope: 'review', client_version: app.getVersion() }, this.token)
    const dr = (r.data?.reason as string) || ''
    // 成功：必须拿到 api_key + session_id 才算 ok
    if (r.code === 200 && r.data?.api_key && r.data?.session_id) {
      const d = r.data
      return {
        ok: true,
        reason: 'ok',
        data: {
          api_key: String(d.api_key),
          endpoint: String(d.endpoint || ''),
          model: String(d.model || 'qwen3.7-flash'),
          ttl: Number(d.ttl) || 600,
          session_id: String(d.session_id),
          daily_limit: Number(d.daily_limit) || 0,
          used_today: Number(d.used_today) || 0,
          remaining: Number(d.remaining) || 0
        }
      }
    }
    // 失败：优先用后端 data.reason，否则按 code 推断；拒绝时也带回供展示的额度字段
    // 后端额外保护分支（契约未列）：403 service_disabled（总开关关）/ 503 key_not_configured（后台未配 key）
    //   均归一为 service_unavailable（服务暂不可用降级，绝不当作非会员去推开通）
    let reason: 'unauthorized' | 'not_member' | 'quota_exceeded' | 'rate_limited' | 'bad_request' | 'network' | 'service_unavailable'
    if (dr === 'not_member' || dr === 'quota_exceeded' || dr === 'rate_limited' || dr === 'unauthorized' || dr === 'bad_request' || dr === 'service_unavailable') {
      reason = dr
    } else if (dr === 'service_disabled' || dr === 'key_not_configured') {
      reason = 'service_unavailable'
    } else if (r.code === 0) {
      reason = 'network'
    } else if (r.code === 503) {
      reason = 'service_unavailable'
    } else if (r.code === 401) {
      reason = 'unauthorized'
    } else if (r.code === 403) {
      reason = 'not_member'
    } else if (r.code === 429) {
      reason = 'rate_limited'
    } else {
      reason = 'bad_request'
    }
    const usedToday = Number(r.data?.used_today) || 0
    const dailyLimit = Number(r.data?.daily_limit) || 0
    return {
      ok: false,
      reason,
      // 额度展示用：api_key 置空（调用方仅在 reason==='ok' 时才读 api_key）
      data: { api_key: '', endpoint: '', model: '', ttl: 0, session_id: '', daily_limit: dailyLimit, used_today: usedToday, remaining: Number(r.data?.remaining) || Math.max(0, dailyLimit - usedToday) },
      retry_after: r.code === 429 ? Number(r.data?.retry_after) || undefined : undefined
    }
  }

  /** 接口 B：分批上报本会话成功复审张数（服务端按 (session_id, seq) 幂等累加 used_today）。 */
  async reportReviewUsage(
    sessionId: string,
    seq: number,
    delta: number
  ): Promise<{ ok: boolean; usedToday?: number; remaining?: number; reason?: string }> {
    if (!this.token || !sessionId) return { ok: false, reason: 'unauthorized' }
    const r = await request<Record<string, unknown>>('ai_review_usage.php', { scope: 'review', session_id: sessionId, seq, delta: Math.max(0, Math.floor(delta)) }, this.token)
    if (r.code === 200) {
      return {
        ok: true,
        usedToday: Number(r.data?.used_today) || 0,
        remaining: Number(r.data?.remaining) || 0
      }
    }
    // 归一 reason，与 getReviewKey 同口径：service_disabled/key_not_configured/503 → service_unavailable；
    // bad_session/quota_exceeded/rate_limited/not_member/unauthorized 原样透传供调用方分支
    const drB = (r.data?.reason as string) || ''
    const reason =
      drB === 'service_disabled' || drB === 'key_not_configured' || r.code === 503
        ? 'service_unavailable'
        : drB || (r.code === 0 ? 'network' : String(r.code))
    return { ok: false, reason }
  }
}

export const authManager = new AuthManager()
