/**
 * 多选浮动操作栏（第九章 9.3）：选中后底部浮出
 * - "已选中 N 张" + 取消选择 / 反选 / 全选
 * - 「移动到」整按钮已下线（用户 10-14）：面板里四项——三档/废弃库/待确认/自定义相册——
 *   前两项就是旁边两个彩色按钮，后两项拖缩略图到左侧栏即可（多选拖一张=整批走）。
 *   连它独有的「同时移动物理文件」也一并删了：文案写“复制…不删除原图”，但主进程实际是 renameSync
 *   真剪切走原文件，留着反而坑人；物理搬文件只走导出弹窗里那个明写“物理移动（剪切）”的开关。
 * - 废弃库：单选（1 张）直接移；多选（≥2 张）弹确认框（与放大弹窗同语义），防批量误废
 * - 🏷 标签：对全部选中图批量增删标签（加标签=同时出现在该维度分类，不是移动）
 * - 待确认区快捷操作："确认好图"（选档进交付库）/ "确认坏图"（移入命中的维度/废弃库）
 *   其中“进交付库”不限待确认页——在任意坏图分类里判图合格都是最高频动作，常驻（废弃库/重复废弃桶除外，那里已有“还原”）
 * - 待确认页（D2 §8）只留三个出口：好图→交付库 / 坏图→瑕疵维度 / 此判定错误·重判。
 *   “此判定正确”按钮已下线（用户只用“要/不要”两动作）；它的学习职能改由放行(=误判 wrong)、丢废弃库(=判对 correct) 两个真实动作隐式采集（见 ipc.ts moveOne）。
 *   待确认与自定义相册走左侧栏拖拽；物理挪文件只走导出弹窗。
 */
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { useOutsideClose } from './useOutsideClose'
import {
  BAD_DIMENSIONS,
  CAT_LIBRARY,
  CAT_REVIEW,
  CAT_TRASH,
  CAT_DUP_TRASH,
  DEFAULT_TIER_NAMES,
  DIMENSION_LABELS,
  type CategoryKey,
  type TierKey
} from '../../../shared/types'

