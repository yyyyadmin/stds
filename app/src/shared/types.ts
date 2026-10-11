/**
 * 共享类型与常量：检测维度、分类体系、置信度分级
 * 主进程 / 预加载 / 渲染进程 / Python 引擎协议均以此为准
 */

/** 12 个检测维度（第一章/第二章） */
export type DimensionKey =
  | 'eyes_closed' // 闭眼
  | 'eyes_side' // 斜眼
  | 'face_ugly' // 面部狰狞
  | 'blur' // 画面模糊
  | 'exposure' // 曝光异常
  | 'half_head' // 半截头
  | 'duplicate' // 重复/连拍
  | 'single_person' // 单人照
  | 'group_photo' // 多人合拍照（规整摆拍，DB key 沿用历史值）
  | 'mixed_photo' // 多人混合照（在场多人但非摆拍：接亲 / 游戏 / 仪式等互动情节）
  | 'no_person' // 无人物场景
  | 'black_white' // 黑白照

/** 坏维度：被标记后进入待修正区或垃圾桶
 *  注：斜眼(eyes_side)、面部狰狞(face_ugly) 已下线——引擎仍会计算，但 gradeDims 在入库阶段
 *  按本数组过滤，二者不再产生标签/分类/侧栏/导出项（仅界面隐藏，零 CI 风险）。 */
export const BAD_DIMENSIONS: DimensionKey[] = [
  'eyes_closed',
  'blur',
  'exposure',
  'half_head',
  'duplicate'
]

/** 中性维度：仅作为分类标签（人数四分类按「少 → 多 → 无」排列，混合照紧跟合拍照） */
export const NEUTRAL_DIMENSIONS: DimensionKey[] = [
  'single_person',
  'group_photo',
  'mixed_photo',
  'no_person',
  'black_white'
]

export const DIMENSION_LABELS: Record<DimensionKey, string> = {
  eyes_closed: '闭眼',
  eyes_side: '斜眼',
  face_ugly: '面部狰狞',
  blur: '画面模糊',
  exposure: '曝光异常',
  half_head: '半截头',
  duplicate: '重复/连拍',
  single_person: '单人照',
  group_photo: '多人合拍照',
  mixed_photo: '多人混合照',
  no_person: '无人物场景',
  black_white: '黑白照'
}

/**
 * 人数维度互斥表（单一来源）：一张图在同一时刻只能属于其中一个，
 * 「多人合拍照」与「多人混合照」更是非此即彼（同一帧不可能既是规整摆拍又是扎堆抓拍）。
 * 顺序即并列时的优先序：合拍照是五道几何闸全过的强结论，排前；混合照是兜底桶。
 */
export const PERSON_DIMS: DimensionKey[] = ['group_photo', 'mixed_photo', 'single_person', 'no_person']

const PERSON_LEVEL_RANK: Record<ConfidenceLevel, number> = { high: 2, mid: 1, low: 0 }

/**
 * 人数标签互斥收口：tags 里同时出现多个人数维度时，只保留一个，其余删掉。
 * 保留谁：① 用户手动标的优先（那是人工判定，不能悄悄丢掉）→ ② 级别更高 → ③ 置信度更高 → ④ 并列按 PERSON_DIMS 顺序。
 * 所有写 tags 的出口（updateDetectResult / setDimTag）都必须过这里，否则一次旧数据残留
 * 或一次合并写入，就会让同一张卡同时挂着「多人混合照 + 多人合拍照」两枚互相打脸的标签。
 */
export function enforcePersonMutex<T extends Record<string, { confidence: number; level: ConfidenceLevel; method?: string } | undefined>>(
  tags: T
): T {
  const present = PERSON_DIMS.filter((d) => tags[d])
  if (present.length <= 1) return tags
  const keep = present.reduce((a, b) => {
    const ta = tags[a]!
    const tb = tags[b]!
    const ua = ta.method === 'user' ? 1 : 0
    const ub = tb.method === 'user' ? 1 : 0
    if (ua !== ub) return ua > ub ? a : b
    const la = PERSON_LEVEL_RANK[ta.level]
    const lb = PERSON_LEVEL_RANK[tb.level]
    if (la !== lb) return la > lb ? a : b
    if (ta.confidence !== tb.confidence) return ta.confidence > tb.confidence ? a : b
    return PERSON_DIMS.indexOf(a) <= PERSON_DIMS.indexOf(b) ? a : b
  })
  for (const d of present) if (d !== keep) delete tags[d]
  return tags
}

