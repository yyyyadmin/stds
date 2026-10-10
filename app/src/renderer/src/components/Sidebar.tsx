/**
 * 侧栏分类树（第三章 3.1）：全部文件 / 成品库 / 待确认 / 7 坏维度 / 5 中性 / 垃圾桶 / 自定义分类
 * 支持把选中的图片拖拽到分类完成多选移动（9.3）
 */
import { useState } from 'react'
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

function Row(props: {
  label: string
  cat: CategoryKey | null
  count?: number
  dot?: string
  tip?: string
  noDrop?: boolean
  onDelete?: () => void
}): JSX.Element {
  const active = useStore((s) => s.activeCategory === props.cat)
  const openCategory = useStore((s) => s.openCategory)
  const selection = useStore((s) => s.selection)
  const moveTo = useStore((s) => s.moveTo)
  const [hover, setHover] = useState(false)
  return (
    <div
      className={
        'group flex items-center gap-2 px-3 py-2 mx-2 rounded-md cursor-pointer text-sm transition-colors ' +
        (active ? 'bg-brand/15 text-brand border border-brand/40 font-semibold' : 'text-fg2 hover:bg-panel2 border border-transparent') +
        (hover ? ' ring-1 ring-brand' : '')
      }
      onClick={() => void openCategory(props.cat)}
      onDragOver={(e) => {
        if (props.noDrop) return
        if (props.cat && e.dataTransfer.types.includes('application/x-image-ids')) {
          e.preventDefault()
          setHover(true)
        }
      }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault()
        setHover(false)
        if (!props.cat || props.noDrop) return
        const raw = e.dataTransfer.getData('application/x-image-ids')
        if (raw) {
          const ids = JSON.parse(raw) as number[]
          if (ids.length) void moveTo(props.cat, false)
        }
      }}
      title={
        props.tip +
        (props.cat && selection.size > 1 ? `（拖入将移动当前选中的 ${selection.size} 张）` : '')
      }
    >
      {props.dot && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: props.dot }} />}
      <span className="flex-1 truncate">{props.label}</span>
      {props.count != null && (
        <span className={'text-xs tabular-nums ' + (active ? 'text-blue-200' : 'text-gray-500')}>{props.count}</span>
      )}
      {props.onDelete && (
        <button
          className="hidden group-hover:block text-gray-500 hover:text-red-400 px-1"
          onClick={(e) => {
            e.stopPropagation()
            props.onDelete?.()
          }}
          title="删除分类（其中图片回归成品库）"
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
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')

  const submitAdd = (): void => {
    if (name.trim()) void addCustomCategory(name.trim())
    setName('')
    setAdding(false)
  }

  return (
    <aside className="w-56 shrink-0 bg-panel border-r border-line flex flex-col overflow-y-auto py-3 text-[13px]">
      <div className="px-4 pb-2 text-gray-500 text-xs">分类体系</div>
      <Row label="全部文件" cat={null} count={counts.all} />
      <Row label="成品库（导出用）" cat={CAT_LIBRARY} count={counts[CAT_LIBRARY]} dot={lit(counts[CAT_LIBRARY], '#22c55e')} tip="未被任何坏维度标记的图" />
      <Row label="待确认" cat={CAT_REVIEW} count={counts[CAT_REVIEW]} dot={lit(counts[CAT_REVIEW], '#eab308')} tip="中置信度 0.7-0.9，需人工复核；默认不导出" />

      <div className="px-4 pt-6 pb-2 text-gray-500 text-xs">坏维度（{PRECISION_TIERS.ref.label}参考）</div>
      {BAD_DIMENSIONS.map((d) => (
        <Row key={d} label={DIMENSION_LABELS[d]} cat={d} count={counts[d]} dot={lit(counts[d], BAD_DOT_COLORS[d] ?? '#ef4444')} noDrop={d === 'duplicate'} tip={d === 'duplicate' ? '重复/连拍：由聚类自动分组，不可拖入；点入用分组视图选留/废' : `${DIMENSION_LABELS[d]} · 精度档位：${PRECISION_TIERS[dimTier(d)].tip}（灰 = 暂无图片）`} />
      ))}

      <div className="px-4 pt-6 pb-2 text-gray-500 text-xs">中性分类</div>
      {NEUTRAL_DIMENSIONS.map((d) => (
        <Row key={d} label={DIMENSION_LABELS[d]} cat={d} count={counts[d]} dot={lit(counts[d], NEUTRAL_DOT_COLOR)} tip={`${DIMENSION_LABELS[d]} · 仅作标签，不影响好坏判定`} />
      ))}

      <div className="px-4 pt-6 pb-2 text-gray-500 text-xs">回收</div>
      <Row label="垃圾桶" cat={CAT_TRASH} count={counts[CAT_TRASH]} dot={lit(counts[CAT_TRASH], '#e11d48')} tip="用户手动标记的废片，永远不可能被导出" />
      <Row label="重复/连拍-废弃" cat={CAT_DUP_TRASH} count={counts[CAT_DUP_TRASH]} dot={lit(counts[CAT_DUP_TRASH], '#9333ea')} noDrop tip="重复分组里被你丢弃的多余图；永不导出、不可拖入，可点入分组视图恢复到重复/连拍" />

      <div className="px-4 pt-6 pb-2 text-gray-500 text-xs flex items-center justify-between">
        <span>自定义分类</span>
        <button
          className="w-6 h-6 -mr-1 shrink-0 rounded-full bg-brand text-white text-lg leading-none font-bold flex items-center justify-center hover:bg-blue-500 active:scale-90 shadow-[0_1px_5px_rgba(59,130,246,0.55)] transition"
          onClick={() => setAdding(true)}
          title="新建自定义分类"
        >
          ＋
        </button>
      </div>
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
          dot={lit(counts[`custom:${c.id}`], '#a855f7')}
          onDelete={() => void removeCustomCategory(c.id)}
        />
      ))}
      <div className="flex-1" />
    </aside>
  )
}
