/**
 * 空态拖拽导入辅助层：库内无图片时在视图区中央显示引导（ImageView 已显示文案，
 * 此处仅补一个可点击的导入入口：单张/多选图片、文件夹三合一，也可直接拖文件进窗口）
 */
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'

export default function DropZone(): JSX.Element | null {
  const ready = useStore((s) => s.ready)
  const counts = useStore((s) => s.counts)
  const images = useStore((s) => s.images)
  const activeCategory = useStore((s) => s.activeCategory)
  const pickAndImport = useStore((s) => s.pickAndImport)
  const pickAndImportImages = useStore((s) => s.pickAndImportImages)
  const [menu, setMenu] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenu(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  // 仅"全部文件"视图且整个库为空时显示热区
  if (!ready || images.length > 0 || counts.all || activeCategory !== null) return null

  return (
    <div className="absolute inset-0 flex items-end justify-center pb-10 pointer-events-none">
      <div className="relative pointer-events-auto" ref={ref}>
        <button className="btn-primary text-base px-6 py-2.5" onClick={() => setMenu((v) => !v)}>
          导入照片 ▾
        </button>
        {menu && (
          <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-1 z-40 w-52 rounded-md border border-line bg-panel shadow-xl py-1">
            <button
              className="w-full text-left px-3 py-2 text-sm hover:bg-panel2 transition-colors"
              onClick={() => {
                setMenu(false)
                void pickAndImportImages()
              }}
            >
              选择图片…
              <span className="block text-[11px] text-fg3 mt-0.5">单张或 Ctrl/Shift 多选</span>
            </button>
            <button
              className="w-full text-left px-3 py-2 text-sm hover:bg-panel2 transition-colors"
              onClick={() => {
                setMenu(false)
                void pickAndImport()
              }}
            >
              选择文件夹…
              <span className="block text-[11px] text-fg3 mt-0.5">递归导入全部照片</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
