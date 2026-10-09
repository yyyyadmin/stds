/**
 * 多视图（9.2）：网格(160px 4-6列自适应) / 列表(80px) / 瀑布流(保留比例) / 大图(主区+底部缩略条)
 * 缩略图带 AI 标签 + 置信度分数；单击选中 / Shift 连选 / Ctrl 加选 / 双击放大预览
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore, sortConf } from '../store'
import JudgmentBar from './JudgmentBar'
import type { ImageRecord } from '../../../shared/types'
import { BAD_DIMENSIONS, CAT_LIBRARY, CAT_REVIEW, CAT_TRASH, DIMENSION_LABELS } from '../../../shared/types'
import { dimTagColor } from './Sidebar'

/**
 * 图片上的单个维度标签（坏/中性通用）：
 * 背景色与左侧分类树对应类型的小圆点同色（dimTagColor 单一来源），
 * 白字 + 圆角 5px + 整体阴影，避免图背景杂乱时看不清文字。尺寸保持紧凑。
 */
function DimTag(props: { dim: string; conf: number }): JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[5px] text-[11px] leading-none font-medium text-white shadow-[0_1px_3px_rgba(0,0,0,0.65)]"
      style={{ background: dimTagColor(props.dim) }}
    >
      {DIMENSION_LABELS[props.dim as keyof typeof DIMENSION_LABELS]}
      <span className="opacity-80">{(props.conf * 100).toFixed(0)}</span>
    </span>
  )
}

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

/** 中部视图顶部的后台任务横幅：导入中 / 生成缩略图中（醒目大号品牌色胶囊） */
function BusyBanner(): JSX.Element | null {
  const imp = useStore((s) => s.importProgress)
  const th = useStore((s) => s.thumbsProgress)
  let label: string | null = null
  let pct: number | null = null
  if (imp) {
    label = `导入中 ${imp.done}/${imp.total}，正在登记文件…`
    pct = imp.total ? imp.done / imp.total : null
  } else if (th) {
    label = `正在生成缩略图 ${th.done}/${th.total}…`
    pct = th.total ? th.done / th.total : null
  }
  if (!label) return null
  return (
    <div className="sticky top-0 z-30 flex justify-center py-2 pointer-events-none">
      <div className="flex items-center gap-3 rounded-full bg-brand text-white shadow-2xl ring-2 ring-white/30 px-6 py-3 text-lg font-semibold">
        <span className="w-5 h-5 rounded-full border-[3px] border-white/40 border-t-white animate-spin inline-block shrink-0" />
        <span>{label}</span>
        {pct != null && <span className="tabular-nums text-white/90">{Math.round(pct * 100)}%</span>}
      </div>
    </div>
  )
}

function TagChips({ img }: { img: ImageRecord }): JSX.Element | null {
  const entries = Object.entries(img.tags || {}).filter(([, t]) => t && t.level !== 'low')
  if (!entries.length) return null
  const sorted = entries.sort((a, b) => (b[1]?.confidence || 0) - (a[1]?.confidence || 0))
  return (
    <div className="absolute left-1 bottom-1 right-1 flex flex-wrap gap-1 pointer-events-none">
      {sorted.slice(0, 3).map(([dim, t]) => (
        <DimTag key={dim} dim={dim} conf={t!.confidence} />
      ))}
      {sorted.length > 3 && <span className="chip bg-panel2/90 text-gray-300">+{sorted.length - 3}</span>}
    </div>
  )
}

function StatusRibbon({ img }: { img: ImageRecord }): JSX.Element | null {
  if (img.status === 'pending') return <span className="chip bg-gray-600/80 text-gray-200 absolute right-1 top-1">待筛选</span>
  if (img.status === 'error') return <span className="chip bg-bad/90 text-white absolute right-1 top-1">检测失败</span>
  if (img.status === 'skip') return <span className="chip bg-gray-700/90 text-gray-300 absolute right-1 top-1">无法解码</span>
  if (img.category === CAT_TRASH) return <span className="chip bg-black/70 text-white absolute right-1 top-1">🗑</span>
  if (img.category === CAT_REVIEW) return <span className="chip bg-warn text-white absolute right-1 top-1">待确认</span>
  if (img.category === CAT_LIBRARY) return <span className="absolute right-px top-px w-2 h-2 rounded-full bg-emerald-400 ring-1 ring-white shadow-[0_0_5px_1px_rgba(52,211,153,0.9)]" title="成品库" />
  return null
}

