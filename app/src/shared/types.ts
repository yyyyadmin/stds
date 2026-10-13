/**
 * 共享类型与常量：检测维度、分类体系、置信度分级
 * 主进程 / 预加载 / 渲染进程 / Python 引擎协议均以此为准
 */

/** 12 个检测维度（第一章/第二章） */
export type DimensionKey =
  | 'eyes_closed' // 闭眼
  | 'eyes_side' // 斜眼
  | 'face_ugly' // 表情崩坏（原“面部狰狞”，v2.1 依真值校准后重新启用）
  | 'blur' // 画面模糊
  | 'exposure' // 曝光异常
  | 'half_head' // 半截头
  | 'duplicate' // 重复/连拍
  | 'single_person' // 单人照
  | 'group_photo' // 多人合拍照（规整摆拍，DB key 沿用历史值）
  | 'mixed_photo' // 多人混合照（在场多人但非摆拍：接亲 / 游戏 / 仪式等互动情节）
  | 'no_person' // 无人物场景
  | 'black_white' // 黑白照

/** 坏维度：命中即打“瑕疵标签”，落入瑕疵片视图、默认不导出（D2 后不再充当主分类，只管导出闸门）。
 *  注：斜眼(eyes_side) 已下线——引擎仍计算但按本数组过滤，不再产标签/分类/侧栏/导出项；
 *  表情崩坏(face_ugly) v2.1 依 12 帧真值校准阈值后重新启用（eyeSquint 主 + 嘴开/仰头佐证，咧嘴不作佐证）。
 *  v2.0.67：重复/连拍从这里摘出去——它是“同组已有一张代表帧”的结构结论，不是这张照片拍坏了。
 *  以前它混在这里，导致 860 张本身没有任何毛病的好片被归成“瑕疵片”（用户 10-13 投诉的原点）。 */
export const BAD_DIMENSIONS: DimensionKey[] = [
  'eyes_closed',
  'half_head',
  'face_ugly',
  'blur',
  'exposure'
]

/** 中性维度：仅作为分类标签（人数四分类按「少 → 多 → 无」排列，混合照紧跟合拍照） */
export const NEUTRAL_DIMENSIONS: DimensionKey[] = [
  'single_person',
  'group_photo',
  'mixed_photo',
  'no_person',
  'black_white'
]

/**
 * 结构维度（v2.0.67）：结论来自“跨图关系”而不是这张图本身拍得怎样。
 * duplicate（重复/连拍）在这里：它不影响瑕疵等级（不进瑕疵片、不进待确认），
 * 但仍然是交付闸门——一个重复组里只有一张代表帧进交付库，其余默认不导出，
 * 因为“要不要多留一张”是选片意图，用户 10-13 实测无法用任何图像信号自动判定，只能留给他手动定。
 */
export const STRUCTURAL_DIMENSIONS: DimensionKey[] = ['duplicate']

/** 全部会写进 tags 的维度（瑕疵 + 客观事实 + 结构）：视图与计数并集口径用它 */
export const ALL_TAG_DIMENSIONS: DimensionKey[] = [...BAD_DIMENSIONS, ...NEUTRAL_DIMENSIONS, ...STRUCTURAL_DIMENSIONS]