/** 待确认图猜测存在中置信度的坏维度（修正记录用） */
export function guessMidDim(tags: Record<string, { level: string } | undefined>): string | null {
  for (const [d, t] of Object.entries(tags)) {
    if (t && t.level === 'mid' && isBadDim(d)) return d
  }
  for (const [d, t] of Object.entries(tags)) {
    if (t && t.level === 'mid') return d
  }
  return null
}

/** 中置信度维度的置信度（修正记录原判定置信度） */
export function midConf(tags: Record<string, { level: string; confidence: number } | undefined>): number | null {
  const dim = guessMidDim(tags)
  return dim ? (tags[dim]?.confidence ?? null) : null
}

/**
 * 代价偏向（第二章表格）：
 * recall  = 偏向召回，阈值调低（宁可多标让用户复核）
 * precise = 偏向精确，阈值调高（只标明显的）
 * high    = 精度本身高
 */
export type DimBias = 'recall' | 'precise' | 'high'

export const DIMENSION_BIAS: Record<DimensionKey, DimBias> = {
  eyes_closed: 'recall',
  eyes_side: 'recall',
  face_ugly: 'precise',
  blur: 'recall',
  exposure: 'high',
  half_head: 'recall',
  duplicate: 'recall',
  single_person: 'high',
  group_photo: 'high',
  // 混合照是「凑不出规整主群」时的兜底桶，判定本身依赖构图几何，偏保守不主动放宽
  mixed_photo: 'precise',
  no_person: 'high',
  black_white: 'high'
}

/** 特殊分类桶 */
export const CAT_LIBRARY = 'library' // 交付库（导出用）；库里存的 key 仍是 'library'，改的只是展示名
export const CAT_REVIEW = 'review' // 待确认
export const CAT_TRASH = 'trash' // 垃圾桶（永不导出）
/** 重复/连拍专用废弃桶：从重复分组里被丢弃的图，像垃圾桶一样永不导出、不可被拖入，仅可移出 */
export const CAT_DUP_TRASH = 'dup_trash'

/** 垃圾桶类（永不导出、不出现在其它并集视图）：普通垃圾桶 + 重复废弃桶 */
export function isTrashLike(cat: string): boolean {
  return cat === CAT_TRASH || cat === CAT_DUP_TRASH
}

/**
 * 是否属于「交付库（导出用）」这个虚桶。与 db.virtualCategorySql(CAT_LIBRARY)、
 * exporter.isLibrary 同一口径，三处必须一致。
 * 重点：它是“不在瑕疵区/待确认/垃圾桶”的统称，不等于 category === 'library'——
 * 单人照/多人合拍照/多人混合照/无人物/黑白照/自定义分类的图全都算在这里、全都正常导出。
 * （多人混合照是接亲、做游戏这类互动情节片，属于可交付内容，任何时候都不要划进瑕疵维度。）
 * 展示“这张在哪个库 / 会不会导出”时严禁直接比较枚举值（否则绝大多数图会错判成“不属于交付库”）。
 */
export function isLibraryBucket(cat: string): boolean {
  return !isBadDim(cat) && cat !== CAT_REVIEW && !isTrashLike(cat)
}

/** 分类桶 key = 'library' | 'review' | 'trash' | DimensionKey | 'custom:<id>' */
export type CategoryKey = string

/** 置信度分级（第四章）默认阈值；缺省为"严格"档（旧名"非常严格"），用户可在设置中调整 */
export const DEFAULT_HIGH_THRESHOLD = 0.8
export const DEFAULT_MID_THRESHOLD = 0.55

export type ConfidenceLevel = 'high' | 'mid' | 'low'

/** 检测程度：阈值组合的快捷档位（custom = 用户手动拉过滑条） */
export type Strictness = 'normal' | 'strict' | 'very' | 'custom'

