/**
 * 判定操作工具栏（现在只有放大弹窗右栏在用；以前还服务过独立的「大图」视图，那个视图已下线）：
 * 普通图：[✕ 不合格 废弃库] [✓ 合格 → 交付库（选档）] [标签管理]
 * 待确认图（D2 §8）：[✕ 不合格 废弃库] [✓ 好图 → 交付库（选档）] [此判定错误（重判面板）]
 * 「移动到」整按钮已下线（用户 10-14）：面板里四项——三档/废弃库/待确认/自定义相册——前两项就是旁边
 * 两个彩色按钮，后两项拖缩略图到左侧栏即可（多选拖一张=整批走），留着一个重复入口反而让人不敢点。
 * 「此判定正确」按钮已下线（用户 10-13 产品判断：真实用户只用“要→交付库 / 不要→废弃库”两个动作，
 *  不会额外去点“判对”）；它的学习职能改出“隐式采样”——放行=该瑕疵误判(wrong)、丢进废弃库=该瑕疵判对(correct)，
 *  两条都从用户真正会点的按钮里自然长出（见 ipc.ts moveOne）。
 * D2 语义：主分类=人数，瑕疵只是标签；“此判定错误”开重判面板（ReviewPanel）：人数单选 + 瑕疵逐项三态。
 * 布局固定为放大弹窗右栏的 2 列网格（此布局不显🏷 标签入口，标签增删已在右栏内联）。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'
import { useOutsideClose } from './useOutsideClose'
import {
  CAT_REVIEW,
  CAT_TRASH,
  DEFAULT_TIER_NAMES,
  flawLevel,
  isTrashLike,
  type CategoryKey,
  type ImageRecord,
  type TierKey
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
  // 档位名（可自定义）：交付库不再是可直接移入的目标，只能移到下面三档之一
  const tierNames = useStore((s) => s.settings.tierNames) ?? DEFAULT_TIER_NAMES
  const openTagManager = useStore((s) => s.openTagManager)
  const openReviewPanel = useStore((s) => s.openReviewPanel)
  const [panel, setPanel] = useState<'none' | 'trash' | 'tier'>('none')
  const anchorRef = useRef<HTMLDivElement>(null)
  const trashBtnRef = useRef<HTMLButtonElement>(null)
  const libBtnRef = useRef<HTMLButtonElement>(null)
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
    // 面板顶部贴自己的触发按钮（废弃库/合格入档）下 5px，而不是整排按钮的底部
    const br = (panel === 'trash' ? trashBtnRef : libBtnRef).current?.getBoundingClientRect()
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

  // 交付库不再是可直接移入的栏（用户 10-13）：面板里列它下面三个档位，选任一档=放行入库+定档
  const tierButtons = (onPick: (cat: CategoryKey) => void, extra: string): JSX.Element => (
    <>
      {([1, 2, 3] as TierKey[]).map((t) => (
        <button key={t} className={`${t === 1 ? 'btn-good' : t === 2 ? 'btn-primary' : 'btn-neutral'} whitespace-nowrap ${extra}`} onClick={() => onPick(`tier:${t}` as CategoryKey)}>
          {tierNames[t - 1] || t}
        </button>
      ))}
    </>
  )

  const btnPad = size === 'lg' ? 'px-3 py-2.5 text-sm' : 'py-1 text-xs'

  // D2 §8：待确认语境（中置信瑕疵派生或手动停泊）换成三按钮组：废弃库 / 好图→交付库 /
  // 此判定错误（重判面板）。图去别的相册一律拖左侧栏，这里不再摆“移动到”。
  const fl = flawLevel(img.tags)
  const inReview = !isTrashLike(img.category) && fl !== 'high' && (img.category === CAT_REVIEW || fl === 'mid')

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
                <div className="text-fg mb-1.5 text-[13px] font-medium">确定把这张图移入废弃库？</div>
                <div className="text-fg3 mb-2.5 leading-relaxed">
                  标签全部保留作为废弃原因；图会从交付库/待确认/自定义和所有维度分类视图消失，只出现在废弃库里，可随时还原。
                </div>
                <div className="flex gap-2">
                  <button
                    className="btn-danger flex-1 !py-1.5 text-xs whitespace-nowrap"
                    onClick={() => {
                      void moveIds([img.id], CAT_TRASH)
                      setPanel('none')
                    }}
                  >
                    确认移入废弃库
                  </button>
                  <button className="btn flex-1 !py-1.5 text-xs" onClick={() => setPanel('none')}>
                    取消
                  </button>
                </div>
              </>
            ) : panel === 'tier' ? (
              <>
                <div className="text-fg mb-1.5 text-[13px] font-medium">放行入交付库 · 选一个档位</div>
                <div className="text-fg3 mb-2.5 leading-relaxed">
                  会清除全部缺陷类标签（闭眼/模糊/曝光/半截头等）、人数与黑白照标签保留，图参与导出；顶栏 ↩ 可撤回。
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {tierButtons((cat) => {
                    void moveIds([img.id], cat)
                    setPanel('none')
                  }, '!py-3 text-sm')}
                </div>
                <button className="btn-ghost text-fg2 text-xs mt-2 w-full text-center" onClick={() => setPanel('none')}>
                  取消
                </button>
              </>
            ) : null}
          </div>,
          document.body
        )}
      <button
        ref={trashBtnRef}
        className={`btn-danger whitespace-nowrap ${btnPad} ${panel === 'trash' ? 'ring-2 ring-bad' : ''}`}
        title="移入废弃库（永不导出，需确认）"
        onClick={() => setPanel((p) => (p === 'trash' ? 'none' : 'trash'))}
      >
        ✕ 不合格 废弃库
      </button>
      {/* 这里不再摆「移动到」：三档 = 下面的绿色按钮，废弃库 = 左边的红色按钮，
          待确认与自定义相册拖左侧栏（用户 10-14） */}
      {/* 复审最高频动作的一步直达：点开后选一个档位（= 放行入该档）。主进程 tier 分支对非交付图走
          与“移到→交付库”同一放行口径（清全部坏维度标签、记误判样本、事实标签保留、category_by=user、可撤回），
          额外一步定档；已在库的图只是改档。图离开本分类后 PreviewModal 自然切下一张 */}
      <button
        ref={libBtnRef}
        className={`btn whitespace-nowrap ${btnPad} bg-emerald-700 hover:bg-emerald-600 text-white border-transparent font-medium ${panel === 'tier' ? 'ring-2 ring-emerald-400' : ''}`}
        title={inReview ? '确认这张没问题：选一个档位即放行入交付库（清除全部存疑/瑕疵标签、参与导出），顶栏 ↩ 可撤回' : '确认这张合格：选一个档位放行入【交付库】（= 移到→交付库，只清除缺陷类标签，人数与黑白照标签保留），顶栏 ↩ 可撤回'}
        onClick={() => setPanel((p) => (p === 'tier' ? 'none' : 'tier'))}
      >
        ✓ {inReview ? '好图' : '合格'} → 交付库 ▴▾
      </button>
      {inReview && (
        <button
          className={`btn whitespace-nowrap ${btnPad} bg-orange-500 hover:bg-orange-600 text-white border-transparent font-medium`}
          title="逐项核对这张图的判定：人数选对归属，瑕疵逐项该有/不该有/不动"
          onClick={() => {
            openReviewPanel([img.id])
            setPanel('none')
          }}
        >
          此判定错误（重判）
        </button>
      )}
      {showTagButton && (
        <button
          className={`btn whitespace-nowrap ${btnPad} bg-brand hover:bg-blue-600 text-white border-transparent font-medium`}
          title="给这一张图增删标签"
          onClick={() => openTagManager([img.id])}
        >
          标签管理
        </button>
      )}
    </div>
  )
}
