/**
 * 全局状态（zustand）
 * 覆盖：分类树与计数、当前视图图片、选择集（Shift/Ctrl 多选）、
 * 扫描进度事件流、一键修正、导出/设置对话框、视图快捷键 1-3 与大图 4
 */
import { create } from 'zustand'
import type { AppSettings, CategoryKey, ImageRecord, DimensionKey, PerfHint, TierKey, AiReviewSuggestion, AiReviewScope } from '../../shared/types'
import { CAT_LIBRARY, CAT_REVIEW, CAT_TRASH, CAT_DUP_TRASH, CAT_FLAWS, QC_MANUAL_DIMENSIONS, DIMENSION_LABELS, isBadDim, isStructuralDim, isTrashLike, NEUTRAL_DIMENSIONS, PERSON_DIMS, guessMidDim, flawLevel, SUPPORTED_EXTS, tierOfCat, DEFAULT_TIER_NAMES } from '../../shared/types'
import type { AiReviewProgress, AuthState, BootstrapInfo, ConsumeResult, MoveRequest, PlanInfo, UpdateInfo } from '../../shared/ipc'
import { isVip } from '../../shared/membership'
import { effectiveUiScale } from './uiScale'
import type { ScanProgress } from '../../main/services/scanner'
import type { ExportProgress } from '../../main/services/exporter'

export type SortKey = 'default' | 'name' | 'name-desc' | 'conf-asc' | 'conf-desc' | 'time'

/**
 * 大图该按哪个顺序数、翻页、排左侧缩略图：网格实际展示序（排序 + 文件名筛选后的 id 序列，
 * 由 ImageView 同步到 displayIds）。以前大图直接用 images（库里顺序），于是“网格第 500 张、
 * 大图计数器写 20/600”，带筛选时按 → 还会翻到没命中的图。
 * displayIds 可能是别的视图（重复分组等）遗留的，只要有 id 对不上就退回库里顺序——
 * 宁可顺序不完美，也不能翻到列表里没有的图。
 */
export function displayOrder(images: ImageRecord[], displayIds: number[]): ImageRecord[] {
  if (!displayIds.length || displayIds.length > images.length) return images
  const byId = new Map(images.map((i) => [i.id, i]))
  const out: ImageRecord[] = []
  for (const id of displayIds) {
    const r = byId.get(id)
    if (!r) return images
    out.push(r)
  }
  return out
}

/**
 * 文件名过滤（纯展示层，不改库里任何数据）：大小写不敏感的子串匹配。
 * 支持用空格/逗号/顿号/分号/换行分隔多个词，命中任意一个即保留——
 * 开发者给的复查清单是一长串文件名，整段粘进来就能一次翻完。
 */
export function filterByQuery(images: ImageRecord[], query: string): ImageRecord[] {
  const tokens = query
    .toLowerCase()
    .split(/[\s,，、;；\u3000]+/)
    .map((t) => t.trim())
    .filter(Boolean)
  if (!tokens.length) return images
  return images.filter((i) => {
    const name = i.filename.toLowerCase()
    return tokens.some((t) => name.includes(t))
  })
}

/** 一次移动操作的撤回快照：保存移动前全部图片记录（分类/标签/categoryBy） */
export interface UndoSnapshot {
  ids: number[]
  at: number
  /** 本次移动的目标分类（提示用） */
  toCat: CategoryKey
  recs: ImageRecord[]
}

/**
 * 状态分类 = 交付库 / 待确认 / 自定义（不含维度分类与废弃库）。
 * 移动到状态分类 = 人工担保这张图，清掉全部坏维度标签，让它从各坏图并集视图消失；
 * 人数与黑白这类“客观事实”标签一律保留（导出按标签并集捞图，删了就再也选不回来）；
 * 移动到维度分类只补目标标签（其它维度证据保留），移入废弃库保留全部标签作为废弃原因。
 */
function isStatusCat(cat: CategoryKey): boolean {
  // 档位子视图（D4）：拖到档位只是改档（主进程 tier 分支不碰标签），不该触发“人工担保清瑕疵标签”
  if (tierOfCat(cat)) return false
  // 结构维度（重复/连拍 v2.0.67）也不是状态分类：它是个“逐组选留哪张”的并集视图。
  // 不挡住的后果：拖进重复类会被当成“人工担保放行”→ 把闭眼/模糊这些瑕疵证据标签全清掉，
  // “换一张保留”刚把图退回重复组，它身上的其它判定就没了。
  return !isTrashLike(cat) && !isBadDim(cat) && !isStructuralDim(cat) && !(NEUTRAL_DIMENSIONS as string[]).includes(cat)
}

/**
 * 从标签推断人数主分类（与主进程 computeCategory 同口径：取 PERSON_DIMS 里首个非 low 标签），
 * 无可用人数标签则回退待确认。废弃库还原“瑕疵片/坏维度”这类虚视图来源时用它落回真实栏。
 */
function personCatFromTags(tags: ImageRecord['tags'] | undefined): CategoryKey {
  if (tags) {
    for (const dim of PERSON_DIMS) {
      const t = tags[dim]
      if (t && t.level !== 'low') return dim
    }
  }
  return CAT_REVIEW
}

/** 人数四维度互斥表 PERSON_DIMS 直接从 shared/types 导入（与主进程同一份，不再各写一份） */

/**
 * AI 建议里内容型瑕疵的键 → 本项目 DimensionKey。
 * 模型侧用 `expression` 描述"表情崩坏"，落库口径是 `face_ugly`，这里做唯一一处映射，
 * 采纳时据此把只读建议翻译成与手动重判完全一致的 addDimTag/removeDimTag 目标。
 */
const AI_FLAW_TO_DIM: Record<keyof AiReviewSuggestion['flaws'], DimensionKey> = {
  eyes_closed: 'eyes_closed',
  half_head: 'half_head',
  expression: 'face_ugly'
}

/**
 * 图当前"可见"的人数归属（与 ReviewPanel.visiblePerson 同口径）：取 PERSON_DIMS 里首个非 low 标签，
 * 旧数据 category 恰为人数维时兜底；都没有返回 null（表示 AI 没标 / 手动也没标，采纳时按需补标）。
 */
function visiblePersonOf(img: ImageRecord): DimensionKey | null {
  const d = PERSON_DIMS.find((p) => img.tags?.[p] && img.tags[p]!.level !== 'low')
  if (d) return d
  return (PERSON_DIMS as string[]).includes(img.category) ? (img.category as DimensionKey) : null
}

/** 一张图的 AI 建议与现状的差异行（人数 + 内容型瑕疵）：逐张对比视图与小结计数共用同一口径 */
export interface AiReviewDiffRow {
  label: string
  from: string
  to: string
}
export function aiReviewDiffRows(img: ImageRecord): AiReviewDiffRow[] {
  const s = img.ai_review
  // 用户已明确"不采纳"或已确认结案的建议不再算分歧（图留在原地、不计入分歧列表/全部采纳）
  if (!s || s.rejected || s.confirmed) return []
  const rows: AiReviewDiffRow[] = []
  const cur = visiblePersonOf(img)
  if (cur !== s.person) rows.push({ label: '人数', from: cur ? DIMENSION_LABELS[cur] : '未标', to: DIMENSION_LABELS[s.person] })
  for (const key of Object.keys(s.flaws) as (keyof typeof s.flaws)[]) {
    const dim = AI_FLAW_TO_DIM[key]
    const want = s.flaws[key]
    const has = !!img.tags?.[dim] && img.tags[dim]!.level !== 'low'
    if (want !== has) rows.push({ label: DIMENSION_LABELS[dim], from: has ? '有' : '无', to: want ? '有' : '无' })
  }
  return rows
}
/** 该图是否有与现状不同的 AI 建议（驱动小结的"有不同意见 M 张"） */
export function hasAiReviewDiff(img: ImageRecord): boolean {
  return aiReviewDiffRows(img).length > 0
}

/**
 * 逐张复核左栏：云端复核范围内四项的「本地检测 / 云端复核」并列比对。
 * 与 aiReviewDiffRows 的分工要说清：那份只列有差异的（驱动按钮和计数），这份四项全列——
 * 用户 10-14 要的是"左边一眼看到两边各说了什么"，只看改动清单看不出"没改的项两边都是无"。
 * 已结案/不采纳的建议在这里照样显示（不像 aiReviewDiffRows 那样清空），否则归位图会一片空白。
 */
export interface AiReviewCompareRow {
  label: string
  local: string
  cloud: string
  diff: boolean
}
export function aiReviewCompareRows(img: ImageRecord): AiReviewCompareRow[] {
  const s = img.ai_review
  if (!s) return []
  const rows: AiReviewCompareRow[] = []
  const cur = visiblePersonOf(img)
  rows.push({
    label: '人数归属',
    local: cur ? DIMENSION_LABELS[cur] : '未标',
    cloud: DIMENSION_LABELS[s.person],
    diff: cur !== s.person
  })
  for (const key of Object.keys(s.flaws) as (keyof typeof s.flaws)[]) {
    const dim = AI_FLAW_TO_DIM[key]
    const has = !!img.tags?.[dim] && img.tags[dim]!.level !== 'low'
    const want = s.flaws[key]
    rows.push({ label: DIMENSION_LABELS[dim], local: has ? '有' : '无', cloud: want ? '有' : '无', diff: has !== want })
  }
  return rows
}

/**
 * 该图是否还挂着「等用户表态」的 AI 建议（逐张复核队列的入选口径）。
 * 与 hasAiReviewDiff 的区别很关键：AI 与本地一致的图没差异可采，但它同样需要用户点一下「确认采纳」才算结案
 * （用户：复审的目的就是把待确认清空，不能因为两边意见相同就不让我采纳）。
 */
export function hasAiReviewPending(img: ImageRecord): boolean {
  const s = img.ai_review
  return !!s && !s.rejected && !s.confirmed
}

/**
 * 这张图上「云端 AI 没看过」的画质维度（模糊 / 曝光）——就是只能人工定、不能拿“AI 没意见”当放行依据的那几项。
 * 为什么单独问一句：云端提示词只让它判人数 + 闭眼/半截头/表情崩坏（见 aiReviewPrompt.ts，“模糊/曝光/黑白一律不判”），
 * 而待确认里很多图恰恰是卡在“画面模糊（存疑）”上。不把这个盲区说破，用户会误以为“AI 也没意见 = 这张没问题”（用户实反馈：刚才我就迷糊了）。
 */
export function aiReviewBlindSpots(img: ImageRecord): DimensionKey[] {
  return QC_MANUAL_DIMENSIONS.filter((d) => !!img.tags?.[d] && img.tags[d]!.level !== 'low')
}

/**
 * 这张是否还等人工定画质：AI 复审过且已结案（点过「采纳这张」或「确认采纳」）、还挂着云端不看的模糊/曝光，且人没在判定面板里裁过。
 * 现算而不读存起来的标记：画质标签一删（重判面板里删掉或重扫改了结论）它就该立刻变回普通图，
 * 存标记会烂成“角标一直挂着但画质已经没了”。与主进程 db.ts 的 isManualQc 同口径。
 * qcDecided（用户 10-15 拍板）：人在面板里提交过一次，就不再说“等你裁”——
 * 不管他最后判“该有”还是“不该有”，画质这项已经过人了，红标再挂着就是催一件已经办完的事。
 * 驱动三件事：卡片左上角的红底角标、标签变暗规则、本栏默认排序把它顶最前（用户 10-14 拍板）。
 */
export function needsManualReview(img: ImageRecord): boolean {
  const s = img.ai_review
  if (!s || !s.confirmed || s.qcDecided) return false
  return aiReviewBlindSpots(img).length > 0
}