// 档位文案面向客户改成结果导向（用户拍板 2026-10-11）：旧名"一般/严格/非常严格"客户读不出
// 后果，下拉里的"（高 0.80 / 中 0.55）"小数只会吓人。key 不变，存量设置零迁移。
// tip 直接描述"照片会被分到哪"，不出现阈值/置信度术语。
export const STRICTNESS_PRESETS: Array<{ key: Exclude<Strictness, 'custom'>; label: string; high: number; mid: number; tip: string }> = [
  { key: 'normal', label: '宽松（相信 AI，复核少）', high: 0.93, mid: 0.8, tip: '只抓把握很大的问题，误报最少，绝大多数照片直接留在交付库' },
  { key: 'strict', label: '标准（平衡复核量）', high: 0.9, mid: 0.7, tip: '中等把握的可疑照片进【待确认】，交付前建议复核一遍' },
  { key: 'very', label: '严格（宁多勿漏）', high: 0.8, mid: 0.55, tip: '稍有可疑就被拉进【待确认】/瑕疵分类，待确认数量最多' }
]

/** 从当前阈值反推档位（浮点容差 0.005） */
export function deriveStrictness(high: number, mid: number): Strictness {
  for (const p of STRICTNESS_PRESETS) {
    if (Math.abs(p.high - high) < 0.005 && Math.abs(p.mid - mid) < 0.005) return p.key
  }
  return 'custom'
}

export function levelOf(confidence: number, high: number, mid: number): ConfidenceLevel {
  if (confidence > high) return 'high'
  if (confidence >= mid) return 'mid'
  return 'low'
}

/** 单个维度的检测结果 */
export interface DimResult {
  /** 该维度成立的可信度 0~1 */
  confidence: number
  /** 检测结果分级 */
  level: ConfidenceLevel
  /** 判定依据说明（供预览层展示） */
  reason?: string
  /** 引擎类型：onnx 模型 / 几何规则 / 传统算法 */
  method?: string
  /**
   * 用户手动补标这个维度的时刻（ms）。“最新在前”排序在维度分类里优先读它：
   * 在单人照里加“闭眼”只该让图在闭眼分类排第一，不该把它在单人照里也顶到最前——
   * 共享的 cat_changed_at 一个字段做不到按分类区分，时间戳必须挂在标签上。
   */
  taggedAt?: number
}

/** 人脸框与关键点（预览层叠加显示） */
export interface FaceInfo {
  box: [number, number, number, number] // x, y, w, h（原图像素坐标）
  score: number
  eyes?: Array<[number, number]> // 双眼中心点
  landmarks?: Array<[number, number]> // 106/68 点（可选）
  gazeYaw?: number // 视线水平角（度）
  gazePitch?: number
  emotion?: Record<string, number>
}

/** 一张图的完整检测响应（Python/Node 引擎 → 主进程） */
export interface DetectResult {
  imageId: number
  dims: Partial<Record<DimensionKey, DimResult>>
  faces: FaceInfo[]
  faceCount: number
  /** 正面主体数（v2.0.65 新口径：人数只数正面露脸/头部完整的人）；旧版引擎无此字段 */
  frontalCount?: number
  /** 规整摆拍主群人数（v2.0.66：合拍照 / 多人混合照的分界依据）；旧版引擎无此字段 */
  posedCount?: number
  /** 重复分组：同组内共享 groupId */
  dupGroup?: string
  /** 引擎内部耗时 ms */
  elapsedMs?: number
  error?: string
}

/** 数据库中的一张图片记录 */
export interface ImageRecord {
  id: number
  path: string
  filename: string
  dir: string
  width: number
  height: number
  format: string
  fileSize: number
  thumb: string // 缩略图 file:// 地址（可能为空）
  status: 'pending' | 'done' | 'error' | 'skip'
  category: CategoryKey // 当前所在分类桶
  tags: Partial<Record<DimensionKey, DimResult>> // AI 检测标签
  details: { faces?: FaceInfo[]; dupGroup?: string; engine?: string; faceCount?: number; frontalCount?: number | null; posedCount?: number | null; phash?: string } | null
  dupGroup: string | null
  scene: string | null
  addedAt: number
  /** 最近一次“进入当前分类”的时间（导入/AI 归入/手动移动/判定错误），用于“最新在前”排序；旧数据无值时回退 addedAt */
  catChangedAt?: number | null
  scannedAt: number | null
  /** 'ai' = AI 判定；'user' = 用户手动放置（AI 不再覆盖） */
  categoryBy: 'ai' | 'user' | null
}

