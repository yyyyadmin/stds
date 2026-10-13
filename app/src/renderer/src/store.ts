/**
 * 全局状态（zustand）
 * 覆盖：分类树与计数、当前视图图片、选择集（Shift/Ctrl 多选）、
 * 扫描进度事件流、一键修正、导出/设置对话框、视图快捷键 1-3 与大图 4
 */
import { create } from 'zustand'
import type { AppSettings, CategoryKey, ImageRecord, DimensionKey, PerfHint, TierKey } from '../../shared/types'
import { CAT_LIBRARY, CAT_REVIEW, CAT_TRASH, CAT_DUP_TRASH, CAT_FLAWS, DIMENSION_LABELS, isBadDim, isStructuralDim, isTrashLike, NEUTRAL_DIMENSIONS, PERSON_DIMS, guessMidDim, SUPPORTED_EXTS, tierOfCat, DEFAULT_TIER_NAMES } from '../../shared/types'
import type { AuthState, BootstrapInfo, ConsumeResult, MoveRequest, UpdateInfo } from '../../shared/ipc'
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

/** 现存的主区布局（读回的老设置里可能出现已下线的 'large'，靠它白名单过滤） */
const VIEW_MODES: string[] = ['grid', 'list', 'masonry']

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
  /** 移动撤回栈（栈顶 = 最近一次移动） */
  undoSnapshots: UndoSnapshot[]
  exportProgress: ExportProgress | null
  showExport: boolean
  showSettings: boolean
  showLogin: boolean
  showMember: boolean
  /** 启动自动检查到新版时的更新弹窗 */
  showUpdate: boolean
  updateInfo: UpdateInfo | null
  /** 失败照片定位弹窗（顶栏红色徽章点开） */
  showFailedImages: boolean
  auth: AuthState
  toast: { msg: string; kind: 'info' | 'error' | 'success'; duration?: number } | null
  /** 多选（≥2 张）移入废弃库的确认弹窗（单选直接移，不弹；null = 不显示） */
  trashAsk: { physical: boolean } | null
  engineBusy: boolean
  appVersion: string
  /**
   * 图片数据对账版本号：每次移动 / 加删标签 / 撤回等改动刷新列表后 +1。
   * 重复分组详情靠它感知“组内某成员的数据变了、但组号没变”（比如把一张冗余帧要进交付库，
   * 它离开了当前分类列表、整组成员却是按组号缓存的，不 bump 就会一直显示它的旧标签卡在下面）。
   */
  dataRev: number

  bootstrap(): Promise<void>
  setTheme(t: 'light' | 'dark'): Promise<void>
  toggleTheme(): Promise<void>
  openLogin(): void
  closeLogin(): void
  openMember(): void
  closeMember(): void
  doLogin(account: string, password: string): Promise<{ ok: boolean; message: string }>
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
  openReviewPanel(ids: number[]): void
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
  rescanAll(): Promise<void>
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
  // 默认按导入时间倒序：每次新导入/全量筛选后，新增图片排在每个分类最前面，方便优先复查新一批
  sortKey: 'time',
  query: '',
  displayIds: [],
  selection: new Set<number>(),
  anchorIndex: -1,
  previewId: null,
  tagManagerIds: null,
  tagManagerTouched: false,
  reviewPanelIds: null,
  tagBusy: null,
  previewOverlay: false,
  reviewSession: null,
  scanProgress: null,
  importProgress: null,
  thumbsProgress: null,
  undoSnapshots: [],
  exportProgress: null,
  showExport: false,
  showSettings: false,
  showLogin: false,
  showMember: false,
  auth: { loggedIn: false, token: null, user: null },
  toast: null,
  trashAsk: null,
  engineBusy: false,
  appVersion: '',
  dataRev: 0,
  showUpdate: false,
  updateInfo: null,
  showFailedImages: false,

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
      // 设置是从库里读回来的，可能带着老版本的 viewMode='large'（独立大图视图已下线，
      // 见 openLargePreview）：不兜一下主区三个分支都匹配不上，什么都不渲染，看着像图全没了
      viewMode: VIEW_MODES.includes(info.settings.viewMode) ? info.settings.viewMode : 'grid',
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
    // 恢复登录态（不阻塞首屏）
    void window.api.authBootstrap().then((a) => set({ auth: a }))
    await get().openCategory(null)
    get().bindEvents()
    // 启动后静默检查更新（错开 2.5s 不拖慢首屏），有新版自动弹窗
    setTimeout(() => void get().checkUpdateSilent(), 2500)
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
  async doLogin(account, password) {
    const a = await window.api.authLogin(account, password)
    set({ auth: a })
    if (a.loggedIn) {
      set({ showLogin: false })
      return { ok: true, message: '登录成功' }
    }
    return { ok: false, message: '账号或密码错误' }
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
    // 筛选结束事件也会被标签/移动等操作的收尾 send 重复触发：若每个事件都立刻重拉全量列表，
    // 一次点标签就是两三千行 JSON 重解析（用户看到的“反应本该很快却很慢”）。防抖合并成一次。
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    window.api.onScanProgress((p) => {
      set({ scanProgress: p })
      if (!p.running && (p.phase === 'done' || p.phase === 'stopped')) {
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = setTimeout(() => {
          settleTimer = null
          void get().refreshCounts()
          void get().refreshImages()
        }, 260)
      }
    })
    window.api.onScanImage((img) => {
      const { activeCategory, images } = get()
      const next = [...images]
      const idx = next.findIndex((i) => i.id === img.id)
      if (idx >= 0) next[idx] = img
      else if (activeCategory == null || img.category === activeCategory) next.push(img)
      set({ images: next })
      // 节流刷新计数
      void get().refreshCounts()
    })
    window.api.onImportProgress((p) => set({ importProgress: p }))
    window.api.onThumbsProgress((p) => set({ thumbsProgress: p }))
    // 后台缩略图逐批就绪：节流刷新当前视图
    let thumbTimer: ReturnType<typeof setTimeout> | null = null
    window.api.onThumbsReady(() => {
      if (thumbTimer) return
      thumbTimer = setTimeout(() => {
        thumbTimer = null
        void get().refreshImages()
        void get().refreshCounts()
      }, 900)
    })
    // 登录态 / 积分变化（含筛选后自动扣费的不足提醒）
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
    })
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
    })
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

  handleClickSelect(index, e) {
    const { images, selection, anchorIndex, displayIds } = get()
    // index 是“当前展示序”的下标（视图层按时间/置信度/文件名重排过），必须经 displayIds
    // 映射回 id；直接用 images[index] 会在非默认排序下选错图（选中样式“消失”）。
    const order = displayIds.length === images.length ? displayIds : images.map((i) => i.id)
    const id = order[index]
    if (id == null) return
    const sel = new Set(selection)
    if (e.shiftKey && anchorIndex >= 0) {
      const [a, b] = [Math.min(anchorIndex, index), Math.max(anchorIndex, index)]
      for (let i = a; i <= b; i++) sel.add(order[i])
    } else {
      // 单击即多选：每次点击都加入选中，再点一次取消（不清掉其他已选）
      if (sel.has(id)) sel.delete(id)
      else sel.add(id)
      set({ anchorIndex: index })
    }
    set({ selection: sel })
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
    // 放大弹窗判定栏（废弃库/移动到）同样给用户即时反馈，1 秒自动消失
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

  openReviewPanel(ids) {
    if (!ids.length) return
    set({ reviewPanelIds: ids })
  },
  closeReviewPanel() {
    set({ reviewPanelIds: null })
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
    const isMember = auth.user && auth.user.membership.level !== 'free' && !auth.user.membership.is_expired
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
    set({ toast: { msg: `缓存已清除：${r.retried} 张解码失败项自动重试，缩略图后台重建中`, kind: 'info' } })
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
        msg: `导入完成：新增 ${r.added} 张${r.existed ? `，已存在 ${r.existed} 张` : ''}${r.filtered ? `，已跳过 ${r.filtered} 个不支持的格式` : ''}${r.skipped ? `，无法解码 ${r.skipped} 张` : ''}`,
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