function Thumb({ img, size, index, onClick, onDoubleClick, dragIds, dragging, onDragStart, onDragEnter, onDragEnd, elRef }: {
  img: ImageRecord
  size: number
  index: number
  onClick: (index: number, e: React.MouseEvent) => void
  onDoubleClick: (img: ImageRecord) => void
  dragIds: number[]
  dragging?: boolean
  onDragStart?: (id: number) => void
  onDragEnter?: (e: React.DragEvent, id: number) => void
  onDragEnd?: () => void
  elRef?: (el: HTMLDivElement | null) => void
}): JSX.Element {
  const selected = useStore((s) => s.selection.has(img.id))
  const scanCurrent = useStore((s) => (s.scanProgress?.running ? s.scanProgress.current : ''))
  const isScanning = !!scanCurrent && img.filename === scanCurrent
  const src = img.thumb ? toSrc(img.thumb) : toSrc(img.path)
  return (
    <div
      ref={elRef}
      className={
        'relative rounded-md overflow-hidden bg-panel2 border transition-all duration-150 cursor-pointer group ' +
        (isScanning
          ? 'border-red-500 ring-[3px] ring-red-500 scale-105 z-20 '
          : selected
            ? 'border-brand ring-2 ring-brand shadow-[0_0_0_2px_rgba(59,130,246,0.45)]'
            : 'border-line hover:border-gray-500') +
        (dragging ? ' opacity-40 scale-90' : '')
      }
      style={{ width: size, height: size }}
      draggable
      onDragStart={(e) => {
        const ids = selected ? dragIds : [img.id]
        if (!selected) onClick(index, e)
        e.dataTransfer.setData('application/x-image-ids', JSON.stringify(ids))
        e.dataTransfer.effectAllowed = 'move'
        onDragStart?.(img.id)
      }}
      onDragEnter={(e) => onDragEnter?.(e, img.id)}
      onDragOver={(e) => e.preventDefault()}
      onDragEnd={() => onDragEnd?.()}
      onClick={(e) => onClick(index, e)}
      onDoubleClick={() => onDoubleClick(img)}
      title={`${img.filename}\n${Object.entries(img.tags || {}).filter(([, t]) => t && t.level !== 'low').map(([d, t]) => `${DIMENSION_LABELS[d as keyof typeof DIMENSION_LABELS]} ${(t?.confidence || 0) * 100}%(<${t?.level}>)`).join('\n') || '无坏维度标记'}`}
    >
      <img src={src} loading="lazy" className="w-full h-full object-cover pointer-events-none" alt={img.filename} draggable={false} />
      {selected && <span className="absolute left-1 top-1 w-4 h-4 rounded-full bg-brand text-white text-[10px] flex items-center justify-center">✓</span>}
      {isScanning && <span className="absolute left-1 top-1 z-10 px-1.5 py-0.5 rounded bg-red-500 text-white text-[10px] font-bold animate-pulse shadow">检测中</span>}
      <StatusRibbon img={img} />
      <TagChips img={img} />
    </div>
  )
}

/**
 * 网格视图（可拖拽自由排序）：
 * - 本地维护 id 顺序，拖动时实时换位（拖哪就插到哪），松手回网格才落库
 * - 拖到左侧分类的 move 仍由 Sidebar 处理（同一 dataTransfer），互不干扰
 * - props.images 变化（刷新/换排序）时若非拖动中则重同步本地顺序
 */