export const DIMENSION_LABELS: Record<DimensionKey, string> = {
  eyes_closed: '闭眼',
  eyes_side: '斜眼',
  face_ugly: '表情崩坏',
  blur: '画面模糊',
  exposure: '曝光异常',
  half_head: '半截头',
  // 客户看到的分类名统一叫「重复照片」（用户 10-13 拍板）；内部 key 仍是 duplicate，零迁移
  duplicate: '重复照片',
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

/**
 * 事实/结构维度：回答“这张图是什么 / 是不是冗余”，不回答“这张图好不好”。
 * 力度档（宽松/标准/严格）与自学习都不得改变它们的判定——固定在默认刻度上。
 * 3185 张真实库实测（app/scripts/check-strictness-impact.js，逐维度数“换档会变几张”）：
 *   宽松档会把 139 张合拍照、105 张黑白照从 high 降成 mid，被 anyMid 拉进【待确认】（越宽松越打扰，方向反了）；
 *   滑条 high 拉到 0.99 时 739 张单人照 / 1295 张重复图的标签整段变 low，图直接从分类视图里凭空消失
 *   ——与历史上“人数维度被 tuned 顶过 high 线”同一类坑，这些维度的分数多为 0.99/1.0 常量，阈值只能全开/全关。
 */
export const FACT_DIMENSIONS: DimensionKey[] = [...PERSON_DIMS, 'black_white', 'duplicate']

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
export const CAT_TRASH = 'trash' // 废弃库（永不导出）
/** @deprecated legacy：已并入统一废弃库 CAT_TRASH（靠 trashFrom='duplicate' 区分来源）。仅保留用于兼容旧数据行与导出排除，不再产生新行 */
export const CAT_DUP_TRASH = 'dup_trash'
/** 瑕疵片虚桶：带任一高置信瑕疵标签、默认不导出的图（D2 新增，纯由 tags 派生，不写进 category） */
export const CAT_FLAWS = 'flaws'
/**
 * 侧栏“重复多余”状态行的计数 key（v2.0.67）：它不是一个可移入的归属，只是 counts 表里的键，
 * 专门给上段“互斥可求和”补位：本身没拍坏、只因同组已有代表帧而不导出的那批图。
 * 点开这一行进的是重复/连拍整组视图（cat 仍用 'duplicate'）。
 */
export const DUP_REDUNDANT_KEY = 'dup_redundant'

/**
 * 交付库档位（D4，第三条轴）：只在交付库内部再分层，瑕疵片/待确认/废片无档位。
 * 1=优质（值得精修）/ 2=良好（初修直出）/ 3=一般（凑数备份）。
 * 不碰 category（归属）与 tags（瑕疵）两根轴：tier 由 AI 按“离瑕疵线的距离”预分，
 * 人工拖拽改档后 tierBy='user'，永不被重筛覆盖。
 */
export type TierKey = 1 | 2 | 3
export const DEFAULT_TIER_NAMES = ['优质', '良好', '一般']
/** 档位视图 key 约定：activeCategory / 拖放目标 / counts key 都用 'tier:1' 形式 */
export function tierOfCat(cat: string): TierKey | null {
  const m = /^tier:([123])$/.exec(cat)
  return m ? (Number(m[1]) as TierKey) : null
}

/** 废弃库类（永不导出、不出现在其它并集视图）：普通废弃库 + 重复废弃桶 */
export function isTrashLike(cat: string): boolean {
  return cat === CAT_TRASH || cat === CAT_DUP_TRASH
}

/** 瑕疵等级：该图所有坏维度标签里的最高级（high > mid > none，低置信忽略）。
 *  交付库 / 瑕疵片 / 待确认三档状态全由它派生，与主分类(人数)正交。 */
export type FlawLevel = 'high' | 'mid' | 'none'
export function flawLevel(tags: Record<string, { level?: string } | undefined> | null | undefined): FlawLevel {
  if (!tags) return 'none'
  let high = false
  let mid = false
  for (const d of BAD_DIMENSIONS) {
    const t = tags[d]
    if (!t || t.level === 'low') continue
    if (t.level === 'high') high = true
    else if (t.level === 'mid') mid = true
  }
  return high ? 'high' : mid ? 'mid' : 'none'
}

/**
 * 是否属于「交付库（好片，默认导出）」——D2 后这是"主分类 + 瑕疵标签"双条件判定：
 * 非废弃库/待确认/瑕疵片虚桶，且没有任何中/高置信瑕疵标签（人数、黑白这些客观事实不算瑕疵）。
 * 一张"疑似闭眼"的图 category 仍是单人照，但不属于交付库、不导出，而是落在待确认。
 * v2.0.67 追加第二个闸门：重复组里的冗余帧（带可见 duplicate 标签）也不导出，
 * 但它不是因为拍坏才被拦的，所以绝不进瑕疵片/待确认，单独算“重复多余”。
 * 口径必须与 db.virtualCategorySql/matchesView、exporter 完全一致（三数一致）。
 */
export function isDeliverable(cat: CategoryKey, tags: Record<string, { level?: string } | undefined> | null | undefined): boolean {
  if (isTrashLike(cat) || cat === CAT_REVIEW || cat === CAT_FLAWS) return false
  if (isBadDim(cat)) return false // 旧数据 category 仍指向坏维度：按瑕疵处理，不作交付
  if (cat === 'duplicate') return false // 旧数据 category 停在重复视图：当年就是被当冗余拦下的
  if (isDupRedundant(tags)) return false // 组内非代表帧：默认不导出，由用户在分组里改留
  return flawLevel(tags) === 'none'
}

/** 交付库虚桶判定（D2 起收 tags：瑕疵标签会把它从交付库挪到瑕疵片/待确认）。口径单一来源见 isDeliverable。 */
export function isLibraryBucket(cat: CategoryKey, tags: Record<string, { level?: string } | undefined> | null | undefined): boolean {
  return isDeliverable(cat, tags)
}

/** 分类桶 key = 'library' | 'review' | 'trash' | DimensionKey | 'custom:<id>' */
export type CategoryKey = string

/** 置信度分级（第四章）默认阈值；缺省为"严格"档（旧名"非常严格"），用户可在设置中调整 */
export const DEFAULT_HIGH_THRESHOLD = 0.8
export const DEFAULT_MID_THRESHOLD = 0.55

export type ConfidenceLevel = 'high' | 'mid' | 'low'

/**
 * 缺陷维度的基线阈值（一次性标定，用户 2026-10-13 拍板"别指望我多点一下，把参数一次做好"）。
 *
 * 为什么要按维度各定一把尺：引擎给出的 confidence 不是同一量纲的连续概率，而是
 * 各算子自己的"码内台阶"。用一对全局数（0.55/0.8）去切所有维度，等于对每个维度
 * 随机决定"报了就等于铁证"还是"报了只算可疑"。标定依据 = v2.0.64 真实婚礼库 3185 张
 * 判定分布（分析脚本 app/scripts/analyze-calib.js，逐维度打印台阶与候选切点后果）：
 *   eyes_closed  只有 1.000(120) / 0.820(16) / 0.750(187) / 0.380(13) 四个台阶，
 *                0.75 = 半闭折半(probs[1]+probs[2]*0.5)，1.0 才是完全闭合 → high 卡 0.95 之上
 *   blur         0.90*sigmoid 饱和在 0.83~0.85（331 张一整块，模糊面积占比 ~85-90%），
 *                主体清晰/背景虚化被引擎封顶 0.50（本意就是"不判模糊"）→ high 必须落在
 *                0.88（0.85 之上、1.0 之下）；旧 wedding 预设的 0.85 正好劈在同一档糊度中间
 *   exposure     双峰极端：1.000(73) 与 0.62 以下的长尾，中间是空的 → high 落 0.80，
 *                0.55~0.80 那 ~26 张（接近死黑死白的边缘态）留待确认
 *   half_head    贴边距离算子饱和于 0.967~0.980(143)；大脸特写被引擎主动封顶 0.78
 *                （代码注释：框到边≠头被裁）→ high 卡 0.90，让 0.70~0.90 的构图嫌疑进待确认
 *   duplicate    不进基线表：它的分数是常量 0.99（1300 张里 1298 张一模一样），阈值对它只有
 *                “全开/全关”两种语义。实测过教训：一进表，“宽松”档平移后 high 变 0.99，
 *                0.99 > 0.99 不成立，1298 张重复图整段从“标瑕疵”塌进“待确认”（待确认 473→1546）。
 *                沿用全局一对数时，0.99 在任何力度档都稳定高于 high，这正好是我们要的“硬事实不受力度动摇”。
 * 人数四分类与黑白是结构/事实结论（引擎给 0.93~0.99 常量），不进这张表，沿用全局阈值，
 * 以免静默把图从某个分类视图里挪走（历史上发生过）。
 *
 * 力度档与滑条不再"直接当阈值用"，而是在这把尺上整体平移（见 classify.effectiveThresholds）。
 */
export const BASELINE_THRESHOLDS: Partial<Record<DimensionKey, [number, number]>> = {
  eyes_closed: [0.7, 0.95],
  face_ugly: [0.7, 0.82], // 引擎台阶：0.78=单一子特征（码内注释“落入待确认区”），≥0.86=两个以上子特征
  blur: [0.6, 0.88],
  exposure: [0.55, 0.8],
  half_head: [0.7, 0.9]
}

/**
 * 台阶基线 / 阈值语义 / 档位依据 / 重复分组规则的变更版本。存量库的 tags.level 是检测时写死的，只改这张表不会自己变，
 * 所以启动时按版本补跑一次 regradeAll（拿已存 confidence 重算 level/category/tier，不重跑引擎）。
 * 改动 BASELINE_THRESHOLDS 或 effectiveThresholds 的算法时把这里 +1。
 * v1 = 2026-10-13 首次按台阶标定；v2 = 同日把事实/结构维度（人数/黑白/重复）从力度平移里摘出去；
 * v3 = 同日档位（tier）依据从“离瑕疵线多远”换成引擎原始锐度实测（见 SHARP_ANCHORS）；
 * v4 = 重复/连拍从瑕疵维度改为结构维度（不再算瑕疵、不再归瑕疵片），且每组代表帧改为按用户权重挑最好一张；
 *      同时启动补跑一次 reclusterStored()（只用库里现存 phash 重新成组与改挂标签，不重跑引擎）。
 */
export const REGRADE_VERSION = 4

/**
 * 档位（优质/良好/一般）的量化依据：从 blur 的 reason 里解析引擎**原始测量值**。
 *
 * 为什么不直接用引擎的模糊置信度（3185 张真实库实测）：
 * - 交付库内（AI 判无瑕疵）的图，blur 置信度毫无分辨率：方差 56（明显偏软）到 1459（很锐）
 *   一律给 0.000，只有方差 <30 才给分。旧档位“离瑕疵线多远”因此恒等于最大档 → 优质占 95%。
 * - 原始方差本身跨 200 倍，且 face / full 两套口径同值不同义（同样的数，脸距不同含义不同），
 *   所以按口径各自在 log 域归一，再混入高频占比（线性口径）。
 * 锚点取真实分布的 p5 / p90（face 口径 n=644：方差 27→1073、占比 0.49→0.71；
 * full 口径 n=541：方差 34→634、占比 0.467→0.683）。
 */
export const SHARP_ANCHORS: Record<'face' | 'full', { varLo: number; varHi: number; hfLo: number; hfHi: number }> = {
  face: { varLo: 27, varHi: 1073, hfLo: 0.49, hfHi: 0.71 },
  full: { varLo: 34, varHi: 634, hfLo: 0.467, hfHi: 0.683 }
}
/** 锐度分里拉普拉斯方差的权重，余量给高频占比（两个信号同向，混用以压制单点噪声） */
export const SHARP_VAR_WEIGHT = 0.65
/** 优质 / 良好切点：取真实锐度分分布的 p70 与 p35，使三档真的分成堆（实测 30% / 35% / 35%） */
export const TIER_SHARP_TRUST = 0.7
export const TIER_SHARP_OK = 0.43
/** 拿不到实测（放行时清过 blur 标签、或 node 降级引擎只给“模糊面积占比”）时的档位：不奖不罚 */
export const TIER_SHARP_UNKNOWN: TierKey = 2

/**
 * 渲染层用的“这张进交付库会落哪一档”估算（v2.0.67）。
 *
 * 为什么要单独有一个：重复组里的非代表帧被拦在库外时 tier 存 null（scoreTier 认定它不在交付库
 * 就不分级），可分组详情页恰恰要拿这个档位给客户比“这几张哪张更清楚”。
 * 这里只看清晰度实测，不重复判瑕疵：瑕疵在库外已经被角标说清楚了。
 * 与主进程 classify.scoreTier 同公式同常数（常数就在本文件上方），不会漂移。
 */
export function estimateTier(tags: Record<string, { level?: string; reason?: string } | undefined> | null | undefined, tier: number | null): TierKey | null {
  if (tier === 1 || tier === 2 || tier === 3) return tier
  const m = (tags?.blur?.reason || '').match(/清晰度方差\s*(-?\d+(?:\.\d+)?)\((full|face)\)\s*高频占比\s*(-?\d+(?:\.\d+)?)/)
  if (!m) return TIER_SHARP_UNKNOWN
  const a = SHARP_ANCHORS[(m[2] as 'face' | 'full')] || SHARP_ANCHORS.face
  const clamp = (x: number): number => Math.min(1, Math.max(0, x))
  const v = Math.max(1, Number(m[1]))
  const lv = (Math.log10(v) - Math.log10(a.varLo)) / (Math.log10(a.varHi) - Math.log10(a.varLo))
  const lh = (Number(m[3]) - a.hfLo) / (a.hfHi - a.hfLo)
  const s = SHARP_VAR_WEIGHT * clamp(lv) + (1 - SHARP_VAR_WEIGHT) * clamp(lh)
  if (s >= TIER_SHARP_TRUST) return 1
  if (s >= TIER_SHARP_OK) return 2
  return 3
}

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
  /** 交付库档位（D4）：1 优质 / 2 良好 / 3 一般；不在交付库或未按新 tags 重算时为 null */
  tier: TierKey | null
  /** 'ai' = 打分自动预分（随标签重算）；'user' = 手动改档（重筛/重算不覆盖） */
  tierBy: 'ai' | 'user' | null
  /** 统一废弃库：被丢弃时所在的来源栏 key（library/review/duplicate/flaws/eyes_closed/custom:3 等）；仅 category 为 trash 时有意义，历史数据为 null */
  trashFrom?: string | null
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
  // 婚礼跟拍：不写 overrides。BASELINE_THRESHOLDS 本来就是拿 3185 张真实婚礼图标定的，
  // 再叠一层只会把卡好的台阶重新挪歪（旧值 blur/eyes high=0.85 就是把 0.83~0.85 那整块
  // 同等糊度的 331 张图从中间劈成两半的元凶）。想为婚礼再收紧时，在这里加显式覆盖即可。
  { key: 'wedding', label: '婚礼跟拍', overrides: {} },
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
  /**
   * D2（主分类=人数 / 瑕疵降为标签）一次性 recompute 版本门控：
   * 旧库把"最坏瑕疵"当主分类存的行，启动时按版本用 computeCategory 从已存 tags 重算一遍（不重跑引擎），
   * 让 App 在整库重筛前就自洽（category 恒为人数/用户状态）。规则升级时 +1。
   */
  d2Migration?: number
  /**
   * D4 档位（tier）列一次性 backfill 版本门控：给存量 status=done 行按已存 tags 补算 tier
   *（不重跑引擎）。规则升级时 +1。
   */
  tierMigration?: number
  /**
   * 阈值台阶基线一次性重算（regrade）版本门控，见 REGRADE_VERSION：存量行拿已存 confidence
   * 重算 level/category/tier（不重跑引擎）。基线表或平移算法升级时把 REGRADE_VERSION +1。
   */
  regradeVersion?: number
  /** 档位目录名（3 项，侧栏与导出子目录共用）；不设时用 DEFAULT_TIER_NAMES */
  tierNames?: string[]
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
  review: { label: '建议复核', tip: '闭眼、模糊、重复照片 —— 97-98%，黄色高亮待确认' },
  ref: { label: '仅作参考', tip: '狰狞、斜视、半截头 —— 90-95%，标注"建议人工复核"' }
}

