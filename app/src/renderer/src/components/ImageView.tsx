/**
 * 多视图（9.2）：网格(格子最小 160px，列数自适应并把整行铺满) / 列表(80px) / 瀑布流(保留比例)
 * 缩略图带 AI 标签名（不显示置信度数字）；单击选中 / Shift 连选 / Ctrl 加选 / 双击放大预览
 * （以前还有第四种「大图」布局，与双击小图弹出的放大弹窗功能重叠，已下线：顶栏「大图」直接开那个弹窗）
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useStore, sortConf, filterByQuery, needsManualReview, aiReviewRank } from '../store'
import DuplicateGroupsView from './DuplicateGroupsView'
import { TrashView } from './TrashView'
import AiReviewBar from './AiReviewBar'
import { toSrc, ThumbImg } from './imageSrc'
import type { ImageRecord, DimensionKey } from '../../../shared/types'
import { ALL_TAG_DIMENSIONS, CAT_LIBRARY, CAT_REVIEW, CAT_FLAWS, CAT_TRASH, CAT_DUP_TRASH, DIMENSION_LABELS, QC_MANUAL_DIMENSIONS, isLibraryBucket, isDupRedundant, flawLevel, DEFAULT_TIER_NAMES, PERSON_DIMS } from '../../../shared/types'
import { dimTagColor } from './Sidebar'

/**
 * 网格 Ctrl+滚轮缩放的上下限（现在是「一格最小宽」，实际格子会再撑大一点铺满整行）。
 * 上限 610 是按窗口宽度反推的：主区实宽≈2040 CSS px
 * （2560 屏 − 侧栏 224 − 滚动条与内边距），auto-fill 下“一行三张”最多能放到 672 一格，
 * 610 留了余量（再往上就变成一行两张，没意义了）；以前卡在 360，最多只能放到一行五张。
 * 清晰度已与主进程同步提档：importer.ts 的 THUMB_MAX 已从 640 提到 960，3:2 横片短边
 * 640px，610 格子在 100% 系统缩放下约 1:1；125% 缩放还差约 1.2 倍（610×1.25≈763 物理
 * px），要再清只能继续提 THUMB_MAX（代价是磁盘，一万张 960 档约 270~310MB）。
 */
const GRID_MIN = 100
const GRID_MAX = 610
/** 网格间距，对应容器 className 的 gap-3（Tailwind 0.75rem = 12px）。改样式必须同步这里：
 *  GridView 靠它反推「一格真实宽度」，算错就会选错缩略图档，小屏笔记本上格子会发糊。 */
const GRID_GAP = 12

/**
 * hex 与白/黑混合：p>0 往白靠、p<0 往黑靠，返回 #rrggbb。
 * 在 JS 里算而不用 CSS color-mix：不依赖内核版本，且三档色（底/框/字）都从
 * dimTagColor 单一来源派生，改一处左图右栏颜色照旧同步。
 */
function tint(hex: string, p: number): string {
  const n = parseInt(hex.slice(1), 16)
  const q = Math.abs(p)
  const target = p > 0 ? 255 : 0
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * (1 - q) + target * q)
  return '#' + [16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')
}

/**
 * 图片上的单个维度标签（坏/中性通用）：
 * 基色与左侧分类树对应类型的小圆点同色（dimTagColor 单一来源）。
 * 样式是「彩色描边 + 同色浅底 + 同色加深文字」：以前是实底色+白字，跟右上角
 * 分类角标（绿/橙实底）、右下角标签按钮（橙实底）是同一种视觉语言，三种东西分不清；
 * 改成亮色描边款后一眼能认出“这是维度标签”。文字用基色掺黑加深、底色用基色掺白
 * 提到接近不透明（尾缀 F2 只留一点透明度让芯片“坐”在图上不飘），任意照片上都可读。
 * 只写维度名、不跟置信度数字：芯片本来就是按置信度从高到低排出来后取前 3 个的
 * （见 TagChips 的 sort），数字对筛选本身没有决策价值还占掉一格宽度。数值照旧留在
 * images.tags[].confidence 里——排序、阈值分级、列表视图的「最高置信度」列、以及主进程
 * 写进 corrections.orig_confidence 的校准样本都不读这里的 DOM，隐藏显示不影响任何判定。
 * 人物分类标签例外（用户拍板 2026-10-12）：实心蓝底白字、无描边——它回答的是
 * “这是什么图”，和瑕疵标签“这图哪里有问题”不是一类信息，视觉语言必须拉开。
 */
function DimTag(props: { dim: string; faded?: boolean }): JSX.Element {
  const c = dimTagColor(props.dim)
  // faded：这张已转人工定画质，除模糊/曝光以外的标签都是“AI 已定过”的，压淡一点让待定的两项跳出来（用户 10-14）
  const fade = props.faded ? ' opacity-50 saturate-[.6]' : ''
  if (isPersonDim(props.dim)) {
    return (
      <span
        className={'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[5px] text-[11px] leading-none font-medium text-white shadow-[0_1px_3px_rgba(0,0,0,0.65)]' + fade}
        style={{ background: c }}
        title={props.faded ? '该项已由云端复核确认；待人工裁定的是画面模糊、曝光异常' : undefined}
      >
        {DIMENSION_LABELS[props.dim as keyof typeof DIMENSION_LABELS]}
      </span>
    )
  }
  return (
    <span
      className={'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[5px] text-[11px] leading-none font-medium border shadow-[0_1px_3px_rgba(0,0,0,0.65)]' + fade}
      style={{ color: tint(c, -0.35), background: tint(c, 0.88) + 'F2', borderColor: tint(c, 0.2) }}
      title={props.faded ? '该项已由云端复核确认；待人工裁定的是画面模糊、曝光异常' : undefined}
    >
      {DIMENSION_LABELS[props.dim as keyof typeof DIMENSION_LABELS]}
    </span>
  )
}

/** 是否人物分类维度（单人/合影/混合/无人）：卡片左下角固定排第一的那类标签 */
function isPersonDim(dim: string): boolean {
  return (PERSON_DIMS as string[]).includes(dim)
}

/** 人物分类标签固定排第一，其余按置信度从高到低（卡片左下角与列表视图共用） */
function sortTagsPersonFirst<T extends [string, { confidence?: number } | undefined]>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const pa = isPersonDim(a[0]) ? 0 : 1
    const pb = isPersonDim(b[0]) ? 0 : 1
    if (pa !== pb) return pa - pb
    return (b[1]?.confidence || 0) - (a[1]?.confidence || 0)
  })
}

/**
 * 已转人工定画质的卡片用这个序：模糊/曝光顶到最前（它们正是“还没定完”的那两项，被折叠就看不到了），
 * 其次人物标签（旧规则：固定第一位），再其余按置信度（用户 10-14：“一眼没看到这两个标签等待人工复审”是不行的）。
 */
function sortManualQcFirst<T extends [string, { confidence?: number } | undefined]>(list: T[]): T[] {
  const rank = (d: string): number => ((QC_MANUAL_DIMENSIONS as string[]).includes(d) ? 0 : isPersonDim(d) ? 1 : 2)
  return [...list].sort((a, b) => rank(a[0]) - rank(b[0]) || (b[1]?.confidence || 0) - (a[1]?.confidence || 0))
}

/**
 * 导入/缩略图生成期间的点击拦截层（挂在 App 的 main 相对容器上，盖住整个中部内容区）：
 * 一次导入几千张时，主进程在批量解码生成缩略图，渲染层同时再加载大量原图/响应点击会明显卡顿。
 * 这层半透明遮罩自带 pointer-events，吸收照片点击/拖拽；「开始筛选」按钮在 TopBar 同步禁用。
 */
