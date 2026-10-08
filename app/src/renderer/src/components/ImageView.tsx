/**
 * 多视图（9.2）：网格(160px 4-6列自适应) / 列表(80px) / 瀑布流(保留比例) / 大图(主区+底部缩略条)
 * 缩略图带 AI 标签 + 置信度分数；单击选中 / Shift 连选 / Ctrl 加选 / 双击放大预览
 */
import { useEffect, useMemo, useRef } from 'react'
import { useStore, sortConf } from '../store'
import type { ImageRecord } from '../../../shared/types'
import { BAD_DIMENSIONS, CAT_REVIEW, CAT_TRASH, DIMENSION_LABELS, isBadDim } from '../../../shared/types'

/** localfile 协议 URL（与 preload fileUrl 一致，渲染层直接同步构造） */
export function toSrc(p: string): string {
  return 'localfile://x/' + encodeURIComponent(p)
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
  const idx = Math.min(sorted.length - 1, Math.max(0, largeIndex))
  const cur = sorted[idx]
  const stripRef = useRef<HTMLDivElement>(null)
  const activeThumbRef = useRef<HTMLDivElement>(null)

  // 切换图片时把当前缩略图滚入可视区
  useEffect(() => {
    activeThumbRef.current?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
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
      <div className="relative flex-1 min-h-0 flex items-center justify-center p-4" onWheel={onWheel} onDoubleClick={() => cur && dbl(cur)}>
        {cur && (
          <img src={toSrc(cur.path)} className="max-w-full max-h-full object-contain" alt={cur.filename} draggable={false} title={`${cur.filename}（双击放大）`} />
        )}
        {/* 左右切换按钮 */}
        <button
          className="absolute left-3 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-black/35 hover:bg-black/60 text-white text-3xl flex items-center justify-center transition-colors disabled:opacity-25 disabled:cursor-not-allowed"
          onClick={() => stepLarge(-1)}
          disabled={idx <= 0}
          title="上一张（← / ↑ / 滚轮向上）"
        >
          ‹
        </button>
        <button
          className="absolute right-3 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-black/35 hover:bg-black/60 text-white text-3xl flex items-center justify-center transition-colors disabled:opacity-25 disabled:cursor-not-allowed"
          onClick={() => stepLarge(1)}
          disabled={idx >= sorted.length - 1}
          title="下一张（→ / ↓ / 滚轮向下）"
        >
          ›
        </button>
        <div className="absolute top-3 left-1/2 -translate-x-1/2 chip bg-black/55 text-white">
          {idx + 1} / {sorted.length}
        </div>
        {cur && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2">
            <TagChipsFixed img={cur} />
          </div>
        )}
      </div>
      <div ref={stripRef} className="shrink-0 h-24 overflow-x-auto flex gap-2 px-3 py-2 bg-panel/60 border-t border-line">
        {sorted.map((img, i) => (
          <div
            key={img.id}
            ref={i === idx ? activeThumbRef : undefined}
            className={
              'shrink-0 w-16 h-16 rounded overflow-hidden border cursor-pointer ' +
              (i === idx ? 'border-brand ring-2 ring-brand/60' : 'border-line hover:border-fg3')
            }
            onClick={(e) => {
              setLargeIndex(i)
              click(i, e)
            }}
            onDoubleClick={() => dbl(img)}
          >
            <img src={img.thumb ? toSrc(img.thumb) : toSrc(img.path)} loading="lazy" className="w-full h-full object-cover" alt="" draggable={false} />
          </div>
        ))}
      </div>
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