export function dimTier(dim: DimensionKey): 'trust' | 'review' | 'ref' {
  if (['single_person', 'group_photo', 'no_person', 'black_white', 'exposure'].includes(dim)) return 'trust'
  if (['eyes_closed', 'blur', 'duplicate'].includes(dim)) return 'review'
  // mixed_photo 刻意留在 ref：合拍 / 混合的分界靠构图几何，是人数维度里最不稳的一环，
  // 说它「99%+ 可直接信任」是假承诺
  return 'ref'
}

/** 是否属于坏维度（瑕疵） */
export function isBadDim(dim: string): dim is DimensionKey {
  return (BAD_DIMENSIONS as string[]).includes(dim)
}

/** 是否属于结构维度（重复/连拍）：不是瑕疵，但拦交付 */
export function isStructuralDim(dim: string): dim is DimensionKey {
  return (STRUCTURAL_DIMENSIONS as string[]).includes(dim)
}

/** 这张图是否被判定为“组内冗余帧”（带着可见的重复/连拍标签）。
 *  单一真源：交付闸门、侧栏“重复多余”计数、角标三处都读它，避免口径漂移。 */
export function isDupRedundant(tags: Record<string, { level?: string } | undefined> | null | undefined): boolean {
  if (!tags) return false
  const t = tags.duplicate
  return !!t && t.level !== 'low'
}

