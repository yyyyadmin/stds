/**
 * 账号 / 会员 / 积分服务（主进程）
 * - 对接后台 API（见 API接口文档.md）：登录/注册/验证码/用户信息/套餐/订单/系统配置/积分消费
 * - Token 本地持久化（userData/auth.json），启动时自动恢复并刷新用户信息
 * - 统一把 login（扁平字段）与 user_info（嵌套字段）归一化为 AuthUser
 */
import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import type {
  AuthState,
  AuthUser,
  ConsumeResult,
  MembershipInfo,
  MembershipLevel,
  PlanInfo,
  SysConfig,
  UpdateInfo
} from '../../shared/ipc'

const API_BASE = 'https://st.uxuuu.cn/api/client'
const LEVELS: MembershipLevel[] = ['free', 'monthly', 'quarterly', 'yearly']

function authFile(): string {
  return join(app.getPath('userData'), 'auth.json')
}

function normLevel(v: unknown): MembershipLevel {
  const s = String(v || 'free')
  return (LEVELS.includes(s as MembershipLevel) ? s : 'free') as MembershipLevel
}

/** 归一化 login.user 与 user_info 两种结构 */
function toUser(raw: Record<string, unknown>): AuthUser {
  const membership: MembershipInfo =
    raw.membership && typeof raw.membership === 'object'
      ? (raw.membership as MembershipInfo)
      : {
          level: normLevel(raw.membership_level),
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
  return {
    id: Number(raw.id) || 0,
    phone: (raw.phone as string) || null,
    email: (raw.email as string) || null,
    nickname: (raw.nickname as string) || null,
    avatar_url: (raw.avatar_url as string) || null,
    membership: { ...membership, level: normLevel(membership.level) },
    points
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
    return !!this.user && this.user.membership.level !== 'free' && !this.user.membership.is_expired
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
      site_name: (d.site_name as string) || null
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
}

export const authManager = new AuthManager()