function GridView(props: {
  images: ImageRecord[]
  size: number
  click: (index: number, e: React.MouseEvent) => void
  dbl: (img: ImageRecord) => void
  dragIds: number[]
  onReorder: (ids: number[]) => void
}): JSX.Element {
  const [order, setOrder] = useState<number[]>(() => props.images.map((i) => i.id))
  const orderRef = useRef<number[]>(order)
  const [draggingId, setDraggingId] = useState<number | null>(null)
  const draggingRef = useRef<number | null>(null)
  // FLIP 动画用：记录每个缩略图 DOM 与上一次静止位置
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const prevRects = useRef<Map<number, DOMRect>>(new Map())

  const applyOrder = (next: number[]): void => {
    orderRef.current = next
    setOrder(next)
  }

  // 非拖拽期间，外部图片集（内容/排序）变化时重同步
  useEffect(() => {
    if (draggingRef.current != null) return
    applyOrder(props.images.map((i) => i.id))
  }, [props.images])

  // FLIP：order 变化时，让“让位”的相邻缩略图平滑滑到新位置（拖拽中的那张不参与，跟手交给浏览器拖影），
  // 消除网格重排的“瞬间跳格”，换来“自然让位、丝滑插入”的手感
  useLayoutEffect(() => {
    const next = new Map<number, DOMRect>()
    itemRefs.current.forEach((el, id) => {
      if (el) next.set(id, el.getBoundingClientRect())
    })
    next.forEach((rect, id) => {
      if (id === draggingRef.current) return
      const prev = prevRects.current.get(id)
      if (!prev) return
      const dx = prev.left - rect.left
      const dy = prev.top - rect.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return
      const el = itemRefs.current.get(id)
      if (!el) return
      el.style.transition = 'none'
      el.style.transform = `translate(${dx}px, ${dy}px)`
      requestAnimationFrame(() => {
        el.style.transition = 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1)'
        el.style.transform = ''
      })
    })
    prevRects.current = next
  }, [order])

  const byId = useMemo(() => {
    const m = new Map<number, ImageRecord>()
    for (const im of props.images) m.set(im.id, im)
    return m
  }, [props.images])

  const onDragEnter = (e: React.DragEvent, id: number): void => {
    const drag = draggingRef.current
    if (drag == null || drag === id) return
    e.preventDefault()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const after = e.clientX - rect.left > rect.width / 2
    const base = orderRef.current.filter((x) => x !== drag)
    const at = base.indexOf(id)
    if (at < 0) return
    base.splice(after ? at + 1 : at, 0, drag)
    applyOrder(base)
  }

  const ordered = order.map((id) => byId.get(id)).filter(Boolean) as ImageRecord[]

  return (
    <div
      className="grid gap-3 justify-center"
      style={{ gridTemplateColumns: `repeat(auto-fill, ${props.size}px)` }}
      onDragOver={(e) => {
        if (draggingRef.current != null) e.preventDefault()
      }}
      onDrop={(e) => {
        if (draggingRef.current == null) return
        e.preventDefault()
        props.onReorder(orderRef.current)
      }}
    >
      {ordered.map((img, i) => (
        <Thumb
          key={img.id}
          img={img}
          index={i}
          size={props.size}
          dragging={draggingId === img.id}
          onClick={props.click}
          onDoubleClick={props.dbl}
          dragIds={props.dragIds}
          onDragStart={(id) => {
            draggingRef.current = id
            setDraggingId(id)
          }}
          onDragEnter={onDragEnter}
          onDragEnd={() => {
            draggingRef.current = null
            setDraggingId(null)
          }}
          elRef={(el) => {
            if (el) itemRefs.current.set(img.id, el)
            else itemRefs.current.delete(img.id)
          }}
        />
      ))}
    </div>
  )
}

