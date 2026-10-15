/**
 * 侧栏分类树（第三章 3.1，D4 面向客户简化 + 分组顺序重排）
 * 上段“交付状态”互斥可求和：全部 / 交付库（三行档位子行带「└──」层级连接符、缩进一档，
 * 子行数字比父行更小更浅、选中也不粗体——从属关系不能反客为主）/ 待确认 / 瑕疵片；
 * 下段按“先看后弃”排序：人物与影调 → 瑕疵（按缺陷类型）→ 自定义相册 → 废片（最底，确定不要的垫底）。
 * 原“按内容分”折叠开关已取消：分组固定排序后直接摊开，遮起来反而找不到。
 * 层级只靠排版（标题 13px 粗体 fg 不可点、行 13px fg2、着色词 10px），
 * tooltip 全部写成一句客户话（禁“置信/阈值/样本”等内部术语，保留操作效果说明）。
 * 每行行首是图形 + 颜色双编码（见 SidebarIcons）。支持把图片拖到分类移动（9.3），拖到档位行改档。
 */
import { createContext, useContext, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { NavIcon } from './SidebarIcons'
import TutorialCenter from './TutorialCenter'
import AiReviewTag from './AiReviewTag'
import { useStore } from '../store'
import {
  BAD_DIMENSIONS,
  CAT_LIBRARY,
  CAT_FLAWS,
  CAT_REVIEW,
  CAT_TRASH,
  DIMENSION_LABELS,
  NEUTRAL_DIMENSIONS,
  DEFAULT_TIER_NAMES,
  DUP_REDUNDANT_KEY,
  DUP_GROUP_KEY,
  isBadDim,
  isStructuralDim,
  type TierKey
} from '../../../shared/types'
import type { CategoryKey } from '../../../shared/types'

/** 坏维度专用调色板：每个维度颜色固定且互不相同 */
const BAD_DOT_COLORS: Record<string, string> = {
  eyes_closed: '#ef4444', // 闭眼 · 红
  eyes_side: '#f97316', // 斜眼 · 橙
  face_ugly: '#ec4899', // 面部狰狞 · 粉
  blur: '#8b55f6', // 画面模糊 · 紫罗兰
  exposure: '#eab308', // 曝光异常 · 黄
  half_head: '#14b8a6', // 半截头 · 青
  duplicate: '#6366f1' // 重复照片 · 蓝紫
}

/** 中性维度统一配色（蓝） */
export const NEUTRAL_DOT_COLOR = '#3b82f6'

/**
 * 维度 → 配色单一来源：右侧图片上的坏/中性标签背景色，与此处左侧小圆点颜色完全同步。
 * 供 Sidebar 画圆点、ImageView 画标签共用，改一处即可两端同步。
 */
export function dimTagColor(dim: string): string {
  // 结构维度（重复/连拍）跟瑕疵用同一张调色板：它也要在卡片上挂一枚看得见的彩色标签，
  // 掉回蓝色会被当成“客观事实类标签”（单人照/黑白照那种不带好坏色彩的）
  if (isBadDim(dim) || isStructuralDim(dim)) return BAD_DOT_COLORS[dim] ?? '#ef4444'
  return NEUTRAL_DOT_COLOR
}

/** 状态点规则：库里没有图时一律置灰，有图才亮各自的颜色 */
const DOT_OFF = '#4b5563'
function lit(count: number | undefined, color: string): string {
  return (count ?? 0) > 0 ? color : DOT_OFF
}

/**
 * 导出状态：只用一个着色词，右对齐在标题行末尾，不套方框。
 * 绿 = 进交付包，红 = 默认不导出但可捞回，灰 = 永不导出（只能还原）。
 */
const GROUP_STATUS = {
  normal: { text: '照常导出', cls: 'text-good' },
  bad: { text: '默认不导出', cls: 'text-bad' },
  never: { text: '永不导出', cls: 'text-fg3' }
} as const

/**
 * 分组标题后的问号提示。悬停即弹出自定义浮层（不是系统原生 title 那种一行灰条）：
 * 走 Portal + fixed 挂到 body（沿用 TagChips 的做法），绕开侧栏可能的 overflow 裁剪，
 * 无延迟、样式可控、靠屏幕右缘自动往左收；浮层 pointer-events-none 不拦截交互。
 */
function HelpTip(props: { title: string; text: string }): JSX.Element {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  return (
    <span
      className="shrink-0 inline-flex items-center align-middle translate-y-[1.5px] text-fg3 hover:text-fg2 cursor-pointer [&_svg]:h-3.5 [&_svg]:w-3.5"
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        // 弹在图标右侧；靠屏幕右缘时往左收（预留 300），靠底部时往上抬（预留 220）
        const left = Math.max(8, Math.min(r.right + 10, window.innerWidth - 300))
        const top = Math.max(8, Math.min(r.top - 6, window.innerHeight - 220))
        setPos({ left, top })
      }}
      onMouseLeave={() => setPos(null)}
    >
      <NavIcon name="help" />
      {pos &&
        createPortal(
          <div
            className="fixed z-[90] w-[280px] max-w-[calc(100vw-16px)] rounded-xl border border-line bg-panel/95 px-3.5 py-2.5 shadow-2xl pointer-events-none"
            style={{ left: pos.left, top: pos.top }}
          >
            <div className="mb-1.5 border-b border-line/60 pb-1.5 text-[12px] font-bold leading-snug text-fg">
              {props.title}
            </div>
            <div className="space-y-1.5 text-[11.5px] leading-relaxed text-fg">
              {props.text.split('\n').map((raw, i) => {
                const line = raw.trim()
                if (!line) return null
                if (line.startsWith('·')) {
                  // 实心圆点：用最深令牌 bg-fg 上色、放大到 5px，文字换行时缩进到点后面
                  return (
                    <div key={i} className="flex gap-2">
                      <span className="mt-[7px] h-[5px] w-[5px] shrink-0 rounded-full bg-fg" />
                      <span className="flex-1">{line.replace(/^·\s*/, '')}</span>
                    </div>
                  )
                }
                return <div key={i}>{line}</div>
              })}
            </div>
          </div>,
          document.body
        )}
    </span>
  )
}