export function BusyOverlay(): JSX.Element | null {
  const imp = useStore((s) => s.importProgress)
  const th = useStore((s) => s.thumbsProgress)
  if (!imp && !th) return null
  const done = imp ? imp.done : (th as { done: number }).done
  const total = imp ? imp.total : (th as { total: number }).total
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-canvas/55 backdrop-blur-[2px] cursor-progress"
      title="导入与缩略图生成完成前请暂缓操作"
    >
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-panel/95 px-8 py-6 shadow-2xl">
        <span className="inline-block w-8 h-8 rounded-full border-[3px] border-brand border-t-transparent animate-spin" />
        <div className="text-base font-bold text-fg">
          {imp ? `正在导入照片 ${done} / ${total}` : `正在生成缩略图 ${done} / ${total}`}
        </div>
        <div className="w-56 h-2 rounded-full bg-panel2 overflow-hidden">
          <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${pct}%` }} />
        </div>
        <div className="text-xs text-fg3">AI 引擎正在准备图库，完成前请暂缓点击照片或开始筛选</div>
      </div>
    </div>
  )
}

/** 中部视图顶部的后台任务横幅：导入中 / 生成缩略图中（醒目大号品牌色胶囊） */
function BusyBanner(): JSX.Element | null {
  const imp = useStore((s) => s.importProgress)
  const th = useStore((s) => s.thumbsProgress)
  let label: string | null = null
  let pct: number | null = null
  if (imp) {
    label = `导入中 ${imp.done}/${imp.total}，正在登记文件…`
    pct = imp.total ? imp.done / imp.total : null
  } else if (th) {
    label = `正在生成缩略图 ${th.done}/${th.total}…`
    pct = th.total ? th.done / th.total : null
  }
  if (!label) return null
  return (
    <div className="sticky top-0 z-30 flex justify-center py-2 pointer-events-none">
      <div className="flex items-center gap-3 rounded-full bg-brand text-white shadow-2xl ring-2 ring-white/30 px-6 py-3 text-lg font-semibold">
        <span className="w-5 h-5 rounded-full border-[3px] border-white/40 border-t-white animate-spin inline-block shrink-0" />
        <span>{label}</span>
        {pct != null && <span className="tabular-nums text-white/90">{Math.round(pct * 100)}%</span>}
      </div>
    </div>
  )
}

/**
 * 卡片上的标签管理器入口（网格/列表/瀑布流共用）：不必进大图也能删标错的标签、
 * 补 AI 漏检的标签。永远只操作当前这一张图——多选状态不劫持它（用户拍板 2026-10-11：
 * 要从卡片点进来就该是单图独立管理）；批量增删只走底部工具栏的「批量标签管理」。
 * 默认隐藏，鼠标经过/停在图片上才浮现（hover 胶囊，无描边无图标，只留「标签」两字）。
 * 橙色实底：与左下角维度芯片（彩色描边浅底款）的视觉语言完全不同，拉开区分度。
 * stopPropagation 避免误触单击选中 / 双击放大 / 拖拽排序。
 */
function TagBtn({ img, variant = 'hover' }: { img: ImageRecord; variant?: 'hover' | 'plain' }): JSX.Element {
  const openTagManager = useStore((s) => s.openTagManager)
  return (
    <button
      className={
        // 行高不能写 leading-none：那等于把行盒压到 11px，比雅黑本身的内容高（~15px）还矮，
        // 半 leading 变负值，CJK 基线落点就不受 align-items:center 控制了（看上去偏上/偏下）。
        // 给回 1.4 倍行高让半 leading ≥ 0，文字才真正在 h-6 里几何居中。
        'inline-flex items-center justify-center rounded-md bg-orange-500 text-white font-medium leading-[1.4] cursor-pointer whitespace-nowrap ' +
        (variant === 'hover'
          ? 'absolute right-1 bottom-1 z-20 h-6 px-2 text-[11px] opacity-0 pointer-events-none transition-all duration-150 group-hover:opacity-100 group-hover:pointer-events-auto group-hover:hover:bg-orange-600 group-hover:active:scale-95'
          : 'h-6 px-2 text-[11px] hover:bg-orange-600 active:scale-95 transition-colors')
      }
      title="标签管理（仅当前这张图）：删除标错的标签 / 补上 AI 漏检的标签（添加后图同时出现在该分类第一张）；批量请走底部工具栏"
      draggable={false}
      onClick={(e) => {
        e.stopPropagation()
        openTagManager([img.id])
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      标签管理
    </button>
  )
}

/**
 * 卡片左上角的「人工复审」红底角标：这张已经 AI 复审并结案，但还卡着云端不看的模糊/曝光，只能人工定（用户 10-14）。
 * 待确认页写「人工复审」、瑕疵片页写「画质需人工复审」（用户 10-14 二次拍板，原先叫「画质待人工」）：同一个标记两种字——瑕疵片那张已经确定是坏片，
 * 要留意的只是画质两项；待确认那张还没定完，所以直接叫人。用贴角红底（语义令牌 bad，随主题换深浅）而不是又一枚方框 chip：
 * 层级靠形状与颜色，不再加边框块（UI 铁律 a387a39d）。用户 10-14 追加：不要前缀符号、要更大一号、字要居中。
 * 点它直接打开重判面板：这批图已结案、不在逐张复核队列里了，不把入口放在标记上用户就只能自己找“此判定错误”。
 */
function ManualFlag({ img }: { img: ImageRecord }): JSX.Element | null {
  const openReviewPanel = useStore((s) => s.openReviewPanel)
  if (!needsManualReview(img)) return null
  const flaws = flawLevel(img.tags || {}) === 'high'
  return (
    <span
      role="button"
      tabIndex={0}
      className="absolute left-0 top-0 z-20 flex cursor-pointer items-center justify-center rounded-br-[12px] bg-bad px-3.5 py-1.5 text-xs font-bold leading-none text-white shadow-[0_1px_4px_rgba(0,0,0,0.7)] hover:brightness-110"
      title={
        flaws
          ? '本张已完成云端复核；画面模糊、曝光异常不在复核范围内，请在此人工裁定画质'
          : '本张已完成云端复核；画面模糊、曝光异常不在复核范围内，云端结论不构成画质放行依据，请在此人工裁定'
      }
      onClick={(e) => {
        e.stopPropagation()
        openReviewPanel([img.id])
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return
        e.stopPropagation()
        openReviewPanel([img.id])
      }}
    >
      {flaws ? '画质需人工复审' : '人工复审'}
    </span>
  )
}

/**
 * 这张是否为“重复组代表帧停在待确认”：主分类在待确认 + 它属于某个重复组（dupGroup 有值）+ 它不是
 * 组里的冗余帧（没带可见 duplicate 标签，即它是那张代表帧）。成因：整组没一张能直接交，程序把最不坏的
 * 这张停到待确认等用户拍板“这几张重复的留哪张”（与 scanner.ts parkReview、db.matchesView 同口径）。
 */
function isDupRepParked(img: ImageRecord): boolean {
  return img.category === CAT_REVIEW && !!img.dupGroup && !isDupRedundant(img.tags)
}

/** 左上角是否已被一枚贴角红标占住（人工复审 或 重复组代表帧）：选中点/检测中需往下让一格，不叠在一起 */
function hasCornerFlag(img: ImageRecord): boolean {
  return needsManualReview(img) || isDupRepParked(img)
}

/**
 * 重复组代表帧停在待确认的左上角贴角红标（用户 10-16）：这张不是画质没过，而是“整组没一张能直接交、
 * 留它等你拍板重复照片里留哪张”。复用「人工复审」同款样式，但文字叫「重复照片待定」（用户 10-16 拍板）：
 * 它等的是“留哪张”不是“裁画质”，跟「人工复审」同名会让人以为复审了没清掉。纯显示、不可点。
 * 若这张同时要人工复审（画质没过），让位给 ManualFlag，不叠两枚（UI 铁律：同一位置只留一处）。
 */
function DupParkFlag({ img }: { img: ImageRecord }): JSX.Element | null {
  if (needsManualReview(img) || !isDupRepParked(img)) return null
  return (
    <span
      className="absolute left-0 top-0 z-20 flex items-center justify-center rounded-br-[12px] bg-bad px-3.5 py-1.5 text-xs font-bold leading-none text-white shadow-[0_1px_4px_rgba(0,0,0,0.7)]"
      title="这张停在待确认，是因为它所在的重复组里没有一张能直接交付，留它等你拍板‘这几张重复的留哪张’——不是画质没过关。"
    >
      重复照片待定
    </span>
  )
}

/**
 * 卡片左下角的维度标签条：按置信度取前 3 枚，剩下的折成「+N」。
 * 悬停 +N 只弹被折叠的剩余标签（用户拍板：不重复显示卡片上已有的前 3 枚）。
 * 弹层走 portal + fixed：卡片根节点是 overflow-hidden，弹在卡片内部会被剪掉；
 * pointer-events-none 让它不拦截穿过它去点卡片/拖卡片的行为。
 * 容器本身 pointer-events-none（点击要透到图上），只有 +N 这一枚要回来才能接住悬停。
 */
function TagChips({ img }: { img: ImageRecord }): JSX.Element | null {
  const entries = Object.entries(img.tags || {}).filter(([, t]) => t && t.level !== 'low')
  if (!entries.length) return null
  // 已转人工定画质的卡片：模糊/曝光顶最前且保持原色，AI 定过的几项压淡；其余卡片仍按人物标签第一
  const manual = needsManualReview(img)
  const sorted = manual ? sortManualQcFirst(entries) : sortTagsPersonFirst(entries)
  const fadedOf = (dim: string): boolean => manual && !(QC_MANUAL_DIMENSIONS as string[]).includes(dim)
  const hidden = sorted.length > 3 ? sorted.slice(3) : []
  const [morePos, setMorePos] = useState<{ left: number; bottom: number; maxW: number } | null>(null)
  return (
    <div className="absolute left-1 bottom-1 right-16 flex flex-wrap gap-1 pointer-events-none">
      {sorted.slice(0, 3).map(([dim]) => (
        <DimTag key={dim} dim={dim} faded={fadedOf(dim)} />
      ))}
      {hidden.length > 0 && (
        <span
          className="chip bg-panel2/90 text-gray-300 pointer-events-auto cursor-help"
          onMouseEnter={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            // 靠右边缘的卡片把弹层往左收（留 300 预估宽），但不碰穿左边距；最宽 288
            const left = Math.max(8, Math.min(r.left, window.innerWidth - 300))
            setMorePos({ left, bottom: window.innerHeight - r.top + 6, maxW: Math.min(288, window.innerWidth - left - 12) })
          }}
          onMouseLeave={() => setMorePos(null)}
        >
          +{hidden.length}
        </span>
      )}
      {morePos &&
        hidden.length > 0 &&
        createPortal(
          <div
            className="fixed z-[80] flex flex-wrap gap-1 rounded-lg border border-line bg-panel/95 px-2 py-1.5 shadow-xl pointer-events-none"
            style={{ left: morePos.left, bottom: morePos.bottom, maxWidth: morePos.maxW }}
          >
            {hidden.map(([dim]) => (
              <DimTag key={dim} dim={dim} faded={fadedOf(dim)} />
            ))}
          </div>,
          document.body
        )}
    </div>
  )
}

function StatusRibbon({ img }: { img: ImageRecord }): JSX.Element | null {
  // 档位名订阅（D4）：Hook 必须在早退分支之前无条件调用
  const tierNamesSetting = useStore((s) => s.settings.tierNames)
  if (img.status === 'pending') return <span className="chip bg-gray-600/80 text-gray-200 absolute right-1 top-1">待筛选</span>
  if (img.status === 'error') return <span className="chip bg-bad/90 text-white absolute right-1 top-1">检测失败</span>
  if (img.status === 'skip') return <span className="chip bg-gray-700/90 text-gray-300 absolute right-1 top-1">无法解码</span>
  if (img.category === CAT_TRASH || img.category === CAT_DUP_TRASH) return <span className="chip bg-black/70 text-white absolute right-1 top-1">🗑</span>
  // D2：交付状态由"主分类 + 瑕疵等级"派生的三档互斥角标（与侧栏上段、导出口径同一真源）：
  // 主分类停在待确认 ∪ 中置信瑕疵 → 待确认；高置信瑕疵 → 瑕疵片；无瑕疵 → 交付
  const fl = flawLevel(img.tags)
  // 停在待确认的先报“待确认”：重复组“整组没一张能交”的代表帧带着高置信瑕疵也被停在这里拍板，
  // 按旧顺序它会先被 fl==='high' 兜成“瑕疵”，与它在侧栏/视图里的实际归属不一致
  if (img.category === CAT_REVIEW || fl === 'mid')
    return <span className="chip bg-warn text-white absolute right-1 top-1">待确认</span>
  if (fl === 'high')
    return <span className="chip bg-bad/90 text-white absolute right-1 top-1" title="判出缺陷的图：不进交付库、默认不导出">瑕疵</span>
  // 重复照片（v2.0.67，旧名“重复多余”）：本身没拍坏，只是同组已经挑了一张更好的进库。它不是瑕疵，必须单独一枚角标，
  // 否则这张图在网格上看起来与交付库里的图一模一样（用户分不清哪张会被导出去）。
  if (isDupRedundant(img.tags))
    return (
      <span className="chip bg-indigo-500/90 text-white absolute right-1 top-1" title="同一瞬间已经有更好的那张进了交付库，这张默认不导出；想多留这张，去【重复照片】那一组里点保留">
        重复照片
      </span>
    )
  // 交付角标走虚桶判定（传入 tags）：干净的人数图属交付库且正常导出；
  // D4：文案改用档位名（优质=绿、良好=蓝、一般=灰），无档位（尚未 backfill）时仍写“交付”
  if (isLibraryBucket(img.category, img.tags)) {
    const names = tierNamesSetting ?? DEFAULT_TIER_NAMES
    const tier = img.tier
    const text = tier ? names[tier - 1] || String(tier) : '交付'
    const cls = tier === 2 ? 'bg-blue-600/90' : tier === 3 ? 'bg-gray-500/90' : 'bg-good'
    // 档位来源要说给客户听（用户反馈：手动改过档在界面上完全看不出来）：
    // v3 档位走引擎实测清晰度，人工改过的行主进程用 tier_by='user' 永久保护，这里把两者区分开。
    const tierSrc =
      img.tierBy === 'user'
        ? '· 档位你手动定过，重筛不会改'
        : img.tags.blur
          ? '· 档位按引擎实测清晰度分的'
          : '· 这张没留清晰度记录，暂归中间档'
    return (
      <span
        className={'chip text-white absolute right-1 top-1 shadow-[0_1px_3px_rgba(0,0,0,0.65)] ' + cls}
        title={
          img.category === CAT_LIBRARY
            ? `交付库 · ${text}（默认参与导出）${tierSrc}`
            : `交付库 · ${text}（默认参与导出），当前相册：${categoryLabelShort(img.category)} ${tierSrc}`
        }
      >
        {text}
      </span>
    )
  }
  return null
}

/**
 * 拖拽预览：把“拖中的这批图”叠成一摞（每张重叠约 90%，错开 10%）+ 右下角计数角标，
 * 交给 dataTransfer.setDragImage 当拖影。浏览器默认只会把被拖的那一张原样缩小当影，
 * 多选时完全看不出“拖中的是一整批 N 张”（用户反馈 2026-10-11）。
 * 坑：元素必须先挂到 body 里、且不能 display:none（否则 Chromium 不渲染拖影）；这里用
 * top:-1000px 放到屏外，setDragImage 在 dragstart 同步取图后由调用方 setTimeout 移除。
 */
function makeStackDragImage(ids: number[]): HTMLElement {
  const images = useStore.getState().images
  const byId = new Map(images.map((im) => [im.id, im] as const))
  const total = ids.length
  const shown = ids.slice(0, 4) // 最多 4 张卡面，再多也只叠这几层，靠角标说总数
  const CARD = 92
  const step = Math.round(CARD * 0.1) // 重叠 90% → 每张只错开 10%
  const stackW = CARD + step * (shown.length - 1)
  const h = CARD + step * (shown.length - 1)
  // 计数角标改放整摞照片的正下方（用户拍板 2026-10-11）：横向不再占空间，
  // 光标左侧“箭头要去分类栏的方向”彻底没有东西挡；右侧只铺重叠卡，天然在箭头后方。
  const badgeH = total > 1 ? 26 : 0
  const w = stackW
  const wrap = document.createElement('div')
  wrap.style.cssText = `position:fixed;top:-1000px;left:-1000px;width:${w}px;height:${h + badgeH}px;z-index:99999;pointer-events:none;`
  // 拖影把手点定在最上层那张（前沿卡）中心：光标像“捻住领头的一张”，
  // 整摞卡片朝右后方拖、角标垂在下面，往左侧分类拖时前进方向完全清爽
  wrap.dataset.hotX = String(Math.round(CARD / 2))
  wrap.dataset.hotY = String(Math.round(h / 2))
  // 从后往前放，让 ids 的第一张落在最上层
  for (let i = shown.length - 1; i >= 0; i--) {
    const rec = byId.get(shown[i])
    const card = document.createElement('div')
    card.style.cssText =
      `position:absolute;left:${i * step}px;top:${i * step}px;width:${CARD}px;height:${CARD}px;` +
      'border-radius:8px;overflow:hidden;border:2px solid rgba(255,255,255,0.9);' +
      'box-shadow:0 4px 14px rgba(0,0,0,0.45);background:rgb(31,41,55);'
    if (rec) {
      const im = document.createElement('img')
      im.src = rec.thumb ? toSrc(rec.thumb) : toSrc(rec.path)
      im.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;'
      card.appendChild(im)
    }
    wrap.appendChild(card)
  }
  if (total > 1) {
    const badge = document.createElement('div')
    badge.textContent = `${total} 张`
    // 贴在整摞下方、领头的左前卡正下：视觉上属于“这摞照片”，且不侵扰水平方向
    badge.style.cssText =
      'position:absolute;left:0;bottom:0;padding:2px 8px;border-radius:9999px;white-space:nowrap;' +
      'background:rgb(59,130,246);color:#fff;font-size:12px;font-weight:600;line-height:1.5;' +
      'box-shadow:0 2px 6px rgba(0,0,0,0.4);'
    wrap.appendChild(badge)
  }
  document.body.appendChild(wrap)
  return wrap
}

function ThumbBase({ img, cellPx, index, onClick, onDoubleClick, dragIds }: {
  img: ImageRecord
  /** 一格的实际 CSS 宽（不是滑块值，见 GridView 里对 cellPx 的解释），只用来决定取哪档缩略图 */
  cellPx: number
  index: number
  onClick: (index: number, e: React.MouseEvent) => void
  onDoubleClick: (img: ImageRecord) => void
  dragIds: number[]
}): JSX.Element {
  const selected = useStore((s) => s.selection.has(img.id))
  const scanCurrent = useStore((s) => (s.scanProgress?.running && s.scanProgress.phase === 'scanning' ? s.scanProgress.current : ''))
  const isScanning = !!scanCurrent && img.filename === scanCurrent
  return (
    <div
      data-img-id={img.id}
      className={
        'relative rounded-md overflow-hidden bg-panel2 border transition-all duration-150 cursor-pointer group ' +
        (isScanning
          ? 'border-red-500 ring-[3px] ring-red-500 scale-105 z-20 '
          : selected
            ? 'border-brand ring-2 ring-brand shadow-[0_0_0_2px_rgba(59,130,246,0.45)]'
            : 'border-line hover:border-gray-500')
      }
      style={{ width: '100%', aspectRatio: '1 / 1' }}
      draggable
      // 自由排序已取消（用户拍板 2026-10-11）：这里只保留 HTML5 拖拽的 dataTransfer，
      // 供“拖到左侧分类移动”使用（与瀑布流 MasonryThumb 同一套），不再回调实时换位
      onDragStart={(e) => {
        const ids = selected ? dragIds : [img.id]
        if (!selected) onClick(index, e)
        e.dataTransfer.setData('application/x-image-ids', JSON.stringify(ids))
        e.dataTransfer.effectAllowed = 'move'
        // 自定义拖影：把这批（多张时）叠成一摞，拖拽途中一眼看清“拖中了 N 张”
        const preview = makeStackDragImage(ids)
        const hotX = Number(preview.dataset.hotX) || Math.ceil(preview.offsetWidth / 2)
        const hotY = Number(preview.dataset.hotY) || Math.ceil(preview.offsetHeight / 2)
        e.dataTransfer.setDragImage(preview, hotX, hotY)
        setTimeout(() => preview.remove(), 0)
      }}
      onClick={(e) => onClick(index, e)}
      onDoubleClick={() => onDoubleClick(img)}
      // 悬停只给文件名：以前这里会把每个标签的置信度 + 等级（“半截头 91%(<high>)”）全列一遍，
      // 那是给调阈值的人看的判定详情，客户和摄影师看着只会懵；卡片下方的彩色芯片只留维度名。
      // 判定理由与置信度依旧完整存在库里的 tags JSON 里（三个标签入口也都不再渲染它），只是不往悬停提示上铺。
      title={img.filename}
    >
      <ThumbImg img={img} cellPx={cellPx} className="w-full h-full object-cover pointer-events-none" />
      <ManualFlag img={img} />
      <DupParkFlag img={img} />
      {/* 左上角已被「人工复审」红底占住时，选中圆点/检测中往下让一格，不叠在一起（两者都是左对齐）*/}
      {selected && (
        <span className={'absolute left-1 z-20 w-4 h-4 rounded-full bg-brand text-white text-[10px] flex items-center justify-center ' + (hasCornerFlag(img) ? 'top-[26px]' : 'top-1')}>✓</span>
      )}
      {isScanning && (
        <span className={'absolute left-1 z-10 px-1.5 py-0.5 rounded bg-red-500 text-white text-[10px] font-bold animate-pulse shadow ' + (hasCornerFlag(img) ? 'top-[26px]' : 'top-1')}>检测中</span>
      )}
      <StatusRibbon img={img} />
      <TagChips img={img} />
      <TagBtn img={img} />
    </div>
  )
}
// memo：框选时 GridView 会随选框一帧一帧重渲染，未 memo 的 Thumb 会跟着 3000 个一起重建。
// memo 后，只要 props 没变（纯移框、选中集未变）缩略图整体跳过；选中态由 Thumb 内部
// useStore 订阅驱动，单张变色只重渲染那一张。
const Thumb = memo(ThumbBase)

/**
 * 网格视图：渲染缩略图 + 两种拖拽手势并存、互不冲突（用户拍板 2026-10-11）：
 * - 从「空白背景」按下拖动 → 橡皮筋框选（本次新增）：拖出矩形，实时把压到的图选中，松手即为最终选中集；
 *   框选=全新选中（Ctrl 叠加）。因为从空白处起手，和下面“从图上起手”的手势天然区分开。
 * - 从「缩略图上」按下拖动 → HTML5 拖拽（Thumb 的 draggable + dataTransfer），拖到左侧分类移动，
 *   由 Sidebar 接 drop。多选时拖其中一张带的是全部选中项（批量）。
 * 自由排序拖拽（拖哪插哪、实时让位、松手落库）已整体取消，顺序完全交给 store 的 sortKey。
 *
 * 性能坑：本列表未虚拟化，3000 张缩略图全在 DOM 里。若每次 mousemove 都对全体节点
 * getBoundingClientRect 并写 store，会让 3000 个订阅 selection 的 Thumb 反复重渲染而卡顿。
 * 所以：按下时一次性快照所有节点矩形（框选期间不自动滚动，矩形稳定），移动中只做数字比较，
 * 且用 RAF 节流 + 结果集去重，只有选中的 id 集合真的变了才写一次库。
 */
function GridView(props: {
  images: ImageRecord[]
  size: number
  click: (index: number, e: React.MouseEvent) => void
  dbl: (img: ImageRecord) => void
  dragIds: number[]
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const marqueeSelect = useStore((s) => s.marqueeSelect)
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  // 框选期间用的不可变快照：节点矩形 + 上次算出的选中集（去重用）
  const hitRects = useRef<{ id: number; l: number; t: number; r: number; b: number }[]>([])
  const lastKey = useRef<string>('')
  const startPt = useRef<{ x: number; y: number } | null>(null)
  const moved = useRef(false)
  const additive = useRef(false)
  const raf = useRef<number | null>(null)
  const cur = useRef<{ x: number; y: number }>({ x: 0, y: 0 })

  /**
   * 一格的实际宽度：容器宽 − 间距，再除以当行列数（与 CSS auto-fill 同一套算法）。
   * 为什么不能直接把滑块的 size 交给 ThumbImg 判档：minmax(size,1fr) 会把每行剩下的
   * 零头摊给当行各列，实际格子比 size 大 0~22%。拿 size 判就低估了需求，格子物理边长
   * 超过小档短边时图片被放大显示——小屏笔记本 + 150%/200% 系统缩放下网格发糊的成因之一
   * （另一半成因是小档按长边定尺寸，见 shared/types.ts 双档注释）。
   * 用公式算而不量 DOM：读写交替会触发重排，而这里每次窗口变化都要算。
   */
  const [cellPx, setCellPx] = useState(props.size)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = (): void => {
      const w = el.clientWidth
      if (w <= 0) return // 隐藏状态下量到 0，算出的列数是负数，不如保持上一次的值
      const cols = Math.max(1, Math.floor((w + GRID_GAP) / (props.size + GRID_GAP)))
      setCellPx((w - GRID_GAP * (cols - 1)) / cols)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [props.size])

  const computeSelection = (x0: number, y0: number, x1: number, y1: number): void => {
    const minX = Math.min(x0, x1)
    const maxX = Math.max(x0, x1)
    const minY = Math.min(y0, y1)
    const maxY = Math.max(y0, y1)
    const ids: number[] = []
    for (const h of hitRects.current) {
      // 矩形相交（含擦边）即算框到
      if (h.r >= minX && h.l <= maxX && h.b >= minY && h.t <= maxY) ids.push(h.id)
    }
    // 去重：同一批选中不重复写库，避免无谓的全量重渲染
    const key = ids.join(',')
    if (key === lastKey.current) return
    lastKey.current = key
    marqueeSelect(ids, additive.current)
  }

  const onMouseDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    // 从缩略图（或其内部子元素）按下：交给浏览器原生拖拽 / 单击选中，不进入框选
    if ((e.target as HTMLElement).closest('[data-img-id]')) return
    const el = containerRef.current
    if (!el) return
    e.preventDefault() // 阻止拖动空白处选中文字
    startPt.current = { x: e.clientX, y: e.clientY }
    cur.current = { x: e.clientX, y: e.clientY }
    moved.current = false
    additive.current = e.ctrlKey || e.metaKey
    // 一次性快照所有缩略图的视口矩形（框选期间不滚动，坐标稳定）
    hitRects.current = Array.from(el.querySelectorAll<HTMLElement>('[data-img-id]')).map((n) => {
      const r = n.getBoundingClientRect()
      return { id: Number(n.dataset.imgId), l: r.left, t: r.top, r: r.right, b: r.bottom }
    })
    lastKey.current = additive.current ? '' : '__reset__'
    setBox({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY })

    const onMove = (ev: MouseEvent): void => {
      const s0 = startPt.current
      if (!s0) return
      if (!moved.current && Math.hypot(ev.clientX - s0.x, ev.clientY - s0.y) < 4) return
      moved.current = true
      cur.current = { x: ev.clientX, y: ev.clientY }
      if (raf.current != null) return // 本帧已排程：合并，避免一帧多次 setBox 触发全量重渲染
      // RAF 节流：一帧最多重绘一次选框 + 算一次命中 + 写一次库
      raf.current = requestAnimationFrame(() => {
        raf.current = null
        const s = startPt.current
        if (!s) return
        const c = cur.current
        const nb = { x0: s.x, y0: s.y, x1: c.x, y1: c.y }
        setBox(nb)
        computeSelection(nb.x0, nb.y0, nb.x1, nb.y1)
      })
    }
    const onUp = (ev: MouseEvent): void => {
      if (raf.current != null) cancelAnimationFrame(raf.current)
      raf.current = null
      const s0 = startPt.current
      if (s0 && moved.current) {
        computeSelection(s0.x, s0.y, ev.clientX, ev.clientY)
      } else if (!additive.current) {
        // 空白处轻点（没拖出框）= 取消选中（标准文件管理器语义）
        marqueeSelect([], false)
      }
      startPt.current = null
      setBox(null)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      ref={containerRef}
      className="grid gap-3"
      /* minmax(size, 1fr)：size 是「一格最小宽」而不是固定宽——先按能塞下几列，
         再把行剩下的零头均摊给这几列，所以每行必定正好铺满整宽，不会再出现
         “每行张数不同 → 左右留白一会在这一会在那”。以前列宽钉死 + justify-center
         就是把那块零头居中，才看着边距忽宽忽窄。
         必须用 auto-fill 而不是 auto-fit：auto-fit 会折叠空列，库里只剩三张图时
         会被拉成三块大饼。 */
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${props.size}px, 1fr))` }}
      onMouseDown={onMouseDown}
    >
      {props.images.map((img, i) => (
        <Thumb
          key={img.id}
          img={img}
          index={i}
          cellPx={cellPx}
          onClick={props.click}
          onDoubleClick={props.dbl}
          dragIds={props.dragIds}
        />
      ))}
      {/* 橡皮筋选框：fixed 定位直接用视口坐标，省掉跟随滚动换算；pointer-events-none 不挡后续命中 */}
      {box && (
        <div
          className="fixed z-50 pointer-events-none rounded-[3px] border border-brand bg-brand/15"
          style={{
            left: Math.min(box.x0, box.x1),
            top: Math.min(box.y0, box.y1),
            width: Math.abs(box.x1 - box.x0),
            height: Math.abs(box.y1 - box.y0),
          }}
        />
      )}
    </div>
  )
}

