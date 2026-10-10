/**
 * 大图预览层（9.2 + 第五章）
 * - 滚轮缩放 / 拖拽平移 / 双击复位 / ←→切换 / ESC 关闭
 * - AI 标记依据叠加：人脸框、关键点、标签与置信度、判定理由
 * - 一键修正："此判定正确 / 此判定错误"；错误时弹出目标选择面板
 * - 原图对比切换
 * - 布局：左缩略列 + 中画布 + 右判定信息/工具列（三栏并排常驻）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { toSrc, useBigSrc, Spinner } from './imageSrc'
import JudgmentBar from './JudgmentBar'
import TagEditor from './TagEditor'
import {
  CAT_REVIEW,
  CAT_TRASH,
  DIMENSION_LABELS,
  isBadDim,
  type DimensionKey
} from '../../../shared/types'

interface Transform {
  scale: number
  x: number
  y: number
}

export default function PreviewModal(): JSX.Element | null {
  const previewId = useStore((s) => s.previewId)
  const images = useStore((s) => s.images)
  const closePreview = useStore((s) => s.closePreview)
  const stepPreview = useStore((s) => s.stepPreview)
  const openPreview = useStore((s) => s.openPreview)
  const settings = useStore((s) => s.settings)
  const selection = useStore((s) => s.selection)
  const toggleSelect = useStore((s) => s.toggleSelect)
  // 标记叠加开关提到全局 store：切换图片 / 关闭重开大图都保持上次选择（本次筛选全程记忆）
  const showOverlay = useStore((s) => s.previewOverlay)
  const togglePreviewOverlay = useStore((s) => s.togglePreviewOverlay)

  const img = useMemo(() => images.find((i) => i.id === previewId) || null, [images, previewId])
  // 原图加载：缩略图占位 → 原图就绪无缝替换；超 300ms 才提示
  const big = useBigSrc(img)

  const [t, setT] = useState<Transform>({ scale: 1, x: 0, y: 0 })
  const [compareOriginal, setCompareOriginal] = useState(true)
  const dragging = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const activeThumbRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setT({ scale: 1, x: 0, y: 0 })
  }, [previewId])

  // 图片被移出当前分类（移除标签 / 移动 / 入垃圾桶）时：不关闭弹窗，自动切到它原位置的
  // 下一张（删除后后一张正好顶到同一 index）；列表清空（最后一张）才关闭
  const lastIdxRef = useRef(0)
  useEffect(() => {
    if (previewId == null) return
    const i = images.findIndex((x) => x.id === previewId)
    if (i >= 0) {
      lastIdxRef.current = i
      return
    }
    if (images.length) openPreview(images[Math.min(lastIdxRef.current, images.length - 1)].id)
    else closePreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images, previewId])

  // 切换图片时左侧缩略列表跟随滚动
  useEffect(() => {
    activeThumbRef.current?.scrollIntoView({ block: 'nearest' })
  }, [previewId])

  const reset = useCallback(() => setT({ scale: 1, x: 0, y: 0 }), [])

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
    setT((prev) => {
      const ns = Math.min(20, Math.max(0.1, prev.scale * factor))
      // 以鼠标位置为中心缩放
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return { ...prev, scale: ns }
      const cx = e.clientX - rect.left - rect.width / 2
      const cy = e.clientY - rect.top - rect.height / 2
      const k = ns / prev.scale
      return { scale: ns, x: cx - (cx - prev.x) * k, y: cy - (cy - prev.y) * k }
    })
  }, [])

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      dragging.current = { sx: e.clientX, sy: e.clientY, ox: t.x, oy: t.y }
    },
    [t]
  )
  useEffect(() => {
    const move = (e: MouseEvent): void => {
      const d = dragging.current
      if (!d) return
      // 关键：同步把 dragging.current 捕获到局部变量 d，setT 的更新函数被 React 延迟执行时
      // 可能 mouseup 已把 dragging.current 置 null，若仍读 dragging.current!.ox 会抛错→白屏
      const dx = e.clientX - d.sx
      const dy = e.clientY - d.sy
      setT((prev) => ({ ...prev, x: d.ox + dx, y: d.oy + dy }))
    }
    const up = (): void => {
      dragging.current = null
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [])

  if (!img) return null

  // 当前 AI 判定（右侧信息列顶部显示）
  const primaryDim = isBadDim(img.category) ? (img.category as DimensionKey) : null
  const primaryTag = primaryDim ? img.tags[primaryDim] : null
  const src = compareOriginal ? big.src : img.thumb ? toSrc(img.thumb) : big.src
  const faces = (img.details?.faces || []).filter((f) => f && f.box)

  return (
    <div className="fixed inset-0 z-40 bg-black/85 flex flex-col fade-in" onClick={(e) => e.target === e.currentTarget && closePreview()}>
      {/* 顶部工具条 */}
      <div className="shrink-0 relative flex items-center gap-2 px-4 py-2.5 text-[15px] bg-black/40 border-b border-white/10">
        {/* 居中（顶部中间）：文件名 + 尺寸 + 格式 + 文件大小 */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-baseline gap-2.5 max-w-[50%]">
          <span className="text-[15px] text-white/90 truncate" title={img.path}>{img.filename}</span>
          <span className="text-[13px] text-white/60 whitespace-nowrap">{img.width}×{img.height} · {img.format?.toUpperCase()}{img.fileSize ? ` · ${(img.fileSize / 1048576).toFixed(1)} MB` : ''}</span>
        </div>
        <div className="flex-1" />
        {/* 选中开关：与列表选择完全同步（同一 selection 状态） */}
        {img && (
          <button
            className={
              'px-3 py-1.5 rounded-md text-sm border whitespace-nowrap transition-colors ' +
              (selection.has(img.id)
                ? 'bg-brand text-white border-brand'
                : 'bg-white/10 text-white/80 border-white/25 hover:border-white/70')
            }
            onClick={() => toggleSelect(img.id)}
            title="选中/取消选中（与列表多选同步）"
          >
            {selection.has(img.id) ? '✓ 已选中' : '☐ 选中'}
          </button>
        )}
        <button className="btn-ghost-dark text-sm text-white/85" onClick={() => setCompareOriginal(!compareOriginal)} title="原图/缓存对比切换">
          {compareOriginal ? '原图' : '缓存图'}
        </button>
        <button className={'btn-ghost-dark text-sm ' + (showOverlay ? 'text-brand' : 'text-white/60')} onClick={togglePreviewOverlay}>
          标记叠加 {showOverlay ? '开' : '关'}
        </button>
        <button className="btn-ghost-dark text-sm text-white/85" onClick={reset} title="双击画面也可复位">复位缩放</button>
        <button className="btn-ghost-dark text-sm text-white/85" onClick={closePreview}>关闭</button>
      </div>

      {/* 工作区：左缩略列 + 中画布 + 右信息/工具列（三栏并排，全部常驻可操作） */}
      <div className="flex-1 min-h-0 flex gap-2 p-2">
        {/* 左侧：竖排缩略图列表（加宽一档；滚轮只滚动列表，不触发原图缩放） */}
        <aside
          className="w-52 shrink-0 overflow-y-auto flex flex-col gap-1.5 bg-black/45 rounded-lg p-2"
          onWheel={(e) => e.stopPropagation()}
        >
          {images.map((im) => (
            <div
              key={im.id}
              ref={im.id === img.id ? activeThumbRef : undefined}
              className={
                'shrink-0 aspect-square rounded overflow-hidden border cursor-pointer ' +
                (im.id === img.id ? 'border-brand ring-2 ring-brand/60' : 'border-white/20 hover:border-white/70')
              }
              onClick={() => openPreview(im.id)}
              title={im.filename}
            >
              <img src={im.thumb ? toSrc(im.thumb) : toSrc(im.path)} loading="lazy" className="w-full h-full object-cover" alt="" draggable={false} />
            </div>
          ))}
        </aside>

        {/* 主画布 */}
        <div
          ref={containerRef}
          className="flex-1 min-w-0 relative overflow-hidden rounded-lg cursor-grab active:cursor-grabbing"
          onWheel={onWheel}
          onMouseDown={onMouseDown}
          onDoubleClick={reset}
        >
          <div className="absolute inset-0" style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`, transformOrigin: 'center center' }}>
            {/* 包裹层拿满画布尺寸，图用 object-contain 适配：打开就是“完整居中”，不撑爆视口；
                人脸框 SVG 用 xMidYMid meet，与 object-contain 的留边几何完全一致，叠加不会错位 */}
            <div className="relative w-full h-full flex items-center justify-center">
              <img src={src} className="w-full h-full object-contain select-none pointer-events-none" alt={img.filename} draggable={false} />
              {compareOriginal && big.loading && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <Spinner label="加载原图中…" dark />
                </div>
              )}
              {showOverlay && faces.length > 0 && (
                <svg
                  className="absolute inset-0 w-full h-full pointer-events-none"
                  viewBox={`0 0 ${img.width || 1} ${img.height || 1}`}
                  preserveAspectRatio="xMidYMid meet"
                >
                  {faces.map((f, i) => (
                    <g key={i}>
                      <rect x={f.box[0]} y={f.box[1]} width={f.box[2]} height={f.box[3]} fill="none" stroke="#3b82f6" strokeWidth={Math.max(img.width, img.height) / 400} />
                      <text x={f.box[0]} y={Math.max(12, f.box[1] - 4)} fill="#3b82f6" fontSize={Math.max(img.width, img.height) / 45}>
                        face {(f.score * 100).toFixed(0)}
                      </text>
                      {(f.landmarks || []).map((p, j) => (
                        <circle key={j} cx={p[0]} cy={p[1]} r={Math.max(img.width, img.height) / 350} fill="#22c55e" />
                      ))}
                    </g>
                  ))}
                </svg>
              )}
            </div>
          </div>
          {/* 缩放倍率 */}
          {Math.abs(t.scale - 1) > 0.01 && (
            <span className="absolute top-2 left-2 chip bg-black/60 text-white/80">{(t.scale * 100).toFixed(0)}%</span>
          )}
          {/* 左右切换（画布内侧，不压住左右两列） */}
          <button className="absolute left-3 top-1/2 -translate-y-1/2 w-14 h-14 rounded-full bg-black/40 hover:bg-black/70 text-white text-4xl flex items-center justify-center transition-colors" onClick={() => stepPreview(-1)} title="上一张（←）">‹</button>
          <button className="absolute right-3 top-1/2 -translate-y-1/2 w-14 h-14 rounded-full bg-black/40 hover:bg-black/70 text-white text-4xl flex items-center justify-center transition-colors" onClick={() => stepPreview(1)} title="下一张（→）">›</button>
        </div>

        {/* 右侧：AI 判定依据 + 标签增删 + 判定工具栏（400px，大字号） */}
        <aside className="w-[400px] shrink-0 overflow-y-auto rounded-lg bg-black/60 border border-white/10 p-4 flex flex-col gap-4">
          <div className="text-lg text-white/90 flex flex-wrap items-center gap-2">
            当前 AI 判定：
            {primaryDim ? (
              <span className="chip bg-bad/90 text-white !text-base">{DIMENSION_LABELS[primaryDim]} {(primaryTag?.confidence ?? 0).toFixed(2)}</span>
            ) : img.category === CAT_TRASH ? (
              <span className="chip bg-white/15 text-white/80 !text-base">垃圾桶（手动标记）</span>
            ) : img.category === CAT_REVIEW ? (
              <span className="chip bg-warn/90 text-black !text-base">待确认（中置信度）</span>
            ) : (
              <span className="chip bg-good/90 text-white !text-base">正常（成品库）</span>
            )}
            {img.categoryBy === 'user' && <span className="text-xs text-white/50">（用户修正过）</span>}
          </div>

          {/* 标签：✖ 删除单个标签 / ＋ 添加漏检标签（人数互斥、已有置灰） */}
          <div className="text-sm text-white/70">AI 检测标签（觉得不对可直接删，漏了可加）：</div>
          <TagEditor imgs={[img]} anchorDim={primaryDim} size="lg" />

          {/* 判定操作工具栏：紧跟标签信息下方，2×2 大按钮 */}
          <div className="pt-3 border-t border-white/10 flex flex-col gap-2">
            <JudgmentBar img={img} layout="grid" size="lg" showTagButton={false} />
            <div className="text-[10px] text-white/40">
              高亮阈值：高 &gt;{settings.highThreshold} · 中 {settings.midThreshold}-{settings.highThreshold} · 低 &lt;{settings.midThreshold}
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}

/** 待确认图的中置信度标签猜测已提到 shared/types（guessMidDim/midConf，JudgmentBar 共用） */