export default function SelectionBar(): JSX.Element | null {
  const selection = useStore((s) => s.selection)
  const activeCategory = useStore((s) => s.activeCategory)
  const previewId = useStore((s) => s.previewId)
  const images = useStore((s) => s.images)
  const moveTo = useStore((s) => s.moveTo)
  const trashAsk = useStore((s) => s.trashAsk)
  const askTrash = useStore((s) => s.askTrash)
  const confirmTrashAsk = useStore((s) => s.confirmTrashAsk)
  const dismissTrashAsk = useStore((s) => s.dismissTrashAsk)
  const openTagManager = useStore((s) => s.openTagManager)
  const openReviewPanel = useStore((s) => s.openReviewPanel)
  const selectNone = useStore((s) => s.selectNone)
  const invertSelection = useStore((s) => s.invertSelection)
  const selectAll = useStore((s) => s.selectAll)
  // “✓ 合格 → 交付库”不再一步直达：交付库不是可直接移入的栏，点开先选一个档位（用户 10-13）
  const [libPanel, setLibPanel] = useState(false)
  const tierNames = useStore((s) => s.settings.tierNames) ?? DEFAULT_TIER_NAMES
  const libWrapRef = useRef<HTMLDivElement>(null)
  const trashWrapRef = useRef<HTMLDivElement>(null)
  const trashPanelRef = useRef<HTMLDivElement>(null)
  useOutsideClose(libPanel, () => setLibPanel(false), libWrapRef)
  // 确认框同样点外即关（取消）
  useOutsideClose(trashAsk != null, () => dismissTrashAsk(), trashWrapRef, trashPanelRef)
  // 选中数掉回 1 张以下（Esc/清空选择）时，残留的确认框自动关闭
  useEffect(() => {
    if (trashAsk && selection.size < 2) dismissTrashAsk()
  }, [trashAsk, selection.size, dismissTrashAsk])

  // 放大弹窗自带判定工具栏，不重复显示此浮动条（以前还有个大图视图也走这个判断，那个视图已下线）
  if (!selection.size || previewId != null) return null
  const n = selection.size
  const inTrash = activeCategory === CAT_TRASH
  const inDupTrash = activeCategory === CAT_DUP_TRASH
  const inReview = activeCategory === CAT_REVIEW
  const allSelected = n === images.length && images.length > 0
  // "确认坏图"：把选中图各自的中置信度维度聚合，取出现最多的维度作为目标分类（无则废弃库）
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
          <button className="btn" onClick={() => void useStore.getState().restoreFromTrash()} title="从废弃库还原回交付库">
            ♻️ 还原
          </button>
        ) : !inReview ? (
          <div className="relative" ref={trashWrapRef}>
            <button
              className={'btn-danger' + (trashAsk ? ' ring-2 ring-bad' : '')}
              onClick={() => askTrash(false)}
              title="移入废弃库（Delete）：单选直接移，多选弹确认"
            >
              ✕ 不合格 废弃库
            </button>
            {/* 多选确认框：向上升起在工具栏上方，文案与放大弹窗的废弃库确认一致 */}
            {trashAsk && (
              <div ref={trashPanelRef} className="absolute bottom-full mb-2 left-0 w-[340px] bg-panel border border-line rounded-lg shadow-2xl p-3 z-40 fade-in">
                <div className="text-sm font-bold text-fg mb-1.5">确定把这 {selection.size} 张图移入废弃库？</div>
                <div className="text-xs text-fg2 leading-relaxed mb-2.5">
                  标签全部保留作为废弃原因；图会从交付库/待确认/自定义和所有维度分类视图消失，只出现在废弃库里，可随时还原。
                </div>
                <div className="flex gap-2">
                  <button className="btn-danger flex-1 text-xs" onClick={confirmTrashAsk}>确认移入废弃库</button>
                  <button className="btn text-xs text-fg2" onClick={dismissTrashAsk}>取消</button>
                </div>
              </div>
            )}
          </div>
        ) : null}

        {/* “判合格→交付库”常驻：以前只在待确认页有，在闭眼/模糊等坏图页判误判得先绕两跳。
            废弃库与重复废弃桶不显（那里已有♻️ 还原）、交付库页本身不显（图已在此）。
            交付库不再是可直接移入的目标，点开先选一个档位（= 放行入该档） */}
        {!inTrash && !inDupTrash && activeCategory !== CAT_LIBRARY && (
          <div className="relative" ref={libWrapRef}>
            <button
              className="btn bg-emerald-700 hover:bg-emerald-600 text-white border-transparent"
              onClick={() => setLibPanel((v) => !v)}
              title={inReview ? '确认是好图：选一个档位放行入【交付库】（可导出、不进坏图分类）' : '确认合格：选一个档位放行入【交付库】（清除缺陷类标签，人数与黑白照标签保留）'}
            >
              {inReview ? '✓ 好图 → 交付库' : '✓ 合格 → 交付库'} ▾
            </button>
            {libPanel && (
              <div className="absolute bottom-full mb-2 left-0 w-[340px] bg-panel border border-line rounded-lg shadow-2xl p-2.5 z-40 fade-in">
                <div className="text-xs text-gray-500 mb-2 px-0.5 whitespace-nowrap">放行入交付库·选一个档位（同时清除缺陷类标签）</div>
                <div className="grid grid-cols-3 gap-2">
                  {([1, 2, 3] as TierKey[]).map((t) => (
                    <button key={t} className={`${t === 1 ? 'btn-good' : t === 2 ? 'btn-primary' : 'btn-neutral'} py-2.5 text-sm whitespace-nowrap`} onClick={() => { void moveTo(`tier:${t}` as CategoryKey); setLibPanel(false) }}>
                      {tierNames[t - 1] || t}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        {inReview && (
          <>
            <button
              className="btn bg-orange-700 hover:bg-orange-600 text-white border-transparent"
              onClick={() => void moveTo(reviewDim || CAT_TRASH)}
              title={
                reviewDim
                  ? `确认是坏图 → 移入【${DIMENSION_LABELS[reviewDim as keyof typeof DIMENSION_LABELS]}】分类（永不导出）`
                  : '确认是坏图 → 移入【废弃库】（永不导出）'
              }
            >
              ✗ 坏图 → {reviewDim ? DIMENSION_LABELS[reviewDim as keyof typeof DIMENSION_LABELS] : '废弃库'}
            </button>
          </>
        )}

        {/* 原「移动到 ▾」整按钮已删（用户 10-14）：三档 = 绿色按钮，废弃库 = 红色按钮，
            待确认与自定义相册拖左侧栏那一行即可（多选时拖任意一张，整批一起走） */}

        {inReview && (
          <button
            className="btn bg-orange-500 hover:bg-orange-600 text-white border-transparent text-xs whitespace-nowrap font-medium"
            onClick={() => openReviewPanel([...selection])}
            title="重判面板：批量逐项改正——人数选归属，瑕疵逐项“该有/不该有/不动”（勾加、叉删、没动留，异构批量不压平），提交后离开待确认"
          >
            此判定错误·重判
          </button>
        )}
        {!inReview && (
          <button
            className="btn bg-orange-500 hover:bg-orange-600 text-white border-transparent text-xs whitespace-nowrap font-medium"
            onClick={() => openTagManager([...selection])}
            title="给选中的全部图批量增删标签"
          >
            {selection.size > 1 ? '批量标签管理' : '标签管理'}
          </button>
        )}

        <span className="text-[10px] text-gray-600 hidden md:inline whitespace-nowrap">
          也可拖拽缩略图到左侧任意分类（含待确认、自定义相册；多选时拖一张=整批走）
        </span>
      </div>
    </div>
  )
}
