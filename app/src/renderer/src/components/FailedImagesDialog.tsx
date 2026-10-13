/**
 * 失败照片定位弹窗（第一梯队四件套 D）
 * - 本轮筛选里 status=error（无法解码/引擎异常等）没跑成的照片列出来：文件名 + 所在文件夹
 * - 「重试这 N 张」直接调 startScan：pendingImages() 本就包含 error 行，无需新代码，重跑会再试一次
 * - 仿 UpdateDialog 壳（遮罩点击关闭、主题跟随）
 */
import { useEffect, useState } from 'react'
import { useStore } from '../store'

type FailedItem = { id: number; filename: string; dir: string }

export default function FailedImagesDialog(): JSX.Element {
  const startScan = useStore((s) => s.startScan)
  const scanProgress = useStore((s) => s.scanProgress)
  const close = (): void => useStore.setState({ showFailedImages: false })
  const [items, setItems] = useState<FailedItem[] | null>(null)
  const scanning = !!scanProgress?.running

  useEffect(() => {
    void window.api.listErrorImages().then(setItems)
  }, [])

  const retry = (): void => {
    close()
    void startScan()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="bg-panel border border-line rounded-xl shadow-2xl w-full max-w-lg fade-in flex flex-col max-h-[80vh]">
        <div className="px-5 py-3 border-b border-line flex items-center gap-2">
          <span className="text-lg">⚠️</span>
          <h2 className="text-fg font-bold">这些照片没跑成</h2>
          <span className="ml-auto text-xs text-fg3 tabular-nums">{items ? `${items.length} 张` : '加载中…'}</span>
        </div>

        <div className="px-5 py-3 text-xs text-fg3 leading-relaxed border-b border-line/60">
          筛选时读不出来的照片（比如无法解码的 RAW、文件损坏、或已被移动删除）。它们不会进任何分类，确认原文件还在后点下方「重试」再跑一遍即可。
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3 space-y-1 text-sm">
          {items === null ? (
            <div className="text-fg3 text-center py-6">加载中…</div>
          ) : items.length === 0 ? (
            <div className="text-fg3 text-center py-6">没有失败的照片 ✓</div>
          ) : (
            items.map((it) => (
              <div key={it.id} className="rounded-md bg-panel2 border border-line px-3 py-2">
                <div className="text-fg truncate" title={it.filename}>{it.filename}</div>
                <div className="text-fg3 text-xs truncate" title={it.dir}>{it.dir}</div>
              </div>
            ))
          )}
        </div>

        <div className="px-5 py-4 border-t border-line flex items-center justify-end gap-2">
          <button className="btn-ghost text-fg3 text-sm px-3" onClick={close}>关闭</button>
          <button
            className="btn-primary text-sm px-4 py-1.5 disabled:opacity-50"
            onClick={retry}
            disabled={scanning || !items || items.length === 0}
            title={scanning ? '筛选正在进行中，稍后再重试' : '重新筛选一遍（会把这些失败的再试一次）'}
          >
            {scanning ? '筛选中…' : `重试这 ${items?.length ?? 0} 张`}
          </button>
        </div>
      </div>
    </div>
  )
}