/**
 * 待确认 / 瑕疵片默认顺序的分层（用户 10-14：人工复审的排最前，其次不采纳的）：
 *  0 = 等人工定画质（AI 说不上话，只能你定）
 *  1 = 你不采纳过：不采纳不算结案，等下一轮 AI 重判（图同时留在本栏等你手动定也行）
 *  2 = 有建议还没表态（逐张复核队列里的那些）
 *  3 = 其余（没判过的、已干净的）
 */
export function aiReviewRank(img: ImageRecord): number {
  if (needsManualReview(img)) return 0
  const s = img.ai_review
  if (s?.rejected) return 1
  if (aiReviewShouldHome(img)) return 2 // 已结案但该归位：同样等你点一下，不能让它悄悄排在后面
  if (s && !s.confirmed) return 2
  return 3
}

/**
 * 该归位（用户 10-14 实测抓出的那类“谁都不管的一张”）：这张已结案，身上再没有任何中/高置信瑕疵，
 * 却还停在待确认。成因有两个：以前手动停泊进来的干净图（靠“停泊”这一条留在视图里）、存疑瑕疵刚被复审删干净。
 * 两种都不该继续占着待确认——待确认能不能真清空就看这一条（用户原话：我的目的就是清空待确认）。
 * 判定用的是“身上没瑕疵标签”这个事实（本地检测 + 已结案的人工确认），不是拿云端的默许当放行依据。
 */
export function aiReviewShouldHome(img: ImageRecord): boolean {
  const s = img.ai_review
  if (!s || !s.confirmed || s.rejected) return false
  return img.category === CAT_REVIEW && flawLevel(img.tags || {}) === 'none'
}

/**
 * 这张还等你做点什么：有建议还没表意的（含与本地一致的）或已结案但该归位的。
  * 顶部条、逐张队列、全部采纳三处共用这一个口径，避免再出现“哪儿都不在”的图。
 */
export function hasAiReviewAction(img: ImageRecord): boolean {
  return hasAiReviewPending(img) || aiReviewShouldHome(img)
}

/**
 * 标签增删的本地乐观更新：先把 store.images 里的记录改到位，界面立即变（芯片秒加/秒删），
 * 不等主进程写完再重拉整个分类列表（几千张时那才是“点了半天没反应”的根源）。
 * 主分类连带移出规则与后端 removeDimTag 一致：取剩余最高置信坏维度，没有则回交付库。
 */
function patchTagLocal(img: ImageRecord, dim: DimensionKey, add: boolean): ImageRecord {
  const tags = { ...img.tags }
  let category = img.category
  if (!add) {
    delete tags[dim]
    // D2：主分类恒为人数，删瑕疵标签不改归属（图靠 flawLevel 自动离开瑕疵片/待确认）；
    // 仅当删掉的正是当前主分类（人数维或旧数据坏维度）时回落，真实归属由后端 removeDimTag 重算。
    if (category === dim) category = CAT_LIBRARY
    return { ...img, tags, category }
  }
  if (PERSON_DIMS.includes(dim)) {
    for (const d of PERSON_DIMS) if (d !== dim) delete tags[d]
    // 主分类是另一个人数分类时必须跟着换：维度相册是「主分类 ∪ 标签」的并集视图，
    // 只换标签不换归属的话，旧相册仍会靠主分类命中它（一张图同时出现在单人照和多人合拍照）
    if ((PERSON_DIMS as string[]).includes(category)) category = dim
  }
  // 与主进程 addDimTag 同口径：时间戳盖在标签上（taggedAt），只让图在目标分类排第一；
  // 不刷 catChangedAt——那会把图在当前浏览的分类里也顶到顶部（加标签不是移动，位置不该动）
  tags[dim] = { confidence: 1, level: 'high', reason: '用户手动添加', method: 'user', taggedAt: Date.now() }
  return { ...img, tags }
}

/** 分类键 → 中文名（撤回提示用） */
function catLabel(cat: CategoryKey, customs: Array<{ id: number; name: string }>, tierNames?: string[]): string {
  const tierN = tierOfCat(cat)
  if (tierN) return `交付库/${(tierNames ?? DEFAULT_TIER_NAMES)[tierN - 1] || String(tierN)}`
  if (cat === CAT_LIBRARY) return '交付库'
  if (cat === CAT_REVIEW) return '待确认'
  if (cat === CAT_TRASH) return '废弃库'
  const s = cat as string
  if (s.startsWith('custom:')) {
    const c = customs.find((x) => x.id === Number(s.slice(7)))
    return c ? `自定义「${c.name}」` : '自定义分类'
  }
  return DIMENSION_LABELS[s as keyof typeof DIMENSION_LABELS] || s
}

/**
 * 网格一行列数（2026-10-19 用户拍板，替代旧的格子像素滑块 gridSize 100~610）：
 * 客户的心智模型就是“一行几张”，顶栏视图组旁的「一行 N 张」按钮 + Ctrl+滚轮按列步进，
 * 两入口共用这一个设置（localStorage 持久化）；都不悬浮压在图上。
 * 清晰度无忧：列数变少格子变大时 ThumbImg 选档逻辑自动改用大档缩略图（960）。
 */
export const GRID_COLS_MIN = 3
export const GRID_COLS_MAX = 7
function resolveGridCols(): number {
  const v = Number(localStorage.getItem('gridCols'))
  if (Number.isFinite(v) && v >= GRID_COLS_MIN && v <= GRID_COLS_MAX) return v
  const old = Number(localStorage.getItem('gridSize'))
  if (Number.isFinite(old) && old >= 100 && old <= 610) {
    // 老版本存的是格子像素：换算成最接近的列数，不把客户调好的习惯清零（12=网格间距 gap-3）
    const est = Math.round((window.innerWidth - 260) / (old + 12))
    return Math.max(GRID_COLS_MIN, Math.min(GRID_COLS_MAX, est))
  }
  // 从没选过：按屏幕自适应（innerWidth 是界面缩放后的有效宽，与 uiScale 同一口径）——
  // 笔记本 4 列、中等屏 5 列、2K/4K 大屏 6 列，装机第一眼就“图不小”
  const w = window.innerWidth
  return w < 1700 ? 4 : w < 2100 ? 5 : 6
}

interface StoreState {
  ready: boolean
  settings: AppSettings
  /** 低配精简模式生效中（第二档 A1，见 applyPerfLean）：渲染层选档/降级 UI 读它 */
  perfLean: boolean
  /** 机器性能探测原始结果（设置页展示本机档位用）：null=未探到/探测失败 */
  perfHint: PerfHint | null
  /** 纯按探测结果判“这台机器是不是低配”（不受手动档影响）：告诉用户自己的硬件级别用 */
  perfAutoLean: boolean
  counts: Record<string, number>
  customCategories: Array<{ id: number; name: string }>
  activeCategory: CategoryKey | null
  images: ImageRecord[]
  viewMode: 'grid' | 'list' | 'masonry'
  /** 网格一行列数（3~7，顶栏按钮与 Ctrl+滚轮共用；见 GRID_COLS_MIN 注释） */
  gridCols: number
  sortKey: SortKey
  /** 文件名搜索词：只显示当前相册里匹配的图片，切相册自动清空 */
  query: string
  /** 当前视图的展示顺序（id 序列，由 ImageView 在排序后同步）：点击索引必须按它映射，
   * 否则非默认排序下会选错图（选中样式“消失”） */
  displayIds: number[]
  selection: Set<number>
  anchorIndex: number
  previewId: number | null
  /** 大图人脸框/关键点叠加：默认关。那是给校阈值的人看的诊断视图，
   * 判片时框线只会遮住要看的细节；要看的人点顶部「标记叠加」打开，本次筛选全程记住 */
  previewOverlay: boolean
  /** 复核模式会话：在大图里连续过片时记录“本轮开始时的总数 + 所属分类”，
   *  用于显示「已判 X / 共 Y」进度。判完（该分类清空）自动结束并置 null */
  reviewSession: { total: number; cat: string } | null
  scanProgress: ScanProgress | null
  importProgress: { done: number; total: number; current: string } | null
  /** 后台缩略图回填进度（生成完毕后为 null） */
  thumbsProgress: { done: number; total: number } | null
  /** AI 复审后台任务进度（主进程事件回填；null=从未跑过/已收尾）。只读建议的呈现由它驱动 */
  aiReview: AiReviewProgress | null
  /** 本轮复审完成后的小结横条是否被"以后再说"收起（新一轮完成自动重置） */
  aiReviewSummaryDismissed: boolean
  /** 复审刚跑完→正在把库里的建议读回内存的短暂收尾态：此期间内容区显示"整理结果"加载遮罩，不可关闭 */
  aiReviewSettling: boolean
  /** 页内顶部条的就地反馈（点了复审但没跑起来的原因）：用户视线就在按钮上，比底部 toast 显眼；6 秒自动消失 */
  aiReviewFeedback: string | null
  dismissAiReviewSummary(): void
  /** 从页内顶部入口重新唤起本轮完成小结（把被"以后再说"收起的面板再打开） */
  reopenAiReviewSummary(): void
  /** 移动撤回栈（栈顶 = 最近一次移动） */
  undoSnapshots: UndoSnapshot[]
  exportProgress: ExportProgress | null
  showExport: boolean
  showSettings: boolean
  showLogin: boolean
  showMember: boolean
  /** 「联系客服开通」二维码弹窗（用户 2026-10-15 定：软件内不收款，只有点「开通」才弹码） */
  showContactQr: boolean
  /** 是从哪一档套餐弹出来的；未登录或从别的入口进来为 null，弹窗改说「任一套餐」 */
  contactQrPlan: PlanInfo | null
  /** 启动自动检查到新版时的更新弹窗 */
  showUpdate: boolean
  updateInfo: UpdateInfo | null
  /** 失败照片定位弹窗（顶栏红色徽章点开） */
  showFailedImages: boolean
  /** 新手指导（首启分步带路）：没看过则启动后自动弹一次，之后只能从侧栏「新手指导」重放 */
  showOnboarding: boolean
  /** 带路“暂停”：亮层收起、界面交还给用户自己点（引导没结束，底部留胶囊可继续）。
   *  暂停时全局快捷键不再屏蔽，不然用户想按 1/2/3 换视图、按 Del 丢废片都按不动。 */
  onboardingPaused: boolean
  auth: AuthState
  toast: { msg: string; kind: 'info' | 'error' | 'success'; duration?: number } | null
  /** 多选（≥2 张）移入废弃库的确认弹窗（单选直接移，不弹；null = 不显示） */
  trashAsk: { physical: boolean } | null
  engineBusy: boolean
  /** 当前真引擎类型（顶栏徽章用，用户 10-18）：python 才显“运行中”；node=降级被杀显黄色“引擎异常”；none=还没握手完 */
  engineType: 'python' | 'node' | 'none'
  appVersion: string
  /** 是否未打包的开发版。截至 v2.0.76 仅被赋值，没有任何界面消费它。
      旧引擎重扫横幅（StaleBanner）开发版与正式版都显示——用户 2026-10-14 拍板：
      系统升级后，老客户库里还没按新规则筛过的图就该支持再来一次。
      别仅凭这条注释给它加“仅开发版”门禁（旧注释已错过一次，db.ts 迁移注释才是准的）。 */
  isDev: boolean
  /** 引擎签名过期信息：ready=引擎已报签名；sig=当前签名；count=旧引擎结果张数 */
  staleReady: boolean
  staleSig: number | null
  staleCount: number
  /**
   * 图片数据对账版本号：每次移动 / 加删标签 / 撤回等改动刷新列表后 +1。
   * 重复分组详情靠它感知“组内某成员的数据变了、但组号没变”（比如把一张冗余帧要进交付库，
   * 它离开了当前分类列表、整组成员却是按组号缓存的，不 bump 就会一直显示它的旧标签卡在下面）。
   */
  dataRev: number