/**
 * 分组容器。两个对齐细节：标题用 px-5 跟行里的文字基线（mx-2 + px-3 = 20px）齐平；
 * 末尾的着色词右对齐，与行里的数字同一列。标题不是按钮：不绑 onClick、没有 hover 底色，
 * 只用 font-bold + text-fg（最深的令牌）压住下面 13px 常规 fg2 的行。
 * 说明分层：hover 标题 = 一句 `tip` 短描述；标题后的问号图标（`help`）hover = 详细的
 * `hint` 长说明。长文字不再常驻在标题下，侧栏因此更简洁，需要时悬停问号即弹出。
 */
function Group(props: {
  title: string
  status: keyof typeof GROUP_STATUS
  tip: string
  hint?: string
  action?: ReactNode
  children: ReactNode
}): JSX.Element {
  const s = GROUP_STATUS[props.status]
  return (
    <section className="mt-4 border-t border-line/70 pt-2">
      <div className="px-5 flex items-center gap-2">
        <span className="flex-1 min-w-0 flex items-center gap-1.5">
          <span className="min-w-0 truncate text-[13px] font-bold text-fg" title={props.tip}>
            {props.title}
          </span>
          {props.hint && <HelpTip title={props.title} text={props.hint} />}
        </span>
        <span className={'shrink-0 text-[10px] font-medium ' + s.cls}>{s.text}</span>
        {props.action}
      </div>
      <div className="mt-1">{props.children}</div>
    </section>
  )
}

/** 拖拽命中目标（单一真源）：容器裁判算出当前悬停的分类，Row 只对照自己亮不亮 */
const DropCtx = createContext<CategoryKey | null>(null)

