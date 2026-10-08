/**
 * IPC 通道与渲染层 API 契约（preload <-> renderer 共享）
 */
import type { AppSettings, CategoryKey, ImageRecord } from './types'
import type { ScanProgress } from '../main/services/scanner'
import type { ExportOptions, ExportProgress } from '../main/services/exporter'
import type { EngineStatus } from '../main/engine'
import type { ImportProgress } from '../main/services/importer'
import type { TuneReport } from '../main/services/tuner'

// ---------- 账号 / 会员 / 积分（对接 API 接口文档） ----------

export type MembershipLevel = 'free' | 'monthly' | 'quarterly' | 'yearly'

export interface MembershipInfo {
  level: MembershipLevel
  start_at?: string | null
  expire_at?: string | null
  is_expired?: boolean
}

export interface AuthUser {
  id: number
  phone?: string | null
  email?: string | null
  nickname?: string | null
  avatar_url?: string | null
  membership: MembershipInfo
  points: { balance: number; total_earned: number; total_consumed: number }
}

export interface AuthState {
  loggedIn: boolean
  token: string | null
  user: AuthUser | null
}

export interface PlanInfo {
  code: string
  name: string
  duration_days: number
  price: string
  original_price: string
  points_gift: number
  features: string[]
  is_recommended: number
}

export interface ConsumeResult {
  ok: boolean
  consumed: number
  remaining: number | null
  insufficient: boolean
  memberFree?: boolean
  required?: number
  balance?: number
  message?: string
}

export interface SysConfig {
  wechat_qrcode: string | null
  customer_service_qrcode: string | null
  site_name: string | null
}

export const CH = {
  // 渲染 -> 主（invoke）
  appBootstrap: 'app:bootstrap',
  importPaths: 'import:paths',
  importCancel: 'import:cancel',
  importPickFolder: 'import:pick-folder',
  pickFolder: 'dialog:pick-folder',
  listImages: 'images:list',
  imageGet: 'images:get',
  categoryCounts: 'images:counts',
  moveImages: 'images:move',
  deleteImages: 'images:delete',
  correctImage: 'images:correct', // 一键修正（判定正确/错误）
  customList: 'custom:list',
  customAdd: 'custom:add',
  customRemove: 'custom:remove',
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  scanStart: 'scan:start',
  scanStop: 'scan:stop',
  scanProgress: 'scan:progress',
  scanRescanAll: 'scan:rescan-all',
  reclassify: 'scan:reclassify',
  exportPreview: 'export:preview',
  exportRun: 'export:run',
  exportCancel: 'export:cancel',
  engineStatus: 'engine:status',
  tuneNow: 'tune:now',
  tuneReset: 'tune:reset',
  tuneStats: 'tune:stats',
  fileUrl: 'file:url', // 本地文件 -> 可展示 URL
  revealInFolder: 'file:reveal',
  // 账号 / 会员 / 积分
  authBootstrap: 'auth:bootstrap',
  authSendCaptcha: 'auth:send-captcha',
  authRegister: 'auth:register',
  authLogin: 'auth:login',
  authLogout: 'auth:logout',
  authMe: 'auth:me',
  plansList: 'member:plans',
  orderCreate: 'member:order',
  sysConfig: 'member:config',
  consumePoints: 'member:consume',
  checkUpdate: 'app:check-update',
  // 主 -> 渲染（send 事件）
  E_scanProgress: 'evt:scan-progress',
  E_scanImage: 'evt:scan-image',
  E_importProgress: 'evt:import-progress',
  E_exportProgress: 'evt:export-progress',
  E_thumbsReady: 'evt:thumbs-ready',
  E_authChanged: 'evt:auth-changed'
} as const

export interface BootstrapInfo {
  settings: AppSettings
  counts: Record<string, number>
  customCategories: Array<{ id: number; name: string }>
  engine: EngineStatus
  progress: ScanProgress
  version: string
  platform: string
}

export interface MoveRequest {
  ids: number[]
  category: CategoryKey
  physical?: boolean
  /** 是否同时清除旧 AI 坏标签（移动到成品库/中性分类时） */
  clearBadTags?: boolean
}

export interface CorrectRequest {
  imageId: number
  action: 'correct' | 'wrong'
  origDim: string | null
  origConfidence: number | null
  /** 判定错误时的目标分类 */
  targetCategory?: CategoryKey
}

export interface RendererApi {
  bootstrap(): Promise<BootstrapInfo>
  pickFolder(): Promise<string | null>
  importPaths(paths: string[]): Promise<{ added: number; skipped: number; existed: number }>
  importCancel(): Promise<void>
  listImages(filter: { category?: CategoryKey; status?: string }): Promise<ImageRecord[]>
  getImage(id: number): Promise<ImageRecord | null>
  categoryCounts(): Promise<Record<string, number>>
  moveImages(req: MoveRequest): Promise<void>
  deleteImages(ids: number[]): Promise<void>
  correctImage(req: CorrectRequest): Promise<ImageRecord | null>
  customList(): Promise<Array<{ id: number; name: string }>>
  customAdd(name: string): Promise<{ id: number; name: string }>
  customRemove(id: number): Promise<void>
  getSettings(): Promise<AppSettings>
  saveSettings(s: Partial<AppSettings>): Promise<AppSettings>
  scanStart(): Promise<{ started: boolean; message: string }>
  scanStop(): Promise<void>
  scanRescanAll(): Promise<{ started: boolean; message: string }>
  reclassify(): Promise<void>
  exportPreview(opts: ExportOptions): Promise<{ will: number; total: number }>
  exportRun(opts: ExportOptions): Promise<ExportProgress['finished']>
  exportCancel(): Promise<void>
  engineStatus(): Promise<EngineStatus>
  tuneNow(): Promise<TuneReport>
  tuneReset(): Promise<void>
  tuneStats(): Promise<{ total: number; perDim: Record<string, { falsePositive: number; truePositive: number; total: number }> }>
  fileUrl(path: string): Promise<string>
  revealInFolder(path: string): Promise<void>
  // 账号 / 会员 / 积分
  authBootstrap(): Promise<AuthState>
  authSendCaptcha(req: { phone?: string; email?: string; type: 'register' | 'login' | 'reset_password' }): Promise<{ ok: boolean; message: string }>
  authRegister(req: { phone?: string; email?: string; password: string; code: string }): Promise<{ ok: boolean; message: string }>
  authLogin(account: string, password: string): Promise<AuthState>
  authLogout(): Promise<AuthState>
  authMe(): Promise<AuthState>
  plansList(): Promise<PlanInfo[]>
  orderCreate(productType: string, productId: string): Promise<{ ok: boolean; message: string; order_no?: string; amount?: string }>
  sysConfig(): Promise<SysConfig>
  consumePoints(imageCount: number): Promise<ConsumeResult>
  checkUpdate(current: string): Promise<{ has_update: boolean; latest_version?: string; notes?: string; download_url?: string } | null>
  // 事件订阅
  onScanProgress(cb: (p: ScanProgress) => void): () => void
  onScanImage(cb: (img: ImageRecord) => void): () => void
  onImportProgress(cb: (p: ImportProgress) => void): () => void
  onExportProgress(cb: (p: ExportProgress) => void): () => void
  onThumbsReady(cb: (count: number) => void): () => void
  onAuthChanged(cb: (state: AuthState, consume?: ConsumeResult) => void): () => void
}