  bootstrap(): Promise<void>
  setTheme(t: 'light' | 'dark'): Promise<void>
  toggleTheme(): Promise<void>
  /** 界面缩放：按 settings.uiScale（auto 看窗口宽度）算倍率，交给主进程整页缩放；启动、改设置、窗口变化时重apply */
  applyUiScale(): void
  openLogin(): void
  closeLogin(): void
  openMember(): void
  closeMember(): void
  /** 弹「联系客服开通」：传套餐则写明这一档价目，不传就是通用引导 */
  openContactQr(plan?: PlanInfo | null): void
  closeContactQr(): void
  /** 首次开启 AI 复审的应用内授权弹窗（禁 window.confirm）：null=false 不显示 */
  showAiReviewConsent: boolean
  /** 开关 AI 复审：开启时若尚未授权先弹授权弹窗（同意才真开），已授权则存偏好并后台跑一次 */
  toggleAiReview(): void
  /** 授权弹窗里点[同意并开启]：落盘 consent+enabled 并立即启动复审 */
  agreeAiReviewConsent(): void
  /** 关闭授权弹窗（不同意）：不改任何偏好 */
  dismissAiReviewConsent(): void
  doLogin(account: string, password: string): Promise<{ ok: boolean; message: string }>
  /** 验证码登录（手机号或邮箱 + 验证码）。后端此刻还不认 code，失败原因由主进程换成中文，界面直接显示 */
  doLoginCode(req: { phone?: string; email?: string; code: string }): Promise<{ ok: boolean; message: string }>
  doRegister(req: { phone?: string; email?: string; password: string; code: string }): Promise<{ ok: boolean; message: string }>
  sendCaptcha(req: { phone?: string; email?: string; type: 'register' | 'login' | 'reset_password' }): Promise<{ ok: boolean; message: string }>
  doLogout(): Promise<void>
  refreshAuth(): Promise<void>
  openCategory(cat: CategoryKey | null): Promise<void>
  refreshCounts(): Promise<void>
  refreshImages(): Promise<void>
  /** 差量对账：操作后只重拉受影响的几张（移动/标签/撤回），替代整分类重拉；失败自动回退全量 */
  refreshImagesFor(ids: number[]): Promise<void>
  setSort(k: SortKey): void
  setQuery(q: string): void
  /** 视图层排序完成后同步展示序（内容未变时不重 set，避免渲染循环） */
  setDisplayIds(ids: number[]): void
  setViewMode(m: 'grid' | 'list' | 'masonry'): Promise<void>
  setGridCols(n: number): void
  handleClickSelect(index: number, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): void
  /** 网格空白处橡皮筋框选：把选中集整体设为框到的这批 id（additive=叠加到已有选中，否则全新选中） */
  marqueeSelect(ids: number[], additive?: boolean): void
  toggleSelect(id: number): void
  selectAll(): void
  selectNone(): void
  invertSelection(): void
  selectByCurrentCategoryAll(): void
  moveTo(cat: CategoryKey, physical?: boolean): Promise<void>
  moveIds(ids: number[], cat: CategoryKey): Promise<void>
  reorder(ids: number[]): Promise<void>
  undoMove(): Promise<void>
  moveToTrash(): Promise<void>
  /** 废弃库入口：单选直接移；多选（≥2）弹确认框（与放大弹窗的废弃库确认同语义） */
  askTrash(physical?: boolean): void
  confirmTrashAsk(): void
  dismissTrashAsk(): void
  restoreFromTrash(): Promise<void>
  /** 统一废弃库：按每张丢弃时的来源栏（trashFrom）分组还原，“从哪来回哪去” */
  restoreTrash(ids: number[]): Promise<void>
  /** 从废弃库直接把图选档加入交付库（复用后端档位放行分支） */
  promoteTrashToTier(ids: number[], tier: TierKey): Promise<void>
  correct(req: { imageId?: number; action: 'correct' | 'wrong'; origDim: string | null; origConfidence: number | null; targetCategory?: CategoryKey }): Promise<void>
  correctBatch(ids: number[], action: 'correct' | 'wrong', targetCategory?: CategoryKey): Promise<void>
  /** 删除标签（可批量）：只删该标签并记入误判学习；若图的主分类就是该维度，同时移出该分类 */
  removeTag(ids: number[], dim: DimensionKey): Promise<void>
  /** 添加标签（可批量）：图同时出现在该维度分类并排第一（不是移动），记入漏检学习 */
  addTag(ids: number[], dim: DimensionKey): Promise<void>
  /** 标签写入进行中的提示文案（null = 空闲）：卡片上的反馈 */
  tagBusy: string | null
  /** 标签管理器：列表端对单/多选图增删标签（null=关闭；放大弹窗里的标签栏不走它） */
  tagManagerIds: number[] | null
  /** 本次弹窗打开期间是否真正成功做过标签增删：关闭时据此清空多选 */
  tagManagerTouched: boolean
  openTagManager(ids: number[]): void
  closeTagManager(): void
  /** 待确认重判面板（D2 §8）：“此判定错误”的逐项改正入口（单/多选皆可）。null=关闭 */
  reviewPanelIds: number[] | null
  /** AI 复审“改一改”进 ReviewPanel 时的预填建议（人数预选/瑕疵三态按建议设好）；null=无预填 */
  reviewPanelPrefill: AiReviewSuggestion | null
  openReviewPanel(ids: number[], prefill?: AiReviewSuggestion | null): void
  closeReviewPanel(): void
  openPreview(id: number): void
  closePreview(): void
  togglePreviewOverlay(): void
  startReview(cat: string, total: number): void
  exitReview(): void
  stepPreview(delta: number): void
  /** 顶栏「大图」/ 快捷键 4：直接打开与双击小图同一个放大弹窗 */
  openLargePreview(): void
  startScan(): Promise<void>
  stopScan(): Promise<void>
  /** AI 复审：启动会员专属后台任务（未登录/非会员/未授权/额度尽均不会真跑，理由经 toast/会员中心回显）；scope 默认待确认；force=true 重判本栏每一张（含已判过的） */
  startAiReview(scope?: AiReviewScope, force?: boolean): Promise<void>
  /** AI 复审：请求停止（停在当前张，已完成建议保留） */
  stopAiReview(): Promise<void>
  /** 采纳单张 AI 建议：完全复用手动重判通道（add/removeDimTag + correctImage + moveIds），采纳后清该图建议 */
  adoptAiReview(id: number): Promise<boolean>
  /** 不采纳单张 AI 建议：什么都不改，只把该建议从分歧列表剔除；不采纳不算结案，下轮复审会重新判这张 */
  rejectAiReview(id: number): Promise<void>
  /** 确认单张已结案（AI 与本地一致时标签原样不动）：留痕 + 收尾归位，返回是否把它搬出了待确认 */
  confirmAiReview(id: number): Promise<boolean>
  /** 结案收尾：这张已没中/高瑕疵却还停在待确认时，按人数标签归位搬走（走 moveIds，可逐张撤回） */
  homeIfCleanParked(id: number): Promise<boolean>
  /** 批量采纳当前待确认库里所有带建议的图，返回成功采纳张数 */
  adoptAllReviewSuggestions(): Promise<number>
  rescanAll(): Promise<void>
  /** 拉取引擎签名过期信息（开发版横幅用） */
  refreshStale(): Promise<void>
  /** 只重扫旧引擎结果的图（非全库），跑完由扫描结束事件自动刷新横幅 */
  rescanStale(): Promise<void>
  clearLibraryAll(): Promise<void>
  clearCacheAll(): Promise<void>
  saveSettings(patch: Partial<AppSettings>, reclassify?: boolean): Promise<void>
  addCustomCategory(name: string): Promise<void>
  removeCustomCategory(id: number): Promise<void>
  pushUndo(ids: number[], toCat: CategoryKey): void
  undoMove(): Promise<void>
  importPaths(paths: string[]): Promise<void>
  pickAndImport(): Promise<void>
  pickAndImportImages(): Promise<void>
  /** 启动静默检查更新：有新版且未跳过该版本时弹 UpdateDialog */
  checkUpdateSilent(): Promise<void>
  /** 打开新手指导（侧栏「新手指导」重放 / 首启自动弹均走这里） */
  openOnboarding(): void
  /** 关掉新手指导：看完和提前点 × 都落“已看过”，不重复打扰 */
  closeOnboarding(): void
  /** 带路中途暂停 / 继续（不改任何数据，只切亮层显示与否） */
  pauseOnboarding(): void
  resumeOnboarding(): void
  runExport(opts: Parameters<typeof window.api.exportRun>[0]): Promise<void>
  cancelExport(): Promise<void>
  dismissToast(): void
  bindEvents(): void
}

/** 排序 key：坏标签最高置信度（用于交付库内优先抽查低置信度） */
function sortConf(img: ImageRecord): number {
  const vals = Object.values(img.tags || {})
  if (!vals.length) return 1
  return Math.max(...vals.map((t) => t?.confidence ?? 0))
}

/** 应用主题到 <html data-theme> */
function applyTheme(t: 'light' | 'dark'): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', t)
    document.documentElement.style.colorScheme = t
  }
}

/** 启动更新检查只跑一次（bootstrap 可能因 HMR/重渲染重入） */
let updateChecked = false

/*
 * 旧引擎重扫横幅：引擎初始化是启动时的异步过程（mediapipe 加载需数秒），
 * 首帧 staleInfo 常拿不到签名（ready=false）。未就绪时轻量轮询几次直到 ready，就绪后即停，
 * 后续靠扫描结束事件刷新。开发版与正式版都启动（检测规则升级后需提示客户重扫）。
 */
let stalePollTimer: ReturnType<typeof setTimeout> | null = null
let stalePollTries = 0
// IPC 事件监听器的退订清单（见 bindEvents 尾部）：模块级，重跑 bindEvents 前逐个退订，
// 保证任何重复初始化（HMR / 未来可能的重连场景）都只留一套监听器
let unsubEvents: Array<() => void> = []
function startStalePoll(): void {
  if (stalePollTimer || stalePollTries >= 20) return
  stalePollTimer = setTimeout(() => {
    stalePollTimer = null
    void useStore.getState().refreshStale().then(() => {
      const s = useStore.getState()
      if (!s.staleReady) {
        stalePollTries++
        startStalePoll()
      }
    })
  }, 3000)
}

/*
 * 顶栏徽章的引擎真类型轮询（兼容兑底）：主进程引擎初始化是异步的，bootstrap 那一刻常报 none，
 * 徽章不能拿 none 冒充“运行中”。每 2 秒轻询一次 engineStatus，握手出真结果（python/node）即停。
 * 主进程已改为就绪时主动推送（onEngineStatus），本轮询仅作“漏推”时的兑底；上限抬到 150 次
 * （约 5 分钟），避免慢机器（如 M1 首次加载模型+自愈重签）超 40 秒就提前放弃、徽章卡在“初始化中”。
 */
let engineTypePollTimer: ReturnType<typeof setTimeout> | null = null
let engineTypePollTries = 0
function startEngineTypePoll(): void {
  if (engineTypePollTimer || engineTypePollTries >= 150) return
  engineTypePollTimer = setTimeout(() => {
    engineTypePollTimer = null
    void window.api
      .engineStatus()
      .then((st) => {
        useStore.setState({ engineType: st.type })
        if (st.type === 'none') {
          engineTypePollTries++
          startEngineTypePoll()
        }
      })
      .catch(() => {
        /* 主进程瞬时未就绪：下轮再取，不打扰用户 */
      })
  }, 2000)
}

/*
 * 低配机自动降级（第二档 A1）：主进程探测（核数/内存/GPU 合成）+ 手动三档决定“是否进精简模式”。
 * 砍的东西在 index.css 的 .perf-lean 规则里——只砍过渡动画、毛玻璃与装饰性 pulse；
 * spin 加载转圈保留（不然用户分不清软件是卡死还是在忙），选中 ring 也不动。
 * 探测线：<=4 核 / <8G 内存 / 软件渲染命中任意一条才降级，好机器 auto 下与从前完全一样。
 */
