/**
 * 侧栏分类树（第三章 3.1）
 * 结构：顶部三行状态入口（全部文件 / 交付库 / 待确认）+ 四个分组
 * （瑕疵照片 = 7 个坏维度 / 人物与影调 = 5 个中性维度 / 废片 = 垃圾桶 + 重复废弃桶 / 自定义分类）。
 * 层级靠三件事拉开，不靠方框：分组标题是 13px 粗体 + 最深的 fg 且不可点（没 hover 底色），
 * 行是 13px 常规 fg2 可点，小字是 10px fg3；“会不会导出”只用标题行末尾一个着色词说。
 * 每行行首是图形 + 颜色双编码（见 SidebarIcons），色弱用户靠形状也能分档。
 * 代码术语（坏/中性维度）只留在注释里。支持把选中的图片拖拽到分类完成多选移动（9.3）。
 */
import { createContext, useContext, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { NavIcon } from './SidebarIcons'
import { useStore } from '../store'
import {
  BAD_DIMENSIONS,
  CAT_LIBRARY,
  CAT_REVIEW,
  CAT_TRASH,
  CAT_DUP_TRASH,
  DIMENSION_LABELS,
  NEUTRAL_DIMENSIONS,
  PRECISION_TIERS,
  dimTier,
  isBadDim
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
  duplicate: '#6366f1' // 重复/连拍 · 蓝紫
}

/** 中性维度统一配色（蓝） */
export const NEUTRAL_DOT_COLOR = '#3b82f6'

/**
 * 维度 → 配色单一来源：右侧图片上的坏/中性标签背景色，与此处左侧小圆点颜色完全同步。
 * 供 Sidebar 画圆点、ImageView 画标签共用，改一处即可两端同步。
 */
export function dimTagColor(dim: string): string {
  return isBadDim(dim) ? BAD_DOT_COLORS[dim] ?? '#ef4444' : NEUTRAL_DOT_COLOR
}

/** 状态点规则：库里没有图时一律置灰，有图才亮各自的颜色 */
const DOT_OFF = '#4b5563'
function lit(count: number | undefined, color: string): string {
  return (count ?? 0) > 0 ? color : DOT_OFF
}

/**
 * 导出状态：只用一个着色词，右对齐在标题行末尾，不套方框。
 * 上一版给每组标题都挂了一枚 chip 徽标，一栏里挤了五个框，“什么都是标签”就等于
 * 什么都没有主次；框只留给真正的状态角标（卡片上的 待确认 / 🗑），分组靠颜色 + 位置说。
 * 绿 = 进交付包，红 = 默认不导出但可捞回，灰 = 永不导出（只能还原）。
 */
const GROUP_STATUS = {
  normal: { text: '照常导出', cls: 'text-good' },
  bad: { text: '默认不导出', cls: 'text-bad' },
  never: { text: '永不导出', cls: 'text-fg3' }
} as const

/**
 * 分组容器。两个对齐细节：标题用 px-5 跟行里的文字基线（mx-2 + px-3 = 20px）齐平；
 * 末尾的着色词右对齐，与行里的数字同一列。标题不是按钮：不绑 onClick、没有 hover 底色，
 * 只用 font-bold + text-fg（最深的令牌）压住下面 13px 常规 fg2 的行。
 */
function Group(props: {
  title: string
  hint: string
  status: keyof typeof GROUP_STATUS
  tip: string
  action?: ReactNode
  children: ReactNode
}): JSX.Element {
  const s = GROUP_STATUS[props.status]
  return (
    <section className="mt-4 border-t border-line/70 pt-2">
      <div className="px-5 flex items-center gap-2" title={props.tip}>
        <span className="flex-1 min-w-0 truncate text-[13px] font-bold text-fg">{props.title}</span>
        <span className={'shrink-0 text-[10px] font-medium ' + s.cls}>{s.text}</span>
        {props.action}
      </div>
      <div className="px-5 mt-0.5 text-[10px] leading-snug text-fg3">{props.hint}</div>
      <div className="mt-1">{props.children}</div>
    </section>
  )
}

/** 拖拽命中目标（单一真源）：容器裁判算出当前悬停的分类，Row 只对照自己亮不亮 */
const DropCtx = createContext<CategoryKey | null>(null)

function Row(props: {
  label: string
  cat: CategoryKey | null
  count?: number
  /** 图形名（见 SidebarIcons），与颜色一起构成双编码 */
  icon?: string
  /** 图形着色；省略时继承行文字色，选中态会跟着变品牌色 */
  color?: string
  tip?: string
  noDrop?: boolean
  onDelete?: () => void
}): JSX.Element {
  const active = useStore((s) => s.activeCategory === props.cat)
  const openCategory = useStore((s) => s.openCategory)
  const selection = useStore((s) => s.selection)
  // 拖放高亮不再由本行自己监听：旧逐行实现里 dragleave 穿过图标/数字等子元素就误清高亮，
  // 下一帧 dragover 又点亮，快速划动时整栏频闪“不丝滑”；命中判定全部交给容器裁判（见 Sidebar），
  // 这里只订阅“当前目标是不是我”。
  const isDropTarget = props.cat !== null && useContext(DropCtx) === props.cat
  return (
    <div
      className={
        'group flex items-center gap-2 px-3 py-2 mx-2 rounded-md cursor-pointer text-sm transition-colors ' +
        (active ? 'bg-brand/15 text-brand border border-brand/40 font-semibold' : 'text-fg2 hover:bg-panel2 border border-transparent') +
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
      {props.icon && <NavIcon name={props.icon} color={props.color} />}
      <span className="flex-1 truncate">{props.label}</span>
      {props.count != null && (
        // 选中行的数字必须跟标签同色（主题品牌色）：这里曾用 text-blue-200，浅色主题下
        // 它是近白的浅蓝，压在 bg-brand/15 的浅蓝底上几乎看不见，反而比未选中的 gray-500 更难读
        <span className={'text-xs tabular-nums ' + (active ? 'text-brand' : 'text-gray-500')}>{props.count}</span>
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
  const customCategories = useStore((s) => s.customCategories)
  const addCustomCategory = useStore((s) => s.addCustomCategory)
  const removeCustomCategory = useStore((s) => s.removeCustomCategory)
  const moveIds = useStore((s) => s.moveIds)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')

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
        className="w-56 shrink-0 bg-panel border-r border-line flex flex-col overflow-y-auto py-3 text-[13px]"
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
      <div className="px-5 pb-2 text-[11px] font-semibold tracking-wide text-fg3">分类体系</div>
      <Row label="全部文件" cat={null} count={counts.all} icon="all" tip="不过滤的任何图，连瑕疵与废片都在里面，只为了看全貌；导出时不看这里" />
      <Row label="交付库" cat={CAT_LIBRARY} count={counts[CAT_LIBRARY]} icon="library" color={lit(counts[CAT_LIBRARY], '#22c55e')} tip="没被任何缺陷标记的图，默认全部参与导出（人数、黑白这些事实不算缺陷，这里的图照常导出）" />
      <Row label="待确认" cat={CAT_REVIEW} count={counts[CAT_REVIEW]} icon="review" color={lit(counts[CAT_REVIEW], '#eab308')} tip="中置信度 0.7-0.9，需人工复核；默认不导出" />

      {/* 原文案“坏维度（{ref.label}参考）”会把用户撞晕：一是“坏维度”是开发术语，二是 ref.label
          本身已是“仅作参考”，拼接后显示成“仅作参考参考”；改成行业用语，精度档位放进悬停提示 */}
      <Group
        title="瑕疵照片"
        status="bad"
        hint="AI 挑出的毛病，人工可以捞回"
        tip="按缺陷类型归类：闭眼、斜眼、面部狰狞、画面模糊、曝光异常、半截头、重复/连拍。命中任一缺陷即归入对应分类，默认不参与导出；各维度的精度档位悬停在具体分类名上可看"
      >
        {BAD_DIMENSIONS.map((d) => (
          <Row key={d} label={DIMENSION_LABELS[d]} cat={d} count={counts[d]} icon={d} color={lit(counts[d], BAD_DOT_COLORS[d] ?? '#ef4444')} noDrop={d === 'duplicate'} tip={d === 'duplicate' ? '重复/连拍：由聚类自动分组，不可拖入；点入用分组视图选留/废' : `${DIMENSION_LABELS[d]} · 精度档位：${PRECISION_TIERS[dimTier(d)].tip}（灰 = 暂无图片）`} />
        ))}
      </Group>

      {/* 内部叫“中性维度”，对用户说“中性”等同于说“不重要”，他们猜不到里面是人数与黑白；
          直接拿内容命名，并说明白它们不影响好坏、照常导出（这些图本来就属于交付库） */}
      <Group
        title="人物与影调"
        status="normal"
        hint="按人数 / 黑白再分一遍，不代表好坏"
        tip="按画面人数与摆拍结构再分一遍：单人照 / 多人合拍照（人人成排、一起看镜头的摆拍）/ 多人混合照（接亲、做游戏这类人物扎堆但有情节的抓拍）/ 无人物场景，再加黑白影调。只是客观属性，不代表照片好坏，这些图本来就属于交付库、照常参与导出（混合照尤其不要当瑕疵——那是正要交的互动瞬间）。要只交某一类时，勾上这个分类单独导一次即可"
      >
        {NEUTRAL_DIMENSIONS.map((d) => (
          <Row key={d} label={DIMENSION_LABELS[d]} cat={d} count={counts[d]} icon={d} color={lit(counts[d], NEUTRAL_DOT_COLOR)} tip={`${DIMENSION_LABELS[d]} · 仅作标签，不影响好坏判定`} />
        ))}
      </Group>

      {/* 行业三档说法（好片 / 瑕疵片 / 废片）里的最后一档：这一组就是“人工丢掉的”，
          比“回收”直白，也能与上面“瑕疵照片（默认不导出）”拉开层次：一个还可能要、一个确定不要 */}
      <Group
        title="废片"
        status="never"
        hint="你亲手丢的，随时可还原"
        tip="你亲手丢掉的图：垃圾桶里的手动废片，以及重复/连拍分组里丢弃的多余帧。它们永不参与导出，也从其它分类视图里消失，但随时可以还原；重新筛选不会动这里的图"
      >
        <Row label="垃圾桶" cat={CAT_TRASH} count={counts[CAT_TRASH]} icon="trash" color={lit(counts[CAT_TRASH], '#e11d48')} tip="用户手动标记的废片，永远不可能被导出；重新筛选不会动这里的图，所以这个数在重筛前后不变" />
        <Row label="重复/连拍-废弃" cat={CAT_DUP_TRASH} count={counts[CAT_DUP_TRASH]} icon="dup_trash" color={lit(counts[CAT_DUP_TRASH], '#9333ea')} noDrop tip="重复分组里被你丢弃的多余图；永不导出、不可拖入，可点入分组视图恢复到重复/连拍；重筛不会动这里的图，所以数不变" />
      </Group>

      <Group
        title="自定义分类"
        status="normal"
        hint="手动归的相册，同样参与导出"
        tip="自己建的相册（如「主桌」「伴娘」）：把图拖进来即归类，跟人数 / 黑白一样属于交付库、正常导出；删除分类时里面的图回归交付库"
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
      <div className="flex-1" />
      </aside>
    </DropCtx.Provider>
  )
}
