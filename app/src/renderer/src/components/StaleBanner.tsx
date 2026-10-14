/**
 * 旧引擎重扫横幅（开发版 + 正式版都显示）
 * 检测到当前引擎签名比库里结果扫出来时的签名新（staleCount>0），就在顶栏下方整宽挂一条
 * “有 N 张还是旧引擎结果，点这里用新引擎重扫”，把“改了规则得重扫才落库”这件事做成软件级提醒：
 * 客户升级到新引擎后会被如实引导重扫，不用自己猜“我是不是用上了新版本”。
 * 扫描进行中不显示（避免与进度条抢视线，跑完 onScanProgress 会自动把计数刷新归零再收起）。
 */
import { useEffect, useState } from 'react'
import { useStore } from '../store'

export default function StaleBanner(): JSX.Element | null {
  const staleReady = useStore((s) => s.staleReady)
  const staleCount = useStore((s) => s.staleCount)
  const scanProgress = useStore((s) => s.scanProgress)
  const engineBusy = useStore((s) => s.engineBusy)
  const rescanStale = useStore((s) => s.rescanStale)
  const [dismissedAt, setDismissedAt] = useState(-1)

  // 计数变化（新的过期图出现）时自动撤销本会话的“关闭”，让横幅重新露脸
  useEffect(() => {
    setDismissedAt(-1)
  }, [staleCount])

  if (!staleReady || staleCount <= 0) return null
  if (scanProgress?.running || engineBusy) return null
  if (dismissedAt === staleCount) return null

  return (
    <div className="shrink-0 flex items-center gap-3 px-4 py-2 bg-amber-900/80 border-b border-amber-700 text-amber-100 text-sm">
      <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 shrink-0 text-amber-300" aria-hidden>
        <path
          fillRule="evenodd"
          d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 6a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 6Zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
          clipRule="evenodd"
        />
      </svg>
      <span className="min-w-0">
        筛选规则已升级，库里有 <b>{staleCount}</b> 张还是按旧规则判的结果，用新引擎重扫后才会更新。
      </span>
      <button
        type="button"
        onClick={() => void rescanStale()}
        className="shrink-0 px-3 py-1 rounded-md bg-amber-500 text-amber-950 font-medium hover:bg-amber-400 transition-colors"
        title="只重扫这批旧引擎结果，你手动放置与废弃库里的图不受影响"
      >
        用新引擎重扫这 {staleCount} 张
      </button>
      <button
        type="button"
        onClick={() => setDismissedAt(staleCount)}
        className="shrink-0 ml-auto px-2 py-1 rounded text-amber-200/80 hover:text-amber-50 hover:bg-amber-800/60 transition-colors"
        title="本次会话内先隐藏"
      >
        稍后
      </button>
    </div>
  )
}