let perfHintCache: PerfHint | null = null
function perfLeanFor(mode: 'auto' | 'full' | 'lean', hint: PerfHint | null): boolean {
  if (mode === 'lean') return true
  if (mode === 'full') return false
  if (!hint) return false
  return hint.cores <= 4 || hint.memGB < 7.5 || hint.gpuSoftware
}
function applyPerfLean(lean: boolean): void {
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('perf-lean', lean)
}

/*
 * 标签写入合并（第二档 A2）：用户连续快点加/删标签时，上一笔还没写完库，后一笔的 id
 * 并入同一批队列，一轮 drain 里每个（操作，维度）只发一次 IPC。乐观更新仍在点击瞬间
 * 落到本地（芯片反馈不变），只是“写库+对账”按批发；toast 合并成一条；任一失败
 * 回退全量对账列表（库里是真相，等价于把乐观态精确回滚）。
 */
interface TagOp {
  kind: 'add' | 'remove'
  dim: DimensionKey
  ids: Set<number>
  /** 排队时批量标签弹窗开着（成功后要标 tagManagerTouched） */
  fromManager: boolean
}
const tagOpPending = new Map<string, TagOp>()
let tagOpDraining: Promise<void> | null = null

function queueTagOp(kind: 'add' | 'remove', dim: DimensionKey, ids: number[]): Promise<void> {
  const key = `${kind}:${dim}`
  let op = tagOpPending.get(key)
  if (!op) {
    op = { kind, dim, ids: new Set(), fromManager: !!useStore.getState().tagManagerIds }
    tagOpPending.set(key, op)
  }
  for (const id of ids) op.ids.add(id)
  if (!tagOpDraining) tagOpDraining = drainTagOps().finally(() => { tagOpDraining = null })
  return tagOpDraining
}

async function drainTagOps(): Promise<void> {
  const allIds = new Set<number>()
  let opsSeen = 0
  let last: TagOp | null = null
  let managerTouched = false
  let failed: unknown = null
  // “正在…”横幅延迟露脸：单张/几张的标签写库只要几十毫秒，每次操作都闪一条横幅
  // 反而把顶栏顶得一动，体感就是“卡一下”（用户 10-13 反馈）。超过 350ms 还没写完
  //（大批量或主进程正忙）才显示；drain 结束统一收掉。
  let busyText = ''
  let busyTimer: ReturnType<typeof setTimeout> | null = null
  while (tagOpPending.size && !failed) {
    const batch = [...tagOpPending.values()]
    tagOpPending.clear()
    busyText = `${batch[0].kind === 'add' ? '正在标记' : '正在移除'}「${DIMENSION_LABELS[batch[0].dim]}」…`
    if (!busyTimer) busyTimer = setTimeout(() => useStore.setState({ tagBusy: busyText }), 350)
    for (const op of batch) {
      opsSeen++
      const ids = [...op.ids]
      try {
        if (op.kind === 'add') await window.api.addDimTag(ids, op.dim)
        else await window.api.removeDimTag(ids, op.dim)
        for (const id of ids) allIds.add(id)
        if (op.fromManager) managerTouched = true
        last = op
      } catch (e) {
        failed = e
        break
      }
    }
  }
  if (busyTimer) {
    clearTimeout(busyTimer)
    useStore.setState({ tagBusy: null })
  }
  if (failed || !last) {
    if (failed) {
      useStore.setState({ tagBusy: null, toast: { msg: `保存标签失败：${String(failed).slice(0, 180)}`, kind: 'error' } })
      void useStore.getState().refreshImages()
    } else {
      useStore.setState({ tagBusy: null })
    }
    return
  }
  const single = opsSeen === 1
  useStore.setState({
    tagBusy: null,
    toast: single
      ? last.kind === 'add'
        ? { msg: `已为 ${last.ids.size} 张图添加「${DIMENSION_LABELS[last.dim]}」标签，已出现在该分类第一张`, kind: 'success', duration: 1600 }
        : { msg: `已从 ${last.ids.size} 张图移除「${DIMENSION_LABELS[last.dim]}」标签`, kind: 'success', duration: 1400 }
      : { msg: `已保存 ${allIds.size} 张图的标签改动`, kind: 'success', duration: 1400 },
    ...(managerTouched && useStore.getState().tagManagerIds ? { tagManagerTouched: true } : {})
  })
  // 一轮合并后统一对账受影响 id 与计数，不阻塞反馈：主分类连带移出等结果后台校正
  const s = useStore.getState()
  void Promise.all([s.refreshImagesFor([...allIds]), s.refreshCounts()])
}

