/**
 * IPC 通道与渲染层 API 契约（preload <-> renderer 共享）
 */
import type { AppSettings, CategoryKey, DimensionKey, ImageRecord, PerfHint, AiReviewScope } from './types'
import type { ScanProgress } from '../main/services/scanner'
import type { ExportOptions, ExportProgress } from '../main/services/exporter'
import type { EngineStatus } from '../main/engine'
import type { ImportProgress } from '../main/services/importer'

// ---------- 账号 / 会员 / 积分（对接 API 接口文档） ----------

/**
 * 会员等级代号。后端 2026-10-15 明确：后台可自建动态套餐，代号是 custom3d 这类自由值，
 * 所以这里只列常见值作提示，类型上必须接受任意字符串（客户端绝不拿它做枚举映射）。
 */
export type MembershipLevel = 'free' | 'monthly' | 'quarterly' | 'yearly' | 'lifetime' | (string & {})

export interface MembershipInfo {
  level: MembershipLevel
  /** 身份显示名（后端 user_info.php 下发，如「年卡会员」「3天体验卡」）；后端没给时前端按 level 兜底 */
  name?: string | null
  /** 后端权威会员判定：非 free 且未过期即 true（含体验卡）。缺省时前端退回按 level 判 */
  is_vip?: boolean | null
  /** 剩余天数（向上取整）；永久会员与非会员均为 null */
  days_left?: number | null
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
  /** 服务端权威的今日 AI 复审额度（user_info.php 会员返回）；非会员/无此字段时缺省 */
  ai_review?: { daily_limit: number; used_today: number; remaining: number }
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
  /** 后端可选回传：AI 复审每日张数上限。非会员拿不到 user_info.ai_review（那是会员接口才回的字段），
   *  但会员中心想给他展示“每天 N 张”做促单；config.php 愿意回一份就能显示真数，没回则 null（界面退回定性说法，不编数字） */
  ai_review_daily_limit?: number | null
}

/** 一条积分变动记录（points_history.php）。consume_points 负=扣费、正=充值；remark 格式为「类型说明-备注」 */
export interface PointsHistoryItem {
  consume_time: string
  consume_points: number
  status: string
  remaining_points: number
  reason: string
  remark: string
}

/** 积分变动记录分页结果 */
export interface PointsHistoryResult {
  ok: boolean
  message: string
  list: PointsHistoryItem[]
  page: number
  page_size: number
  total: number
  total_pages: number
}

