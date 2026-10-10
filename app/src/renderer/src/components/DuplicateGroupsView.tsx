/**
 * 重复/连拍 分组视图（专用定制界面）
 * - 把同一 dupGroup（≥2 张）的重复/连拍图叠成一张"3D 堆叠卡"：后层向左上、前层向右下错开，
 *   每张都露出右下角，一眼看出这一组有几张。
 * - 点击堆叠卡 → 弹窗平铺该组全部照片，逐张标记「留 / 废」：
 *   · keep 模式（在【重复/连拍】分类内）：默认全留，把不要的标「废」→ 确认后被丢弃的移入【重复/连拍-废弃】
 *   · trash 模式（在【重复/连拍-废弃】分类内）：勾选要恢复的 → 确认还原回【重复/连拍】
 * - 每张卡片中心有「🔍 放大查看」：点它进入原图全屏查看器（键盘上下左右 / 滚轮切换、底部选中/关闭/上/下一张）；
 *   点卡片其它区域仍是默认的「留/废」切换。
 * - 两个分类都不允许从别处拖入（在 Sidebar 已禁用 drop），只能经此流程进出。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { toSrc, useBigSrc, Spinner } from './imageSrc'
import type { ImageRecord } from '../../../shared/types'
import { CAT_DUP_TRASH } from '../../../shared/types'

/** 取缩略图地址：优先已生成的 thumb，回退原图 */
function src(img: ImageRecord): string {
  return img.thumb ? toSrc(img.thumb) : toSrc(img.path)
}

interface Group {
  gid: string
  arr: ImageRecord[]
}

/** 单张堆叠卡：最多叠 4 层，右下角错开露出，营造 3D 层叠感 */
function StackCard({ group, onOpen }: { group: Group; onOpen: () => void }): JSX.Element {
  const layers = group.arr.slice(0, 4)
  const n = group.arr.length
  const step = 14
  return (
    <button
      className="relative text-left focus:outline-none group"
      style={{ width: 168 + step * (layers.length - 1), height: 168 + step * (layers.length - 1) }}
      onClick={onOpen}
      title={`这一组 ${n} 张重复/连拍，点击选择保留 / 丢弃`}
    >
      {layers.map((img, i) => (
        <span
          key={img.id}
          className="absolute overflow-hidden rounded-lg border border-line bg-panel2 shadow-lg transition-transform group-hover:scale-[1.02]"
          style={{
            width: 168,
            height: 168,
            left: i * step,
            top: i * step,
            zIndex: i,
            transform: `rotate(${(i - (layers.length - 1) / 2) * 1.6}deg)`
          }}
        >
          <img src={src(img)} loading="lazy" className="w-full h-full object-cover" alt={img.filename} draggable={false} />
        </span>
      ))}
      <span className="absolute -right-1 -top-1 z-20 min-w-[22px] h-[22px] px-1 rounded-full bg-brand text-white text-[12px] font-bold flex items-center justify-center shadow ring-2 ring-base">
        {n}
      </span>
    </button>
  )
}

/** 放大镜图标（zoom-in） */
function ZoomIcon(): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="11" y1="8" x2="11" y2="14" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  )
}

/**
 * 原图全屏查看器：
 * - 展示当前图原图（RAW/HEIC 走主进程高清预览，缩略图占位）
 * - 底部：上一张 / 选中（留↔废 或 恢复勾选）/ 下一张 / 关闭
 * - 键盘 ← ↑ = 上一张，→ ↓ = 下一张，ESC = 关闭（capture 阶段拦截，避免与全局快捷键冲突）
 * - 鼠标滚轮下=下一张、上=上一张（250ms 节流）
 */
