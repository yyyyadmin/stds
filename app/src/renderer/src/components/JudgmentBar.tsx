/**
 * 判定操作工具栏（大图模式 / 放大弹窗共用）：
 * [🗑 垃圾桶] [移动到 ▾] [此判定正确] [🏷 标签]
 * 设计收敛：维度归属完全交给标签（TagEditor 加/删）——加标签即出现在该分类并排第一，
 * 删标签即从该分类消失（主分类是该维度时连带移出）；“移动到”只负责状态分类
 * （成品库/待确认/自定义/垃圾桶），原“此判定错误”与两者重叠，已下线。
 * layout='grid' 供大图右侧栏 2×2 使用（默认横排供弹窗底栏）。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'
import { useOutsideClose } from './useOutsideClose'
import {
  CAT_LIBRARY,
  CAT_REVIEW,
  CAT_TRASH,
  type CategoryKey,
  type ImageRecord
} from '../../../shared/types'

export default function JudgmentBar({
  img,
  layout = 'row',
  size = 'sm',
  showTagButton = true
}: {
  img: ImageRecord
  /** row：弹窗底栏横排；grid：大图右侧栏 2×2 */
  layout?: 'row' | 'grid'
  /** sm：紧凑按钮；lg：大图右侧栏的大按钮 */
  size?: 'sm' | 'lg'
  /** 大图右侧栏已常驻完整标签编辑器，不需要再一个“🏷 标签”入口 */
  showTagButton?: boolean
}): JSX.Element {
  const moveIds = useStore((s) => s.moveIds)
  const correct = useStore((s) => s.correct)
  const customCategories = useStore((s) => s.customCategories)
  const openTagManager = useStore((s) => s.openTagManager)
  const selection = useStore((s) => s.selection)
  const [panel, setPanel] = useState<'none' | 'move' | 'trash'>('none')
  const anchorRef = useRef<HTMLDivElement>(null)
  const moveBtnRef = useRef<HTMLButtonElement>(null)
  const trashBtnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // 选择面板改用 portal + fixed 视口坐标：若留在右栏内，会被 aside 的 overflow 裁切（左侧被挡）
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null)
  // 点面板与按钮以外的任何地方（选别的图、点别的按钮）就自然收起，不必去找「✕ 收起」
  useOutsideClose(panel !== 'none', () => setPanel('none'), anchorRef, panelRef)

  useLayoutEffect(() => {
    if (panel === 'none') {
      setPos(null)
      return
    }
    const r = anchorRef.current?.getBoundingClientRect()
    // 面板顶部贴自己的触发按钮（移动到/垃圾桶）下 5px，而不是整排按钮的底部
    const br = (panel === 'trash' ? trashBtnRef : moveBtnRef).current?.getBoundingClientRect()
    if (!r) return
    // 大图右栏：面板与上方按钮区同宽同左边缘（而不是固定 400 飘在栏外），
    // 顶部贴触发按钮下 5px，允许盖住下方的「此判定正确」（用户预期：面板属于这个按钮）
    if (layout === 'grid') {
      const top = (br?.bottom ?? r.bottom) + 5
      setPos({ left: r.left, top, width: r.width, maxHeight: Math.max(120, window.innerHeight - top - 12) })
      return
    }
    // 普通底栏：垃圾桶确认框小巧地贴在垃圾桶按钮下方；移动面板靠锚点右边缘对齐
    if (panel === 'trash') {
      const w = Math.min(340, window.innerWidth - 24)
      const left = Math.max(12, Math.min((br?.left ?? r.left) - 40, window.innerWidth - w - 12))
      const top = (br?.bottom ?? r.bottom) + 5
      setPos({ left, top, width: w, maxHeight: Math.max(120, window.innerHeight - top - 12) })
      return
    }
    const w = Math.min(440, Math.max(280, window.innerWidth - 24))
    const left = Math.max(12, Math.min(r.right - w, window.innerWidth - w - 12))
    const top = (br?.bottom ?? r.bottom) + 5
    setPos({ left, top, width: w, maxHeight: Math.max(120, window.innerHeight - top - 12) })
  }, [panel, layout])

  // 切换图片时收起面板
  useEffect(() => setPanel('none'), [img.id])

  const doCorrect = (): void => {
    const prim = img.tags && (img.category as string) ? null : null
    void prim
    void correct({
      imageId: img.id,
      action: 'correct',
      origDim: null,
      origConfidence: null
    })
    setPanel('none')
  }

  const targets = (onPick: (cat: CategoryKey) => void): JSX.Element => (
    <>
      <button className="btn col-span-full bg-good/20 border-good/50 text-good py-1 text-xs" onClick={() => onPick(CAT_LIBRARY)}>
        成品库（正常图片，同时清除所有坏维度标签）
      </button>
      <button className="btn col-span-full bg-warn/20 border-warn/50 text-warn py-1 text-xs" onClick={() => onPick(CAT_REVIEW)}>
        移入待确认（同时清除所有坏维度标签）
      </button>
      {customCategories.length > 0 && <div className="col-span-full text-fg3 mt-1">自定义分类：</div>}
      {customCategories.map((c) => (
        <button key={c.id} className="btn py-1 text-xs" onClick={() => onPick(`custom:${c.id}`)}>
          {c.name}
        </button>
      ))}
      <button className="btn py-1 text-xs col-span-full bg-bad/20 border-bad/50 text-bad" onClick={() => setPanel('trash')}>
        移入垃圾桶（保留标签作为废弃原因）
      </button>
    </>
  )

  const btnPad = size === 'lg' ? 'px-3 py-2.5 text-sm' : 'py-1 text-xs'

  return (
    <div ref={anchorRef} className={layout === 'grid' ? 'grid grid-cols-2 gap-2' : 'relative flex items-center gap-2'}>
      {panel !== 'none' &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            className="fixed bg-panel border border-line rounded-lg p-3 overflow-y-auto text-xs fade-in shadow-xl z-[70]"
            style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight }}
          >
            {panel === 'trash' ? (
              <>
                <div className="text-fg mb-1.5 text-[13px] font-medium">确定把这张图移入垃圾桶？</div>
                <div className="text-fg3 mb-2.5 leading-relaxed">
                  标签全部保留作为废弃原因；图会从成品库/待确认/自定义和所有维度分类视图消失，只出现在垃圾桶里，可随时还原。
                </div>
                <div className="flex gap-2">
                  <button
                    className="btn-danger flex-1 !py-1.5 text-xs whitespace-nowrap"
                    onClick={() => {
                      void moveIds([img.id], CAT_TRASH)
                      setPanel('none')
                    }}
                  >
                    确认移入垃圾桶
                  </button>
                  <button className="btn flex-1 !py-1.5 text-xs" onClick={() => setPanel('none')}>
                    取消
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="text-fg3 mb-2">移动到状态分类（维度归类请用🏷 标签）：</div>
                <div className={layout === 'grid' ? 'grid grid-cols-2 gap-1.5' : 'grid grid-cols-3 gap-1.5'}>
                  {targets((cat) => {
                    void moveIds([img.id], cat)
                    setPanel('none')
                  })}
                </div>
                <button className="btn-ghost text-fg2 text-xs mt-2 w-full text-center" onClick={() => setPanel('none')}>
                  ✕ 收起
                </button>
              </>
            )}
          </div>,
          document.body
        )}
      <button
        ref={trashBtnRef}
        className={`btn-danger whitespace-nowrap ${btnPad} ${panel === 'trash' ? 'ring-2 ring-bad' : ''}`}
        title="移入垃圾桶（永不导出，需确认）"
        onClick={() => setPanel((p) => (p === 'trash' ? 'none' : 'trash'))}
      >
        🗑 垃圾桶
      </button>
      <button
        ref={moveBtnRef}
        className={`btn whitespace-nowrap ${btnPad} ${panel === 'move' ? 'border-brand text-brand' : ''}`}
        title="移动到指定分类"
        onClick={() => setPanel((p) => (p === 'move' ? 'none' : 'move'))}
      >
        移动到 ▴▾
      </button>
      <button
        className={`btn bg-emerald-700 hover:bg-emerald-600 text-white border-transparent whitespace-nowrap ${btnPad} ${layout === 'grid' && !showTagButton ? 'col-span-2' : ''}`}
        title="AI 这次分类判对了：图片保持原位不移动，仅记录一条“判对”样本，用于累计后自动微调阈值（每维度累计 200 条修正记录后生效）"
        onClick={doCorrect}
      >
        此判定正确
      </button>
      {showTagButton && (
        <button
          className={`btn whitespace-nowrap ${btnPad} bg-brand hover:bg-blue-600 text-white border-transparent font-medium`}
          title="标签管理：删除标错的标签 / 补上 AI 漏检的标签（添加后图会同时出现在该维度分类并排第一）"
          onClick={() => openTagManager(selection.has(img.id) && selection.size > 1 ? [...selection] : [img.id])}
        >
          {selection.has(img.id) && selection.size > 1 ? '批量标签管理' : '标签管理'}
        </button>
      )}
    </div>
  )
}
