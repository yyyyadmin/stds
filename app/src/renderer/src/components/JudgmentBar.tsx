/**
 * 判定操作工具栏（现在只有放大弹窗右栏在用；以前还服务过独立的「大图」视图，那个视图已下线）：
 * [🗑 垃圾桶] [移动到 ▾] [✓ 合格 → 交付库] [此判定正确（仅记录）] [🏷 标签]
 * 设计收敛：维度归属完全交给标签（TagEditor 加/删）——加标签即出现在该分类并排第一，
 * 删标签即从该分类消失（主分类是该维度时连带移出）；“移动到”只负责状态分类
 * （交付库/待确认/自定义/垃圾桶），原“此判定错误”与两者重叠，已下线。
 * 布局固定为放大弹窗右栏的 2×2 网格（此布局不显🏷 标签入口，标签增删已在右栏内联）；
 * 以前的横排 'row' 分支服务的是已下线的独立大图视图底栏，全库无调用方，已连根删除。
 * “✓ 合格 → 交付库”与“此判定正确”是一对：前者改归属（清坏标签、可导出、可撤回），后者只写一条学习样本、归属不变。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'
import { useOutsideClose } from './useOutsideClose'
import {
  CAT_LIBRARY,
  CAT_REVIEW,
  CAT_TRASH,
  guessMidDim,
  isBadDim,
  type CategoryKey,
  type DimensionKey,
  type ImageRecord
} from '../../../shared/types'

export default function JudgmentBar({
  img,
  size = 'sm',
  showTagButton = true
}: {
  img: ImageRecord
  /** sm：紧凑按钮；lg：放大弹窗右侧栏的大按钮 */
  size?: 'sm' | 'lg'
  /** 放大弹窗右侧栏已常驻完整标签编辑器，不需要再一个“🏷 标签”入口 */
  showTagButton?: boolean
}): JSX.Element {
  const moveIds = useStore((s) => s.moveIds)
  const correct = useStore((s) => s.correct)
  const customCategories = useStore((s) => s.customCategories)
  const openTagManager = useStore((s) => s.openTagManager)
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
    // 放大弹窗右栏：面板与整条右栏同宽同左边缘（370，而不是比栏窄一截或飘到栏外），
    // 顶部贴触发按钮下 5px，允许盖住下方的「此判定正确」（用户预期：面板属于这个按钮）。
    // 注意锚点 anchorRef 是右栏内部的按钮栅格，与右栏边界之间还隔着 aside 的 p-4 内边距，
    // 所以宽度要左右各补回 16px、左边缘要外移 16px，面板才能与右栏对齐（改 aside 内边距时需同步）
    const asidePad = 16
    const top = (br?.bottom ?? r.bottom) + 5
    setPos({ left: r.left - asidePad, top, width: r.width + asidePad * 2, maxHeight: Math.max(120, window.innerHeight - top - 12) })
  }, [panel])

  // 切换图片时收起面板
  useEffect(() => setPanel('none'), [img.id])

  const doCorrect = (): void => {
    // “判对”样本必须带维度归属：correctionStats 按 orig_dim 分组统计 truePositive 做误检率分母，
    // 以前这里写死 null，样本的 orig_dim 为 NULL 会被 WHERE orig_dim IS NOT NULL 过滤掉——
    // 按了等于没按。口径与 SelectionBar 批量路径（store.correctBatch）一致：
    // 坏维度分类图记该维度；待确认图猜中置信维度；交付库图无维度可归（只计总量不计维度）
    const prim = isBadDim(img.category)
      ? (img.category as DimensionKey)
      : img.category === CAT_REVIEW
        ? ((guessMidDim(img.tags || {}) ?? null) as DimensionKey | null)
        : null
    void correct({
      imageId: img.id,
      action: 'correct',
      origDim: prim,
      origConfidence: prim ? (img.tags?.[prim]?.confidence ?? null) : null
    })
    setPanel('none')
  }

  const targets = (onPick: (cat: CategoryKey) => void): JSX.Element => (
    <>
      <button className="btn col-span-full bg-good/20 border-good/50 text-good py-1 text-xs" onClick={() => onPick(CAT_LIBRARY)}>
        交付库（正常图片，同时清除缺陷类标签）
      </button>
      <button className="btn col-span-full bg-warn/20 border-warn/50 text-warn py-1 text-xs" onClick={() => onPick(CAT_REVIEW)}>
        移入待确认（同时清除缺陷类标签）
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
    <div ref={anchorRef} className="grid grid-cols-2 gap-2">
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
                  标签全部保留作为废弃原因；图会从交付库/待确认/自定义和所有维度分类视图消失，只出现在垃圾桶里，可随时还原。
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
                <div className="grid grid-cols-2 gap-1.5">
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
      {/* 复审最高频动作的一步直达：等同于“移动到 → 交付库”（同一代码路径，同样只清掉全部坏
          维度标签、人数与黑白等事实标签保留、category_by=user、可被顶栏 ↩ 撤回），
          只是省掉展开面板两跳。图离开本分类后 PreviewModal 会自然切到下一张，所以复审时可以一直点不松手 */}
      <button
        className={`btn whitespace-nowrap ${btnPad} bg-emerald-700 hover:bg-emerald-600 text-white border-transparent font-medium`}
        title="确认这张合格，一步移入【交付库】（= 移动到 → 交付库）：只清除缺陷类标签（闭眼/模糊/曝光/半截头等），人数与黑白照标签保留，以后还能按单人照单独导出；点完自动看下一张，顶栏 ↩ 可撤回"
        onClick={() => {
          void moveIds([img.id], CAT_LIBRARY)
          setPanel('none')
        }}
      >
        ✓ 合格 → 交付库
      </button>
      <button
        className={`btn whitespace-nowrap ${btnPad} bg-emerald-700 hover:bg-emerald-600 text-white border-transparent`}
        title="AI 这次分类判对了：图片保持原位不移动（待确认的图仍然留在待确认，要清掉它请用左边的“✓ 合格 → 交付库”），仅记录一条“判对”样本，用于累计后自动微调阈值（每维度累计 200 条修正记录后生效）"
        onClick={doCorrect}
      >
        {/* 大图右栏是 2 列栅格（每格约 165px），“此判定正确（仅记录）”同字号放不进
            一行会折行；把补充说明降一号，既保一行又不丢信息 */}
        此判定正确<span className="text-[11px] opacity-80">（仅记录）</span>
      </button>
      {showTagButton && (
        <button
          className={`btn whitespace-nowrap ${btnPad} bg-brand hover:bg-blue-600 text-white border-transparent font-medium`}
          title="标签管理（仅当前这张图）：删除标错的标签 / 补上 AI 漏检的标签（添加后图会同时出现在该维度分类并排第一）"
          onClick={() => openTagManager([img.id])}
        >
          标签管理
        </button>
      )}
    </div>
  )
}
