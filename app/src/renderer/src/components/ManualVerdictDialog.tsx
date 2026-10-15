/**
 * 人工裁定小弹窗：逐张复核右栏「人工裁定本张」的三选一出口（用户 10-14 指定）。
 *
 * 为什么要有它：云端复核只看人数/闭眼/半截头/表情，画面模糊与曝光异常归本地引擎，
 * 而逐张复核弹窗底部只有「采纳 / 不采纳 / 确认采纳」——画质这两项在弹窗里没有出口，
 * 以前只能关掉弹窗、回到卡片底栏找「此判定错误」，路径断了一次。
 *
 * 三条动作口径（一律走既有通道，不自己写库，避免出现第二套归档规则）：
 *  · 合格·入交付库 → moveIds(ids, 'tier:N')：后端按"人工担保放行 + 归档"处理——清掉全部坏维度标签
 *    （记误判样本喂自学习）、主分类落回交付库、定档且 tier_by='user'（重筛不覆盖）。
 *  · 移入废弃库 → moveIds(ids, CAT_TRASH)：给 AI 判的瑕疵记"判对"样本、写 trash_from=当前栏，
 *    废弃库里可按来源还原。
 *  · 稍后再判定 → 只关本弹窗，标签/归属/结案状态一律不动（用户 10-14 拍板），这张继续留在逐张队列。
 *  · 底部灰字「逐项改判」→ 打开 ReviewPanel，只改其中某一项而不决定归档；它现在压在逐张弹窗之上，
 *    主弹窗不关。
 *
 * 层级：z-[80]，与全屏原图遮罩同层（二者不会同时出现）。关闭和三个动作都不关主弹窗；
 * 前两条动作会把这张移出待确认，主弹窗由它自己的队列 effect 顺位到下一张。
 */
import { useState } from 'react'
import { useStore } from '../store'
import { CAT_TRASH, DEFAULT_TIER_NAMES, type ImageRecord, type TierKey } from '../../../shared/types'

/** 档位一句话用途：与侧栏三行、教程中心同一套话，这里只截最短的一段 */
const TIER_HINTS: Record<TierKey, string> = {
  1: '放大精修放心用',
  2: '正常出片够用',
  3: '画面偏软，备选凑数'
}

export default function ManualVerdictDialog({ img, onDismiss, onResolved }: {
  img: ImageRecord
  /** 关本弹窗且不写任何东西（稍后再判定、点背景、Esc、✕ 都走这里） */
  onDismiss: () => void
  /** 已做出归档动作（入档/废弃）后关弹窗：由父级顺位到下一张，避免主弹窗空一帧 */
  onResolved: () => void
}): JSX.Element {
  const moveIds = useStore((s) => s.moveIds)
  const openReviewPanel = useStore((s) => s.openReviewPanel)
  const tierNames = useStore((s) => s.settings.tierNames) ?? DEFAULT_TIER_NAMES
  const [pickingTier, setPickingTier] = useState(false)
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
      onResolved()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-4"
      onClick={(e) => e.target === e.currentTarget && !busy && onDismiss()}
    >
      <div className="w-full max-w-md rounded-xl border border-line bg-panel shadow-2xl fade-in">
        <div className="px-5 py-3 border-b border-line flex items-center gap-3">
          <h3 className="flex-1 min-w-0 text-base font-bold text-fg">
            {pickingTier ? '入交付库哪一档' : '人工裁定本张'}
          </h3>
          <button
            className="shrink-0 text-fg2 hover:text-fg text-lg leading-none px-1 cursor-pointer"
            title="关闭（等同稍后再判定，什么都不改）"
            onClick={() => !busy && onDismiss()}
          >
            ✕
          </button>
        </div>

        <div className="px-5 py-4 space-y-2">
          {!pickingTier ? (
            <>
              <button
                className="btn-primary w-full text-left text-sm px-4 py-2.5"
                disabled={busy}
                title="人工担保放行：撤销这张身上全部瑕疵判定（画面模糊、曝光异常在内），移出待确认并按所选档位进交付库，可逐条撤销"
                onClick={() => setPickingTier(true)}
              >
                合格 · 入交付库
              </button>
              <p className="pb-1 text-xs leading-relaxed text-fg2">
                撤销这张全部瑕疵判定（画面模糊、曝光异常在内），按人数归档到你选的档位。
              </p>

              <button
                className="btn-danger w-full text-left text-sm px-4 py-2.5"
                disabled={busy}
                title="丢进废弃库：保留标签作为废弃原因，可在废弃库按来源还原"
                onClick={() => void run(async () => { await moveIds([img.id], CAT_TRASH) })}
              >
                移入废弃库
              </button>
              <p className="pb-1 text-xs leading-relaxed text-fg2">
                这张不要了：进废弃库并记下丢弃来源，永不导出，随时可从废弃库还原。
              </p>

              <button
                className="btn w-full text-left text-sm px-4 py-2.5"
                disabled={busy}
                title="只关本窗口：标签、归属、结案状态都不动，这张仍在逐张复核队列里"
                onClick={() => !busy && onDismiss()}
              >
                稍后再判定
              </button>
              <p className="text-xs leading-relaxed text-fg2">什么都不改，这张继续留在待确认与本队列里。</p>

              <div className="pt-2 border-t border-line">
                <button
                  className="text-xs text-fg2 hover:text-brand underline underline-offset-2 cursor-pointer"
                  disabled={busy}
                  title="打开逐项判定面板：只改其中某一项瑕疵或换人数归属，不决定这张归档去哪"
                  onClick={() => {
                    onDismiss()
                    openReviewPanel([img.id], img.ai_review)
                  }}
                >
                  逐项改判（不决定归档去向）
                </button>
              </div>
            </>
          ) : (
            <>
              {([1, 2, 3] as TierKey[]).map((t) => (
                <button
                  key={t}
                  className="btn w-full flex items-baseline justify-between gap-3 text-left text-sm px-4 py-2.5"
                  disabled={busy}
                  title={`按「${tierNames[t - 1] || t}」档放行归档`}
                  onClick={() => void run(async () => { await moveIds([img.id], `tier:${t}`) })}
                >
                  <span className="font-semibold text-fg">{tierNames[t - 1] || `档位${t}`}</span>
                  <span className="text-xs text-fg2">{TIER_HINTS[t]}</span>
                </button>
              ))}
              <button
                className="mt-1 text-xs text-fg2 hover:text-brand underline underline-offset-2 cursor-pointer"
                disabled={busy}
                onClick={() => setPickingTier(false)}
              >
                ← 返回
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