/**
 * 欠账行的选中态：整行改用同色淡底 + 同色描边 + 同色字，不再回落品牌蓝。
 * 用户 2026-10-15 指出：选中「待确认」时字变回黑色，等于把刚建立的强调丢了。
 */
const TONE_ACTIVE: Record<string, string> = {
  'text-warn': 'bg-warn/15 text-warn border-warn/40',
  // 交付库走绿色（用户 2026-10-15 定：跟待确认同一套机制，只换个色）——
  // 它本来就是“能交出去的产出”，行首图标有图时也是绿的，选中态跟上同一色才不拧巴
  'text-good': 'bg-good/15 text-good border-good/40'
}

function Row(props: {
  label: string
  cat: CategoryKey | null
  count?: number
  /** 图形名（见 SidebarIcons），与颜色一起构成双编码 */
  icon?: string
  /** 子行行首的层级连接符（如「└──」）：占 icon 的位置、浅色不参与配色；
   *  带连接符的行数字自动降一档（更小更浅不跟选中态变粗） */
  connector?: string
  /** 图形着色；省略时继承行文字色，选中态会跟着变品牌色 */
  color?: string
  tip?: string
  noDrop?: boolean
  onDelete?: () => void
  /** 数字与标签层级强调：total=全部文件（15px 粗 fg），status=组内主行（13px 粗 fg2） */
  emphasis?: 'total' | 'status'
  /** 数字背后的量词（如「组」）：侧栏“重复照片”按组数计，不写单位会被当成张数跟旁边几行相加 */
  unit?: string
  /** 传了就在标签后紧跟一枚可点的小字「导出」，点击直接开导出面板（不触发选中分类）。
   *  颜色走品牌蓝而不是绿：交付库整行已是绿色（内容状态），蓝是“这里可以点”的通用信号，两者不抢 */
  onExport?: () => void
  /** 标签文字后、数字前的一块自定义区域（如「待确认」行后的 AI 复审运行态小字）：靠排版内联，不改变行点击语义 */
  after?: ReactNode
  /** 欠账着色（用户 2026-10-15 定）：传了就在本行有图时一路生效（选中与否都走这个色）。
   *  只给真正要人去处理的那一栏用（待确认） */
  tone?: string
}): JSX.Element {
  const active = useStore((s) => s.activeCategory === props.cat)
  const openCategory = useStore((s) => s.openCategory)
  const selection = useStore((s) => s.selection)
  // 拖放高亮不再由本行自己监听：旧逐行实现里 dragleave 穿过图标/数字等子元素就误清高亮，
  // 下一帧 dragover 又点亮，快速划动时整栏频闪“不丝滑”；命中判定全部交给容器裁判（见 Sidebar），
  // 这里只订阅“当前目标是不是我”。
  const isDropTarget = props.cat !== null && useContext(DropCtx) === props.cat
  // 有欠账才着色（count > 0）；清零后自动回落普通色，不然侧栏永远一片红，强调就成了噪声。
  // 选中时也不丢（用户 2026-10-15 定）：点进「待确认」正是去处理欠账，这时有色比无色更要紧
  const tone = (props.count ?? 0) > 0 ? props.tone : undefined
  const labelCls = 'truncate' + (props.emphasis === 'status' ? ' font-semibold ' + (tone || 'text-fg') : '')
  const activeCls = tone && TONE_ACTIVE[tone] ? TONE_ACTIVE[tone] : 'bg-brand/15 text-brand border-brand/40'
  return (
    <div
      className={
        'group flex items-center gap-2 px-3 py-2 mx-2 rounded-md cursor-pointer ' +
        (props.emphasis === 'total' ? 'text-[15px] font-bold' : 'text-sm') + ' transition-colors ' +
        (active
          ? 'border ' + activeCls + (props.emphasis === 'total' ? '' : ' font-semibold')
          : (props.emphasis === 'total' ? 'text-fg' : 'text-fg2') + ' hover:bg-panel2 border border-transparent') +
        (isDropTarget ? ' ring-1 ring-brand bg-brand/25' : '') +
        // 空分类整行压暗：它点进去是白屏，不配跟有图的行一样扎眼
        (props.count === 0 ? ' opacity-50' : '')
      }
      data-drop-cat={props.cat ?? '@null'}
      data-drop-off={props.noDrop || props.cat === null ? '1' : undefined}
      onClick={() => void openCategory(props.cat)}
      title={
        // tip 没传时不能直接拼接，否则悬停会看到一行“undefined（拖入将移动…）”
        (props.tip ?? '') +
        (props.cat && selection.size > 1 ? `（拖入将移动当前选中的 ${selection.size} 张）` : '')
      }
    >
      {props.connector && (
        <span className="shrink-0 text-fg3 select-none whitespace-pre" aria-hidden="true">
          {props.connector}
        </span>
      )}
      {props.icon && <NavIcon name={props.icon} color={props.color} />}
      {props.onExport ? (
        <span className="flex-1 flex items-center min-w-0">
          <span className={labelCls}>{props.label}</span>
          <button
            className="shrink-0 self-start text-[10px] font-medium text-brand hover:underline cursor-pointer translate-y-[3px] -ml-0.5"
            onClick={(e) => {
              e.stopPropagation()
              props.onExport?.()
            }}
            title="导出交付库照片"
          >
            「导出」
          </button>
        </span>
      ) : props.after ? (
        <span className="flex-1 flex items-center min-w-0">
          <span className={labelCls}>{props.label}</span>
          {props.after}
        </span>
      ) : (
        <span className={'flex-1 ' + labelCls}>
          {props.label}
        </span>
      )}
      {props.count != null && (
        // 选中行的数字必须跟标签同色（主题品牌色）：这里曾用 text-blue-200，浅色主题下
        // 它是近白的浅蓝，压在 bg-brand/15 的浅蓝底上几乎看不见，反而比未选中的 gray-500 更难读。
        // 档位子行（带连接符）例外：数字永远比父行小一档、浅一档、不粗体，不能压过“交付库”的总数
        <span
          className={
            props.connector
              ? 'text-[11px] tabular-nums font-normal text-gray-400'
              : props.emphasis === 'total'
                ? 'text-[15px] tabular-nums font-bold ' + (active ? 'text-brand' : 'text-fg')
                : props.emphasis === 'status'
                  ? 'text-[13px] tabular-nums font-bold ' + (tone || (active ? 'text-brand' : 'text-fg2'))
                  : 'text-xs tabular-nums ' + (tone || (active ? 'text-brand' : 'text-gray-500'))
          }
        >
          {props.count}
          {props.unit}
        </span>
      )}
      {props.onDelete && (
        <button
          className="hidden group-hover:block text-gray-500 hover:text-red-400 px-1"
          onClick={(e) => {
            e.stopPropagation()
            props.onDelete?.()
          }}
          title="删除分类（其中图片回归交付库）"
        >
          ×
        </button>
      )}
    </div>
  )
}