/** 一键修正记录（第五章 5.4，用于阈值微调） */
export interface CorrectionRecord {
  id: number
  imageId: number
  origDim: string | null
  origConfidence: number | null
  newCategory: string
  action: 'correct' | 'wrong' // 判定正确 / 判定错误
  timestamp: number
}

/** 场景预设（第九章 9.1）：自动加载对应阈值 */
export interface ScenePreset {
  key: string
  label: string
  /** 各维度阈值覆盖 [mid, high] */
  overrides: Partial<Record<DimensionKey, [number, number]>>
}

export const SCENE_PRESETS: ScenePreset[] = [
  { key: 'wedding', label: '婚礼跟拍', overrides: { eyes_closed: [0.6, 0.85], blur: [0.6, 0.85], duplicate: [0.6, 0.9] } },
  { key: 'studio', label: '棚拍写真', overrides: { exposure: [0.65, 0.88] } },
  { key: 'kids', label: '儿童抓拍', overrides: { eyes_closed: [0.55, 0.8], blur: [0.62, 0.86] } },
  { key: 'default', label: '通用', overrides: {} }
]

/** 机器性能探测结果（主进程 perfHint）：auto 档据此决定是否开启精简模式 */
export interface PerfHint {
  /** CPU 逻辑核心数 */
  cores: number
  /** 物理内存 GB（保留一位小数） */
  memGB: number
  /** GPU 合成不可用（软件渲染/省电模式）——低配机最典型的信号 */
  gpuSoftware: boolean
}

/** 全局设置 */
export interface AppSettings {
  highThreshold: number
  midThreshold: number
  /** 筛选力度快捷档（宽松/标准/严格，手动拉滑条后为 custom） */
  strictness: Strictness
  scene: string
  enginePreference: 'auto' | 'python' | 'node' // AI 引擎偏好
  devicePreference: 'auto' | 'cpu' | 'cuda' // GPU/CPU 模式
  /** 重复/连拍分组弹窗的选图模式（记忆用户习惯）：drop=点选要丢弃的（默认） / keep=点选要保留的 */
  dupPickMode?: 'drop' | 'keep'
  /** 性能模式（第二档 A1）：auto=探测到低配自动精简 / full=始终全特效 / lean=始终精简。不设=auto */
  perfMode?: 'auto' | 'full' | 'lean'
  /** 重复/连拍选图模式的首次使用引导是否已看过 */
  dupGuideSeen?: boolean
  /** 重复/连拍分组弹窗宫格密度（记忆）：false=每排 4 张（默认）/ true=每排 2 张大图 */
  dupGridBig?: boolean
  /** 重复/连拍页顶部的“这一页怎么看”说明是否已点过已阅（点过以后默认收起） */
  dupBannerSeen?: boolean
  /**
   * 连拍组人数一致化的规则版本（主进程启动时按版本补跑一次，老库不必重跑 AI）。
   * 改判规则升级时把代码里的 HARMONY_VERSION +1 即可让全库重算一遍。
   */
  personHarmony?: number
  /** 修正记录积累后的自动阈值微调 */
  autoTune: boolean
  /** 按维度的阈值微调覆盖（由修正记录学习得到） */
  tunedThresholds: Partial<Record<DimensionKey, [number, number]>>
  /** 主区布局。老版本还有一个 'large'（独立大图视图），已下线为「大图 = 打开放大弹窗」，
   * 库里残留的旧值由 store.bootstrap 兜成 grid */
  viewMode: 'grid' | 'list' | 'masonry'
  /** 主题：简白（默认）/ 暗夜 */
  theme: 'light' | 'dark'
  lastExportDir: string | null
  lastImportDir: string | null
  /** 启动自动更新弹窗：对此版本点过“跳过”后不再弹，新版本再弹 */
  skipUpdateVersion?: string | null
  /** 缩略图方向修正版本：旧版缩略图未应用 EXIF 方向（竖拍显示为横），升级后需一次性重建。不设默认值，未迁移时为 undefined */
  thumbOrientVersion?: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  highThreshold: DEFAULT_HIGH_THRESHOLD,
  midThreshold: DEFAULT_MID_THRESHOLD,
  strictness: 'very',
  scene: 'default',
  enginePreference: 'auto',
  devicePreference: 'auto',
  autoTune: true,
  tunedThresholds: {},
  viewMode: 'grid',
  theme: 'light',
  lastExportDir: null,
  lastImportDir: null,
  skipUpdateVersion: null
}

