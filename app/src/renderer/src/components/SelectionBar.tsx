/**
 * 多选浮动操作栏（第九章 9.3）：选中后底部浮出
 * - "已选中 N 张" + 取消选择 / 反选
 * - 移动到：成品库 / 待确认 / 坏维度 / 中性 / 自定义 / 垃圾桶（下拉面板）
 * - 待确认区快捷操作："确认好图"（进成品库）/ "确认坏图"（移垃圾桶）
 * - 物理移动开关 + 快捷键提示
 */
import { useState } from 'react'
import { useStore } from '../store'
import {
  BAD_DIMENSIONS,
  CAT_LIBRARY,
  CAT_REVIEW,
  CAT_TRASH,
  DIMENSION_LABELS,
  NEUTRAL_DIMENSIONS
} from '../../../shared/types'

export default function SelectionBar(): JSX.Element | null {
  const selection = useStore((s) => s.selection)
  const activeCategory = useStore((s) => s.activeCategory)
  const viewMode = useStore((s) => s.viewMode)
  const images = useStore((s) => s.images)
  const customCategories = useStore((s) => s.customCategories)
  const moveTo = useStore((s) => s.moveTo)
  const selectNone = useStore((s) => s.selectNone)
  const invertSelection = useStore((s) => s.invertSelection)
  const selectAll = useStore((s) => s.selectAll)
  const [panel, setPanel] = useState(false)
  const [physical, setPhysical] = useState(false)

  if (!selection.size) return null
  const n = selection.size
  const inTrash = activeCategory === CAT_TRASH
  const inReview = activeCategory === CAT_REVIEW
  const allSelected = n === images.length && images.length > 0
  // "确认坏图"：把选中图各自的中置信度维度聚合，取出现最多的维度作为目标分类（无则垃圾桶）
  const reviewDim = (() => {
    const count: Record<string, number> = {}
    for (const img of images) {
      if (!selection.has(img.id)) continue
      for (const [d, t] of Object.entries(img.tags || {})) {
        if (t && t.level !== 'low' && BAD_DIMENSIONS.includes(d as never)) count[d] = (count[d] || 0) + 1
      }
    }
    let best: string | null = null
    for (const [d, c] of Object.entries(count)) if (!best || c > count[best]) best = d
    return best
  })()

  return (
    <div className={'fixed bottom-0 left-0 right-0 z-30 flex justify-center pointer-events-none ' + (viewMode === 'large' ? 'pb-28' : 'pb-3')}>
      <div className="pointer-events-auto bg-panel border border-line rounded-xl shadow-2xl px-3 py-2 flex items-center gap-2 text-sm fade-in max-w-[92vw]">
        <span className="text-fg whitespace-nowrap">
          已选中 <b className="text-brand tabular-nums">{n}</b> 张
        </span>
        <button className="btn-ghost text-xs" onClick={selectNone} title="取消选择（Esc 也可）">取消</button>
        <button className="btn-ghost text-xs" onClick={invertSelection} title="反选当前视图">反选</button>
        <button className="btn-ghost text-xs" onClick={allSelected ? selectNone : selectAll} title="全选/取消全选（Ctrl+A）">
          {allSelected ? '取消全选' : '全选'}
        </button>

        {inTrash ? (
          <button className="btn" onClick={() => void useStore.getState().restoreFromTrash()} title="从垃圾桶还原回成品库">
            ♻️ 还原
          </button>
        ) : (
          <button className="btn-danger" onClick={() => void moveTo(CAT_TRASH)} title="移入垃圾桶（Delete）">
            🗑 垃圾桶
          </button>
        )}

        {inReview && (
          <>
            <button
              className="btn bg-emerald-700 hover:bg-emerald-600 text-white border-transparent"
              onClick={() => void moveTo(CAT_LIBRARY)}
              title="确认是好图 → 移入【成品库】（可导出、不进坏图分类）"
            >
              ✓ 好图 → 成品库
            </button>
            <button
              className="btn bg-orange-700 hover:bg-orange-600 text-white border-transparent"
              onClick={() => void moveTo(reviewDim || CAT_TRASH)}
              title={
                reviewDim
                  ? `确认是坏图 → 移入【${DIMENSION_LABELS[reviewDim as keyof typeof DIMENSION_LABELS]}】分类（永不导出）`
                  : '确认是坏图 → 移入【垃圾桶】（永不导出）'
              }
            >
              ✗ 坏图 → {reviewDim ? DIMENSION_LABELS[reviewDim as keyof typeof DIMENSION_LABELS] : '垃圾桶'}
            </button>
          </>
        )}

        <div className="relative">
          <button className="btn-primary" onClick={() => setPanel((v) => !v)}>
            移动到 ▾
          </button>
          {panel && (
            <div className="absolute bottom-full mb-2 right-0 w-80 max-h-80 overflow-y-auto bg-panel border border-line rounded-lg shadow-2xl p-2 grid grid-cols-3 gap-1 text-xs fade-in">
              <button className="btn col-span-3 bg-good/20 border-good/50 text-good" onClick={() => { void moveTo(CAT_LIBRARY, physical); setPanel(false) }}>
                成品库（正常图片）
              </button>
              <button className="btn col-span-3 bg-warn/20 border-warn/50 text-warn" onClick={() => { void moveTo(CAT_REVIEW, physical); setPanel(false) }}>
                待确认
              </button>
              <div className="col-span-3 text-gray-500 mt-1">坏维度：</div>
              {BAD_DIMENSIONS.map((d) => (
                <button key={d} className="btn py-1" onClick={() => { void moveTo(d, physical); setPanel(false) }}>
                  {DIMENSION_LABELS[d]}
                </button>
              ))}
              <div className="col-span-3 text-gray-500 mt-1">中性：</div>
              {NEUTRAL_DIMENSIONS.map((d) => (
                <button key={d} className="btn py-1" onClick={() => { void moveTo(d, physical); setPanel(false) }}>
                  {DIMENSION_LABELS[d]}
                </button>
              ))}
              {customCategories.length > 0 && <div className="col-span-3 text-gray-500 mt-1">自定义：</div>}
              {customCategories.map((c) => (
                <button key={c.id} className="btn py-1" onClick={() => { void moveTo(`custom:${c.id}`, physical); setPanel(false) }}>
                  {c.name}
                </button>
              ))}
              <div className="col-span-3 mt-1">
                <label className="flex items-center gap-1.5 text-gray-400 cursor-pointer">
                  <input type="checkbox" checked={physical} onChange={(e) => setPhysical(e.target.checked)} />
                  同时移动物理文件（复制到原目录/筛图结果/分类名/，不删除原图）
                </label>
              </div>
            </div>
          )}
        </div>

        <span className="text-[10px] text-gray-600 hidden md:inline whitespace-nowrap">
          也可直接拖拽缩略图到左侧分类
        </span>
      </div>
    </div>
  )
}
