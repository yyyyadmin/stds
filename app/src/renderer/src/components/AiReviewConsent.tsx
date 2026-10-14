/**
 * AI 复审首次开启的应用内授权弹窗（Electron 铁律：绝不用 window.confirm）。
 *
 * 讲清三件事（spec §7.2）：复审是什么、只读不改、点采纳才生效且可撤回；
 * 以及"照片会压缩后直连云端 AI、不经过第三方"的凭证与去向边界。同意才落 consent+enabled。
 */
import { useEffect } from 'react'
import { useStore } from '../store'

export default function AiReviewConsent(): JSX.Element | null {
  const open = useStore((s) => s.showAiReviewConsent)
  const agree = useStore((s) => s.agreeAiReviewConsent)
  const dismiss = useStore((s) => s.dismissAiReviewConsent)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, dismiss])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4"
      onClick={(e) => e.target === e.currentTarget && dismiss()}
    >
      <div className="w-full max-w-md rounded-xl border border-line bg-panel shadow-2xl fade-in">
        <div className="px-5 py-4 border-b border-line">
          <div className="text-base font-bold text-fg">开启 AI 复审？</div>
          <div className="mt-0.5 text-xs text-fg3">会员专属 · 给「待确认 / 瑕疵片」照片做第二次筛选</div>
        </div>
        <div className="px-5 py-4 text-sm leading-relaxed text-fg2 space-y-3">
          <p>
            复审会用云端 AI 逐张复核<strong className="text-fg">待确认</strong>和<strong className="text-fg">瑕疵片</strong>
            里拿不准的照片，重点看<strong className="text-fg">人数</strong>和<strong className="text-fg">闭眼 / 半截头 / 表情崩坏</strong>这类内容问题。
          </p>
          <ul className="space-y-1.5">
            <li className="flex gap-2">
              <span className="mt-[7px] h-[5px] w-[5px] shrink-0 rounded-full bg-good" />
              <span>
                <strong className="text-fg">只给建议，绝不自动改判定</strong>
                ：不会自动改分类、入库或覆盖标签，一切以现有 AI 结果为准。
              </span>
            </li>
            <li className="flex gap-2">
              <span className="mt-[7px] h-[5px] w-[5px] shrink-0 rounded-full bg-good" />
              <span>
                <strong className="text-fg">你点「采纳」才生效</strong>
                ，采纳后仍可像平时移动 / 改标签一样逐张撤回。
              </span>
            </li>
            <li className="flex gap-2">
              <span className="mt-[7px] h-[5px] w-[5px] shrink-0 rounded-full bg-brand" />
              <span>照片会被压缩到较小尺寸后直连云端 AI 复核，画质型问题（模糊 / 曝光 / 黑白）本地已判，不在复审范围。</span>
            </li>
          </ul>
        </div>
        <div className="px-5 py-4 flex justify-end gap-2 border-t border-line">
          <button className="btn text-sm" onClick={dismiss}>
            先不开
          </button>
          <button className="btn-primary text-sm px-4 whitespace-nowrap" onClick={agree}>
            同意并开启
          </button>
        </div>
      </div>
    </div>
  )
}
