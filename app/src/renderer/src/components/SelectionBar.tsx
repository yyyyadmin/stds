/**
 * 多选浮动操作栏（第九章 9.3）：选中后底部浮出
 * - "已选中 N 张" + 取消选择 / 反选 / 全选
 * - 移动到：只负责状态分类（成品库/待确认/自定义/垃圾桶），维度归类交给🏷 标签管理器
 * - 垃圾桶：单选（1 张）直接移；多选（≥2 张）弹确认框（与大图模式同语义），防批量误废
 * - 🏷 标签：对全部选中图批量增删标签（加标签=同时出现在该维度分类，不是移动）
 * - 待确认区快捷操作："确认好图"（进成品库）/ "确认坏图"（移入命中的维度/垃圾桶）
 * - 物理移动开关 + 快捷键提示
 */
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { useOutsideClose } from './useOutsideClose'
import {
  BAD_DIMENSIONS,
  CAT_LIBRARY,
  CAT_REVIEW,
  CAT_TRASH,
  DIMENSION_LABELS
} from '../../../shared/types'

export default function SelectionBar(): JSX.Element | null {
  const selection = useStore((s) => s.selection)
  const activeCategory = useStore((s) => s.activeCategory)
  const viewMode = useStore((s) => s.viewMode)
  const previewId = useStore((s) => s.previewId)
  const images = useStore((s) => s.images)
  const customCategories = useStore((s) => s.customCategories)
  const moveTo = useStore((s) => s.moveTo)
  const trashAsk = useStore((s) => s.trashAsk)
  const askTrash = useStore((s) => s.askTrash)
  const confirmTrashAsk = useStore((s) => s.confirmTrashAsk)
  const dismissTrashAsk = useStore((s) => s.dismissTrashAsk)
  const correctBatch = useStore((s) => s.correctBatch)
  const openTagManager = useStore((s) => s.openTagManager)
  const selectNone = useStore((s) => s.selectNone)
  const invertSelection = useStore((s) => s.invertSelection)
  const selectAll = useStore((s) => s.selectAll)
  const [panel, setPanel] = useState(false)
  const [physical, setPhysical] = useState(false)
  const moveWrapRef = useRef<HTMLDivElement>(null)
  const trashWrapRef = useRef<HTMLDivElement>(null)
  const trashPanelRef = useRef<HTMLDivElement>(null)
  // 点“移动到”面板以外的任何地方（选图、点其它按钮）自然收起
  useOutsideClose(panel, () => setPanel(false), moveWrapRef)
  // 确认框同样点外即关（取消）
  useOutsideClose(trashAsk != null, () => dismissTrashAsk(), trashWrapRef, trashPanelRef)
  // 选中数掉回 1 张以下（Esc/清空选择）时，残留的确认框自动关闭
  useEffect(() => {
    if (trashAsk && selection.size < 2) dismissTrashAsk()
  }, [trashAsk, selection.size, dismissTrashAsk])

  // 大图模式／放大弹窗自带判定工具栏，不重复显示此浮动条
  if (!selection.size || viewMode === 'large' || previewId != null) return null
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
    <div className={'fixed bottom-0 left-0 right-0 z-30 flex justify-center pointer-events-none pb-3'}>
      <div className="relative pointer-events-auto bg-panel border border-line rounded-xl shadow-2xl px-3 py-2 flex items-center gap-2 text-sm fade-in max-w-[92vw] flex-wrap">
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
          <div className="relative" ref={trashWrapRef}>
            <button
              className={'btn-danger' + (trashAsk ? ' ring-2 ring-bad' : '')}
              onClick={() => askTrash(false)}
              title="移入垃圾桶（Delete）：单选直接移，多选弹确认"
            >
              🗑 垃圾桶
            </button>
            {/* 多选确认框：向上升起在工具栏上方，文案与大图模式垃圾桶确认一致 */}
            {trashAsk && (
              <div ref={trashPanelRef} className="absolute bottom-full mb-2 left-0 w-[340px] bg-panel border border-line rounded-lg shadow-2xl p-3 z-40 fade-in">
                <div className="text-sm font-bold text-fg mb-1.5">确定把这 {selection.size} 张图移入垃圾桶？</div>
                <div className="text-xs text-fg2 leading-relaxed mb-2.5">
                  标签全部保留作为废弃原因；图会从成品库/待确认/自定义和所有维度分类视图消失，只出现在垃圾桶里，可随时还原。
                </div>
                <div className="flex gap-2">
                  <button className="btn-danger flex-1 text-xs" onClick={confirmTrashAsk}>确认移入垃圾桶</button>
                  <button className="btn text-xs text-fg2" onClick={dismissTrashAsk}>取消</button>
                </div>
              </div>
            )}
          </div>
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

        <div className="relative" ref={moveWrapRef}>
          <button className="btn-primary" onClick={() => setPanel((v) => !v)}>
            移动到 ▾
          </button>
          {panel && (
            <div className="absolute bottom-full mb-2 right-0 w-80 max-h-[70vh] overflow-y-auto bg-panel border border-line rounded-lg shadow-2xl p-2 grid grid-cols-3 gap-1 text-xs fade-in z-40">
              <div className="col-span-3 text-gray-500">状态分类（维度归类请用🏷 标签）：</div>
              <button className="btn col-span-3 bg-good/20 border-good/50 text-good" onClick={() => { void moveTo(CAT_LIBRARY, physical); setPanel(false) }}>
                成品库（正常图片，同时清除所有坏维度标签）
              </button>
              <button className="btn col-span-3 bg-warn/20 border-warn/50 text-warn" onClick={() => { void moveTo(CAT_REVIEW, physical); setPanel(false) }}>
                待确认（同时清除所有坏维度标签）
              </button>
              {customCategories.length > 0 && <div className="col-span-3 text-gray-500 mt-1">自定义：</div>}
              {customCategories.map((c) => (
                <button key={c.id} className="btn py-1" onClick={() => { void moveTo(`custom:${c.id}`, physical); setPanel(false) }}>
                  {c.name}
                </button>
              ))}
              <button className="btn col-span-3 mt-1 bg-bad/20 border-bad/50 text-bad" onClick={() => { setPanel(false); askTrash(physical) }}>
                垃圾桶（保留标签作为废弃原因）
              </button>
              <div className="col-span-3 mt-1">
                <label className="flex items-center gap-1.5 text-gray-400 cursor-pointer">
                  <input type="checkbox" checked={physical} onChange={(e) => setPhysical(e.target.checked)} />
                  同时移动物理文件（复制到原目录/筛图结果/分类名/，不删除原图）
                </label>
              </div>
            </div>
          )}
        </div>

        {/* 批量判定：对选中所有图记录修正学习（与大图/弹窗 JudgmentBar 同源） */}
        <button
          className="btn bg-emerald-700 hover:bg-emerald-600 text-white border-transparent text-xs whitespace-nowrap"
          onClick={() => void correctBatch([...selection], 'correct')}
          title="确认选中图的 AI 判定正确，记录用于阈值微调"
        >
          此判定正确
        </button>
        <button
          className="btn bg-orange-500 hover:bg-orange-600 text-white border-transparent text-xs whitespace-nowrap font-medium"
          onClick={() => openTagManager([...selection])}
          title="标签管理器：对选中的全部图删除标错的标签 / 补上 AI 漏检的标签（添加后图同时出现在该维度分类并排第一，不是移动）"
        >
          {selection.size > 1 ? '批量标签管理' : '标签管理'}
        </button>

        <span className="text-[10px] text-gray-600 hidden md:inline whitespace-nowrap">
          也可直接拖拽缩略图到左侧分类
        </span>
      </div>
    </div>
  )
}