/**
 * 网格/列表/瀑布流的“视口锚定”：列表内容变了（移走图、重排）之后，把视口拉回原来正在看的那一张。
 *
 * 为什么要自己做：删标签 / 移动 / 判定错误都会 refreshImages() 整包重拉，store 换掉整个 images 数组，
 * React 按 key 卸掉一批卡片节点。浏览器的原生滚动锚定只在“上方少量 DOM 变化”时兜得住，
 * 几百个节点同时换位置就直接失效，于是用户在第 1444 张的位置被弹回顶部——批量复查时最打断节奏。
 *
 * 做法：稳态时（没有列表变化在处理的瞬间）持续记下“正压在视口上沿的是哪一张、它距容器顶多少像素”，
 * 一旦列表的成员集合真的变了（有图进出），提交后按 id 找回那一张把偏移还原回去；
 * 锚点那张被移走了，就用顶上来的相邻那张占住视口上沿，而不是回顶。
 *
 * 两个容易踩的点：
 * - 光在“成员变化那次提交”里读 DOM 是读不到旧布局的（layout effect 跑在 DOM 变更之后），所以锚点
 *   必须靠 scroll 监听 + 每次稳态提交来保鲜；否则用户滚到新位置再操作，会被弹回历史位置，更莫名。
 * - 只有顺序变、成员没变（手动拖拽重排、换排序键）时不复位：那时候用户在挑哪张拖哪张，
 *   强行把他锚回原图片等于跟他的操作打架。
 *
 * resetKey（当前相册）变化时不锚定：切相册本来就该从头看，拿上个相册的视口位置过来只会让人莫名。
 */
