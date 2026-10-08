/**
 * 空态拖拽导入辅助层：库内无图片时在视图区中央显示引导（ImageView 已显示文案，
 * 此处仅补一个可点击的导入热区，点击即打开文件夹选择器）
 */
import { useStore } from '../store'

export default function DropZone(): JSX.Element | null {
  const ready = useStore((s) => s.ready)
  const counts = useStore((s) => s.counts)
  const images = useStore((s) => s.images)
  const activeCategory = useStore((s) => s.activeCategory)
  const pickAndImport = useStore((s) => s.pickAndImport)

  // 仅"全部文件"视图且整个库为空时显示热区
  if (!ready || images.length > 0 || counts.all || activeCategory !== null) return null

  return (
    <div className="absolute inset-0 flex items-end justify-center pb-10 pointer-events-none">
      <button className="btn-primary pointer-events-auto text-base px-6 py-2.5" onClick={() => void pickAndImport()}>
        选择照片文件夹导入
      </button>
    </div>
  )
}
