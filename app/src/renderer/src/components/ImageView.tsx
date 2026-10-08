/**
 * 多视图（9.2）：网格(160px 4-6列自适应) / 列表(80px) / 瀑布流(保留比例) / 大图(主区+底部缩略条)
 * 缩略图带 AI 标签 + 置信度分数；单击选中 / Shift 连选 / Ctrl 加选 / 双击放大预览
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, sortConf } from '../store'
import JudgmentBar from './JudgmentBar'
import type { ImageRecord } from '../../../shared/types'
import { BAD_DIMENSIONS, CAT_REVIEW, CAT_TRASH, DIMENSION_LABELS, isBadDim } from '../../../shared/types'

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

/** 中部视图顶部的后台任务横幅：导入中 / 生成缩略图中 */
function BusyBanner(): JSX.Element | null {
  const imp = useStore((s) => s.importProgress)
  const th = useStore((s) => s.thumbsProgress)
  let label: string | null = null
  if (imp) label = `导入中 ${imp.done}/${imp.total}，正在登记文件…`
  else if (th) label = `生成缩略图中 ${th.done}/${th.total}…`
  if (!label) return null
  return (
    <div className="sticky top-0 z-20 flex justify-center pb-2">
      <Spinner label={label} />
    </div>
  )
}

function TagChips({ img }: { img: ImageRecord }): JSX.Element | null {
  const entries = Object.entries(img.tags || {}).filter(([, t]) => t && t.level !== 'low')
  if (!entries.length) return null
  const sorted = entries.sort((a, b) => (b[1]?.confidence || 0) - (a[1]?.confidence || 0))
  return (
    <div className="absolute left-1 bottom-1 right-1 flex flex-wrap gap-1 pointer-events-none">
      {sorted.slice(0, 3).map(([dim, t]) => {
        const bad = isBadDim(dim)
        const cls = bad
          ? t!.level === 'high'
            ? 'bg-bad/90 text-white'
            : 'bg-warn/90 text-black'
          : 'bg-brand/80 text-white'
        return (
          <span key={dim} className={'chip ' + cls}>
            {DIMENSION_LABELS[dim as keyof typeof DIMENSION_LABELS]}
            <span className="opacity-80">{(t!.confidence * 100).toFixed(0)}</span>
          </span>
        )
      })}
      {sorted.length > 3 && <span className="chip bg-panel2/90 text-gray-300">+{sorted.length - 3}</span>}
    </div>
  )
}

function StatusRibbon({ img }: { img: ImageRecord }): JSX.Element | null {
  if (img.status === 'pending') return <span className="chip bg-gray-600/80 text-gray-200 absolute right-1 top-1">待筛选</span>
  if (img.status === 'error') return <span className="chip bg-bad/90 text-white absolute right-1 top-1">检测失败</span>
  if (img.status === 'skip') return <span className="chip bg-gray-700/90 text-gray-300 absolute right-1 top-1">无法解码</span>
  if (img.category === CAT_TRASH) return <span className="chip bg-black/70 text-white absolute right-1 top-1">🗑</span>
  if (img.category === CAT_REVIEW) return <span className="chip bg-warn/90 text-black absolute right-1 top-1">待确认</span>
  return null
}

