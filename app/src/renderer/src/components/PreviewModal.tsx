/**
 * 大图预览层（9.2 + 第五章）
 * - 滚轮缩放 / 拖拽平移 / 双击复位 / ←→切换 / ESC 关闭；顶部文件名点击即复制
 * - AI 标记叠加（人脸框/关键点）：默认关，点顶部「标记叠加」才开；判定理由长句只写库不渲染（showReason 默认关）
 * - 一键修正："✓ 合格 → 交付库 / 此判定正确（仅记录）"；原"此判定错误"与右栏的「移动到」都已下线（与标签增删重叠），
 *   换分类用右栏两个彩色按钮或拖左侧栏，换维度归属用标签管理（两条路径都会写学习样本）
 * - 原图对比切换
 * - 布局：左缩略列 + 中画布 + 右判定信息/工具列（三栏并排常驻）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore, displayOrder } from '../store'
import { toSrc, useBigSrc, Spinner } from './imageSrc'
import JudgmentBar from './JudgmentBar'
import TagEditor, { anchorDimOfCategory, categoryDisplayName } from './TagEditor'
import type { MetaItem } from '../../../shared/ipc'
import {
  BAD_DIMENSIONS,
  CAT_FLAWS,
  CAT_REVIEW,
  CAT_TRASH,
  DIMENSION_LABELS,
  isBadDim,
  type DimensionKey,
  type FaceInfo,
  type ImageRecord
} from '../../../shared/types'

interface Transform {
  scale: number
  x: number
  y: number
}

export default function PreviewModal(): JSX.Element | null {
  const previewId = useStore((s) => s.previewId)
  const images = useStore((s) => s.images)
  const activeCategory = useStore((s) => s.activeCategory)
  const displayIds = useStore((s) => s.displayIds)
  const customCategories = useStore((s) => s.customCategories)
  const closePreview = useStore((s) => s.closePreview)
  const stepPreview = useStore((s) => s.stepPreview)
  const openPreview = useStore((s) => s.openPreview)
  const settings = useStore((s) => s.settings)
  const selection = useStore((s) => s.selection)
  const toggleSelect = useStore((s) => s.toggleSelect)
  // 标记叠加开关提到全局 store：切换图片 / 关闭重开大图都保持上次选择（本次筛选全程记忆）
  const showOverlay = useStore((s) => s.previewOverlay)
  const togglePreviewOverlay = useStore((s) => s.togglePreviewOverlay)
  const reviewSession = useStore((s) => s.reviewSession)
  const startReview = useStore((s) => s.startReview)
  const exitReview = useStore((s) => s.exitReview)

  const img = useMemo(() => images.find((i) => i.id === previewId) || null, [images, previewId])
  /**
   * 大图必须按“网格展示序”数张数、翻页、排左侧缩略列：直接用 images（库里顺序）会出现
   * “网格里第 500 张、计数器写 20/600”，带筛选或改过排序时按 → 还会翻到没命中的图。
   */
  const list = useMemo(() => displayOrder(images, displayIds), [images, displayIds])
  const pos = list.findIndex((i) => i.id === previewId)
  const catLabel = categoryDisplayName(activeCategory, customCategories)
  // 复核模式：待确认 / 瑕疵片 / 任一坏维度才提供（都是“需要逐张人工过一遍”的语境）
  const reviewEligible = activeCategory === CAT_REVIEW || activeCategory === CAT_FLAWS || (!!activeCategory && isBadDim(activeCategory))
  const reviewActive = !!reviewSession && reviewSession.cat === activeCategory
  const judged = reviewSession ? Math.max(0, reviewSession.total - list.length) : 0
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

  // 图片被移出当前分类（移除标签 / 移动 / 入废弃库）时：不关闭弹窗，自动切到它原位置的
  // 下一张（删除后后一张正好顶到同一 index）；列表清空（最后一张）才关闭
  const lastIdxRef = useRef(0)
  useEffect(() => {
    if (previewId == null) return
    const i = list.findIndex((x) => x.id === previewId)
    if (i >= 0) {
      lastIdxRef.current = i
      return
    }
    if (list.length) openPreview(list[Math.min(lastIdxRef.current, list.length - 1)].id)
    else closePreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, previewId])

  // 切换图片时左侧缩略列表跟随滚动：必须居中。用 'nearest' 的语义是“已经在可视区就不滚”，
  // 于是连着按 → 时当前图会一路贴在列表最下面那张，正好看不到“下一张”预览
  useEffect(() => {
    activeThumbRef.current?.scrollIntoView({ block: 'center' })
  }, [previewId])

  // 复核模式下本组判完（该分类清空）：即时反馈完成并结束会话（上面已有 effect 会随之关闭弹窗）
  useEffect(() => {
    if (reviewSession && reviewSession.cat === activeCategory && list.length === 0) {
      useStore.setState({ toast: { msg: `本组复核完成，共判 ${reviewSession.total} 张`, kind: 'success', duration: 1800 } })
      exitReview()
    }
  }, [list.length, reviewSession, activeCategory, exitReview])

  // 列表记录已瘦身不带 details（人脸框/关键点），只有这里的人脸叠加需要——按 previewId 单张取全量记录（一次 IPC，代价可忽略）
  const [lazyFaces, setLazyFaces] = useState<FaceInfo[]>([])
  useEffect(() => {
    if (previewId == null) return
    let alive = true
    void window.api.getImage(previewId).then((r) => {
      if (alive) setLazyFaces((r?.details?.faces || []).filter((f) => f && f.box))
    })
    return () => {
      alive = false
    }
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

  // 当前 AI 判定（右边信息列顶部）：只报维度名，不带置信度小数——
  // “0.91”对判片没有信息量（分数高低不代表该不该留），卡片芯片上已有百分比。
  // D2：主分类=人数不携瑕疵，当前 AI 判定取最高置信的非 low 瑕疵标签（旧数据 category 恰为坏维度时兼容）
  let primaryDim: DimensionKey | null = isBadDim(img.category) ? (img.category as DimensionKey) : null
  if (!primaryDim) {
    let bc = -1
    for (const d of BAD_DIMENSIONS) {
      const t = img.tags?.[d]
      if (t && t.level !== 'low' && t.confidence > bc) {
        bc = t.confidence
        primaryDim = d
      }
    }
  }
  const src = compareOriginal ? big.src : img.thumb ? toSrc(img.thumb) : big.src
  const faces = lazyFaces

  // 复制文件名到剪贴板：成功/失败都有 toast 反馈，不用弹任何确认框
  const copyFilename = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(img.filename)
      useStore.setState({ toast: { msg: `已复制文件名：${img.filename}`, kind: 'success', duration: 1200 } })
    } catch {
      useStore.setState({ toast: { msg: '复制文件名失败，请手动选择复制', kind: 'error' } })
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/85 flex flex-col fade-in" onClick={(e) => e.target === e.currentTarget && closePreview()}>
      {/* 顶部工具条 */}
      <div className="shrink-0 relative flex items-center gap-2 px-4 py-2.5 text-[15px] bg-black/40 border-b border-white/10">
        {/* 左上：当前分类 + 这是分类里的第几张（tabular-nums 让翻页时数字不左右跳） */}
        <div className="flex items-baseline gap-2 min-w-0 max-w-[24%]">
          <span className="text-[15px] text-white/90 truncate" title={`当前分类：${catLabel}`}>{catLabel}</span>
          <span className="text-[13px] text-white/55 tabular-nums whitespace-nowrap">{pos >= 0 ? pos + 1 : '-'} / {list.length}</span>
        </div>
        {/* 复核模式开关（仅待确认/瑕疵/坏维度提供）：开启后顶部显「已判 X / 共 Y」，
            判一张自动连跳下一张（复用上方离开分类即切图的逻辑），不加任何快捷键 */}
        {reviewEligible && (reviewActive ? (
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[13px] text-emerald-300 tabular-nums whitespace-nowrap" title="本轮复核进度">复核中 · 已判 {judged} / 共 {reviewSession?.total}</span>
            <button className="btn-ghost-dark text-[12px] px-2 py-1 rounded border border-white/20 text-white/70 hover:text-white" onClick={exitReview} title="退出复核（不影响已做的判定）">退出复核</button>
          </div>
        ) : (
          <button
            className="btn-ghost-dark text-[12px] px-2 py-1 rounded border border-emerald-400/40 text-emerald-200 hover:bg-emerald-400/10 whitespace-nowrap shrink-0"
            onClick={() => startReview(activeCategory as string, list.length)}
            title="连续过片：判完一张自动跳下一张，顶部显示本组进度"
          >
            ▶ 开始复核
          </button>
        ))}
        {/* 居中（顶部中间）：文件名（点击复制） + 尺寸 + 格式 + 文件大小 */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-baseline gap-2.5 max-w-[50%]">
          <span
            className="group inline-flex items-baseline gap-1 min-w-0 cursor-pointer"
            title={`${img.path}\n点击复制文件名`}
            onClick={() => void copyFilename()}
          >
            <span className="text-[15px] text-white/90 truncate group-hover:text-white transition-colors">{img.filename}</span>
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 shrink-0 self-center text-white/40 opacity-0 group-hover:opacity-90 transition-opacity" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15V5a2 2 0 0 1 2-2h10" />
            </svg>
          </span>
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
        <button
          className="px-3 py-1.5 rounded-md text-sm font-medium whitespace-nowrap bg-bad text-white border border-bad hover:bg-bad/85 hover:border-bad/85 transition-colors"
          onClick={closePreview}
          title="关闭大图（也可直接按 Esc）"
        >
          ESC 关闭
        </button>
      </div>

      {/* 工作区：左缩略列 + 中画布 + 右信息/工具列（三栏并排，全部常驻可操作） */}
      <div className="flex-1 min-h-0 flex gap-2 p-2">
        {/* 左侧：竖排缩略图列表（加宽一档；滚轮只滚动列表，不触发原图缩放） */}
        <aside
          className="w-52 shrink-0 overflow-y-auto flex flex-col gap-1.5 bg-black/45 rounded-lg p-2"
          onWheel={(e) => e.stopPropagation()}
        >
          {list.map((im) => (
            <div key={im.id} className="relative shrink-0 pr-2.5">
              <div
                ref={im.id === img.id ? activeThumbRef : undefined}
                className={
                  'aspect-square rounded overflow-hidden border cursor-pointer ' +
                  (im.id === img.id ? 'border-white ring-2 ring-white/60' : 'border-white/20 hover:border-white/70')
                }
                onClick={() => openPreview(im.id)}
                title={im.filename}
              >
                <img src={im.thumb ? toSrc(im.thumb) : toSrc(im.path)} loading="lazy" className="w-full h-full object-cover" alt="" draggable={false} />
              </div>
              {/* 当前图指针：右侧留出的窄栏里放一个左指白三角，尖端指向选中缩略图。
                  光靠白框在整列都偏亮时不够醒目，三角能一眼定位“现在看的是哪张”；
                  SVG 而不是字符（◀ 会被 Segoe UI Symbol 渲染出自带灰度，也不随主题） */}
              {im.id === img.id && (
                <svg viewBox="0 0 8 12" className="absolute right-0.5 top-1/2 -translate-y-1/2 w-2 h-3 text-white pointer-events-none" fill="currentColor" aria-hidden="true">
                  <path d="M8 0 0 6 8 12Z" />
                </svg>
              )}
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
          {/* 左右切换（画布内侧，不压住左右两列）：箭头用 SVG 而不是 ‹› 字符——
              字符在 flex 居中时受字体基线影响会视觉上偏上，而且 text-4xl 的 ‹ 实际笔画很小；
              SVG 36px 画在 56px 黑圈内，箭头本身放大且真正上下居中（黑圈尺寸不变） */}
          <button className="absolute left-3 top-1/2 -translate-y-1/2 w-14 h-14 rounded-full bg-black/40 hover:bg-black/70 text-white flex items-center justify-center transition-colors" onClick={() => stepPreview(-1)} title="上一张（←）">
            <svg viewBox="0 0 24 24" className="w-9 h-9" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 4.5 7.5 12 15 19.5" /></svg>
          </button>
          <button className="absolute right-3 top-1/2 -translate-y-1/2 w-14 h-14 rounded-full bg-black/40 hover:bg-black/70 text-white flex items-center justify-center transition-colors" onClick={() => stepPreview(1)} title="下一张（→）">
            <svg viewBox="0 0 24 24" className="w-9 h-9" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 4.5 16.5 12 9 19.5" /></svg>
          </button>
        </div>

        {/* 右侧：当前判定 + 标签管理 + 判定工具 + 拍摄参数（370px，大字号）
            背景一律用不透明主题面板：以前是 bg-black/60 半透黑玻璃，浅色主题下 TagEditor /
            JudgmentBar 这些用主题令牌的组件会白字压白底，整栏看不见 */}
        <aside className="w-[370px] shrink-0 overflow-y-auto rounded-lg bg-panel border border-line p-4 flex flex-col gap-7">
          {/* 当前判定：小标签 + 一个着色粗体结论词。以前是“文字+芯片”一行，芯片和
              标签区的彩色芯片撞脸分不清主次；现在结论词就是本栏最大的字，层级靠排版成立 */}
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-xs text-fg3">当前判定</span>
            {primaryDim ? (
              <span className="text-lg font-bold text-bad">{DIMENSION_LABELS[primaryDim]}</span>
            ) : img.category === CAT_TRASH ? (
              <span className="text-lg font-bold text-fg3">废弃库</span>
            ) : img.category === CAT_REVIEW ? (
              <span className="text-lg font-bold text-warn">待确认</span>
            ) : (
              <span className="text-lg font-bold text-good">正常 · 交付库</span>
            )}
            {img.categoryBy === 'user' && <span className="text-xs text-fg3">（已被您修正过）</span>}
          </div>

          {/* 标签单页三区（当前/人物切换/点加），组件自带区标题不再另写说明；
              定位针锚点取“正在浏览的分类”而非图的主分类：并集视图里图可能主分类是待确认、
              靠“闭眼”标签才在当前列表——用主分类当锚点会漏标 */}
          <TagEditor imgs={[img]} anchorDim={anchorDimOfCategory(activeCategory) ?? primaryDim} size="lg" />

          {/* 判定操作工具栏：紧跟标签信息下方，2×2 大按钮 */}
          <div className="pt-3 border-t border-line flex flex-col gap-2">
            <JudgmentBar img={img} size="lg" showTagButton={false} />
            {/* 叠加图例只在开了标记叠加时才出现：它解释的是人脸框颜色对应的置信度区间，
                叠加关着时摆这么一行阈值公式纯属噪声（而且只有调参数的人看得懂） */}
            {showOverlay && (
              <div className="text-[10px] text-fg3">
                高亮阈值：高 &gt;{settings.highThreshold} · 中 {settings.midThreshold}-{settings.highThreshold} · 低 &lt;{settings.midThreshold}
              </div>
            )}
          </div>

          {/* 内容隔离线 + 拍摄参数：原图 EXIF 全量键值（主进程 exifr 优先，
              CR3 等不支持的容器走字节解析兑底），切图时自动重读 */}
          <div className="pt-3 border-t border-line">
            <ExifPanel img={img} />
          </div>
        </aside>
      </div>
    </div>
  )
}

/** 待确认图的中置信度标签猜测已提到 shared/types（guessMidDim/midConf，JudgmentBar 共用） */

/**
 * 照片参数信息：文件名称/格式/尺寸/大小这四条来自入库记录永远有，相机参数由主进程
 * imageMeta 读原文件并收口成中文白名单（非相机直出的图返回 null，只给一句说明）。
 * 标题靠字重与最深令牌压场，参数行是键左值右的发丝线列表，不加任何框；
 * 切图时重读（主进程按路径缓存，来回翻不重复读盘）。
 */
function ExifPanel({ img }: { img: ImageRecord }): JSX.Element {
  // undefined = 读取中；null = 不是相机直出；数组 = 参数键值
  const [items, setItems] = useState<MetaItem[] | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    setItems(undefined)
    void window.api.imageMeta(img.path).then((m) => {
      if (alive) setItems(m)
    })
    return () => {
      alive = false
    }
  }, [img.path])
  const rows: MetaItem[] = [
    { k: '文件名称', v: img.filename },
    { k: '格式', v: (img.format || '未知').toUpperCase() },
    { k: '像素尺寸', v: img.width ? `${img.width} × ${img.height}` : '未知' },
    ...(img.fileSize ? [{ k: '文件大小', v: `${(img.fileSize / 1048576).toFixed(1)} MB` }] : []),
    ...(items ?? [])
  ]
  return (
    <section>
      <div className="mb-2">
        <div className="text-[14px] font-bold text-fg">照片参数信息</div>
        <div className="text-[11px] text-fg3 mt-0.5">仅相机直出的照片有</div>
      </div>
      {items === undefined && <div className="text-xs text-fg3">读取中…</div>}
      {items !== undefined && (
        <div>
          {rows.map((r) => (
            <div key={r.k} className="flex items-baseline justify-between gap-3 py-[3px] text-xs border-b border-line/60 last:border-0">
              <span className="shrink-0 text-fg3">{r.k}</span>
              <span className="text-right text-fg break-all">{r.v}</span>
            </div>
          ))}
          {items === null && <div className="pt-1 text-[11px] text-fg3">这张不是相机直出的照片，没有拍摄参数</div>}
        </div>
      )}
    </section>
  )
}