export default function ImageView(): JSX.Element {
  const images = useStore((s) => s.images)
  const viewMode = useStore((s) => s.viewMode)
  const sortKey = useStore((s) => s.sortKey)
  const handleClickSelect = useStore((s) => s.handleClickSelect)
  const openPreview = useStore((s) => s.openPreview)
  const selection = useStore((s) => s.selection)
  const scanProgress = useStore((s) => s.scanProgress)

  const sorted = useMemo(() => {
    const arr = [...images]
    switch (sortKey) {
      case 'name':
        arr.sort((a, b) => a.filename.localeCompare(b.filename, 'zh-CN'))
        break
      case 'name-desc':
        arr.sort((a, b) => b.filename.localeCompare(a.filename, 'zh-CN'))
        break
      case 'conf-asc':
        arr.sort((a, b) => sortConf(a) - sortConf(b))
        break
      case 'conf-desc':
        arr.sort((a, b) => sortConf(b) - sortConf(a))
        break
      case 'time':
        arr.sort((a, b) => b.addedAt - a.addedAt)
        break
      default:
        break
    }
    return arr
  }, [images, sortKey])

  const dragIds = useMemo(() => [...selection], [selection])
  const click = (index: number, e: React.MouseEvent): void => handleClickSelect(index, e)
  const dbl = (img: ImageRecord): void => openPreview(img.id)
  const reorder = useStore((s) => s.reorder)

  // Ctrl + 滚轮缩放网格缩略图尺寸（100–360px），列数仍 auto-fill 自适应；记住上次缩放
  const gridRef = useRef<HTMLDivElement | null>(null)
  const [gridSize, setGridSize] = useState<number>(() => {
    const v = Number(localStorage.getItem('gridSize'))
    return Number.isFinite(v) && v >= 100 && v <= 360 ? v : 160
  })
  useEffect(() => {
    if (viewMode !== 'grid') return
    const el = gridRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setGridSize((prev) => {
        const next = Math.min(360, Math.max(100, prev + (e.deltaY < 0 ? 20 : -20)))
        localStorage.setItem('gridSize', String(next))
        return next
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [viewMode])

  if (!sorted.length) {
    return (
      <div className="h-full overflow-auto flex flex-col items-center justify-center text-fg2 p-6">
        <BusyBanner />
        <div className="w-full max-w-2xl rounded-xl border border-line bg-panel2/50 p-6 fade-in">
          <div className="flex flex-col items-center text-center gap-1">
            <div className="text-5xl">📷</div>
            <div className="text-lg text-fg">拖入照片文件夹，或点击左上角「导入文件夹」</div>
            <div className="text-xs text-fg3">全程本地处理 · 无网络请求</div>
          </div>

          {/* 检测维度：直接复用 BAD_DIMENSIONS + DIMENSION_LABELS，不写死 */}
          <div className="mt-5">
            <div className="text-xs font-medium text-fg3 mb-2">AI 检测维度（命中即归入待修正 / 垃圾桶）</div>
            <div className="flex flex-wrap gap-1.5">
              {BAD_DIMENSIONS.map((d) => (
                <span key={d} className="px-2 py-0.5 rounded-full text-xs bg-bad/10 text-bad border border-bad/20">
                  {DIMENSION_LABELS[d]}
                </span>
              ))}
            </div>
          </div>

          {/* 格式三档：与「导入照片」下拉菜单保持一致 */}
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-line bg-panel p-3">
              <div className="text-xs font-medium text-good mb-1">✓ 推荐（检测最稳）</div>
              <div className="text-xs text-fg2 leading-relaxed">JPG · JPEG · PNG · TIFF · BMP · WebP</div>
              <div className="text-[11px] text-fg3 mt-1 leading-relaxed">直接解码 + EXIF 自动转正，全维度稳定</div>
            </div>
            <div className="rounded-lg border border-line bg-panel p-3">
              <div className="text-xs font-medium text-brand mb-1">✓ 完整支持</div>
              <div className="text-xs text-fg2 leading-relaxed">相机 RAW（CR2/CR3/NEF/ARW/DNG…）· iPhone HEIC · AVIF / JXL</div>
              <div className="text-[11px] text-fg3 mt-1 leading-relaxed">内嵌预览兜底 + 方向解析，全维度可检</div>
            </div>
            <div className="rounded-lg border border-line bg-panel p-3">
              <div className="text-xs font-medium text-fg3 mb-1">✕ 不支持（自动跳过）</div>
              <div className="text-xs text-fg2 leading-relaxed">PSD · AI · SVG · ICO 等设计 / 矢量 / 医疗格式</div>
              <div className="text-[11px] text-fg3 mt-1 leading-relaxed">非照片，无人脸 / EXIF 语义，导入时过滤</div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (viewMode === 'grid') {
    return (
      <div ref={gridRef} className="h-full overflow-auto p-3 fade-in">
        <BusyBanner />
        <GridView images={sorted} size={gridSize} click={click} dbl={dbl} dragIds={dragIds} onReorder={(ids) => void reorder(ids)} />
      </div>
    )
  }

  if (viewMode === 'list') {
    const scanning = scanProgress?.running === true
    const currentName = scanProgress?.current ?? ''
    return (
      <div className="h-full overflow-auto px-2 py-1 fade-in">
        <BusyBanner />
        <table className="w-full text-xs border-separate border-spacing-0">
          <thead>
            <tr className="text-fg3 text-left">
              <th className="sticky top-0 z-10 bg-base px-2 py-1.5 font-medium w-14"></th>
              <th className="sticky top-0 z-10 bg-base px-2 py-1.5 font-medium">文件名</th>
              <th className="sticky top-0 z-10 bg-base px-2 py-1.5 font-medium">AI 标签</th>
              <th className="sticky top-0 z-10 bg-base px-2 py-1.5 font-medium w-36">最高置信度</th>
              <th className="sticky top-0 z-10 bg-base px-2 py-1.5 font-medium w-28">分类</th>
              <th className="sticky top-0 z-10 bg-base px-2 py-1.5 font-medium w-20">状态</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((img, i) => {
              const selected = selection.has(img.id)
              const tags = Object.entries(img.tags || {}).filter(([, t]) => t && t.level !== 'low')
              const isCurrent = scanning && !!currentName && img.filename === currentName
              const conf = sortConf(img)
              const rowBg = isCurrent ? 'bg-red-500/10' : selected ? 'bg-brand/20' : i % 2 ? 'bg-panel2/40' : ''
              return (
                <tr
                  key={img.id}
                  className={'cursor-pointer hover:bg-panel2 ' + rowBg}
                  onClick={(e) => click(i, e)}
                  onDoubleClick={() => dbl(img)}
                >
                  <td className={'border-b border-line/50 px-2 py-1 ' + (isCurrent ? 'border-l-2 border-l-red-500' : 'border-l-2 border-l-transparent')}>
                    <img src={img.thumb ? toSrc(img.thumb) : toSrc(img.path)} loading="lazy" className="w-11 h-11 object-cover rounded-md ring-1 ring-line" alt="" draggable={false} />
                  </td>
                  <td className="border-b border-line/50 px-2 py-1 max-w-[280px] align-middle">
                    <div className="truncate font-mono text-fg2" title={img.path}>{img.filename}</div>
                    {isCurrent && <div className="text-[10px] text-red-500">正在检测…</div>}
                  </td>
                  <td className="border-b border-line/50 px-2 py-1 align-middle">
                    <div className="flex flex-wrap gap-1">
                      {tags.map(([d, t]) => (
                        <DimTag key={d} dim={d} conf={t!.confidence} />
                      ))}
                      {!tags.length && <span className="text-fg3">—</span>}
                    </div>
                  </td>
                  <td className="border-b border-line/50 px-2 py-1 align-middle">
                    <div className="flex items-center gap-2">
                      <span className="tabular-nums w-9 text-right text-fg2">{(conf * 100).toFixed(0)}%</span>
                      <span className="h-1.5 flex-1 min-w-[48px] rounded-full bg-line overflow-hidden">
                        <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.round(conf * 100)}%` }} />
                      </span>
                    </div>
                  </td>
                  <td className="border-b border-line/50 px-2 py-1 align-middle">
                    <span className="inline-flex items-center gap-1.5 text-fg2">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: categoryDotColor(img.category) }} />
                      {categoryLabelShort(img.category)}
                    </span>
                  </td>
                  <td className="border-b border-line/50 px-2 py-1 align-middle">
                    <StatusPill status={img.status} scanning={isCurrent} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  if (viewMode === 'masonry') {
    return (
      <div className="h-full overflow-auto p-3 fade-in">
        <BusyBanner />
        <div style={{ columnGap: 12 }} className="columns-2 md:columns-3 xl:columns-4 2xl:columns-5">
          {sorted.map((img, i) => (
            <div key={img.id} className="mb-3 break-inside-avoid" style={{ breakInside: 'avoid' }}>
              <MasonryThumb img={img} index={i} onClick={click} onDoubleClick={dbl} dragIds={dragIds} />
            </div>
          ))}
        </div>
      </div>
    )
  }

  // large 视图：单张占据主区域 + 底部缩略图条
  return <LargeView sorted={sorted} click={click} dbl={dbl} />
}

function categoryLabelShort(cat: string): string {
  if (cat === 'library') return '成品库'
  if (cat === 'review') return '待确认'
  if (cat === 'trash') return '垃圾桶'
  if (cat.startsWith('custom:')) return '自定义'
  return DIMENSION_LABELS[cat as keyof typeof DIMENSION_LABELS] || cat
}

/** 分类小圆点颜色：与左侧分类树同色（成品=绿 待确认=黄 垃圾=灰 自定义=品牌色 其余走维度色） */
function categoryDotColor(cat: string): string {
  if (cat === CAT_LIBRARY) return 'rgb(var(--c-good))'
  if (cat === CAT_REVIEW) return 'rgb(var(--c-warn))'
  if (cat === CAT_TRASH) return '#6b7280'
  if (cat.startsWith('custom:')) return 'rgb(var(--c-brand))'
  return dimTagColor(cat)
}

/** 列表状态胶囊：检测中（蓝色闪烁）/ 已筛（绿）/ 待筛（灰）/ 失败（红）/ 跳过（黄） */
function StatusPill({ status, scanning }: { status: string; scanning: boolean }): JSX.Element {
  if (scanning) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-medium bg-red-500/15 text-red-500 animate-pulse">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
        检测中
      </span>
    )
  }
  const map: Record<string, { t: string; c: string }> = {
    done: { t: '已筛', c: 'bg-good/15 text-good' },
    pending: { t: '待筛', c: 'bg-fg3/15 text-fg3' },
    error: { t: '失败', c: 'bg-bad/15 text-bad' },
    skip: { t: '跳过', c: 'bg-warn/15 text-warn' }
  }
  const s = map[status] || map.pending
  return <span className={'inline-flex items-center px-1.5 py-0.5 rounded-full text-[11px] font-medium ' + s.c}>{s.t}</span>
}

function MasonryThumb(props: { img: ImageRecord; index: number; onClick: (i: number, e: React.MouseEvent) => void; onDoubleClick: (img: ImageRecord) => void; dragIds: number[] }): JSX.Element {
  const { img, index, onClick, onDoubleClick, dragIds } = props
  const selected = useStore((s) => s.selection.has(img.id))
  const scanCurrent = useStore((s) => (s.scanProgress?.running ? s.scanProgress.current : ''))
  const isScanning = !!scanCurrent && img.filename === scanCurrent
  const ratio = img.width && img.height ? img.width / img.height : 1
  return (
    <div
      className={
        'relative rounded-md overflow-hidden border cursor-pointer ' +
        (isScanning
          ? 'border-red-500 ring-[3px] ring-red-500 scale-105 z-20 '
          : selected
            ? 'border-brand ring-2 ring-brand shadow-[0_0_0_2px_rgba(59,130,246,0.45)]'
            : 'border-line hover:border-gray-500')
      }
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-image-ids', JSON.stringify(selected ? dragIds : [img.id]))
        if (!selected) onClick(index, e)
      }}
      onClick={(e) => onClick(index, e)}
      onDoubleClick={() => onDoubleClick(img)}
    >
      <img src={img.thumb ? toSrc(img.thumb) : toSrc(img.path)} loading="lazy" className="w-full object-cover" style={{ aspectRatio: String(ratio) }} alt={img.filename} draggable={false} />
      {isScanning && <span className="absolute left-1 top-1 z-10 px-1.5 py-0.5 rounded bg-red-500 text-white text-[10px] font-bold animate-pulse shadow">检测中</span>}
      <StatusRibbon img={img} />
      <TagChips img={img} />
    </div>
  )
}

function LargeView({ sorted, click, dbl }: {
  sorted: ImageRecord[]
  click: (i: number, e: React.MouseEvent) => void
  dbl: (img: ImageRecord) => void
}): JSX.Element {
  const largeIndex = useStore((s) => s.largeIndex)
  const setLargeIndex = useStore((s) => s.setLargeIndex)
  const stepLarge = useStore((s) => s.stepLarge)
  const selection = useStore((s) => s.selection)
  const toggleSelect = useStore((s) => s.toggleSelect)
  const idx = Math.min(sorted.length - 1, Math.max(0, largeIndex))
  const cur = sorted[idx]
  const big = useBigSrc(cur ?? null)
  const activeThumbRef = useRef<HTMLDivElement>(null)

  // 进入大图视图即自动选中当前图（切回网格/关闭大图后选中态保留）
  useEffect(() => {
    const c = sorted[Math.min(sorted.length - 1, Math.max(0, useStore.getState().largeIndex))]
    if (c) useStore.setState((s) => { const sel = new Set(s.selection); sel.add(c.id); return { selection: sel } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 切换图片时把当前缩略图滚入可视区（左侧竖排）
  useEffect(() => {
    activeThumbRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [idx])

  // 鼠标滚轮切换上/下一张（节流）
  const wheelLock = useRef(0)
  const onWheel = (e: React.WheelEvent): void => {
    const now = Date.now()
    if (now - wheelLock.current < 220) return
    if (Math.abs(e.deltaY) < 8) return
    wheelLock.current = now
    stepLarge(e.deltaY > 0 ? 1 : -1)
  }

  return (
    <div className="h-full flex flex-col fade-in">
      <BusyBanner />
      <div className="flex-1 min-h-0 flex">
        {/* 左侧：竖排缩略图列表（加宽；滚轮只滚动列表，不切换图片/缩放） */}
        <aside
          className="w-36 shrink-0 overflow-y-auto flex flex-col gap-2 px-2 py-2 bg-panel/60 border-r border-line"
          onWheel={(e) => e.stopPropagation()}
        >
          {sorted.map((img, i) => (
            <div
              key={img.id}
              ref={i === idx ? activeThumbRef : undefined}
              className={
                'shrink-0 aspect-square rounded overflow-hidden border cursor-pointer ' +
                (i === idx ? 'border-brand ring-2 ring-brand shadow-[0_0_0_2px_rgba(59,130,246,0.45)]' : 'border-line hover:border-fg3')
              }
              onClick={(e) => {
                setLargeIndex(i)
                click(i, e)
              }}
              onDoubleClick={() => dbl(img)}
              title={img.filename}
            >
              <img src={img.thumb ? toSrc(img.thumb) : toSrc(img.path)} loading="lazy" className="w-full h-full object-cover" alt="" draggable={false} />
            </div>
          ))}
        </aside>
        {/* 主图区 */}
        <div className="relative flex-1 min-h-0 flex items-center justify-center p-4" onWheel={onWheel} onDoubleClick={() => cur && dbl(cur)}>
          {cur && (
            <>
              <img src={big.src} className="max-w-full max-h-full object-contain" alt={cur.filename} draggable={false} title={`${cur.filename}（双击放大）`} />
              {big.loading && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <Spinner label="加载原图中…" dark />
                </div>
              )}
            </>
          )}
          {/* 左右切换按钮（加大） */}
          <button
            className="absolute left-3 top-1/2 -translate-y-1/2 w-16 h-16 rounded-full bg-black/40 hover:bg-black/70 text-white text-5xl flex items-center justify-center transition-colors disabled:opacity-25 disabled:cursor-not-allowed"
            onClick={() => stepLarge(-1)}
            disabled={idx <= 0}
            title="上一张（← / ↑ / 滚轮向上）"
          >
            ‹
          </button>
          <button
            className="absolute right-3 top-1/2 -translate-y-1/2 w-16 h-16 rounded-full bg-black/40 hover:bg-black/70 text-white text-5xl flex items-center justify-center transition-colors disabled:opacity-25 disabled:cursor-not-allowed"
            onClick={() => stepLarge(1)}
            disabled={idx >= sorted.length - 1}
            title="下一张（→ / ↓ / 滚轮向下）"
          >
            ›
          </button>
          <div className="absolute top-3 left-1/2 -translate-x-1/2 chip bg-black/55 text-white">
            {idx + 1} / {sorted.length}
          </div>
          {/* 右上角：选中开关（与列表多选同步） */}
          {cur && (
            <button
              className={
                'absolute top-3 right-3 px-2.5 py-1.5 rounded-md text-xs border whitespace-nowrap transition-colors ' +
                (selection.has(cur.id)
                  ? 'bg-brand text-white border-brand'
                  : 'bg-black/50 text-white/85 border-white/30 hover:border-white/80')
              }
              onClick={() => toggleSelect(cur.id)}
              title="选中/取消选中（与列表多选同步）"
            >
              {selection.has(cur.id) ? '✓ 已选中' : '☐ 选中'}
            </button>
          )}
        </div>
      </div>
      {/* 底部工具栏：当前图标签 + 判定操作（与放大弹窗同一套） */}
      {cur && (
        <div className="shrink-0 border-t border-line bg-panel/90 px-3 py-2 flex items-center gap-3 flex-wrap">
          <span className="text-xs text-fg3 truncate max-w-44" title={cur.filename}>{cur.filename}</span>
          <TagChipsFixed img={cur} />
          <div className="flex-1" />
          <JudgmentBar img={cur} />
        </div>
      )}
    </div>
  )
}

function TagChipsFixed({ img }: { img: ImageRecord }): JSX.Element | null {
  const entries = Object.entries(img.tags || {}).filter(([, t]) => t && t.level !== 'low')
  if (!entries.length) return null
  return (
    <div className="flex gap-1 flex-wrap justify-center pointer-events-none">
      {entries.map(([d, t]) => (
        <DimTag key={d} dim={d} conf={t!.confidence} />
      ))}
    </div>
  )
}