/**
 * 缩略图双档（低配机性能路径）：
 * - 大档 960：放大弹窗、瀑布流、格子×DPR 超过 320 物理像素时用（历史 256 → 640 → 960 的当前档）；
 * - 小档 320：常规网格格子 / 列表行用。解码内存与像素面积成正比，小档单张约为大档 1/9，
 *   几千张滚动时是低配机不掉帧的关键。
 * 大档路径存 DB thumb 列；小档不入库，由大档路径换后缀派生（因此 pruneUnreferencedThumbs
 * 必须把派生出的小档名一并放行，否则会被当垃圾收掉）。大档后缀同时是版本号：
 * 改 THUMB_MAX 后旧档自动判“待重建”，后台无感重刷。
 */
export const THUMB_MAX = 960
export const THUMB_QUALITY = 82
export const THUMB_SMALL_MAX = 320
export const THUMB_SMALL_QUALITY = 80
export const THUMB_SUFFIX = `@${THUMB_MAX}.jpg`
export const THUMB_SMALL_SUFFIX = `@${THUMB_SMALL_MAX}.jpg`

/** 大档路径 → 小档路径；后缀不是当前大档（如老库待重建的 @640）时返回空串，调用方回退大档 */
export function smallThumbPath(bigPath: string): string {
  return bigPath.endsWith(THUMB_SUFFIX) ? bigPath.slice(0, -THUMB_SUFFIX.length) + THUMB_SMALL_SUFFIX : ''
}

/** 支持的导入格式（第九章）：常见格式 + iPhone HEIC + 新格式 AVIF/JXL + 全相机 RAW（LibRaw 系）。
 *  设计/医疗/矢量格式（psd/ai/cdr/xcf/sketch/fig/dcm/nii/fits/exr/dpx/eps/svg/ico 等）不属于照片，
 *  无人脸/EXIF 语义，不予导入（导入只会产生无意义失败）。 */
export const SUPPORTED_EXTS = [
  '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp', '.webp', '.heic', '.heif', '.avif', '.jxl',
  // 相机 RAW：Canon / Nikon / Sony / Fuji / Olympus / Panasonic / Pentax / Leica / Samsung / Sigma
  '.cr2', '.cr3', '.crw', '.nef', '.nrw', '.arw', '.srf', '.sr2', '.raf', '.rw2',
  '.raw', '.orf', '.pef', '.ptx', '.rwl', '.dng', '.srw', '.x3f'
]

/** 维度精度分级承诺（第八章 8.3） */
export const PRECISION_TIERS: Record<string, { label: string; tip: string }> = {
  trust: { label: '可直接信任', tip: '单人/多人、无人物、黑白照、曝光 —— 99%+，自动标记' },
  review: { label: '建议复核', tip: '闭眼、模糊、重复/连拍 —— 97-98%，黄色高亮待确认' },
  ref: { label: '仅作参考', tip: '狰狞、斜视、半截头 —— 90-95%，标注"建议人工复核"' }
}

export function dimTier(dim: DimensionKey): 'trust' | 'review' | 'ref' {
  if (['single_person', 'group_photo', 'no_person', 'black_white', 'exposure'].includes(dim)) return 'trust'
  if (['eyes_closed', 'blur', 'duplicate'].includes(dim)) return 'review'
  // mixed_photo 刻意留在 ref：合拍 / 混合的分界靠构图几何，是人数维度里最不稳的一环，
  // 说它「99%+ 可直接信任」是假承诺
  return 'ref'
}

/** 是否属于坏维度 */
export function isBadDim(dim: string): dim is DimensionKey {
  return (BAD_DIMENSIONS as string[]).includes(dim)
}
