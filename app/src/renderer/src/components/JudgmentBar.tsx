/**
 * 判定操作工具栏（大图模式 / 放大弹窗共用）：
 * [🗑 垃圾桶] [移动到 ▾] [此判定正确] [此判定错误 ▾]
 * 移动 = 纯手动归类（AI 不再覆盖）；判定错误 = 修正流程（记入修正学习并移动）。
 */
import { useEffect, useState } from 'react'
import { useStore } from '../store'
import {
  BAD_DIMENSIONS,
  CAT_LIBRARY,
  CAT_REVIEW,
  CAT_TRASH,
  DIMENSION_LABELS,
  NEUTRAL_DIMENSIONS,
  guessMidDim,
  isBadDim,
  midConf,
  type CategoryKey,
  type DimensionKey,
  type ImageRecord
} from '../../../shared/types'

export default function JudgmentBar({ img }: { img: ImageRecord }): JSX.Element {
  const moveIds = useStore((s) => s.moveIds)
  const correct = useStore((s) => s.correct)
  const customCategories = useStore((s) => s.customCategories)
  const [panel, setPanel] = useState<'none' | 'move' | 'wrong'>('none')

  // 切换图片时收起面板
  useEffect(() => setPanel('none'), [img.id])

  const primaryDim = isBadDim(img.category) ? (img.category as DimensionKey) : null
  const primaryTag = primaryDim ? img.tags[primaryDim] : null
  const origDim = primaryDim || (img.category === CAT_REVIEW ? guessMidDim(img.tags) : null)
  const origConfidence = primaryTag?.confidence ?? midConf(img.tags)

  const doCorrect = (action: 'correct' | 'wrong', target?: CategoryKey): void => {
    void correct({ imageId: img.id, action, origDim, origConfidence, targetCategory: target })
    setPanel('none')
  }

  const targets = (onPick: (cat: CategoryKey) => void): JSX.Element => (
    <>
      <button className="btn col-span-3 bg-good/20 border-good/50 text-good py-1 text-xs" onClick={() => onPick(CAT_LIBRARY)}>
        成品库（正常图片）
      </button>
      <button className="btn col-span-3 bg-warn/20 border-warn/50 text-warn py-1 text-xs" onClick={() => onPick(CAT_REVIEW)}>
        移入待确认
      </button>
      <div className="col-span-3 text-fg3 mt-1">坏维度 / 中性分类：</div>
      {[...BAD_DIMENSIONS, ...NEUTRAL_DIMENSIONS].map((d) => (
        <button key={d} className="btn py-1 text-xs" onClick={() => onPick(d)}>
          {DIMENSION_LABELS[d]}
        </button>
      ))}
      {customCategories.map((c) => (
        <button key={c.id} className="btn py-1 text-xs" onClick={() => onPick(`custom:${c.id}`)}>
          {c.name}
        </button>
      ))}
      <button className="btn py-1 text-xs col-span-3 bg-bad/20 border-bad/50 text-bad" onClick={() => onPick(CAT_TRASH)}>
        移入垃圾桶（永不导出）
      </button>
    </>
  )

  return (
    <div className="relative flex items-center gap-2">
      {panel !== 'none' && (
        <div className="absolute bottom-full right-0 mb-2 bg-panel border border-line rounded-lg p-3 w-96 max-h-[70vh] overflow-y-auto text-xs fade-in shadow-xl z-30">
          <div className="text-fg3 mb-2">{panel === 'move' ? '移动到分类（手动放置，AI 不再覆盖）：' : '选择正确归属（记入修正学习）：'}</div>
          <div className="grid grid-cols-3 gap-1.5">
            {targets((cat) => {
              if (panel === 'move') void moveIds([img.id], cat)
              else doCorrect('wrong', cat)
              setPanel('none')
            })}
          </div>
          <button className="btn-ghost text-fg3 text-xs mt-2" onClick={() => setPanel('none')}>✕ 收起</button>
        </div>
      )}
      <button
        className="btn-danger text-xs whitespace-nowrap"
        title="移入垃圾桶（永不导出）"
        onClick={() => void moveIds([img.id], CAT_TRASH)}
      >
        🗑 垃圾桶
      </button>
      <button
        className={'btn text-xs whitespace-nowrap ' + (panel === 'move' ? 'border-brand text-brand' : '')}
        title="移动到指定分类"
        onClick={() => setPanel((p) => (p === 'move' ? 'none' : 'move'))}
      >
        移动到 ▴▾
      </button>
      <button
        className="btn bg-emerald-700 hover:bg-emerald-600 text-white border-transparent text-xs whitespace-nowrap"
        onClick={() => doCorrect('correct')}
      >
        此判定正确
      </button>
      <button
        className={'btn bg-orange-700 hover:bg-orange-600 text-white border-transparent text-xs whitespace-nowrap ' + (panel === 'wrong' ? 'ring-2 ring-orange-400' : '')}
        onClick={() => setPanel((p) => (p === 'wrong' ? 'none' : 'wrong'))}
      >
        此判定错误
      </button>
    </div>
  )
}