/** 兑换码结果（redeem_code.php，后端给什么兑什么：会员时长或积分） */
export interface RedeemResult {
  type: 'membership' | 'points'
  /** 会员码才有：套餐代号 monthly/quarterly/yearly/lifetime */
  level?: string | null
  /** 会员码才有：顺延后的新到期时间；lifetime 固定 2099-12-31，UI 显示「永久」 */
  expire_at?: string | null
  /** 积分码才有：本次到账积分 */
  points?: number
  /** 积分码才有：入账后的总余额 */
  balance?: number
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
  scanStaleInfo: 'scan:stale-info', // 引擎签名过期信息（仅开发版横幅消费）
  scanRescanStale: 'scan:rescan-stale', // 只重扫旧引擎结果的 N 张
  reclassify: 'scan:reclassify',
  // AI 复审（会员专属·后台任务）
  aiReviewStart: 'aireview:start',
  aiReviewStop: 'aireview:stop',
  aiReviewClear: 'aireview:clear', // 采纳/跳过某张后清掉它的建议
  aiReviewReject: 'aireview:reject', // 用户"不采纳"某张的建议（不改判定，仅从分歧列表剔除；不算结案，下轮复审会重判）
  aiReviewConfirm: 'aireview:confirm', // 用户确认某张已结案（一致时原样保留、采纳后留痕；不会被默认复审重跑）
  aiReviewQcDecided: 'aireview:qcdecided', // 人工在判定面板里提交过画质裁定：清掉左上角「画质需人工复审」红标
  exportPreview: 'export:preview',
  exportRun: 'export:run',
  exportCancel: 'export:cancel',
  engineStatus: 'engine:status',
  fileUrl: 'file:url', // 本地文件 -> 可展示 URL
  revealInFolder: 'file:reveal',
  // 账号 / 会员 / 积分
  authBootstrap: 'auth:bootstrap',
  authSendCaptcha: 'auth:send-captcha',
  authRegister: 'auth:register',
  authLogin: 'auth:login',
  /** 验证码登录（手机号/邮箱 + 验证码）：与 authLogin 同一个后端接口，只是不带 password */
  authLoginCode: 'auth:login-code',
  authLogout: 'auth:logout',
  authMe: 'auth:me',
  /** 兑换码兑换（redeem_code.php）：会员时长或积分，码的类型由后端定 */
  authRedeem: 'auth:redeem',
  plansList: 'member:plans',
  orderCreate: 'member:order',
  sysConfig: 'member:config',
  consumePoints: 'member:consume',
  pointsHistory: 'member:points-history',
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
  E_authChanged: 'evt:auth-changed',
  E_aiReviewProgress: 'evt:ai-review-progress'
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

/**
 * AI 复审进度（主进程→渲染 send 事件）。全局后台任务，不冻结软件；
 * 渲染层用它在顶部显非阻塞小字，在待确认页显独占进度弹窗。
 */
export interface AiReviewProgress {
  running: boolean
  total: number
  done: number
  /** 当前正在复审的文件名（basename） */
  current: string
  phase: 'preparing' | 'reviewing' | 'done' | 'stopped' | 'error'
  message: string
  /** 解析/解码失败跳过的张数 */
  failCount: number
  /** 今日额度已用尽而提前停 */
  quotaExceeded: boolean
  usedToday: number
  dailyLimit: number
  /** 本轮复审作用域：待确认栏 / 瑕疵片栏 */
  scope: AiReviewScope
}

export interface BootstrapInfo {
  settings: AppSettings
  counts: Record<string, number>
  customCategories: Array<{ id: number; name: string }>
  engine: EngineStatus
  progress: ScanProgress
  version: string
  platform: string
  /** 是否未打包的开发版（!app.isPackaged）：旧引擎重扫横幅仅在此为 true 时显示 */
  isDev: boolean
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
  importPaths(paths: string[]): Promise<{ added: number; skipped: number; existed: number; filtered: number; dupSkipped: number; nameKept: number }>
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
  /** 引擎签名过期信息：ready=引擎已拿到签名；sig=当前引擎签名（null 为签名未知）；staleCount=旧结果张数 */
  staleInfo(): Promise<{ ready: boolean; sig: number | null; staleCount: number }>
  /** 只重扫旧引擎结果的图（非扣积分），返回同 scanRescanAll */
  scanRescanStale(): Promise<{ started: boolean; message: string; reset?: number }>
  reclassify(): Promise<void>
  /** AI 复审：启动后台任务（非会员/未授权/额度尽均不会真跑）。返回是否启动及原因；scope 默认待确认；opts.force 重判本栏每一张（含已判过的，橙色「再次AI复审」用） */
  aiReviewStart(scope?: AiReviewScope, opts?: { force?: boolean }): Promise<{ started: boolean; reason?: string; usedToday?: number; dailyLimit?: number }>
  /** AI 复审：请求停止（停在当前张，已完成建议保留） */
  aiReviewStop(): Promise<void>
  /** AI 复审：采纳/跳过后清掉某张图的只读建议 */
  aiReviewClear(id: number): Promise<void>
  /** AI 复审：把某张的建议标记为"用户已不采纳"（从分歧列表剔除；不算结案，下轮复审会重新判这张） */
  aiReviewReject(id: number): Promise<void>
  /** AI 复审：把某张的建议标为"已确认结案"（标签不动，只留痕；不再计入待处理、不被默认复审重跑） */
  aiReviewConfirm(id: number): Promise<void>
  /** AI 复审：记下「这张的画质两项人已亲自在判定面板里裁过」，红标随即消失（不改任何标签与归属） */
  aiReviewQcDecided(id: number): Promise<void>
  exportPreview(opts: ExportOptions): Promise<{ will: number; total: number; byTier: Record<1 | 2 | 3, number>; sizeMB: number | null }>
  exportRun(opts: ExportOptions): Promise<ExportProgress['finished']>
  exportCancel(): Promise<void>
  engineStatus(): Promise<EngineStatus>
  fileUrl(path: string): Promise<string>
  revealInFolder(path: string): Promise<void>
  // 账号 / 会员 / 积分
  authBootstrap(): Promise<AuthState>
  authSendCaptcha(req: { phone?: string; email?: string; type: 'register' | 'login' | 'reset_password' }): Promise<{ ok: boolean; message: string }>
  authRegister(req: { phone?: string; email?: string; password: string; code: string }): Promise<{ ok: boolean; message: string }>
  authLogin(account: string, password: string): Promise<AuthState>
  /** 验证码登录。后端此刻还不认 code（2026-10-15 实测），失败原因已在主进程换成可显示的中文，界面原样回显即可 */
  authLoginCode(req: { phone?: string; email?: string; code: string }): Promise<{ ok: boolean; message: string; state: AuthState }>
  authLogout(): Promise<AuthState>
  authMe(): Promise<AuthState>
  plansList(): Promise<PlanInfo[]>
  orderCreate(productType: string, productId: string): Promise<{ ok: boolean; message: string; order_no?: string; amount?: string; product_name?: string; service_qrcode?: string }>
  sysConfig(): Promise<SysConfig>
  consumePoints(imageCount: number): Promise<ConsumeResult>
  pointsHistory(params: { type?: string; page?: number; page_size?: number }): Promise<PointsHistoryResult>
  /** 兑换码：成功返回权益详情，失败 message 原样可弹；401 时主进程已清登录态 */
  redeemCode(code: string): Promise<{ ok: boolean; message: string; result?: RedeemResult }>
  checkUpdate(): Promise<UpdateInfo | null>
  openExternal(url: string): Promise<void>
  libraryClear(): Promise<{ cleared: number }>
  cacheClear(): Promise<{ retried: number; files: number; freedMB: number; logs: number; big: number; engineInput: number }>
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
  onAiReviewProgress(cb: (p: AiReviewProgress) => void): () => void
}