export const useStore = create<StoreState>((set, get) => ({
  ready: false,
  settings: {
    highThreshold: 0.8,
    midThreshold: 0.55,
    strictness: 'very',
    scene: 'default',
    enginePreference: 'auto',
    devicePreference: 'auto',
    autoTune: true,
    tunedThresholds: {},
    theme: 'light',
    viewMode: 'grid',
    lastExportDir: null,
    lastImportDir: null
  },
  counts: {},
  perfLean: false,
  perfHint: null,
  perfAutoLean: false,
  customCategories: [],
  activeCategory: null,
  images: [],
  viewMode: 'grid',
  gridCols: resolveGridCols(),
  // 默认「默认顺序」（用户 10-15 拍板）：顶栏那个下拉框没人动过就永远停在默认序，重启也回到它。
  // 上一版默认 'time'（最新在前）是替用户做了主——他每次打开看到的是按导入时间重排过的列表，
  // 下拉框却写着「默认顺序」，两者对不上就像排序坏了。人工在下拉里改的选择不落盘，关掉软件即作废。
  sortKey: 'default',
  query: '',
  displayIds: [],
  selection: new Set<number>(),
  anchorIndex: -1,
  previewId: null,
  tagManagerIds: null,
  tagManagerTouched: false,
  reviewPanelIds: null,
  reviewPanelPrefill: null,
  tagBusy: null,
  previewOverlay: false,
  reviewSession: null,
  scanProgress: null,
  importProgress: null,
  thumbsProgress: null,
  aiReview: null,
  aiReviewSummaryDismissed: false,
  aiReviewSettling: false,
  aiReviewFeedback: null,
  undoSnapshots: [],
  exportProgress: null,
  showExport: false,
  showSettings: false,
  showLogin: false,
  showMember: false,
  showContactQr: false,
  contactQrPlan: null,
  showAiReviewConsent: false,
  auth: { loggedIn: false, token: null, user: null },
  toast: null,
  trashAsk: null,
  engineBusy: false,
  engineType: 'none',
  appVersion: '',
  isDev: false,
  staleReady: false,
  staleSig: null,
  staleCount: 0,
  dataRev: 0,
  showUpdate: false,
  updateInfo: null,
  showFailedImages: false,
  showOnboarding: false,
  onboardingPaused: false,

  async bootstrap() {
    const info: BootstrapInfo = await window.api.bootstrap()
    applyTheme(info.settings.theme)
    set({
      ready: true,
      appVersion: info.version,
      settings: info.settings,
      counts: info.counts,
      customCategories: info.customCategories,
      scanProgress: info.progress?.total != null || info.progress?.running ? info.progress : info.progress,
      // 布局入口已精简（用户 10-19 拍板：只留网格）：库里老设置可能存着 list/masonry/large，
      // 不再尊重——统一钉回 grid，免得老用户升级后看着“没了入口却切不走”的怪状态
      viewMode: 'grid',
      isDev: info.isDev,
      engineType: info.engine.type,
      toast: info.engine.type === 'node' ? { msg: info.engine.message, kind: 'info' } : null
    })
    // 低配机自动降级（第二档 A1）：探测一次并缓存，perfMode=auto 时据此进精简模式；不阻塞首屏
    void window.api
      .perfHint()
      .then((h) => {
        perfHintCache = h
        const lean = perfLeanFor(info.settings.perfMode ?? 'auto', h)
        // 探测结果与“纯硬件判档”一并存进 state：设置页要告诉用户自己的机器是什么级别，
        // 这与用户选没选自动无关（perfAutoLean 只按探测线算，不受 perfMode 手动档影响）
        set({ perfLean: lean, perfHint: h, perfAutoLean: perfLeanFor('auto', h) })
        applyPerfLean(lean)
      })
      .catch(() => {
        /* 探测失败保持全特效：宁可不降级，不能误伤好机器 */
      })
    // 恢复登录态（不阻塞首屏）：先用本地缓存把界面填上，再静默重拉一次 /me。
    // 不重拉就会拿着上次落盘的快照：额度是后端按日记的账，在另一台电脑上复审过、或隔夜重置了，
    // 本机顶栏那个“今日额度剩 N 张”还是旧的（用户 10-15：“个人中心与顶部没扣除张数”）。
    void window.api.authBootstrap().then(async (a) => {
      set({ auth: a })
      if (a.loggedIn) await get().refreshAuth()
    })
    await get().openCategory(null)
    get().bindEvents()
    // 界面缩放：启动就按存的档位（或自动档按当前窗口宽）apply 一次，重启后效果不丢
    get().applyUiScale()
    // 拉一次旧引擎过期信息并起轮询（等引擎握手报出签名后横幅才能数得准）：开发版+正式版都需要
    void get().refreshStale()
    startStalePoll()
    // 引擎握手是异步的，bootstrap 那一下常拿到 none：轻轮询到真类型为止，徽章才能如实显“运行中/引擎异常”
    startEngineTypePoll()
    // 实时订阅主进程推送：引擎就绪瞬间即刷新徽章，慢机器也不必等轮询/开设置（轮询仅作兑底备份）
    window.api.onEngineStatus((st) => useStore.setState({ engineType: st.type }))
    // 启动后静默检查更新（错开 2.5s 不拖慢首屏），有新版自动弹窗
    setTimeout(() => void get().checkUpdateSilent(), 2500)
    // 新手指导：这台电脑第一次用才自动弹（已看过 / 正在弹都不重复触发）。
    // 错开 3.2s 让上面的更新弹窗先落地：引导自己会等 UpdateDialog 关掉才现身，两层不会摞在一起。
    if (!info.settings.onboardGuideSeen && !get().showOnboarding) {
      setTimeout(() => {
        if (!get().settings.onboardGuideSeen && !get().showOnboarding) set({ showOnboarding: true })
      }, 3200)
    }
  },

  openOnboarding() {
    set({ showOnboarding: true, onboardingPaused: false })
  },

  closeOnboarding() {
    set({ showOnboarding: false, onboardingPaused: false })
    // 落盘幂等：手动重放时这个标记早就为 true，再写一次也不影响别的设置
    if (!get().settings.onboardGuideSeen) void get().saveSettings({ onboardGuideSeen: true })
  },

  pauseOnboarding() {
    set({ onboardingPaused: true })
  },

  resumeOnboarding() {
    set({ onboardingPaused: false })
  },

  async checkUpdateSilent() {
    if (updateChecked) return
    updateChecked = true
    try {
      const r = await window.api.checkUpdate()
      if (!r || !r.has_update || !r.latest_version) return
      if (get().settings.skipUpdateVersion === r.latest_version) return
      set({ updateInfo: r, showUpdate: true })
    } catch {
      /* 无网/后台异常：启动静默检查不打扰 */
    }
  },

  async setTheme(t) {
    applyTheme(t)
    await get().saveSettings({ theme: t })
  },
  async toggleTheme() {
    const next = get().settings.theme === 'dark' ? 'light' : 'dark'
    await get().setTheme(next)
  },
  applyUiScale() {
    // innerWidth 在缩放生效后是“有效 CSS px”：自动档据此选档；已钉在某个档时
    // 宽度变化只在跨过阈值才换档，不会无限自缩（1440 屏缩到 0.85 后宽度变 1694 → 仍停 0.85）
    const f = effectiveUiScale(get().settings.uiScale, window.innerWidth)
    void window.api.setUiZoom(f)
  },
  openLogin() {
    set({ showLogin: true })
  },
  closeLogin() {
    set({ showLogin: false })
  },
  openMember() {
    set({ showMember: true })
  },
  closeMember() {
    set({ showMember: false })
  },
  openContactQr(plan) {
    set({ showContactQr: true, contactQrPlan: plan ?? null })
  },
  closeContactQr() {
    set({ showContactQr: false })
  },

  toggleAiReview() {
    const { settings } = get()
    const next = !settings.aiReviewEnabled
    // 开启但从未授权：先弹应用内授权（同意才会走下面），不直接写偏好
    if (next && !settings.aiReviewConsent) {
      set({ showAiReviewConsent: true })
      return
    }
    void get().saveSettings({ aiReviewEnabled: next })
    if (next) void get().startAiReview()
    else if (get().aiReview?.running) void get().stopAiReview() // 跑中途关开关：停在建、已完成建议保留
  },
  agreeAiReviewConsent() {
    set({ showAiReviewConsent: false })
    void get().saveSettings({ aiReviewConsent: true, aiReviewEnabled: true })
    void get().startAiReview()
  },
  dismissAiReviewConsent() {
    set({ showAiReviewConsent: false })
  },
  async doLogin(account, password) {
    const a = await window.api.authLogin(account, password)
    set({ auth: a })
    if (a.loggedIn) {
      set({ showLogin: false })
      return { ok: true, message: '登录成功' }
    }
    return { ok: false, message: '账号或密码错误' }
  },
  async doLoginCode(req) {
    const r = await window.api.authLoginCode(req)
    // 成功时 state 里已带补齐过的积分/会员；失败时 state 就是当前登录态，赋回去不会有副作用
    set({ auth: r.state })
    if (r.ok) set({ showLogin: false })
    return { ok: r.ok, message: r.message }
  },
  async doRegister(req) {
    const r = await window.api.authRegister(req)
    // 注册成功 = 已自动登录：要和 doLogin 一样关掉弹窗并给成功提示，否则用户以为“点了没反应”
    if (r.ok) {
      set({
        auth: await window.api.authMe(),
        showLogin: false,
        toast: { msg: r.message || '注册成功，已自动登录', kind: 'success' }
      })
    }
    return r
  },
  async sendCaptcha(req) {
    return window.api.authSendCaptcha(req)
  },
  async doLogout() {
    const a = await window.api.authLogout()
    set({ auth: a, showMember: false })
  },
  async refreshAuth() {
    set({ auth: await window.api.authMe() })
  },

  bindEvents() {
    // 重复调用先退订旧的：每个 onXxx 都返回退订函数，这里收集成清单，重绑前统一清。
    // 开发期 HMR 让模块重新执行会再次 init + bindEvents，旧监听器还挂在同一个
    // ipcRenderer 上（18:52 实测刷出 MaxListenersExceededWarning：scan-progress 挂了 11 个），
    // 后果是每份旧闭包都在重复对账，误报事件还会被处理多遍。正式包里 init 只跑一次，
    // 这里的守卫不改变其行为，只是保证“bindEvents 跑两次也只剩一套监听器”。
    unsubEvents.forEach((f) => f())
    unsubEvents = []
    // 筛选结束事件也会被标签/移动等操作的收尾 send 重复触发：若每个事件都立刻重拉全量列表，
    // 一次点标签就是两三千行 JSON 重解析（用户看到的“反应本该很快却很慢”）。防抖合并成一次。
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    // “筛完自动跳待确认”只认真正跑完一轮：主进程在移动/加删标签/判定这些 IPC 的收尾也会重发
    // 同一份进度快照（phase:'done'、done=上一轮遗留的张数、running 恒 false），渲染层无从分辨。
    // 用户实测（10-15）：在瑕疵片逐张复核点「采纳这张」，采纳走的就是删标/补标/移动通道，260ms 后
    // 被这个误报弹到待确认页。所以加了这一道闸：只有亲眼看到本轮 running 从 true 翻成终态才允许跳，
    // 静态快照重发多少次都不算数（get().scanProgress 在收到事件的第一步就被覆盖，必须在此之前取旧值）。
    let sawRoundRunning = false
    unsubEvents.push(
      window.api.onScanProgress((p) => {
        const wasRunning = get().scanProgress?.running === true
        if (p.running) sawRoundRunning = true
        set({ scanProgress: p })
        if (!p.running && (p.phase === 'done' || p.phase === 'stopped')) {
          if (settleTimer) clearTimeout(settleTimer)
          settleTimer = setTimeout(() => {
            settleTimer = null
            const realRoundEnd = sawRoundRunning && wasRunning
            sawRoundRunning = false
            void (async () => {
              await get().refreshCounts()
              // 筛完自动落到「待确认」（用户 2026-10-15 定）：这一栏有图就直接打开它，让人一眼看到还欠多少张要拍板；
              // 一栏空了就不跳（没东西要人工定），回「交付库」看筛片产出，不给人开白屏。
              // 只在真的处理过图时跳（p.done > 0）：空跑一轮就把用户界面弹走，是劫持不是引导。
              // 误报的标签/移动收尾（realRoundEnd=false）只静默对账列表与计数，绝不替用户切页（用户 10-15 拍板）。
              // 另外只在用户已经离开本轮筛选那一栏时才跳：人就在待确认里点「停止筛选」，
              // 原位刷新就行，把他弹去交付库同样是劫持（上一版只认 target≠当前页，会误弹）。
              if (realRoundEnd && p.done > 0) {
                const target: CategoryKey = (get().counts[CAT_REVIEW] ?? 0) > 0 ? CAT_REVIEW : CAT_LIBRARY
                if (get().activeCategory === target) await get().refreshImages()
                else await get().openCategory(target)
              } else {
                void get().refreshImages()
              }
              // 一轮筛选结束：重扫的图已盖上当前签名，刷新横幅计数（归零则自动收起）
              void get().refreshStale()
              // 筛完自动触发 AI 复审（会员专属·后台不劫持界面）：开关/授权/会员齐备且未在为跑时
              // 才起；待确认是否真的有照片由主进程服务自己判（空则 reason:'empty' 不跑）。
              const { auth, settings, aiReview } = get()
              const isMember = isVip(auth.user)
              if (isMember && settings.aiReviewEnabled && settings.aiReviewConsent && !aiReview?.running) {
                void get().startAiReview()
              }
            })()
          }, 260)
        }
      }),
      window.api.onScanImage((img) => {
        const { activeCategory, images } = get()
        const next = [...images]
        const idx = next.findIndex((i) => i.id === img.id)
        if (idx >= 0) next[idx] = img
        else if (activeCategory == null || img.category === activeCategory) next.push(img)
        set({ images: next })
        // 节流刷新计数
        void get().refreshCounts()
      }),
      window.api.onImportProgress((p) => set({ importProgress: p })),
      window.api.onThumbsProgress((p) => set({ thumbsProgress: p }))
    )
    // 后台缩略图逐批就绪：节流刷新当前视图
    let thumbTimer: ReturnType<typeof setTimeout> | null = null
    // 登录态 / 积分变化（含筛选后自动扣费的不足提醒）
    unsubEvents.push(
      window.api.onThumbsReady(() => {
        if (thumbTimer) return
        thumbTimer = setTimeout(() => {
          thumbTimer = null
          void get().refreshImages()
          void get().refreshCounts()
        }, 900)
      }),
      window.api.onAuthChanged((state: AuthState, consume?: ConsumeResult) => {
        set({ auth: state })
        if (consume && consume.insufficient) {
          set({
            showMember: true,
            toast: { msg: `积分不足：本次需 ${consume.required ?? '?'} 分，当前 ${consume.balance ?? 0} 分，请充值或开通会员`, kind: 'error' }
          })
        } else if (consume && consume.ok && consume.consumed > 0) {
          set({ toast: { msg: `本次消耗 ${consume.consumed} 积分，剩余 ${consume.remaining ?? 0}`, kind: 'info' } })
        }
        // 复审跑中途登出/会员失效：真闸门在后端会 403 停，客户端也主动叫停（已完成建议保留）
        const wasRunning = get().aiReview?.running
        const nowMember = state.loggedIn && isVip(state.user)
        if (wasRunning && !nowMember) {
          void get().stopAiReview()
          set({ toast: { msg: '登录/会员状态变化，已停止 AI 复审（已完成建议保留）', kind: 'info' } })
        }
      }),
      window.api.onExportProgress((p) => {
        set({ exportProgress: p })
        if (!p.running && p.finished) {
          set({
            toast: {
              msg: `成功导出 ${p.finished.success} 张，跳过 ${p.finished.skipped} 张${p.finished.failed ? `，失败 ${p.finished.failed} 张` : ''} → ${p.finished.target}`,
              kind: 'success'
            }
          })
        }
      }),
      // AI 复审后台任务进度回填（全局事件，与用户当前在哪个页无关）：顶部小字/待确认独占弹窗都读它
      window.api.onAiReviewProgress(async (p) => {
        const prev = get().aiReview
        // 新一轮完成（phase done）：重置小结收起标记，让用户下次进待确认页重新看到小结
        const wasDone = prev?.phase === 'done'
        set({ aiReview: p, aiReviewSummaryDismissed: p.phase === 'done' && !wasDone ? false : get().aiReviewSummaryDismissed })
        // 从"在跑"转为终态：断网/错误给错字 toast，额度尽给提示（小结/对比不弹因无可用建议）
        if (prev?.running && !p.running) {
          if (p.phase === 'error' && p.message) set({ toast: { msg: p.message, kind: 'error' } })
          else if (p.phase === 'stopped' && p.quotaExceeded) set({ toast: { msg: '今日云端复核额度已用完，本轮已自动中止', kind: 'info' } })
          // 额度是后端记的账：本轮到底烧了多少张，只有重拉 /me 返回的 ai_review.remaining 才准。
          // 不刷就会出现“复审跑完了，会员中心今日剩余还是老数字”，看着就像没扣次数（用户 10-15 拍到）。
          // 只在终态分支发这一次请求，不在每张进度里刷。
          void get().refreshAuth()
          // 关键：AI 建议是主进程写进库的，内存 images 还带着旧的"无 ai_review"→不刷新则 diffs 恒空、采纳面板不弹。
          // 收尾期间亮"整理结果"遮罩（不可关），刷完 images 再收起→面板随即弹出。
          if (p.phase === 'done' || p.phase === 'stopped') {
            set({ aiReviewSettling: true })
            await get().refreshImages()
            set({ aiReviewSettling: false })
          }
        }
      })
    )
  },

  async openCategory(cat) {
    // 切相册时清空搜索：带着上一个相册的关键词进来，看着就像空库，最容易误判成“图没了”
    set({ activeCategory: cat, selection: new Set(), anchorIndex: -1, query: '' })
    const images = await window.api.listImages(cat ? { category: cat } : {})
    set({ images })
    await get().refreshCounts()
  },

  async refreshCounts() {
    set({ counts: await window.api.categoryCounts() })
  },

  async refreshImages() {
    const { activeCategory } = get()
    const images = await window.api.listImages(activeCategory ? { category: activeCategory } : {})
    set((s) => ({ images, dataRev: s.dataRev + 1 }))
    // 选中集必须跟着新列表裁剪：删标签（主分类连带移出）/ 移动等操作会把图送出当前分类，
    // 不裁剪就会出现“5 张都已移走、底部工具栏还写着已选中 5 张”，而且这些残留 id 会被下一批
    // 选中操作误作用。裁剪发生在拉完列表后（即对账时刻），所以乐观更新不会受影响。
    const sel = get().selection
    if (sel.size) {
      const present = new Set(images.map((i) => i.id))
      if ([...sel].some((id) => !present.has(id))) {
        set({ selection: new Set([...sel].filter((id) => present.has(id))), anchorIndex: -1 })
      }
    }
  },

  /**
   * 差量对账：操作（移动/加删标签/撤回）后只回拉受影响的那几张——就地更新、不再属于当前
   * 视图的移除、新出现的追加（视图层 sorted 按 viewTime 把它排到最前；sortKey=default 的
   * reorder 仍走全量）。这是低配机“点一下卡一下”的主要提速点；差量失败回退全量，对账语义不变。
   */
  async refreshImagesFor(ids) {
    if (!ids.length) return
    const { activeCategory } = get()
    try {
      const recs = await window.api.listByIds(activeCategory ?? 'all', ids)
      // 在途期间用户切了相册：响应属于旧视图，丢弃（新相册的全量列表马上就到，不需补）
      if (get().activeCategory !== activeCategory) return
      const touched = new Set(ids)
      const byId = new Map(recs.map((r) => [r.id, r]))
      const next: ImageRecord[] = []
      for (const img of get().images) {
        if (!touched.has(img.id)) {
          next.push(img)
          continue
        }
        const rep = byId.get(img.id)
        if (rep) next.push(rep)
      }
      const present = new Set(next.map((i) => i.id))
      for (const r of recs) if (!present.has(r.id)) next.push(r)
      set((s) => ({ images: next, dataRev: s.dataRev + 1 }))
      // 选中集同步裁剪（与全量对账同规则）：被操作且已不在当前视图的 id 从选中里去掉，
      // 不然“已选 5 张”里挂着 5 张早被移走的 id，下一批选中会误作用
      const sel = get().selection
      if (sel.size && [...sel].some((id) => touched.has(id) && !present.has(id))) {
        set({ selection: new Set([...sel].filter((id) => !touched.has(id) || present.has(id))), anchorIndex: -1 })
      }
    } catch {
      void get().refreshImages()
    }
  },

  setSort(k) {
    set({ sortKey: k })
  },

  setQuery(q) {
    set({ query: q })
  },

  setDisplayIds(ids) {
    const cur = get().displayIds
    if (cur.length === ids.length && cur.every((v, i) => v === ids[i])) return
    set({ displayIds: ids })
  },

  async setViewMode(m) {
    set({ viewMode: m })
    await window.api.saveSettings({ viewMode: m })
  },

  setGridCols(n) {
    const v = Math.max(GRID_COLS_MIN, Math.min(GRID_COLS_MAX, Math.round(n)))
    localStorage.setItem('gridCols', String(v))
    set({ gridCols: v })
  },

  handleClickSelect(index, e) {
    const { images, selection, anchorIndex, displayIds } = get()
    // index 是“当前展示序”的下标（视图层按时间/置信度/文件名重排过），必须经 displayIds
    // 映射回 id；直接用 images[index] 会在非默认排序下选错图（选中样式“消失”）。
    const order = displayIds.length === images.length ? displayIds : images.map((i) => i.id)
    const id = order[index]
    if (id == null) return
    // 标准文件管理器语义（用户 10-18 拍板“单击为选中”，教程里写的“单击选中/Ctrl 加选”也以此为准）：
    // 普通单击 = 只选中这一张（替掉旧的）；Ctrl/Cmd 单击 = 加选/取消这一张（多选不动其他）；
    // Shift = 从锚点连选到这一张。旧行为是“每次点击都 toggle”，点已选中的图会把它取消、
    // 选中的第一张却永远消不掉，和双击放大混在一起时尤其拧巴。
    const sel = new Set(selection)
    if (e.shiftKey && anchorIndex >= 0) {
      const [a, b] = [Math.min(anchorIndex, index), Math.max(anchorIndex, index)]
      for (let i = a; i <= b; i++) sel.add(order[i])
      set({ selection: sel })
      return
    }
    if (e.ctrlKey || e.metaKey) {
      if (sel.has(id)) sel.delete(id)
      else sel.add(id)
    } else {
      sel.clear()
      sel.add(id)
    }
    set({ anchorIndex: index, selection: sel })
  },

  marqueeSelect(ids, additive = false) {
    // 框选=整体替换（用户拍板 2026-10-11）：拖一个框就是把这批重新选出来，旧选中直接丢掉；
    // 按住 Ctrl 拖才叠加。anchorIndex 置 -1：框不产生“连选锚点”，避免随后 Shift 连选
    // 从一个莫名其妙的旧下标开始拉。
    const sel = additive ? new Set(get().selection) : new Set<number>()
    for (const id of ids) sel.add(id)
    set({ selection: sel, anchorIndex: -1 })
  },

  toggleSelect(id) {
    const sel = new Set(get().selection)
    if (sel.has(id)) sel.delete(id)
    else sel.add(id)
    set({ selection: sel })
  },

  selectAll() {
    const sel = new Set(get().images.map((i) => i.id))
    set({ selection: sel })
  },
  selectNone() {
    set({ selection: new Set() })
  },
  invertSelection() {
    const sel = new Set<number>()
    for (const img of get().images) if (!get().selection.has(img.id)) sel.add(img.id)
    set({ selection: sel })
  },
  selectByCurrentCategoryAll() {
    get().selectAll()
  },

  async moveTo(cat, physical = false) {
    const { selection } = get()
    if (!selection.size) return
    const ids = [...selection]
    get().pushUndo(ids, cat)
    const req: MoveRequest = {
      ids,
      category: cat,
      physical,
      clearBadTags: isStatusCat(cat),
      // 丢进废弃库时记下“丢弃时正看着的来源栏”，供废弃库按来源还原
      ...(cat === CAT_TRASH ? { source: get().activeCategory ?? undefined } : {})
    }
    await window.api.moveImages(req)
    set({ selection: new Set() })
    await get().refreshImagesFor(ids)
    await get().refreshCounts()
    set({ toast: { msg: `已移动 ${ids.length} 张 → ${catLabel(cat, get().customCategories, get().settings.tierNames)}`, kind: 'success', duration: 1000 } })
  },

  async moveToTrash() {
    await get().moveTo(CAT_TRASH)
  },

  askTrash(physical = false) {
    const { selection } = get()
    if (!selection.size) return
    // 单选（含放大弹窗/列表）直接移；多选必须确认，防止批量误废
    if (selection.size >= 2) set({ trashAsk: { physical } })
    else void get().moveTo(CAT_TRASH, physical)
  },
  confirmTrashAsk() {
    const ask = get().trashAsk
    set({ trashAsk: null })
    void get().moveTo(CAT_TRASH, ask?.physical ?? false)
  },
  dismissTrashAsk() {
    set({ trashAsk: null })
  },

  async restoreFromTrash() {
    const { selection } = get()
    if (!selection.size) return
    await get().restoreTrash([...selection])
    set({ selection: new Set() })
  },

  async restoreTrash(ids) {
    if (!ids.length) return
    const { images } = get()
    const byId = new Map(images.map((i) => [i.id, i]))
    // 按“从哪来回哪去”把每张图归到它的还原目标栏，再按目标栏分组批量移动
    const groups = new Map<CategoryKey, number[]>()
    const add = (cat: CategoryKey, id: number): void => {
      const a = groups.get(cat) ?? []
      a.push(id)
      groups.set(cat, a)
    }
    for (const id of ids) {
      const rec = byId.get(id)
      const src = rec?.trashFrom ?? null
      if (!src) { add(CAT_LIBRARY, id); continue }                 // 历史/未知来源 → 兜底回交付库
      if (src === 'duplicate') { add('duplicate', id); continue }  // 回重复分组
      if (src === CAT_FLAWS || isBadDim(src)) {
        // 瑕疵片/坏维度是虚视图：落回人数维，靠未清的瑕疵标签自动重现（废弃库不清标签）
        add(personCatFromTags(rec?.tags), id)
        continue
      }
      add(src, id)                                                  // 真实栏（交付/待确认/自定义/人数维）直接回原栏
    }
    const firstDest = [...groups.keys()][0]
    get().pushUndo(ids, firstDest)
    for (const [cat, gids] of groups) {
      await window.api.moveImages({ ids: gids, category: cat, physical: false, clearBadTags: isStatusCat(cat) })
    }
    await get().refreshImagesFor(ids)
    await get().refreshCounts()
    set({ toast: { msg: `已还原 ${ids.length} 张（回各自来源栏）`, kind: 'success', duration: 1000 } })
  },

  async promoteTrashToTier(ids, tier) {
    await get().moveIds(ids, `tier:${tier}`)
  },

  async moveIds(ids, cat) {
    if (!ids.length) return
    get().pushUndo(ids, cat)
    await window.api.moveImages({
      ids,
      category: cat,
      physical: false,
      clearBadTags: isStatusCat(cat),
      ...(cat === CAT_TRASH ? { source: get().activeCategory ?? undefined } : {})
    })
    await get().refreshImagesFor(ids)
    await get().refreshCounts()
    // 放大弹窗判定栏（废弃库/合格入档）同样给用户即时反馈，1 秒自动消失
    set({ toast: { msg: `已移动 ${ids.length} 张 → ${catLabel(cat, get().customCategories, get().settings.tierNames)}`, kind: 'success', duration: 1000 } })
  },

  /** 手动拖拽排序：按新顺序持久化 sort_order，并切回默认（自定义）序展示 */
  async reorder(ids) {
    if (!ids.length) return
    set({ sortKey: 'default' })
    await window.api.reorderImages(ids)
    await get().refreshImages()
  },

  /** 记录一次移动前的快照（撤回栈最多保留 50 步） */
  pushUndo(ids: number[], toCat: CategoryKey) {
    const { images } = get()
    const recs = ids.map((id) => images.find((i) => i.id === id)).filter(Boolean) as ImageRecord[]
    if (!recs.length) return
    set((s) => ({ undoSnapshots: [...s.undoSnapshots, { ids, at: Date.now(), toCat, recs }].slice(-50) }))
  },

  /** 撤回最近一次移动：还原到移动前的分类 */
  async undoMove() {
    const { undoSnapshots } = get()
    const last = undoSnapshots[undoSnapshots.length - 1]
    if (!last) return
    set({ undoSnapshots: undoSnapshots.slice(0, -1), selection: new Set() })
    await window.api.restoreImages(last.recs)
    await get().refreshImagesFor(last.ids)
    await get().refreshCounts()
    const fromCats = [...new Set(last.recs.map((r) => catLabel(r.category, get().customCategories, get().settings.tierNames)))]
    set({
      toast: {
        msg: `已撤回：把 ${last.ids.length} 张从【${catLabel(last.toCat, get().customCategories, get().settings.tierNames)}】移回【${fromCats.join('、')}】`,
        kind: 'success'
      }
    })
  },

  async correct(req) {
    const { previewId, images } = get()
    const targetId = req.imageId ?? previewId
    if (targetId == null) return
    const rec = images.find((i) => i.id === targetId)
    if (!rec) return
    const updated = await window.api.correctImage({
      imageId: rec.id,
      action: req.action,
      origDim: req.origDim,
      origConfidence: req.origConfidence,
      targetCategory: req.targetCategory
    })
    if (updated) {
      const next = [...images]
      const idx = next.findIndex((i) => i.id === updated.id)
      if (idx >= 0) next[idx] = updated
      set({ images: next })
      await get().refreshCounts()
    }
    if (req.action === 'correct') {
      // D1 一步结案：待确认里的中置信瑕疵被后端提为高置信 → 移入【瑕疵片】（不导出）并退出待确认；
      // 无瑕疵可确认（手动停泊）时仅记学习样本、不改归属。措辞据是否确有中置信瑕疵而定。
      const hasMidFlaw = !!guessMidDim(rec.tags || {})
      set({
        toast: {
          msg: hasMidFlaw
            ? '已确认该瑕疵 → 移入【瑕疵片】（不导出），已退出待确认'
            : '这张没有需要确认的瑕疵，仍留在原分类',
          kind: 'success'
        }
      })
      // 预览层不关闭，自动看下一张（5.2）
      get().stepPreview(1)
    }
  },

  /** 删除标签（可批量）：本地先改到位（芯片秒删）→ 写入并入合并队列（第二档 A2） */
  async removeTag(ids, dim) {
    if (!ids.length) return
    const idSet = new Set(ids)
    set({ images: get().images.map((i) => (idSet.has(i.id) ? patchTagLocal(i, dim, false) : i)) })
    await queueTagOp('remove', dim, ids)
  },

  /** 添加标签（可批量）：本地先长出来（芯片秒加）→ 写入并入合并队列，落库后后台对账位置与计数 */
  async addTag(ids, dim) {
    if (!ids.length) return
    const idSet = new Set(ids)
    set({ images: get().images.map((i) => (idSet.has(i.id) ? patchTagLocal(i, dim, true) : i)) })
    await queueTagOp('add', dim, ids)
  },

  openTagManager(ids) {
    if (!ids.length) return
    set({ tagManagerIds: ids, tagManagerTouched: false })
  },
  /**
   * 关闭弹窗：只要期间真正成功做过加/删/换标签，就把多选整体清空。
   * 被操作移走本分类的图已经在 refreshImages 里被裁剪掉了，但没被移走的还挂着选中——
   * 用户接着点下一张选时会把旧多选累加上去（用户反馈 2026-10-11）。
   * 没做过任何操作（只打开看了看）则保留选中，不剥夺用户原来的选择。
   */
  closeTagManager() {
    if (get().tagManagerTouched) set({ tagManagerIds: null, tagManagerTouched: false, selection: new Set<number>(), anchorIndex: -1 })
    else set({ tagManagerIds: null })
  },

  openReviewPanel(ids, prefill = null) {
    if (!ids.length) return
    set({ reviewPanelIds: ids, reviewPanelPrefill: prefill })
  },
  closeReviewPanel() {
    set({ reviewPanelIds: null, reviewPanelPrefill: null })
  },

  /** 批量判定（多选工具条用）：对每张选中图按当前 AI 判定记录修正学习 */
  async correctBatch(ids, action, targetCategory) {
    const { images } = get()
    let n = 0
    for (const id of ids) {
      const rec = images.find((i) => i.id === id)
      if (!rec) continue
      // D2：主分类不再携带坏维度，待确认来自“中置信瑕疵标签”或手动停泊，维度归属一律从 tags 猜
      const prim = (guessMidDim(rec.tags || {}) ?? (isBadDim(rec.category) ? rec.category : null)) as DimensionKey | null
      const origDim = prim
      const origConfidence = prim ? (rec.tags[prim]?.confidence ?? null) : null
      try {
        await window.api.correctImage({
          imageId: rec.id,
          action,
          origDim,
          origConfidence,
          targetCategory
        })
        n++
      } catch {
        /* 单张失败不中断批量 */
      }
    }
    await get().refreshImagesFor(ids)
    await get().refreshCounts()
    // D1 一步结案后批量“此判定正确”不再只是记样本：带中置信瑕疵的图会被确认为高置信→移入瑕疵片退出待确认；
    // 只有手动停泊无瑕疵的图才留在待确认，文案分开说清楚，免得用户以为按钮“没生效”
    const recs = ids.map((id) => images.find((i) => i.id === id)).filter(Boolean) as ImageRecord[]
    const nConfirmed = action === 'correct' ? recs.filter((r) => r.category === CAT_REVIEW && !!guessMidDim(r.tags || {})).length : 0
    const nParked = action === 'correct' ? recs.filter((r) => r.category === CAT_REVIEW && !guessMidDim(r.tags || {})).length : 0
    set({
      toast: {
        msg: `已对 ${n} 张图记录判定${action === 'correct' ? '（正确）' : '（错误→修正）'}${
          nConfirmed ? `，${nConfirmed} 张存疑瑕疵已确认 → 移入【瑕疵片】退出待确认` : ''
        }${nParked ? `，${nParked} 张手动停泊无瑕疵可确认，仍留待确认（放行请点 ✓ 好图 → 交付库）` : ''}`,
        kind: 'success'
      }
    })
  },

  openPreview(id) {
    set({ previewId: id })
  },
  closePreview() {
    set({ previewId: null })
  },
  togglePreviewOverlay() {
    set((s) => ({ previewOverlay: !s.previewOverlay }))
  },
  startReview(cat, total) {
    set({ reviewSession: { cat, total } })
  },
  exitReview() {
    set({ reviewSession: null })
  },
  stepPreview(delta) {
    const { previewId, images, displayIds } = get()
    if (previewId == null || !images.length) return
    const list = displayOrder(images, displayIds)
    const idx = list.findIndex((i) => i.id === previewId)
    const next = list[Math.min(list.length - 1, Math.max(0, idx + delta))]
    if (next) set({ previewId: next.id })
  },

  /**
   * 顶栏「大图」按钮与快捷键 4。
   * 以前它是第四种布局（LargeView：左侧缩略图条 + 主图 + 底栏判定），与双击小图弹出的
   * 放大弹窗功能几乎重叠——两套“大图”各有自己一套操作，用户得记两遍，还容易在两套之间迷路。
   * 现在直接复用放大弹窗：← → 翻页、判定工具栏、标记叠加、双击缩放全都在。
   * 从哪张开始：优先当前选中的第一张（按展示序，不是按导入序），没选中就从列表第一张。
   */
  openLargePreview() {
    const { images, displayIds, selection } = get()
    const order = displayIds.length === images.length ? displayIds : images.map((i) => i.id)
    if (!order.length) return
    const first = order.find((id) => selection.has(id)) ?? order[0]
    set({ previewId: first })
  },

  async startScan() {
    const { auth } = get()
    if (!auth.loggedIn) {
      set({ showLogin: true, toast: { msg: '请先登录后再开始筛选', kind: 'info' } })
      return
    }
    const isMember = isVip(auth.user)
    if (!isMember && (auth.user?.points.balance ?? 0) <= 0) {
      set({ showMember: true, toast: { msg: '积分不足，请充值或开通会员后再筛选', kind: 'error' } })
      return
    }
    set({ engineBusy: true })
    const r = await window.api.scanStart()
    set({ engineBusy: false })
    if (!r.started) set({ toast: { msg: r.message, kind: 'info' } })
  },
  async stopScan() {
    await window.api.scanStop()
  },

  /**
   * AI 复审：会员专属、只给只读建议的后台二次复判。真闸门在主进程（领 key/会员校验）
   * 与后端（403）；这里只做界面层门禁与失败回显，绝不阻塞其它操作。
   * force：橙色「再次AI复审」专用——重判本栏每一张。不传则是“只补没判过的”（自动复审/首次手动）。
   */
  async startAiReview(scope = 'review', force = false) {
    const { auth, aiReview } = get()
    if (aiReview?.running) return
    const label = scope === 'flaws' ? '瑕疵片' : '待确认'
    if (!auth.loggedIn) {
      set({ showLogin: true, toast: { msg: '请先登录后再使用 AI 复审', kind: 'info' } })
      return
    }
    const isMember = isVip(auth.user)
    if (!isMember) {
      set({ showMember: true, toast: { msg: 'AI 复审为会员专属功能', kind: 'info' } })
      return
    }
    // 页内手动触发也需先过授权：未同意过就先弹应用内授权窗（同意后会自动接着跑），不发后请求
    if (!get().settings.aiReviewConsent) {
      set({ showAiReviewConsent: true })
      return
    }
    const r = await window.api.aiReviewStart(scope, force ? { force: true } : undefined)
    if (r.started) {
      set({ aiReviewFeedback: null, toast: { msg: `已启动云端复核，将在后台逐张核验${label}照片（切换分类不中断）`, kind: 'info', duration: 2000 } })
      return
    }
    // 就地反馈（页内顶部条）的公共出口：比底部 toast 显眼，6 秒自动收回
    const feedback = (msg: string): void => {
      set({ aiReviewFeedback: msg })
      setTimeout(() => {
        if (get().aiReviewFeedback === msg) set({ aiReviewFeedback: null })
      }, 6000)
    }
    // 未启动：按主进程回传的原因给对应反馈（已在跑/断网等由进度事件自行呈现，不重复打扰）
    if (r.reason === 'not_member') set({ showMember: true })
    else if (r.reason === 'unauthorized') set({ showLogin: true, toast: { msg: '登录已失效，请重新登录', kind: 'info' } })
    else if (r.reason === 'service_unavailable')
      set({ toast: { msg: 'AI 复审服务暂不可用，请稍后再试', kind: 'info' } })
    else if (r.reason === 'rate_limited')
      set({ toast: { msg: '操作过于频繁，请稍后再试', kind: 'info' } })
    else if (r.reason === 'network')
      set({ toast: { msg: '网络不可用，无法连接云端复核服务', kind: 'info' } })
    else if (r.reason === 'quota_exceeded')
      feedback(`今日云端复核额度已用完（${r.usedToday ?? 0}/${r.dailyLimit ?? '?'}），额度按日重置`)
    else if (r.reason === 'empty')
      feedback(`${label}无待复核照片：本栏为空，或余下照片都已结案（采纳过 / 确认采纳过），或已转人工裁定画质`)
    else if (r.reason === 'no_consent') set({ toast: { msg: '请先在授权窗口中确认开启 AI 复审', kind: 'info' } })
  },
  async stopAiReview() {
    await window.api.aiReviewStop()
  },
  dismissAiReviewSummary() {
    set({ aiReviewSummaryDismissed: true })
  },
  reopenAiReviewSummary() {
    set({ aiReviewSummaryDismissed: false })
  },

  /**
   * 采纳单张 AI 建议：严格镜像 ReviewPanel 的手动重判提交序列（先删后补、中置信存疑瑕疵提为
   * 高置信、人数变化才 moveIds），不新增任何直改库通道，保证"采纳 == 手动改成同样结果"字节级等价、
   * 可走既有撤回栈。采纳前用 getImage 兜底权威值并二次校验该图仍在待确认（否则跳过），采纳后结案留痕。
   */
  async adoptAiReview(id) {
    const img = await window.api.getImage(id)
    const sug = img?.ai_review
    if (!img || !sug) return false
    // 二次校验仍在它被复审时那一栏（与 db.matchesView 同一口径），否则早已结案/移走，跳过：
    //  - review：非废弃 ∩（category=review ∪ 带中置信瑕疵）——v2.0.93 反转后不再拿冗余帧单独排除
    //    （category 停在待确认的算待确认，哪怕挂着高置信瑕疵；带中置信瑕疵的冗余帧也归此栏）
    //  - flaws：非废弃 ∩ 高置信瑕疵且没停在拍板位（采纳掉标后即自动离开瑕疵片）
    const fl = flawLevel(img.tags || {})
    const scope = sug.scope ?? 'review'
    const stillValid = isTrashLike(img.category)
      ? false
      : scope === 'flaws'
        ? fl === 'high' && img.category !== CAT_REVIEW
        : img.category === CAT_REVIEW || fl === 'mid'
    if (!stillValid) return false
    for (const key of Object.keys(sug.flaws) as (keyof typeof sug.flaws)[]) {
      const dim = AI_FLAW_TO_DIM[key]
      const want = sug.flaws[key]
      const cur = img.tags?.[dim]
      const has = !!cur && cur.level !== 'low'
      if (!want && has) await window.api.removeDimTag([id], dim)
      else if (want && !has) await window.api.addDimTag([id], dim)
      else if (want && cur?.level === 'mid')
        // 建议保留且现状是中置信存疑瑕疵 → 按 D1 提为高置信（与 ReviewPanel:137 同通道）
        await window.api.correctImage({ imageId: id, action: 'correct', origDim: dim, origConfidence: cur.confidence ?? null })
    }
    if (visiblePersonOf(img) !== sug.person) await get().moveIds([id], sug.person as CategoryKey)
    // 结案留痕而不是清空建议：清空后这张看起来像"从没判过"，仍留在本栏的话会被下轮默认复审重跑、白烧额度
    await window.api.aiReviewConfirm(id)
    // 收尾归位：改完标签身上再没瑕疵却还停在待确认的（手动停泊的干净图 / 存疑瑕疵刚被抖掉），按人数搬走；
    // 不搬就会变成“已结案 + 无标记 + 不再复审 + 不进采纳”的死角（用户实测的 CHEN1192.JPG 就是这么冒出来的）
    await get().homeIfCleanParked(id)
    await get().refreshImagesFor([id])
    await get().refreshCounts()
    return true
  },

  /**
   * 不采纳单张 AI 建议：不改任何判定/标签/分类，只在建议上打"已否"标记（主进程 rejectAiReview），
   * 该张立即从分歧列表剔除。不采纳不算结案（用户 10-15 实测后拍板）：这张仍会进下一轮复审，
   * 重判后新建议覆盖旧 JSON，标记自然作废。
   */
  async rejectAiReview(id) {
    await window.api.aiReviewReject(id)
    await get().refreshImagesFor([id])
  },

  /**
   * 确认单张已结案：AI 与本地一致时走这里（标签一个字不动），只把建议打上 confirmed，
   * 再跑一次收尾归位。效果：这张从待处理队列消失，且不会被默认复审重跑（只有强制重判会重判它）。
   */
  async confirmAiReview(id) {
    await window.api.aiReviewConfirm(id)
    const homed = await get().homeIfCleanParked(id)
    // 没搬走的也要重拉一次：confirmed 刚落库，红底角标（等人工定画质）与队列计数都靠这条新记录驱动
    if (!homed) await get().refreshImagesFor([id])
    await get().refreshCounts()
    return homed
  },

  /**
   * 结案收尾：这张已没任何中/高置信瑕疵却还停在待确认（以前手动停泊、或存疑瑕疵刚被复审删干净）时，
   * 按它的人数标签归位到对应栏——随即离开待确认、进交付库（档位仍按本地实测的清晰度定，不拿云端意见当依据）。
   * 拿不到人数标签就不动（不猜归属）；走既有 moveIds 通道，不新增直改库路，可在“移动撤回”里逐张撤。
   */
  async homeIfCleanParked(id) {
    const rec = await window.api.getImage(id)
    if (!rec || !aiReviewShouldHome(rec)) return false
    const target = (visiblePersonOf(rec) ?? rec.ai_review?.person) as CategoryKey | undefined
    if (!target) return false
    await get().moveIds([id], target)
    return true
  },

  /**
   * 批量采纳：以主进程权威栏目列表为准（不依赖当前视图），逐张走 adoptAiReview。
   * 一致的图在里面等于“原样确认结案”（无标签可改、改不动任何东西），有分歧的按 AI 改完再结案。
   * 按钮叫“全部采纳”（用户 10-15 定）：批量做完的事就是逐张“采纳这张”的同一个动作，
   * 名字不一致会让人怀疑“点下去是不是等于没采纳”。
   */
  async adoptAllReviewSuggestions() {
    const scope = get().aiReview?.scope ?? 'review'
    const cat: CategoryKey = scope === 'flaws' ? CAT_FLAWS : CAT_REVIEW
    const reviewImgs = await window.api.listImages({ category: cat })
    const candidates = reviewImgs.filter((i) => hasAiReviewAction(i) && !isTrashLike(i.category)).map((i) => i.id)
    let n = 0
    for (const id of candidates) {
      try {
        if (await get().adoptAiReview(id)) n++
      } catch {
        /* 单张失败不中断批量 */
      }
    }
    // 本批有多少被转为人工裁定画质（带画面模糊/曝光异常）：必须告知“未全部清空”卡在哪些项，否则会沉默剩一堆
    const byId = new Map(get().images.map((i) => [i.id, i]))
    const manual = candidates.filter((id) => {
      const rec = byId.get(id)
      return !!rec && needsManualReview(rec)
    }).length
    // 处理完是否已清空，直接报数：用户的目标就是清空待确认，不报这个数还得他自己去数
    const label = scope === 'flaws' ? '瑕疵片' : '待确认'
    const remaining = (await window.api.listImages({ category: cat })).length
    if (n) {
      set({
        toast: {
          msg: manual
            ? `已应用 ${n} 张复核结论，其中 ${manual} 张仍含画面模糊/曝光异常（不在复核范围内），已标记人工复审并置于本栏首位；${label}剩余 ${remaining} 张`
            : `已应用 ${n} 张复核结论，${remaining ? `${label}剩余 ${remaining} 张` : `${label}已清空`}（所有操作均可逐条撤销）`,
          kind: 'success',
          duration: 2600
        }
      })
    }
    return n
  },
  async rescanAll() {
    const { auth } = get()
    if (!auth.loggedIn) {
      set({ showLogin: true, toast: { msg: '请先登录后再开始筛选', kind: 'info' } })
      return
    }
    set({ engineBusy: true })
    const r = await window.api.scanRescanAll()
    set({ engineBusy: false })
    if (!r.started) {
      set({ toast: { msg: r.message, kind: 'info' } })
      return
    }
    // 归位后立刻重拉列表与计数：不然界面要等第一张图检完才动，整轮开头看着像“数字死了”
    await get().refreshImages()
    await get().refreshCounts()
    set({
      toast: {
        msg: `已开始重新筛选：上一轮 AI 判定已清零 ${r.reset ?? 0} 张，左侧数字会随进度重新涨起来；你手动放置与废弃库里的图未改动`,
        kind: 'success',
        duration: 4000
      }
    })
  },

  /**
   * 拉取引擎签名过期信息（仅开发版横幅消费）：失败/引擎未就绪时保持上次值，
   * 由启动轮询或下一轮扫描结束再刷。staleReady=false 时横幅不显示（宁可不提示，不误报）。
   */
  async refreshStale() {
    try {
      const r = await window.api.staleInfo()
      set({ staleReady: r.ready, staleSig: r.sig, staleCount: r.staleCount })
    } catch {
      /* 引擎握手未完成等瞬时错误：不打扰，下次再取 */
    }
  },

  /**
   * 只重扫旧引擎结果的那批（非全库）：与 rescanAll 同样的登录门禁，但后端只重置过期图。
   * 跑完的 staleCount 归零由 onScanProgress 的收尾刷新自动把横幅收掉。
   */
  async rescanStale() {
    const { auth } = get()
    if (!auth.loggedIn) {
      set({ showLogin: true, toast: { msg: '请先登录后再开始筛选', kind: 'info' } })
      return
    }
    set({ engineBusy: true })
    const r = await window.api.scanRescanStale()
    set({ engineBusy: false })
    if (!r.started) {
      set({ toast: { msg: r.message, kind: 'info' } })
      return
    }
    await get().refreshImages()
    await get().refreshCounts()
    set({
      toast: {
        msg: `已用新引擎重扫旧结果：本轮重置 ${r.reset ?? 0} 张，跑完后横幅自动消失；你手动放置与废弃库里的图未改动`,
        kind: 'success',
        duration: 4000
      }
    })
  },

  /** 真正的清库动作：二次确认在 TopBar 的应用内弹窗里做（Electron 对原生 window.confirm
   * 的支持不可依赖，旧守卫在不同版本下要么弹不出要么永远拦截），本函数不再自带确认 */
  async clearLibraryAll() {
    const r = await window.api.libraryClear()
    set({ selection: new Set(), previewId: null, scanProgress: null, undoSnapshots: [] })
    void get().saveSettings({ lastImportDir: null }) // 清空图库后不再显示“当前筛选目录”
    await get().openCategory(get().activeCategory)
    set({ toast: { msg: `已清空图库（原 ${r.cleared} 张），可重新导入照片了`, kind: 'success' } })
  },

  async clearCacheAll() {
    const r = await window.api.cacheClear()
    // 大白话回报：清了什么、腾出多少空间。图库和登录态不在此次删除范围内，不必让用户担心。
    const freed = r.freedMB > 0 ? `，释放 ${r.freedMB} MB` : ''
    set({ toast: { msg: `已清理缩略图、预览图、日志和运行缓存${freed}。${r.retried} 张解码失败项自动重试，缩略图后台重建中`, kind: 'info' } })
    setTimeout(() => void get().refreshImages(), 1500)
  },

  async saveSettings(patch, reclassify = false) {
    const s = await window.api.saveSettings(patch)
    set({ settings: s })
    if (patch.viewMode) set({ viewMode: patch.viewMode })
    // 性能模式变更：立刻重判定精简模式（复用启动探测缓存，不再多一次 IPC）
    if (patch.perfMode !== undefined) {
      const lean = perfLeanFor(patch.perfMode, perfHintCache)
      set({ perfLean: lean })
      applyPerfLean(lean)
    }
    // 界面缩放改了：落盘后立即重apply，设置里拨下拉马上看到效果
    if (patch.uiScale !== undefined) get().applyUiScale()
    if (reclassify) {
      await window.api.reclassify()
      await get().refreshImages()
      await get().refreshCounts()
    }
  },

  async addCustomCategory(name) {
    const c = await window.api.customAdd(name)
    set({ customCategories: [...get().customCategories, c] })
    await get().refreshCounts()
  },

  async removeCustomCategory(id) {
    await window.api.customRemove(id)
    set({ customCategories: get().customCategories.filter((c) => c.id !== id) })
    const { activeCategory } = get()
    if (activeCategory === `custom:${id}`) await get().openCategory(CAT_LIBRARY)
    await get().refreshCounts()
  },

  async importPaths(paths) {
    const r = await window.api.importPaths(paths)
    // 判定本次是否“选择/拖入了整个目录”：路径不以已知图片扩展名结尾 → 视为目录，记为当前筛选目录（仅选照片时不改）
    const dirPath = paths.find((p) => !SUPPORTED_EXTS.some((e) => p.toLowerCase().endsWith(e)))
    if (dirPath && dirPath !== get().settings.lastImportDir) void get().saveSettings({ lastImportDir: dirPath })
    set({
      importProgress: null,
      toast: {
        msg: `导入完成：新增 ${r.added} 张${r.dupSkipped ? `，过滤同名重复 ${r.dupSkipped} 张` : ''}${r.nameKept ? `，另有 ${r.nameKept} 张同名但内容不同（相机重号），已按不同照片导入` : ''}${r.existed ? `，已存在 ${r.existed} 张` : ''}${r.filtered ? `，已跳过 ${r.filtered} 个不支持的格式` : ''}${r.skipped ? `，无法解码 ${r.skipped} 张` : ''}`,
        kind: 'info'
      }
    })
    await get().openCategory(null)
  },

  async pickAndImport() {
    const dir = await window.api.pickFolder()
    if (dir) await get().importPaths([dir])
  },

  async pickAndImportImages() {
    const files = await window.api.pickImages()
    if (files && files.length) await get().importPaths(files)
  },

  async runExport(opts) {
    try {
      await window.api.exportRun(opts)
    } catch (e) {
      set({ toast: { msg: '导出失败：' + String(e), kind: 'error' } })
    }
  },
  async cancelExport() {
    await window.api.exportCancel()
  },

  dismissToast() {
    set({ toast: null })
  }
}))

export { CAT_LIBRARY, CAT_REVIEW, CAT_TRASH, CAT_DUP_TRASH, DIMENSION_LABELS, sortConf }
