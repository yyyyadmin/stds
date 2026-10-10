/**
 * 图片地址与原图加载共享工具（自 ImageView 抽出）。
 * ImageView 导入了 DuplicateGroupsView，若 DuplicateGroupsView 反向 import ImageView
 * 会形成循环导入，故把 toSrc/viewSrc/useBigSrc/Spinner 提到此叶子模块，双方都从这里引。
 */
import { useEffect, useState } from 'react'
import type { ImageRecord } from '../../../shared/types'

/** localfile 协议 URL（与 preload fileUrl 一致，渲染层直接同步构造） */
export function toSrc(p: string): string {
  return 'localfile://x/' + encodeURIComponent(p)
}

/** 浏览器 <img> 无法直接渲染的格式（RAW/HEIC）：展示时回退到已生成的缩略图预览 */
const UNDISPLAYABLE = new Set(['cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2', 'dng', 'heic', 'heif'])
export function viewSrc(img: ImageRecord): string {
  return UNDISPLAYABLE.has(img.format) && img.thumb ? toSrc(img.thumb) : toSrc(img.path)
}

/**
 * 大图/预览用“原图”加载：普通格式直接加载原文件；RAW/HEIC 由主进程产出高清预览。
 * 先用缩略图占位，原图就绪后无缝替换；仅当加载超过 300ms 才显示“加载原图中”提示（快则不打扰）。
 */
export function useBigSrc(img: ImageRecord | null): { src: string; loading: boolean } {
  const [src, setSrc] = useState<string>(() => (img ? viewSrc(img) : ''))
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!img) {
      setSrc('')
      setLoading(false)
      return
    }
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const fallback = viewSrc(img)
    setSrc(fallback)
    setLoading(false)
    const target: Promise<string> = UNDISPLAYABLE.has(img.format)
      ? window.api.bigPreview(img.id).then((p) => (p ? toSrc(p) : fallback)).catch(() => fallback)
      : Promise.resolve(toSrc(img.path))
    void target.then((t) => {
      if (!alive) return
      if (t === fallback) return
      timer = setTimeout(() => alive && setLoading(true), 300)
      const pre = new Image()
      pre.onload = () => {
        if (!alive) return
        if (timer) clearTimeout(timer)
        setSrc(t)
        setLoading(false)
      }
      pre.onerror = () => {
        if (!alive) return
        if (timer) clearTimeout(timer)
        setLoading(false)
      }
      pre.src = t
    })
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img?.id, img?.path, img?.thumb, img?.format])
  return { src, loading }
}

/** 旋转加载指示器（大图原图加载提示） */
export function Spinner(props: { label: string; dark?: boolean }): JSX.Element {
  return (
    <div className={'flex items-center gap-2 rounded-md px-3 py-1.5 text-xs shadow-lg ' + (props.dark ? 'bg-black/70 text-white' : 'bg-panel/95 border border-line text-fg2')}>
      <span className="w-3.5 h-3.5 rounded-full border-2 border-current/30 border-t-current animate-spin inline-block shrink-0" />
      {props.label}
    </div>
  )
}