export default function Sidebar(): JSX.Element {
  const counts = useStore((s) => s.counts)
  const tierNames = useStore((s) => s.settings.tierNames) ?? DEFAULT_TIER_NAMES
  const customCategories = useStore((s) => s.customCategories)
  const addCustomCategory = useStore((s) => s.addCustomCategory)
  const removeCustomCategory = useStore((s) => s.removeCustomCategory)
  const moveIds = useStore((s) => s.moveIds)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [showTutorial, setShowTutorial] = useState(false)
  // 档位三行的客户话（按 1/2/3 下标）：只说这档图干什么用，不出现打分机制。
  // v3 口径：档位依据从"离瑕疵线多远"换成引擎实测的清晰度（拉普拉斯方差 + 高频细节占比），
  // 所以话术讲"清楚/偏软"这种看得见的差别，不再讲"擦边"；测不到清晰度的图一律兜到中间档，
  // 这句话必须写明，否则用户会以为中间档的图都被测过且真的居中。
  const tierTips: Record<TierKey, string> = {
    1: '清晰度最高，可放大精修',
    2: '清晰度居中，正常出片可用',
    3: '画面偏软，仅作备选，不建议放大'
  }

  /*
   * 拖放命中裁判（旧逐行实现的三个同根问题：① dragleave 穿越本行子元素就误清高亮，
   * 下一帧 dragover 又点亮，快速划动频闪；② 行间空隙/分组标题不属于任何 drop 区，
   * 经过即灭高亮且不接 drop，体感“延迟、不命中”；③ 每行独立 setState 高频重渲染）：
   * 改为整栏单点监听 dragover，用 elementFromPoint + [data-drop-cat] 定位命中的行；
   * 空隙不设新目标也不清旧目标（sticky），松手时落到最后一个命中行；ref 与 state 双写，
   * drop 回调读 ref 避免闭包读到旧值。
   */
  const [dropCat, setDropCat] = useState<CategoryKey | null>(null)
  const dropCatRef = useRef<CategoryKey | null>(null)
  const setDrop = (v: CategoryKey | null): void => {
    if (dropCatRef.current === v) return
    dropCatRef.current = v
    setDropCat(v)
  }
  /** 鼠标坐标→命中行；空隙返回 null */
  const hitRow = (x: number, y: number): { cat: CategoryKey | null; off: boolean } | null => {
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-drop-cat]')
    if (!el) return null
    const raw = el.dataset.dropCat
    if (raw === undefined) return null
    return { cat: raw === '@null' ? null : (raw as CategoryKey), off: el.dataset.dropOff === '1' }
  }

  const submitAdd = (): void => {
    if (name.trim()) void addCustomCategory(name.trim())
    setName('')
    setAdding(false)
  }

  return (
    <DropCtx.Provider value={dropCat}>
      <aside
        className="w-56 shrink-0 bg-panel border-r border-line flex flex-col overflow-y-auto pt-2 pb-3 text-[13px]"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('application/x-image-ids')) return
          const hit = hitRow(e.clientX, e.clientY)
          if (!hit) {
            // 空隙：保持上一个目标；若已有可投目标则继续放行，松手在空隙也算命中
            if (dropCatRef.current !== null) e.preventDefault()
            return
          }
          if (hit.off) {
            setDrop(null)
            return // 不可拖入的行：不 preventDefault，浏览器自然显示禁止光标
          }
          e.preventDefault()
          setDrop(hit.cat)
        }}
        onDragLeave={(e) => {
          // 只有真正离开侧栏才清除；穿越内部子元素不算 leave
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null)
        }}
        onDrop={(e) => {
          e.preventDefault()
          const hit = hitRow(e.clientX, e.clientY)
          // 命中行优先；落在空隙则兜到 sticky 目标
          const cat = hit && !hit.off ? hit.cat : dropCatRef.current
          setDrop(null)
          if (cat === null) return
          const raw = e.dataTransfer.getData('application/x-image-ids')
          if (!raw) return
          const ids = JSON.parse(raw) as number[]
          // 按拖拽载荷里的 id 移动，不隐式依赖 selection 同步
          if (ids.length) void moveIds(ids, cat)
        }}
      >
      <Row emphasis="total" label="全部文件" cat={null} count={counts.all} icon="all" tip="全部照片总览（含各分类）" />
      {/* 筛选结果区域：只靠淡底色与下方 Group 拉开差异，行缩进与 Group 完全一致 */}
      <section className="mt-1 pt-1 pb-1 rounded-lg bg-panel2/25">
      <div className="flex items-center gap-2 px-4 pb-1 pt-1">
        <span className="flex-1 border-t border-fg/20"></span>
        <span className="flex items-center gap-1.5">
          <span className="text-[15px] font-bold text-fg tracking-widest whitespace-nowrap">筛选结果</span>
          <HelpTip
            title="筛选结果"
            text={`AI 筛选结论按交付去向分栏，一张照片只进其中一栏。

· 交付库：无缺陷，默认全量导出；下设优质 / 良好 / 一般三档，仅按清晰度排序。
· 待确认：判定存疑、需人工拍板，暂不导出。
· 瑕疵片：判出缺陷，默认不导出。
· 重复照片：连拍冗余，按组统计。

归属冲突时的优先序：废弃库 → 瑕疵片 → 重复照片 → 待确认 → 交付库。交付库、待确认、瑕疵片三栏互不重叠，重复照片按组计，不能与张数相加。`}
          />
        </span>
        <span className="flex-1 border-t border-fg/20"></span>
      </div>
            <Row emphasis="status" label="交付库" cat={CAT_LIBRARY} count={counts[CAT_LIBRARY]} icon="library" tone="text-good" color={lit(counts[CAT_LIBRARY], '#22c55e')} noDrop onExport={counts[CAT_LIBRARY] ? () => void useStore.setState({ showExport: true }) : undefined} tip="无缺陷照片，默认全量导出；不可直接拖入，请拖至下方档位" />
      {/* 档位三子行：行首「└──」层级连接符 + 外层 ml-2 缩进，跟父行文字拉开一档；
          点开=只看该档，拖入=改档（不移动归属、不清标签） */}
      {([1, 2, 3] as TierKey[]).map((t) => (
        <div key={t} className="ml-2">
          <Row connector="└──" label={tierNames[t - 1] || String(t)} cat={`tier:${t}`} count={counts[`tier:${t}`]} tip={`${tierTips[t]}；点击仅看该档，拖入可改档`} />
        </div>
      ))}
      <Row emphasis="status" tone="text-warn" label="待确认" cat={CAT_REVIEW} count={counts[CAT_REVIEW]} icon="review" color={lit(counts[CAT_REVIEW], '#eab308')} after={<AiReviewTag scope="review" />} tip="AI 判定存疑、需人工拍板，暂不导出" />
      <Row emphasis="status" label="瑕疵片" cat={CAT_FLAWS} count={counts[CAT_FLAWS]} icon="face_ugly" color={lit(counts[CAT_FLAWS], '#ef4444')} noDrop after={<AiReviewTag scope="flaws" />} tip="AI 判出缺陷，默认不导出；确认为误判后删除标签即放行" />
      {/* 重复照片（v2.0.67，客户看到的名字从“重复多余”改成“重复照片”）：本身没拍坏、只因同组已经有一张进了交付库而不导出的那批图。
          以前它们混在“瑕疵片”里，用户看到的就是“好片被当坏片”，10-13 投诉的根源。
          数字改成按组数（用户 2026-10-15：“实际 2 组、左边只显 1”）：点进去看到的几张堆叠卡，就是这儿的数字，
          跟旁边按张数的几行不同义，所以带个“组”字、也不能相加。 */}
      <Row emphasis="status" label="重复照片" cat="duplicate" count={counts[DUP_GROUP_KEY]} unit="组" icon="duplicate" color={lit(counts[DUP_REDUNDANT_KEY], BAD_DOT_COLORS.duplicate)} noDrop tip="按组统计，不与张数相加；每组仅保留一张导出" />
      </section>

      {/* 人物在前、瑕疵在后（用户 10-13 指定）：先按人/影调找图是高频动线，
          瑕疵是复核场景才逐类看；瑕疵行的数字是“带该缺陷的张数”，
          一图两种缺陷会进两行，所以行间数字不加和 */}
      <Group
        title="类型"
        status="normal"
        tip="按人数与影调归类，不代表照片好坏"
        hint={`按照片的客观内容归类，不代表照片好坏，也不影响是否导出。

· 单人照 / 多人合拍照 / 多人混合照 / 无人物场景：按画面人数划分，一张照片只归其中一栏。
· 黑白照：独立维度，一张黑白照片会同时计入它的人数栏与「黑白照」。

因此各行数字相加会大于照片总张数。`}
      >
        {NEUTRAL_DIMENSIONS.map((d) => (
          <Row key={d} label={DIMENSION_LABELS[d]} cat={d} count={counts[d]} icon={d} color={lit(counts[d], NEUTRAL_DOT_COLOR)} tip={`${DIMENSION_LABELS[d]}：按内容归类，不影响导出`}
          />
        ))}
      </Group>

      <Group
        title="瑕疵"
        status="bad"
        tip="按缺陷类型查看；一图多缺陷会计入多行"
        hint={`按缺陷类型分别查看，含该类缺陷的照片均在此列出，默认不参与导出。

· 一张照片可能同时有多种缺陷（如既闭眼、画面又模糊），会同时计入对应的几行。

因此各行数字相加会大于「瑕疵片」总数。确认为误判时，删除该缺陷标签即可恢复导出。`}
      >
        {BAD_DIMENSIONS.map((d) => (
          <Row key={d} label={DIMENSION_LABELS[d]} cat={d} count={counts[d]} icon={d} color={lit(counts[d], BAD_DOT_COLORS[d] ?? '#ef4444')} tip={`${DIMENSION_LABELS[d]}：含该缺陷的照片`} />
        ))}
      </Group>

      {/* 废片沉在自定义分类前面（用户 10-13 指定）：确定不要的比自建相册低频，往下放 */}
      <Group
        title="废片"
        status="never"
        tip="手动丢弃的照片，永不导出；可还原或重新入档"
        hint={`存放手动丢弃的照片，永不参与导出；磁盘上的原文件不会被删除。

· 点进去可按丢弃来源分栏查看。
· 可随时还原，或选定档位重新加入交付库。`}
      >
        <Row emphasis="status" label="废弃库" cat={CAT_TRASH} count={counts[CAT_TRASH]} icon="trash" color={lit(counts[CAT_TRASH], '#e11d48')} tip="永不导出；点进去可按来源还原或入档" />
      </Group>

      <Group
        title="自定义分类"
        status="normal"
        tip="自建相册，照常导出；删除相册后照片回归交付库"
        action={
          <button
            className="w-6 h-6 shrink-0 rounded-full bg-brand text-white text-lg leading-none font-bold flex items-center justify-center hover:bg-blue-500 active:scale-90 shadow-[0_1px_5px_rgba(59,130,246,0.55)] transition"
            onClick={() => setAdding(true)}
            title="新建自定义分类"
          >
            ＋
          </button>
        }
      >
        {adding && (
          <div className="mx-3 mb-1 flex gap-1">
            <input
              autoFocus
              className="input flex-1 min-w-0 text-xs"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitAdd()
                if (e.key === 'Escape') setAdding(false)
              }}
              onBlur={submitAdd}
              placeholder="分类名称"
            />
          </div>
        )}
        {customCategories.map((c) => (
          <Row
            key={c.id}
            label={c.name}
            cat={`custom:${c.id}`}
            count={counts[`custom:${c.id}`]}
            icon="folder"
            color={lit(counts[`custom:${c.id}`], '#a855f7')}
            onDelete={() => void removeCustomCategory(c.id)}
          />
        ))}
      </Group>
      {/* 底部教程中心：文档式弹窗，左边页签切章节（快速上手/分类/操作/会员/设置） */}
      <div className="mx-3 mt-4 flex justify-center">
        <button
          onClick={() => setShowTutorial(true)}
          className="w-full text-[13px] font-semibold text-fg2 hover:text-fg bg-panel2 hover:bg-line/60 border border-line rounded-lg px-4 py-2.5 transition-colors cursor-pointer"
        >
          📖 教程中心
        </button>
      </div>
      {showTutorial && <TutorialCenter onClose={() => setShowTutorial(false)} />}
      </aside>
    </DropCtx.Provider>
  )
}