function ZoomViewer({
  arr,
  index,
  mode,
  marked,
  onToggle,
  onNav,
  onClose
}: {
  arr: ImageRecord[]
  index: number
  mode: 'keep' | 'trash'
  marked: Set<number>
  onToggle: (id: number) => void
  onNav: (delta: number) => void
  onClose: () => void
}): JSX.Element {
  const img = arr[index]
  const big = useBigSrc(img)
  const lastWheel = useRef(0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        onNav(-1)
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        onNav(1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, onNav])

  const onWheel = (e: React.WheelEvent): void => {
    const now = Date.now()
    if (now - lastWheel.current < 250) return
    if (Math.abs(e.deltaY) < 5) return
    lastWheel.current = now
    onNav(e.deltaY > 0 ? 1 : -1)
  }

  const on = marked.has(img.id)
  const statusText = mode === 'keep' ? (on ? '当前：废（将被丢弃）' : '当前：留（保留）') : on ? '当前：已选中（将恢复）' : '当前：未选中'
  const statusCls = mode === 'keep' ? (on ? 'bg-bad/90 text-white' : 'bg-good/90 text-white') : on ? 'bg-brand text-white' : 'bg-white/15 text-white/70'
  const selectLabel = mode === 'keep' ? (on ? '改回保留' : '标记为废') : on ? '取消选中' : '选中恢复'
  const selectCls =
    'px-5 py-2 rounded-md text-lg font-bold border transition-colors ' +
    (mode === 'keep'
      ? on
        ? 'bg-good text-white border-good'
        : 'bg-bad text-white border-bad'
      : on
        ? 'bg-brand text-white border-brand'
        : 'bg-white/10 text-white/85 border-white/25 hover:border-white/70')

  return (
    <div className="fixed inset-0 z-[60] bg-black/95 flex flex-col fade-in" onClick={(e) => e.target === e.currentTarget && onClose()} onWheel={onWheel}>
      {/* 顶栏：居中大字显示“第 N / 总数 · 文件名”与当前留/废状态 */}
      <div className="shrink-0 relative flex items-center gap-3 px-4 py-3 border-b border-white/10 bg-black/40">
        <span className="text-white/90 font-bold text-lg">{mode === 'keep' ? '放大查看 · 选择保留' : '放大查看 · 选择恢复'}</span>
        <div className="flex-1" />
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-3 max-w-[50%]">
          <span className="text-white/90 text-lg truncate" title={img.path}>第 {index + 1} / {arr.length} 张 · {img.filename}</span>
          <span className={'px-2.5 py-1 rounded text-base font-bold whitespace-nowrap ' + statusCls}>{statusText}</span>
        </div>
        <div className="flex-1" />
        <button className="btn-ghost-dark text-base text-white/85" onClick={onClose} title="关闭（ESC）">✕ 关闭</button>
      </div>

      {/* 主图 */}
      <div className="flex-1 min-h-0 relative flex items-center justify-center p-4">
        <img src={big.src} className="max-w-full max-h-full object-contain select-none" alt={img.filename} draggable={false} />
        {big.loading && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <Spinner label="加载原图中…" dark />
          </div>
        )}
        <button className="absolute left-3 top-1/2 -translate-y-1/2 w-14 h-14 rounded-full bg-black/40 hover:bg-black/70 text-white text-4xl flex items-center justify-center transition-colors disabled:opacity-25 disabled:cursor-not-allowed" onClick={() => onNav(-1)} disabled={index <= 0} title="上一张（← / ↑ / 滚轮上）">‹</button>
        <button className="absolute right-3 top-1/2 -translate-y-1/2 w-14 h-14 rounded-full bg-black/40 hover:bg-black/70 text-white text-4xl flex items-center justify-center transition-colors disabled:opacity-25 disabled:cursor-not-allowed" onClick={() => onNav(1)} disabled={index >= arr.length - 1} title="下一张（→ / ↓ / 滚轮下）">›</button>
      </div>

      {/* 底栏：上一张 / 选中 / 下一张 / 关闭（文字加大） */}
      <div className="shrink-0 flex items-center justify-center gap-3 px-4 py-3.5 border-t border-white/10 bg-black/50">
        <button className="btn text-lg px-4 py-2" onClick={() => onNav(-1)} disabled={index <= 0}>← 上一张</button>
        <button className={selectCls} onClick={() => onToggle(img.id)}>{selectLabel}</button>
        <button className="btn text-lg px-4 py-2" onClick={() => onNav(1)} disabled={index >= arr.length - 1}>下一张 →</button>
        <div className="w-3" />
        <button className="btn text-lg px-4 py-2" onClick={onClose}>关闭</button>
      </div>
    </div>
  )
}

