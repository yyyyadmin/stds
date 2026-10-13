/**
 * IPC 通道与渲染层 API 契约（preload <-> renderer 共享）
 */
import type { AppSettings, CategoryKey, DimensionKey, ImageRecord, PerfHint } from './types'
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
  pickImages: 'dialog:pick-images',
  listImages: 'images:list',
  listImagesByGroups: 'images:by-groups', // 按 dup_group 取整组成员（重复/连拍分组视图补全“第一张”）
  listErrorImages: 'images:list-error', // 失败图列表（顶栏徒章点开定位重跑）
  imageGet: 'images:get',
  listByIds: 'images:list-by-ids', // 差量刷新：只重拉受影响 id 的精简记录（不含 details），并按当前分类视图判定去留
  categoryCounts: 'images:counts',
  perfHint: 'perf:hint', // 机器性能探测（核数/内存/GPU 合成）：低配自动精简的依据
  moveImages: 'images:move',
  restoreImages: 'images:restore', // 撤回移动：按快照还原分类与标签
  reorderImages: 'images:reorder', // 手动拖拽排序：按传入 id 顺序写入 sort_order
  deleteImages: 'images:delete',
  correctImage: 'images:correct', // 一键修正（判定正确）
  removeDimTag: 'images:removeDimTag', // 删除标签：从该维度分类视图消失（支持多选批量），记一条误判样本
  addDimTag: 'images:addDimTag', // 添加标签：图同时出现在该维度分类并排第一（不是移动），记一条漏检样本
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
  openExternal: 'app:open-external',
  libraryClear: 'data:library-clear',
  cacheClear: 'data:cache-clear',
  bigPreview: 'img:big-preview',
  imgMeta: 'img:meta', // 原图拍摄参数（EXIF）：大图右栏“拍摄参数”区，CR3 等容器走字节解析兑底
  // 主 -> 渲染（send 事件）
  E_scanProgress: 'evt:scan-progress',
  E_thumbsProgress: 'evt:thumbs-progress',
  E_scanImage: 'evt:scan-image',
  E_importProgress: 'evt:import-progress',
  E_exportProgress: 'evt:export-progress',
  E_thumbsReady: 'evt:thumbs-ready',
  E_authChanged: 'evt:auth-changed'
} as const

/** 软件更新（check_update.php，后台按 platform 返回对应平台安装包：windows=Windows，mac=macOS Intel，arm=macOS Apple 芯片） */
export interface UpdateInfo {
  has_update: boolean
  latest_version?: string
  current_version?: string
  notes?: string
  download_url?: string
  file_size_mb?: number
  platform: 'windows' | 'mac' | 'arm'
}

/** 大图右栏“拍摄参数”区的一条键值（主进程统一格式化：中文名 + 可读值） */
export interface MetaItem {
  k: string
  v: string
}

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
  /** 是否同时清除旧 AI 坏标签（目标是交付库或中性维度—即侧栏「人物与影调」—时） */
  clearBadTags?: boolean
  /** 目标为废弃库(trash)时：丢弃时用户正看着的来源栏 key，存进 trash_from 供按来源还原 */
  source?: CategoryKey
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
  pickImages(): Promise<string[] | null>
  importPaths(paths: string[]): Promise<{ added: number; skipped: number; existed: number; filtered: number }>
  importCancel(): Promise<void>
  listImages(filter: { category?: CategoryKey; status?: string }): Promise<ImageRecord[]>
  /** 按 dup_group 批量取整组全部成员（含不在当前分类的保留帧），供重复/连拍分组视图补全整组 */
  listImagesByGroups(gids: string[]): Promise<ImageRecord[]>
  /** 失败（status=error）图列表 */
  listErrorImages(): Promise<Array<{ id: number; filename: string; dir: string }>>
  getImage(id: number): Promise<ImageRecord | null>
  /** 差量对账：按当前视图分类回拉受影响 id 的最新记录；不再属于该视图的 id 不会出现在返回里（调用方据此移除） */
  listByIds(category: CategoryKey, ids: number[]): Promise<ImageRecord[]>
  categoryCounts(): Promise<Record<string, number>>
  /** 机器性能探测（第二档 A1）：窗口出来后调一次，结合 perfMode 决定是否进精简模式 */
  perfHint(): Promise<PerfHint>
  moveImages(req: MoveRequest): Promise<void>
  /** 撤回移动：把移动前的整批快照（分类/标签/categoryBy）原样还原 */
  restoreImages(snapshots: ImageRecord[]): Promise<void>
  /** 手动拖拽排序：按传入 id 的先后顺序持久化展示序 */
  reorderImages(ids: number[]): Promise<void>
  deleteImages(ids: number[]): Promise<void>
  correctImage(req: CorrectRequest): Promise<ImageRecord | null>
  /** 删除标签（可批量）：只删该维度标签并记为误判样本；若图的主分类就是该维度，同时移出该分类 */
  removeDimTag(ids: number[], dim: DimensionKey): Promise<void>
  /** 添加标签（可批量）：写用户高置信标签，图同时出现在该维度分类并排第一；人数维度自动互斥 */
  addDimTag(ids: number[], dim: DimensionKey): Promise<void>
  customList(): Promise<Array<{ id: number; name: string }>>
  customAdd(name: string): Promise<{ id: number; name: string }>
  customRemove(id: number): Promise<void>
  getSettings(): Promise<AppSettings>
  saveSettings(s: Partial<AppSettings>): Promise<AppSettings>
  scanStart(): Promise<{ started: boolean; message: string }>
  scanStop(): Promise<void>
  scanRescanAll(): Promise<{ started: boolean; message: string; reset?: number }>
  reclassify(): Promise<void>
  exportPreview(opts: ExportOptions): Promise<{ will: number; total: number; byTier: Record<1 | 2 | 3, number>; sizeMB: number | null }>
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
  orderCreate(productType: string, productId: string): Promise<{ ok: boolean; message: string; order_no?: string; amount?: string; product_name?: string; service_qrcode?: string }>
  sysConfig(): Promise<SysConfig>
  consumePoints(imageCount: number): Promise<ConsumeResult>
  checkUpdate(): Promise<UpdateInfo | null>
  openExternal(url: string): Promise<void>
  libraryClear(): Promise<{ cleared: number }>
  cacheClear(): Promise<{ retried: number; files: number }>
  /** RAW/HEIC 等浏览器不可渲染格式的原图高清预览（主进程生成，返回磁盘路径；普通格式不需要调用） */
  bigPreview(id: number): Promise<string | null>
  /** 读原图 EXIF 拍摄参数（有序键值；读不到返回 null），供大图右栏展示 */
  imageMeta(path: string): Promise<MetaItem[] | null>
  // 事件订阅
  onScanProgress(cb: (p: ScanProgress) => void): () => void
  onThumbsProgress(cb: (p: { done: number; total: number } | null) => void): () => void
  onScanImage(cb: (img: ImageRecord) => void): () => void
  onImportProgress(cb: (p: ImportProgress) => void): () => void
  onExportProgress(cb: (p: ExportProgress) => void): () => void
  onThumbsReady(cb: (count: number) => void): () => void
  onAuthChanged(cb: (state: AuthState, consume?: ConsumeResult) => void): () => void
}