function useScrollAnchor(items: ImageRecord[], scrollerRef: RefObject<HTMLDivElement | null>, resetKey: string): void {
  const anchor = useRef<{ id: number; offset: number; index: number } | null>(null)
  const idSetRef = useRef('')
  const idOrdRef = useRef('') // 展示序签名（含顺序）：成员没进出、只是顺序变时靠它识别
  const pending = useRef(false)
  const keyRef = useRef(resetKey)
  const capElRef = useRef<Element | null>(null)
  const capAtRef = useRef(0)
  const boundElRef = useRef<Element | null>(null)

  // 记一次当前视口锚点。force=true 跳过防抖（每次提交后必须拿到准确锚点）；
  // 同时也是“只建档、不复位”的意思：首次进入 / 换容器 / 换相册时不该把视口弹到任何历史位置。
  const capture = (force: boolean): void => {
    const el = scrollerRef.current
    if (!el) return
    const now = Date.now()
    if (!force && now - capAtRef.current < 100) return
    // 容器被换掉了（切到重复叠卡视图等分支会卸载重挂）：当作重新进入，不算“有图进出”
    if (capElRef.current !== el) {
      capElRef.current = el
      idSetRef.current = ''
      idOrdRef.current = ''
      pending.current = false
    }
    capAtRef.current = now
    const ids = items.map((i) => i.id)
    const idOrd = String(ids.length) + ':' + ids.join(',')
    const idSet = String(ids.length) + ':' + [...ids].sort((a, b) => a - b).join(',')
    if (idOrd === idOrdRef.current) {
      idSetRef.current = idSet
      if (pending.current) return // 刚拍完马上又要复位，说明中间那次没抓到，别用此刻的位置去复位
    } else if (idSet === idSetRef.current && anchor.current) {
      // 成员没进出、只是顺序变了——典型：在多人合照里把中间某张拖进【闭眼】（坏维度与人数
      // 维度不互斥，图还留在本相册），但移动刷新了 catChangedAt，按时间排序它飞到第 1 位，
      // 几千张整体挪位把视口甩回顶部（用户实测 2026-10-11）。必须保留滚动期间建档的旧锚点
      // 去复位，不能用跳完的视口覆盖它。旧代码故意"顺序变不复位"，那是给手动拖拽排序让路，
      // 排序功能已删除，这条豁免只剩副作用。
      idOrdRef.current = idOrd
      pending.current = true
      return
    } else {
      if (idSetRef.current === '') force = true // 首次进入：只建档，不复位
      pending.current = force || idSetRef.current !== ''
      idSetRef.current = idSet
      idOrdRef.current = idOrd
    }
    const top = el.getBoundingClientRect().top
    if (top < -2 || top > window.innerHeight) return // 容器根本不在屏上（切了分支视图），不测锚点
    const cands = Array.from(el.querySelectorAll<HTMLElement>('[data-img-id]')).map((n) => ({
      id: Number(n.dataset.imgId),
      offset: n.getBoundingClientRect().top - top
    }))
    // 取“已滚过容器顶”的最后那一张（瀑布流按列排版，DOM 顺序不等于视觉顺序，
    // 不能拿第一个命中的就算），它才是视觉上压在视口上沿的那张
    const best = cands.reduce<{ id: number; offset: number } | null>(
      (acc, c) => (Number.isFinite(c.id) && c.offset <= 0 && (!acc || c.offset > acc.offset) ? { id: c.id, offset: c.offset } : acc),
      null
    )
    if (!best) {
      // 一张都没滚过容器顶（就在列表开头）：没什么需要“锚回去”的，把旧锚点清掉，
      // 免得用户先在中部操作、又滚回顶部，下一次列表变化时被拉回中部
      anchor.current = null
      return
    }
    const index = ids.indexOf(best.id)
    anchor.current = { id: best.id, offset: best.offset, index: index < 0 ? 0 : index }
  }

  // 用户滚动时同步刷新锚点。不接住这一路，锚点只会停在“上一次列表变化”的瞬间：
  // 中间用户自己滚了三千像素，操作完就被弹回他早就离开的地方。
  // callback ref 卸载时会先把 scrollRef 置 null，那一拍什么都不做（不能拿 null 去判“容器换了”）。
  useEffect(() => {
    const el = scrollerRef.current
    if (!el || el === boundElRef.current) return
    boundElRef.current = el
    const onScroll = (): void => capture(false)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (boundElRef.current === el) boundElRef.current = null
    }
  })

  // 每次提交后：列表成员进出就把视口拉回锚点，否则把锚点刷新成此刻的视口位置
  useLayoutEffect(() => {
    if (keyRef.current !== resetKey) {
      // 换相册：不锚定，也不在这里建档——此刻 DOM 里还是上个相册的图（store 先改 activeCategory、
      // 列表还在 await 里），拿旧图的锚点会把新相册滚到一个莫名其妙的位置。留给下一次提交建档。
      keyRef.current = resetKey
      anchor.current = null
      idSetRef.current = ''
      idOrdRef.current = ''
      pending.current = false
      capElRef.current = null
      return
    }
    const el = scrollerRef.current
    if (!el || !pending.current || !anchor.current) {
      capture(true)
      // 顺序变化正是 capture 这一拍才发现的：同一拍就复位，别等下一次渲染——
      // 否则跳顶的画面会先画出一帧，用户看到的就是"闪一下跳到第一张"
      if (!el || !pending.current || !anchor.current) return
    }
    const a = anchor.current
    pending.current = false
    const idx = items.findIndex((i) => i.id === a.id)
    // 锚点还在原位就还原它；已被移出本分类，就让顶上来的相邻那张正好贴住视口上沿
    const target = idx >= 0 ? items[idx] : items[Math.min(items.length - 1, Math.max(0, a.index))]
    const node = target ? el.querySelector<HTMLElement>(`[data-img-id="${target.id}"]`) : null
    if (node) {
      const top = el.getBoundingClientRect().top
      el.scrollTop += node.getBoundingClientRect().top - top - (idx >= 0 ? a.offset : 0)
    }
    capture(true)
  })
}