/** 组内详情弹窗：逐张标记留/废（keep）或勾选恢复（trash）；每卡可放大看原图 */
function GroupModal({ group, mode, onClose }: { group: Group; mode: 'keep' | 'trash'; onClose: () => void }): JSX.Element {
  const moveIds = useStore((s) => s.moveIds)
  // keep: marked 里的将被丢弃；trash: marked 里的将被恢复
  const [marked, setMarked] = useState<Set<number>>(() => new Set())
  const [zoomIdx, setZoomIdx] = useState<number | null>(null)
  const toggle = (id: number): void =>
    setMarked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const nav = (delta: number): void =>
    setZoomIdx((cur) => (cur === null ? cur : Math.min(group.arr.length - 1, Math.max(0, cur + delta))))

  const confirm = (): void => {
    if (mode === 'keep') {
      if (marked.size) void moveIds([...marked], CAT_DUP_TRASH)
    } else {
      if (marked.size) void moveIds([...marked], 'duplicate')
    }
    onClose()
  }

  const keepCount = group.arr.length - (mode === 'keep' ? marked.size : 0)

  return (
    <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-6" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-panel border border-line rounded-xl shadow-2xl w-full max-w-6xl max-h-[90vh] flex flex-col fade-in">
        <div className="px-5 py-3 border-b border-line flex items-center justify-between">
          <h2 className="text-fg font-bold">
            {mode === 'keep' ? '重复/连拍 · 选择保留' : '重复/连拍-废弃 · 选择恢复'}
            <span className="text-fg3 font-normal ml-2 text-sm">本组 {group.arr.length} 张</span>
          </h2>
          <button className="btn-ghost text-gray-400" onClick={onClose}>✕</button>
        </div>

        <div className="p-4 overflow-y-auto">
          <div className="text-xs text-fg3 mb-3">
            {mode === 'keep'
              ? '点击卡片切换「留 / 废」；点卡片中间的「放大查看」看原图对比（方向键 / 滚轮切换）。标为「废」的会移入【重复/连拍-废弃】（永不导出）。默认为全部保留。'
              : '点击卡片勾选要恢复的照片；点「放大查看」看原图。确认后勾选的移回【重复/连拍】，未勾选的继续留在废弃桶。'}
          </div>
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
            {group.arr.map((img, idx) => {
              const on = marked.has(img.id)
              return (
                <button
                  key={img.id}
                  onClick={() => toggle(img.id)}
                  className={
                    'relative rounded-lg overflow-hidden border-2 aspect-square transition-all ' +
                    (mode === 'keep'
                      ? on
                        ? 'border-bad opacity-70'
                        : 'border-good'
                      : on
                        ? 'border-brand'
                        : 'border-line hover:border-gray-500')
                  }
                  title={img.filename}
                >
                  <img src={src(img)} loading="lazy" className="w-full h-full object-cover" alt={img.filename} draggable={false} />
                  <span
                    className={
                      'absolute left-1.5 top-1.5 px-1.5 py-0.5 rounded text-[11px] font-bold text-white shadow ' +
                      (mode === 'keep' ? (on ? 'bg-bad' : 'bg-good') : on ? 'bg-brand' : 'bg-black/50')
                    }
                  >
                    {mode === 'keep' ? (on ? '废' : '留') : on ? '✓ 恢复' : '恢复'}
                  </span>
                  {/* 中心放大镜：点它看原图（stopPropagation 避免触发卡片的留/废切换） */}
                  <span
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation()
                      setZoomIdx(idx)
                    }}
                    className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 flex items-center gap-1.5 rounded-lg bg-black/55 hover:bg-brand text-white px-3 py-2 text-xs font-medium backdrop-blur-sm transition-colors cursor-zoom-in"
                  >
                    <ZoomIcon />
                    放大查看
                  </span>
                  <span className="absolute right-1 bottom-1 left-1 truncate text-[10px] text-white/90 bg-black/45 rounded px-1 py-0.5">{img.filename}</span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-line flex items-center gap-2">
          {mode === 'keep' ? (
            <>
              <button className="btn text-xs" onClick={() => setMarked(new Set(group.arr.slice(1).map((i) => i.id)))} title="只保留第一张，其余丢弃">只留第一张</button>
              <button className="btn text-xs" onClick={() => setMarked(new Set())}>全部保留</button>
            </>
          ) : (
            <>
              <button className="btn text-xs" onClick={() => setMarked(new Set(group.arr.map((i) => i.id)))}>全选</button>
              <button className="btn text-xs" onClick={() => setMarked(new Set())}>全不选</button>
            </>
          )}
          <div className="flex-1" />
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className={mode === 'keep' ? 'btn-danger' : 'btn-primary'}
            disabled={!marked.size}
            onClick={confirm}
          >
            {mode === 'keep' ? `丢弃 ${marked.size} 张（保留 ${keepCount} 张）` : `恢复 ${marked.size} 张`}
          </button>
        </div>
      </div>

      {zoomIdx !== null && (
        <ZoomViewer
          arr={group.arr}
          index={zoomIdx}
          mode={mode}
          marked={marked}
          onToggle={toggle}
          onNav={nav}
          onClose={() => setZoomIdx(null)}
        />
      )}
    </div>
  )
}

export default function DuplicateGroupsView({ images, mode }: { images: ImageRecord[]; mode: 'keep' | 'trash' }): JSX.Element {
  const { groups, singles } = useMemo(() => {
    const m = new Map<string, ImageRecord[]>()
    for (const img of images) {
      const key = img.dupGroup || `single:${img.id}`
      const arr = m.get(key)
      if (arr) arr.push(img)
      else m.set(key, [img])
    }
    const gs: Group[] = []
    const sg: ImageRecord[] = []
    for (const [gid, arr] of m) {
      if (arr.length >= 2 && !gid.startsWith('single:')) gs.push({ gid, arr: arr.sort((a, b) => a.id - b.id) })
      else sg.push(...arr)
    }
    gs.sort((a, b) => b.arr.length - a.arr.length)
    return { groups: gs, singles: sg }
  }, [images])

  const [open, setOpen] = useState<Group | null>(null)

  if (!groups.length && !singles.length) {
    return (
      <div className="h-full overflow-auto flex flex-col items-center justify-center text-fg2 p-6">
        <div className="text-5xl mb-3">{mode === 'keep' ? '✨' : '🗑'}</div>
        <div className="text-lg text-fg">{mode === 'keep' ? '没有检测到重复/连拍照片' : '废弃桶是空的'}</div>
        <div className="text-xs text-fg3 mt-1">{mode === 'keep' ? '筛选完成后，连拍与近似重复会自动归到这里' : '在【重复/连拍】分组里丢弃的多余图会集中到这里，永不导出'}</div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto p-4 fade-in">
      <div className="mb-4 rounded-lg bg-panel2/60 border border-line px-4 py-2.5 text-xs text-fg2">
        {mode === 'keep'
          ? `共 ${groups.length} 组重复/连拍。点击叠卡查看整组并选择保留哪几张，其余将移入【重复/连拍-废弃】。`
          : `废弃桶共 ${groups.length} 组、${images.length} 张。点击叠卡可把照片恢复到【重复/连拍】；此分类永不导出。`}
      </div>

      {groups.length > 0 && (
        <div className="flex flex-wrap gap-6 justify-center mb-6">
          {groups.map((g) => (
            <StackCard key={g.gid} group={g} onOpen={() => setOpen(g)} />
          ))}
        </div>
      )}

      {singles.length > 0 && (
        <div>
          <div className="text-xs text-fg3 mb-2">未成组（{singles.length} 张）：</div>
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))' }}>
            {singles.map((img) => (
              <div key={img.id} className="relative rounded-lg overflow-hidden border border-line aspect-square">
                <img src={src(img)} loading="lazy" className="w-full h-full object-cover" alt={img.filename} draggable={false} />
              </div>
            ))}
          </div>
        </div>
      )}

      {open && <GroupModal group={open} mode={mode} onClose={() => setOpen(null)} />}
    </div>
  )
}