function Thumb({ img, size, index, onClick, onDoubleClick, dragIds }: {
  img: ImageRecord
  size: number
  index: number
  onClick: (index: number, e: React.MouseEvent) => void
  onDoubleClick: (img: ImageRecord) => void
  dragIds: number[]
}): JSX.Element {
  const selected = useStore((s) => s.selection.has(img.id))
  const src = img.thumb ? toSrc(img.thumb) : toSrc(img.path)
  return (
    <div
      className={
        'relative rounded-md overflow-hidden bg-panel2 border transition-all cursor-pointer group ' +
        (selected ? 'border-brand ring-2 ring-brand/60' : 'border-line hover:border-gray-500')
      }
      style={{ width: size, height: size }}
      draggable
      onDragStart={(e) => {
        const ids = selected ? dragIds : [img.id]
        if (!selected) onClick(index, e)
        e.dataTransfer.setData('application/x-image-ids', JSON.stringify(ids))
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={(e) => onClick(index, e)}
      onDoubleClick={() => onDoubleClick(img)}
      title={`${img.filename}\n${Object.entries(img.tags || {}).filter(([, t]) => t && t.level !== 'low').map(([d, t]) => `${DIMENSION_LABELS[d as keyof typeof DIMENSION_LABELS]} ${(t?.confidence || 0) * 100}%(<${t?.level}>)`).join('\n') || '无坏维度标记'}`}
    >
      <img src={src} loading="lazy" className="w-full h-full object-cover pointer-events-none" alt={img.filename} draggable={false} />
      {selected && <span className="absolute left-1 top-1 w-4 h-4 rounded-full bg-brand text-white text-[10px] flex items-center justify-center">✓</span>}
      <StatusRibbon img={img} />
      <TagChips img={img} />
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

  if (!sorted.length) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-gray-600 gap-3">
        <BusyBanner />
        <div className="text-5xl">📷</div>
        <div className="text-lg">拖入照片文件夹，或点击左上角「导入文件夹」</div>
        <div className="text-xs text-gray-700">
          支持 JPG / PNG / TIFF / BMP / WebP / HEIC 及主流 RAW · 全程本地处理 · 无网络请求
        </div>
        <div className="text-xs text-gray-700 mt-2">
          坏维度：{BAD_DIMENSIONS.map((d) => DIMENSION_LABELS[d]).join(' / ')}
        </div>
      </div>
    )
  }

  if (viewMode === 'grid') {
    return (
      <div className="h-full overflow-auto p-3 fade-in">
        <BusyBanner />
        <div
          className="grid gap-3 justify-center"
          style={{ gridTemplateColumns: 'repeat(auto-fill, 160px)' }}
        >
          {sorted.map((img, i) => (
            <Thumb key={img.id} img={img} index={i} size={160} onClick={click} onDoubleClick={dbl} dragIds={dragIds} />
          ))}
        </div>
      </div>
    )
  }

  if (viewMode === 'list') {
    return (
      <div className="h-full overflow-auto p-2 fade-in">
        <BusyBanner />
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-gray-500 text-left sticky top-0 bg-base">
              <th className="p-2 w-20"></th>
              <th className="p-2">文件名</th>
              <th className="p-2">AI 标签</th>
              <th className="p-2 w-24">最高置信度</th>
              <th className="p-2 w-24">分类</th>
              <th className="p-2 w-20">状态</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((img, i) => {
              const selected = selection.has(img.id)
              const tags = Object.entries(img.tags || {}).filter(([, t]) => t && t.level !== 'low')
              return (
                <tr
                  key={img.id}
                  className={
                    'cursor-pointer border-b border-line/60 ' + (selected ? 'bg-brand/20' : 'hover:bg-panel2')
                  }
                  onClick={(e) => click(i, e)}
                  onDoubleClick={() => dbl(img)}
                >
                  <td className="p-1">
                    <img src={img.thumb ? toSrc(img.thumb) : toSrc(img.path)} loading="lazy" className="w-16 h-16 object-cover rounded" alt="" draggable={false} />
                  </td>
                  <td className="p-2 max-w-[280px] truncate" title={img.path}>{img.filename}</td>
                  <td className="p-2">
                    <div className="flex flex-wrap gap-1">
                      {tags.map(([d, t]) => (
                        <span
                          key={d}
                          className={'chip ' + (isBadDim(d) ? (t!.level === 'high' ? 'bg-bad/80 text-white' : 'bg-warn/80 text-black') : 'bg-brand/70 text-white')}
                        >
                          {DIMENSION_LABELS[d as keyof typeof DIMENSION_LABELS]} {(t!.confidence * 100).toFixed(0)}
                        </span>
                      ))}
                      {!tags.length && <span className="text-gray-600">—</span>}
                    </div>
                  </td>
                  <td className="p-2 tabular-nums">{(sortConf(img) * 100).toFixed(0)}%</td>
                  <td className="p-2 text-gray-400">{categoryLabelShort(img.category)}</td>
                  <td className="p-2 text-gray-400">{img.status === 'done' ? '已筛' : img.status === 'pending' ? '待筛' : img.status === 'error' ? '失败' : '跳过'}</td>
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

function MasonryThumb(props: { img: ImageRecord; index: number; onClick: (i: number, e: React.MouseEvent) => void; onDoubleClick: (img: ImageRecord) => void; dragIds: number[] }): JSX.Element {
  const { img, index, onClick, onDoubleClick, dragIds } = props
  const selected = useStore((s) => s.selection.has(img.id))
  const ratio = img.width && img.height ? img.width / img.height : 1
  return (
    <div
      className={
        'relative rounded-md overflow-hidden border cursor-pointer ' +
        (selected ? 'border-brand ring-2 ring-brand/60' : 'border-line hover:border-gray-500')
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
                (i === idx ? 'border-brand ring-2 ring-brand/60' : 'border-line hover:border-fg3')
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
        <span key={d} className={'chip ' + (isBadDim(d) ? (t!.level === 'high' ? 'bg-bad/90 text-white' : 'bg-warn/90 text-black') : 'bg-brand/80 text-white')}>
          {DIMENSION_LABELS[d as keyof typeof DIMENSION_LABELS]} {(t!.confidence * 100).toFixed(0)}
        </span>
      ))}
    </div>
  )
}