/**
 * 重复/连拍组里“该留哪一张”的权重（用户 2026-10-13 口述，v2.0.67）：数字越小越该被留下来。
 *
 * 为什么必须换掉旧规则：旧代码取“组内 id 最小 = 最早导入”的那张当代表帧，完全不看拍得好不好，
 * 3185 张真实库实测有 69 组把“闭眼”或“半截头”的那张留在了交付库里（用户投诉的直接来源）。
 * 而“哪张算多余”是选片意图（实测四族信号全部重叠，判不了），但“组里该留哪张”是可以按他的权重算的。
 *
 * 权重层级照用户原话排：
 *   闭眼 / 半截头 —— 他明确说“永远不会入交付库”，一票否决级（中置信也扣，只是扣得轻）
 *   表情崩坏     —— 他列在“无表情不好”里，次一级
 *   模糊 / 曝光  —— 他说“其他瑕疵可以放在重复里继续选”，只做同级偏好，不一票否决
 *   档位 tier    —— 前三项打平时比引擎实测清晰度（1 优质最好）
 *   导入顺序     —— 全部打仍平时保持旧行为（id 小的赢），避免无谓改组
 * 十进制逐级放大，保证高优先级绝不会被低优先级堆输（下一项最多 2 分，×10 足够压制）。
 */
export function dupKeepWeight(tags: Record<string, { level?: string } | undefined> | null | undefined, tier: number | null = null): number {
  const hit = (d: DimensionKey): number => {
    const t = tags?.[d]
    if (!t || t.level === 'low') return 0
    return t.level === 'high' ? 2 : 0.8
  }
  const fatal = hit('eyes_closed') + hit('half_head')
  const face = hit('face_ugly')
  const soft = hit('blur') + hit('exposure')
  // 拿不到档位（尚未 backfill / 不在交付库）时按“良好”计，不奖不罚
  const tierPenalty = tier === 1 || tier === 2 || tier === 3 ? tier - 1 : 1
  return fatal * 100000 + face * 10000 + soft * 1000 + tierPenalty * 10
}