export default function ImageView(): JSX.Element {
  const images = useStore((s) => s.images)
  const activeCategory = useStore((s) => s.activeCategory)
  const viewMode = useStore((s) => s.viewMode)
  const sortKey = useStore((s) => s.sortKey)
  const query = useStore((s) => s.query)
  const setQuery = useStore((s) => s.setQuery)
  const handleClickSelect = useStore((s) => s.handleClickSelect)
  const openPreview = useStore((s) => s.openPreview)
  const selection = useStore((s) => s.selection)
  const scanProgress = useStore((s) => s.scanProgress)

  const sorted = useMemo(() => {
    // 先按文件名搜索过滤再排序：displayIds 是下面从 sorted 同步的，
    // 所以点击选中、Shift 连选、大图左右翻页会自动只在命中集里走，不需要另改
    const arr = [...filterByQuery(images, query)]
    // 当前浏览分类视角下的“入场时间”：该分类的标签戳 > 主分类变更戳 > 导入戳
    const viewTime = (img: ImageRecord): number =>
      (activeCategory ? img.tags?.[activeCategory as DimensionKey]?.taggedAt : undefined) ?? img.catChangedAt ?? img.addedAt
    switch (sortKey) {
      case 'name':
        arr.sort((a, b) => a.filename.localeCompare(b.filename, 'zh-CN'))
        break
      case 'name-desc':
        arr.sort((a, b) => b.filename.localeCompare(a.filename, 'zh-CN'))
        break
      case 'conf-asc':
        arr.sort((a, b) => sortConf(a) - sortConf(b))
        break
      case 'conf-desc':
        arr.sort((a, b) => sortConf(b) - sortConf(a))
        break
      case 'time':
        // “最新在前”：维度分类里优先看“这张图是被标成该维度的时刻”（tags[当前分类].taggedAt），
        // 没这个戳（AI 标的/旧数据/状态分类浏览）才退回进入主分类的时间（导入/AI 归入/手动移动都会刷）。
        // 为什么要挂在标签上：一张图同时属于好几个分类，共享的 catChangedAt 一动就是
        // 所有分类一起跳顶——在单人照里加“闭眼”，只该在闭眼里排第一，单人照里位置不动。
        arr.sort((a, b) => viewTime(b) - viewTime(a))
        break
      default:
        // 待确认 / 瑕疵片的默认顺序先按“还没定完的”分层（用户 10-14）：
        // 人工复审的排最前，其次是被你不采纳、等下一轮 AI 重判的，再其余；层内保持库里顺序
        if (activeCategory === CAT_REVIEW || activeCategory === CAT_FLAWS) {
          arr.sort((a, b) => aiReviewRank(a) - aiReviewRank(b))
        }
        break
    }
    return arr
  }, [images, sortKey, query, activeCategory])

  // 把展示序（排序后的 id 序列）同步给 store：点击/Shift 连选按它映射回真实图片
  const setDisplayIds = useStore((s) => s.setDisplayIds)
  useEffect(() => {
    setDisplayIds(sorted.map((i) => i.id))
  }, [sorted, setDisplayIds])

  // 三种布局共用一个滚动容器 ref（每次只渲染其中一种，挂上当前那个就行）
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useScrollAnchor(sorted, scrollRef, activeCategory ?? 'all')

  const dragIds = useMemo(() => [...selection], [selection])
  const click = (index: number, e: React.MouseEvent): void => handleClickSelect(index, e)
  const dbl = (img: ImageRecord): void => openPreview(img.id)

  // Ctrl + 滚轮缩放网格缩略图尺寸（GRID_MIN–GRID_MAX），列数仍 auto-fill 自适应；记住上次缩放。
  // 上下限的推导（窗口宽度、缩略图短边与糊不糊的关系）见文件开头 GRID_MIN / GRID_MAX 的注释。
  // 监听器用 callback ref 绑定：网格容器会在切到重复叠卡视图/空库引导等分支时卸载重挂，
  // 若只在 useEffect([viewMode]) 里绑一次，重挂后节点是新的而 effect 不重跑，
  // 导致“Ctrl+滚轮大多时候没反应、偶尔又可以”。callback ref 每次挂载/卸载自动重绑/清理。
  const [gridSize, setGridSize] = useState<number>(() => {
    const v = Number(localStorage.getItem('gridSize'))
    return Number.isFinite(v) && v >= GRID_MIN && v <= GRID_MAX ? v : 160
  })
  const wheelCleanup = useRef<(() => void) | null>(null)
  const bindGridWheel = useCallback((el: HTMLDivElement | null): void => {
    wheelCleanup.current?.()
    wheelCleanup.current = null
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setGridSize((prev) => {
        const next = Math.min(GRID_MAX, Math.max(GRID_MIN, prev + (e.deltaY < 0 ? 20 : -20)))
        localStorage.setItem('gridSize', String(next))
        return next
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    wheelCleanup.current = () => el.removeEventListener('wheel', onWheel)
  }, [])

  // 重复/连拍与废弃桶：走专用叠卡分组视图（放在所有 hooks 之后，不违反 Hook 规则）
  // 搜不到不能走下面那套“拖入照片”空库引导页（那是给真·空库的），否则看起来像图丢了；
  // 这个判断必须在叠卡分组之前，否则在重复页搜不到只剩空白，连“清除搜索”的入口都没
  if (!sorted.length && query.trim()) {
    return (
      <div className="h-full overflow-auto flex flex-col items-center justify-center gap-2 text-fg2 p-6">
        <div className="text-4xl">🔍</div>
        <div className="text-sm">
          没有匹配「{query.trim()}」的图片，本相册共 {images.length} 张
        </div>
        <div className="text-xs text-fg3">搜索只在当前相册里按文件名匹配（切相册会自动清空），多个名字用空格或逗号分开</div>
        <button className="btn text-xs mt-1" onClick={() => setQuery('')}>
          清除搜索
        </button>
      </div>
    )
  }

  if (activeCategory === 'duplicate') {
    return <DuplicateGroupsView images={sorted} mode="keep" />
  }

  // 统一废弃库：按来源栏分列 + 逐张还原/选档入档（旧「重复照片-废弃」已并入此处）
  if (activeCategory === CAT_TRASH) {
    return <TrashView images={sorted} />
  }

  if (!sorted.length) {
    return (
      <div className="h-full overflow-auto flex flex-col items-center justify-center text-fg2 p-6">
        <BusyBanner />
        <div className="w-full max-w-2xl rounded-xl border border-line bg-panel2/50 p-6 fade-in">
          <div className="flex flex-col items-center text-center gap-1">
            <div className="text-5xl">📷</div>
            <div className="text-lg text-fg">拖入照片文件夹，或点击左上角「导入文件夹」</div>
            <div className="text-xs text-fg3">全程本地处理 · 无网络请求</div>
          </div>

          {/* 检测维度：直接复用 ALL_TAG_DIMENSIONS + DIMENSION_LABELS，不写死 */}
          <div className="mt-5">
            <div className="text-xs font-medium text-fg3 mb-2">AI 检测维度（有问题的图会被拦在交付库外面）</div>
            <div className="flex flex-wrap gap-1.5">
              {ALL_TAG_DIMENSIONS.map((d) => (
                <span key={d} className="px-2 py-0.5 rounded-full text-xs bg-bad/10 text-bad border border-bad/20">
                  {DIMENSION_LABELS[d]}
                </span>
              ))}
            </div>
          </div>

          {/* 格式三档：与「导入照片」下拉菜单保持一致 */}
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-line bg-panel p-3">
              <div className="text-xs font-medium text-good mb-1">✓ 推荐（检测最稳）</div>
              <div className="text-xs text-fg2 leading-relaxed">JPG · JPEG · PNG · TIFF · BMP · WebP</div>
              <div className="text-[11px] text-fg3 mt-1 leading-relaxed">直接解码 + EXIF 自动转正，全维度稳定</div>
            </div>
            <div className="rounded-lg border border-line bg-panel p-3">
              <div className="text-xs font-medium text-brand mb-1">✓ 完整支持</div>
              <div className="text-xs text-fg2 leading-relaxed">相机 RAW（CR2/CR3/NEF/ARW/DNG…）· iPhone HEIC · AVIF / JXL</div>
              <div className="text-[11px] text-fg3 mt-1 leading-relaxed">内嵌预览兜底 + 方向解析，全维度可检</div>
            </div>
            <div className="rounded-lg border border-line bg-panel p-3">
              <div className="text-xs font-medium text-fg3 mb-1">✕ 不支持（自动跳过）</div>
              <div className="text-xs text-fg2 leading-relaxed">PSD · AI · SVG · ICO 等设计 / 矢量 / 医疗格式</div>
              <div className="text-[11px] text-fg3 mt-1 leading-relaxed">非照片，无人脸 / EXIF 语义，导入时过滤</div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (viewMode === 'grid') {
    // 网格容器已经用 callback ref 绑滚轮缩放，这里把同一个节点也交给滚动锚定。
    // AiReviewBar 放在滚动容器外面（不参与滚动）：sticky+负 margin 在带 padding 的滚动容器里
    // 顶部总会被 sticky 偏移留出缝（用户实抓），改成固定行后天然顶满、图从其下方滚过
    return (
      <div className="h-full flex flex-col">
        <AiReviewBar />
        <div
          ref={(el) => {
            scrollRef.current = el
            bindGridWheel(el)
          }}
          className="gallery-scroll flex-1 min-h-0 overflow-auto p-3 fade-in"
        >
          <BusyBanner />
          <GridView images={sorted} size={gridSize} click={click} dbl={dbl} dragIds={dragIds} />
        </div>
      </div>
    )
  }

  if (viewMode === 'list') {
    const scanning = scanProgress?.running === true && scanProgress?.phase === 'scanning'
    const currentName = scanProgress?.current ?? ''
    return (
      <div className="h-full flex flex-col">
        <AiReviewBar />
        <div ref={scrollRef} className="gallery-scroll flex-1 min-h-0 overflow-auto px-2 py-1 fade-in">
          <BusyBanner />
          <table className="w-full text-xs border-separate border-spacing-0">
          <thead>
            <tr className="text-fg3 text-left">
              <th className="sticky top-0 z-10 bg-canvas px-2 py-1.5 font-medium w-24"></th>
              <th className="sticky top-0 z-10 bg-canvas px-2 py-1.5 font-medium">文件名</th>
              <th className="sticky top-0 z-10 bg-canvas px-2 py-1.5 font-medium">AI 标签</th>
              <th className="sticky top-0 z-10 bg-canvas px-2 py-1.5 font-medium w-36">最高置信度</th>
              <th className="sticky top-0 z-10 bg-canvas px-2 py-1.5 font-medium w-28">分类</th>
              <th className="sticky top-0 z-10 bg-canvas px-2 py-1.5 font-medium w-20">状态</th>
              <th className="sticky top-0 z-10 bg-canvas px-2 py-1.5 font-medium w-14">标签</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((img, i) => {
              const selected = selection.has(img.id)
              const tags = Object.entries(img.tags || {}).filter(([, t]) => t && t.level !== 'low')
              const isCurrent = scanning && !!currentName && img.filename === currentName
              const conf = sortConf(img)
              const rowBg = isCurrent ? 'bg-red-500/10' : selected ? 'bg-brand/20' : i % 2 ? 'bg-panel2/40' : ''
              return (
                <tr
                  key={img.id}
                  data-img-id={img.id}
                  className={'cursor-pointer hover:bg-panel2 ' + rowBg}
                  onClick={(e) => click(i, e)}
                  onDoubleClick={() => dbl(img)}
                >
                  <td className={'border-b border-line/50 px-2 py-1 ' + (isCurrent ? 'border-l-2 border-l-red-500' : 'border-l-2 border-l-transparent')}>
                    <ThumbImg img={img} cellPx={72} className="w-[72px] h-[72px] object-cover rounded-md ring-1 ring-line" />
                  </td>
                  <td className="border-b border-line/50 px-2 py-1 max-w-[280px] align-middle">
                    <div className="truncate font-mono text-fg2" title={img.path}>{img.filename}</div>
                    {needsManualReview(img) && <div className="text-[11px] font-bold text-bad" title="本张已完成云端复核；画面模糊、曝光异常不在复核范围内，需人工裁定">待人工裁定画质</div>}
                    {isCurrent && <div className="text-[10px] text-red-500">正在检测…</div>}
                  </td>
                  <td className="border-b border-line/50 px-2 py-1 align-middle">
                    <div className="flex flex-wrap gap-1">
                      {(() => {
                        const manual = needsManualReview(img)
                        const isQc = (d: string): boolean => (QC_MANUAL_DIMENSIONS as string[]).includes(d)
                        return (manual ? sortManualQcFirst(tags) : sortTagsPersonFirst(tags)).map(([d]) => (
                          <DimTag key={d} dim={d} faded={manual && !isQc(d)} />
                        ))
                      })()}
                      {!tags.length && <span className="text-fg3">—</span>}
                    </div>
                  </td>
                  <td className="border-b border-line/50 px-2 py-1 align-middle">
                    <div className="flex items-center gap-2">
                      <span className="tabular-nums w-9 text-right text-fg2">{(conf * 100).toFixed(0)}%</span>
                      <span className="h-1.5 flex-1 min-w-[48px] rounded-full bg-line overflow-hidden">
                        <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.round(conf * 100)}%` }} />
                      </span>
                    </div>
                  </td>
                  <td className="border-b border-line/50 px-2 py-1 align-middle">
                    <span className="inline-flex items-center gap-1.5 text-fg2">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: categoryDotColor(img.category) }} />
                      {categoryLabelShort(img.category)}
                    </span>
                  </td>
                  <td className="border-b border-line/50 px-2 py-1 align-middle">
                    <StatusPill status={img.status} scanning={isCurrent} />
                  </td>
                  <td className="border-b border-line/50 px-2 py-1 align-middle">
                    <TagBtn img={img} variant="plain" />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      </div>
    )
  }

  // 瀑布流是剩下的默认布局（老版本还有个 'large' 独立大图视图，已并入双击放大弹窗，
  // 顶栏「大图」现在走 store.openLargePreview；bootstrap 会把库里残留的旧值兜成 grid）
  return (
    <div className="h-full flex flex-col">
      <AiReviewBar />
      <div ref={scrollRef} className="gallery-scroll flex-1 min-h-0 overflow-auto p-3 fade-in">
        <BusyBanner />
        <div style={{ columnGap: 12 }} className="columns-2 md:columns-3 xl:columns-4 2xl:columns-5">
        {sorted.map((img, i) => (
          <div key={img.id} className="mb-3 break-inside-avoid" style={{ breakInside: 'avoid' }}>
            <MasonryThumb img={img} index={i} onClick={click} onDoubleClick={dbl} dragIds={dragIds} />
          </div>
        ))}
        </div>
      </div>
    </div>
  )
}

function categoryLabelShort(cat: string): string {
  if (cat === 'library') return '交付库'
  if (cat === 'review') return '待确认'
  if (cat === 'trash') return '废弃库'
  if (cat.startsWith('custom:')) return '自定义'
  return DIMENSION_LABELS[cat as keyof typeof DIMENSION_LABELS] || cat
}

/** 分类小圆点颜色：与左侧分类树同色（交付=绿 待确认=黄 垃圾=灰 自定义=品牌色 其余走维度色） */
function categoryDotColor(cat: string): string {
  if (cat === CAT_LIBRARY) return 'rgb(var(--c-good))'
  if (cat === CAT_REVIEW) return 'rgb(var(--c-warn))'
  if (cat === CAT_TRASH) return '#6b7280'
  if (cat.startsWith('custom:')) return 'rgb(var(--c-brand))'
  return dimTagColor(cat)
}

/** 列表状态胶囊：检测中（蓝色闪烁）/ 已筛（绿）/ 待筛（灰）/ 失败（红）/ 跳过（黄） */
function StatusPill({ status, scanning }: { status: string; scanning: boolean }): JSX.Element {
  if (scanning) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-medium bg-red-500/15 text-red-500 animate-pulse">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
        检测中
      </span>
    )
  }
  const map: Record<string, { t: string; c: string }> = {
    done: { t: '已筛', c: 'bg-good/15 text-good' },
    pending: { t: '待筛', c: 'bg-fg3/15 text-fg3' },
    error: { t: '失败', c: 'bg-bad/15 text-bad' },
    skip: { t: '跳过', c: 'bg-warn/15 text-warn' }
  }
  const s = map[status] || map.pending
  return <span className={'inline-flex items-center px-1.5 py-0.5 rounded-full text-[11px] font-medium ' + s.c}>{s.t}</span>
}

function MasonryThumb(props: { img: ImageRecord; index: number; onClick: (i: number, e: React.MouseEvent) => void; onDoubleClick: (img: ImageRecord) => void; dragIds: number[] }): JSX.Element {
  const { img, index, onClick, onDoubleClick, dragIds } = props
  const selected = useStore((s) => s.selection.has(img.id))
  const scanCurrent = useStore((s) => (s.scanProgress?.running && s.scanProgress.phase === 'scanning' ? s.scanProgress.current : ''))
  const isScanning = !!scanCurrent && img.filename === scanCurrent
  const ratio = img.width && img.height ? img.width / img.height : 1
  return (
    <div
      data-img-id={img.id}
      className={
        'relative rounded-md overflow-hidden border cursor-pointer group ' +
        (isScanning
          ? 'border-red-500 ring-[3px] ring-red-500 scale-105 z-20 '
          : selected
            ? 'border-brand ring-2 ring-brand shadow-[0_0_0_2px_rgba(59,130,246,0.45)]'
            : 'border-line hover:border-gray-500')
      }
      draggable
      onDragStart={(e) => {
        const ids = selected ? dragIds : [img.id]
        if (!selected) onClick(index, e)
        e.dataTransfer.setData('application/x-image-ids', JSON.stringify(ids))
        e.dataTransfer.effectAllowed = 'move'
        const preview = makeStackDragImage(ids)
        const hotX = Number(preview.dataset.hotX) || Math.ceil(preview.offsetWidth / 2)
        const hotY = Number(preview.dataset.hotY) || Math.ceil(preview.offsetHeight / 2)
        e.dataTransfer.setDragImage(preview, hotX, hotY)
        setTimeout(() => preview.remove(), 0)
      }}
      onClick={(e) => onClick(index, e)}
      onDoubleClick={() => onDoubleClick(img)}
    >
      <img src={img.thumb ? toSrc(img.thumb) : toSrc(img.path)} loading="lazy" className="w-full object-cover" style={{ aspectRatio: String(ratio) }} alt={img.filename} draggable={false} />
      <ManualFlag img={img} />
      <DupParkFlag img={img} />
      {isScanning && (
        <span className={'absolute left-1 z-10 px-1.5 py-0.5 rounded bg-red-500 text-white text-[10px] font-bold animate-pulse shadow ' + (hasCornerFlag(img) ? 'top-[26px]' : 'top-1')}>检测中</span>
      )}
      <StatusRibbon img={img} />
      <TagChips img={img} />
      <TagBtn img={img} />
    </div>
  )
}
