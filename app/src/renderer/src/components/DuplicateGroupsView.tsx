/**
 * 重复/连拍 分组视图（专用定制界面）
 * - 把同一 dupGroup 的重复/连拍图叠成一张"3D 堆叠卡"：后层向左上、前层向右下错开，
 *   每张都露出右下角，一眼看出这一组有几张。
 * - 整组成员 = 本分类的多余帧 + 其它分类里的同伴（聚类时每组最早的第一张 AI 默认保留帧留在成品库）。
 *   后者由主进程 listImagesByGroups 按 dup_group 补全，在弹窗里以锁定卡展示（虚线框 + “已在成品库”角标）：
 *   这样每组永远看得到完整上下文，2 张的组不会再退化成一张“未成组”孤帧（已彻底取消该分区）。
 * - 点击堆叠卡 → 弹窗平铺该组全部照片，逐张标记「留 / 废」：
 *   · keep 模式（在【重复/连拍】分类内）：支持两种选图习惯（全局设置记忆，切换一次永久保持）：
 *     - 选丢弃的（dupPickMode=drop，默认）/ 选保留的（dupPickMode=keep）
 *     两种模式都无默认选择；卡片三态：绿色=标保留、红色=标废弃、无边框=还没决定（留在重复类下次接着选）
 *     底部两个按钮分开执行：「处理已选」（drop=丢弃标红的→废弃桶 / keep=保留标绿的→成品库）
 *     与「处理未选」（把还没决定的批量定案），只点一次不强制对全组下结论
 *     回库/进桶同时清 duplicate 标签（重聚类不会再抓回来）
 *     首次使用弹窗内会显示一次性引导（dupGuideSeen 记忆，看过不再弹）
 *   · trash 模式（在【重复/连拍-废弃】分类内）：勾选要恢复的 → 确认还原回【重复/连拍】
 * - 每张卡片中心有「🔍 放大查看」：点它进入原图全屏查看器（键盘上下左右 / 滚轮切换、底部选中/关闭/上/下一张）；
 *   点卡片其它区域仍是默认的「留/废」切换（锁定卡不可点）。
 * - 两个分类都不允许从别处拖入（在 Sidebar 已禁用 drop），只能经此流程进出。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { toSrc, useBigSrc, Spinner } from './imageSrc'
import type { ImageRecord } from '../../../shared/types'
import { CAT_DUP_TRASH, CAT_LIBRARY, CAT_REVIEW, DIMENSION_LABELS, isBadDim, isTrashLike } from '../../../shared/types'

/** 取缩略图地址：优先已生成的 thumb，回退原图 */
function src(img: ImageRecord): string {
  return img.thumb ? toSrc(img.thumb) : toSrc(img.path)
}

/**
 * 大图宫格（每排 2 张）专用卡片图：库内缩略图仅 256px，放大到 ~560px 必糊——
 * 改走原图/高清预览（useBigSrc：普通格式直接加载原文件，RAW/HEIC 由主进程出大图，缩略图先占位无缝替换）。
 */
function BigCardImg({ img }: { img: ImageRecord }): JSX.Element {
  const { src: s } = useBigSrc(img)
  return <img src={s} loading="lazy" className="w-full h-full object-cover" alt={img.filename} draggable={false} />
}

interface Group {
  gid: string
  /** 整组成员（含不在当前分类的锁定帧），按 id 升序 */
  arr: ImageRecord[]
  /** 不在当前分类、只能看不能选的成员 id（如成品库里的 AI 默认保留帧） */
  locked: Set<number>
}

/**
 * 锁定帧角标：只回答客户真正关心的问题——“这张会不会被导出”。
 * 成品库在这里是虚分类：人数（单人照/多人合照/无人物场景）、黑白照、自定义分类都算成品库
 * （与主进程 exporter.isLibrary 同一口径，导出时一起走），所以主分类是「多人合照」的兜底帧
 * 也照样正常导出——角标写「成品库」而不是「多人合照」，否则会和顶部说明自相矛盾。
 */
function catShort(cat: string): string {
  if (isTrashLike(cat)) return cat === CAT_DUP_TRASH ? '废弃桶' : '垃圾桶'
  if (cat === CAT_REVIEW) return '待确认'
  if (isBadDim(cat)) return DIMENSION_LABELS[cat] || '问题图区'
  return '成品库'
}

/** 这张落在哪个相册（与短名一致时不重复显示） */
function catAlbum(cat: string): string {
  if (cat === CAT_LIBRARY) return ''
  if (cat.startsWith('custom:')) return '自定义分类'
  return DIMENSION_LABELS[cat as keyof typeof DIMENSION_LABELS] || ''
}

/** 悬浮说明用的完整说法：如「成品库（多人合照）」 */
function catFull(cat: string): string {
  const album = catAlbum(cat)
  return album ? `${catShort(cat)}（${album}）` : catShort(cat)
}

/** 单张堆叠卡：最多叠 4 层，右下角错开露出，营造 3D 层叠感 */
function StackCard({ group, onOpen }: { group: Group; onOpen: () => void }): JSX.Element {
  const layers = group.arr.slice(0, 4)
  const n = group.arr.length
  const todo = n - group.locked.size
  // 兜底帧到底在哪个“库”：不能写死成品库（它也可能停在待确认/垃圾桶），取第一张锁定帧的真实短名
  const lockedFirst = group.arr.find((i) => group.locked.has(i.id))
  const step = 14
  return (
    <button
      className="relative text-left focus:outline-none group"
      style={{ width: 168 + step * (layers.length - 1), height: 168 + step * (layers.length - 1) }}
      onClick={onOpen}
      title={`这一组共 ${n} 张重复/连拍，其中 ${todo} 张等你决定（其余已在${group.locked.size ? '其它分类' : '本分类'}），点击逐张处理`}
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
      {/* 整组张数 vs 待你决定的张数；有兜底帧时直接写明它在哪个库 */}
      <span className="absolute left-1/2 -translate-x-1/2 -bottom-2.5 z-20 whitespace-nowrap rounded-full bg-panel border border-line px-2 py-0.5 text-[11px] text-fg2 shadow">
        {group.locked.size > 0 ? `🔒 ${lockedFirst ? catShort(lockedFirst.category) : '其它分类'}已有 ${group.locked.size} 张 · ` : ''}待你决定 {todo}
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
  pickMode,
  locked,
  onToggle,
  onNav,
  onClose
}: {
  arr: ImageRecord[]
  index: number
  mode: 'keep' | 'trash'
  marked: Set<number>
  pickMode: 'drop' | 'keep'
  locked: Set<number>
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
  const isLocked = locked.has(img.id)
  // keep 模式三态：drop 习惯下点击=标废（红），keep 习惯下点击=标留（绿），没点过=未决定（灰）；trash 模式：蓝=勾选恢复
  const statusText = isLocked
    ? `当前：已在${catFull(img.category)}（不参与本组选择）`
    : mode !== 'keep'
      ? on
        ? '当前：已选中（将恢复）'
        : '当前：未选中'
      : on
        ? pickMode === 'drop'
          ? '当前：已标废弃'
          : '当前：已标保留'
        : '当前：未决定（留在重复类）'
  const statusCls = isLocked
    ? 'bg-white/10 text-white/60'
    : mode !== 'keep'
      ? on
        ? 'bg-brand text-white'
        : 'bg-white/15 text-white/70'
      : on
        ? pickMode === 'drop'
          ? 'bg-bad/90 text-white'
          : 'bg-good/90 text-white'
        : 'bg-white/15 text-white/70'
  const selectLabel = isLocked
    ? `🔒 已在${catShort(img.category)}`
    : mode !== 'keep'
      ? on
        ? '取消选中'
        : '选中恢复'
      : on
        ? '取消标记'
        : pickMode === 'drop'
          ? '标记为废'
          : '标记为保留'
  const selectCls =
    'px-5 py-2 rounded-md text-lg font-bold border transition-colors ' +
    (isLocked
      ? 'bg-white/5 text-white/45 border-white/15 cursor-not-allowed'
      : mode !== 'keep'
        ? on
          ? 'bg-brand text-white border-brand'
          : 'bg-white/10 text-white/85 border-white/25 hover:border-white/70'
        : on
          ? pickMode === 'drop'
            ? 'bg-bad text-white border-bad'
            : 'bg-good text-white border-good'
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
        <button className={selectCls} onClick={() => onToggle(img.id)} disabled={isLocked}>{selectLabel}</button>
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
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)
  // 选图模式（全局记忆）：drop=点选要丢弃的；keep=点选要保留的（仅 keep 分类弹窗有意义，废弃桶恢复模式不涉及）
  const pickMode = settings.dupPickMode ?? 'drop'
  // keep+drop：marked = 已标废弃（红）；keep+keep：marked = 已标保留（绿）；未点过的=未决定，留在重复类。
  // trash：marked = 勾选恢复。两种选图模式都无默认选择。
  const [marked, setMarked] = useState<Set<number>>(() => new Set())
  // 首次使用引导：只在看过的选图模式下弹一次，看过写进设置永久不再提示
  const [guide, setGuide] = useState(() => mode === 'keep' && !settings.dupGuideSeen)
  // 宫格密度（全局记忆）：默认每排 4 张；切换后每排 2 张大图，看得更清方便辨认
  const [bigGrid, setBigGrid] = useState(() => settings.dupGridBig ?? false)
  const toggleGrid = (): void => {
    const next = !bigGrid
    setBigGrid(next)
    void saveSettings({ dupGridBig: next })
  }
  const [zoomIdx, setZoomIdx] = useState<number | null>(null)
  // “换一张保留”：待替身选中期间记住哪张锁定帧要被换掉（仅 keep 模式）
  const [swapFrom, setSwapFrom] = useState<number | null>(null)
  // 硬不变式：每组任何时候至少一张留在成品库。所以“先升后降”——
  // 顶替帧先进库，原兜底帧再退回本组重新由用户决定，中间不会出现一组空库的瞬间。
  const doSwap = (targetId: number): void => {
    const from = swapFrom
    if (from === null || from === targetId) return
    setSwapFrom(null)
    setMarked((prev) => {
      const next = new Set(prev)
      next.delete(from)
      next.delete(targetId)
      return next
    })
    void (async () => {
      await moveIds([targetId], CAT_LIBRARY) // 先进库（同时清 duplicate 标签）
      await moveIds([from], 'duplicate') // 后退组（补用户 duplicate 标签，不删不改判）
    })()
  }
  const toggle = (id: number): void => {
    // 锁定帧（不在本分类，如成品库里的保留帧）不参与选择，只能看
    if (group.locked.has(id)) return
    setMarked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const nav = (delta: number): void =>
    setZoomIdx((cur) => (cur === null ? cur : Math.min(group.arr.length - 1, Math.max(0, cur + delta))))

  // 可选成员（落在本分类的）：所有计数、“未选”批量定案都只算它们，锁定帧不背锅
  const catIds = useMemo(() => group.arr.filter((i) => !group.locked.has(i.id)).map((i) => i.id), [group])
  // 还没决定的（未点过）：不强制对全组下结论，它们留在重复类里下次接着选
  const unmarkedIds = useMemo(() => catIds.filter((id) => !marked.has(id)), [catIds, marked])

  // 切换选图模式：两种模式都重置为“无默认选择”的自然起点（选丢弃=全绿；选保留=全红），
  // 并把新习惯写进设置永久记忆。
  const switchPickMode = (next: 'drop' | 'keep'): void => {
    if (next === pickMode) return
    setMarked(new Set())
    void saveSettings({ dupPickMode: next })
  }

  const closeGuide = (): void => {
    setGuide(false)
    void saveSettings({ dupGuideSeen: true })
  }

  // 快捷标记：只改 marked（锁定帧除外），不执行移动；执行永远靠底部两个按钮
  const markAll = (): void => setMarked(new Set(catIds))
  const clearMarks = (): void => setMarked(new Set())

  // 执行“已选”：drop 习惯下已标的是废帧→废弃桶；keep 习惯下已标的是保留帧→成品库
  const applyMarked = (): void => {
    if (mode === 'keep') {
      if (marked.size) void moveIds([...marked], pickMode === 'drop' ? CAT_DUP_TRASH : CAT_LIBRARY)
    } else if (marked.size) {
      void moveIds([...marked], 'duplicate')
    }
    onClose()
  }
  // 执行“未选”（整组定案快捷键）：drop 习惯下未选=保留→成品库；keep 习惯下未选=废→废弃桶
  const applyUnmarked = (): void => {
    if (unmarkedIds.length) void moveIds(unmarkedIds, pickMode === 'drop' ? CAT_LIBRARY : CAT_DUP_TRASH)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-6" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="relative bg-panel border border-line rounded-xl shadow-2xl w-full max-w-6xl max-h-[90vh] flex flex-col fade-in">
        <div className="px-5 py-3 border-b border-line relative flex items-center">
          <h2 className="text-fg font-bold">
            {mode === 'keep' ? '重复/连拍 · 选择保留' : '重复/连拍-废弃 · 选择恢复'}
            <span className="text-fg3 font-normal ml-2 text-sm">
              本组 {group.arr.length} 张 · 待你决定 {catIds.length} 张
            </span>
          </h2>
          {/* 选图模式切换：居中大字显示；习惯选留的还是选废的，选择会被永久记忆 */}
          {mode === 'keep' && (
            <div
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-2"
              title="切换选图习惯：有的人喜欢点选要保留的，有的人喜欢点选要丢弃的；选择会被记住"
            >
              <span className="text-sm text-fg3 whitespace-nowrap">选图模式</span>
              <div className="flex rounded-lg border border-line overflow-hidden text-sm">
                <button
                  className={'px-4 py-1.5 whitespace-nowrap ' + (pickMode === 'drop' ? 'bg-brand text-white font-medium' : 'bg-panel2 text-fg2 hover:bg-line')}
                  onClick={() => switchPickMode('drop')}
                >
                  点选要丢弃的
                </button>
                <button
                  className={'px-4 py-1.5 border-l border-line whitespace-nowrap ' + (pickMode === 'keep' ? 'bg-good text-white font-medium' : 'bg-panel2 text-fg2 hover:bg-line')}
                  onClick={() => switchPickMode('keep')}
                >
                  点选要保留的
                </button>
              </div>
            </div>
          )}
          <div className="flex-1" />
          {/* 宫格密度切换：每排 4 张 ↔ 每排 2 张大图（选择会被记住） */}
          <button
            className="btn text-xs whitespace-nowrap"
            onClick={toggleGrid}
            title={bigGrid ? '当前每排 2 张大图，点击切换为每排 4 张' : '当前每排 4 张，点击切换为每排 2 张大图，看得更清'}
          >
            {bigGrid ? '⊞ 每排 2 张' : '⊞ 每排 4 张'}
          </button>
          <button className="btn-ghost text-gray-400 ml-1" onClick={onClose}>✕</button>
        </div>

        <div className="p-4 overflow-y-auto">
          <div className="text-sm text-fg3 mb-3">
            {mode === 'keep' ? (
              <>
                <div className="mb-1">
                  说明：<b className="text-fg2">虚线框那张</b>是 AI 默认保留帧，已经在其它分类（正常导出），本弹窗只给你对比、不可点选；其余都是与它重复的多余连拍帧，由你逐张决定去留。不喜欢那张？点它上面的<span className="text-brand font-medium">「🔁 换一张保留」</span>顶一张上去，原那张会回到本组重新决定（否则成品库里这组就只剩它一张）。
                </div>
                {pickMode === 'drop' ? (
                  <>点击不要的照片标<span className="text-bad font-medium">红色（废）</span>，再点取消；<b className="text-fg2">没点过的不算数</b>，会留在重复类里下次接着选。底部两按钮分开执行：<span className="text-bad font-medium">丢弃已选</span>→废弃桶，<span className="text-good font-medium">保留未选</span>→成品库（正常导出）。</>
                ) : (
                  <>逐张点击你喜欢的照片标<span className="text-good font-medium">绿色（保留）</span>，再点取消；<b className="text-fg2">没点过的不算数</b>，会留在重复类里下次接着选。底部两按钮分开执行：<span className="text-good font-medium">保留已选</span>→成品库（正常导出），<span className="text-bad font-medium">丢弃未选</span>→废弃桶。</>
                )}
              </>
            ) : (
              '点击卡片勾选要恢复的照片；点「放大查看」看原图。确认后勾选的移回【重复/连拍】，未勾选的继续留在废弃桶。（虚线框是同组里已在其它分类的照片，只作对比、不可勾选）'
            )}
          </div>
          {/* “换一张保留”进行中的顶栏提示：选替身期间点任意一张即完成交换 */}
          {swapFrom !== null && (
            <div className="mb-3 rounded-lg border border-brand/50 bg-brand/10 px-3 py-2 text-sm text-fg flex items-center gap-3 sticky top-0 z-20 shadow">
              <span>🔁 点下面任意一张顶替【成品库】里那张：新那张进成品库（正常导出），原那张回到本组重新由你决定。</span>
              <button className="btn text-xs whitespace-nowrap ml-auto" onClick={() => setSwapFrom(null)}>
                取消
              </button>
            </div>
          )}
          <div className="grid gap-4" style={{ gridTemplateColumns: bigGrid ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))' }}>
            {group.arr.map((img, idx) => {
              // 三态：drop 习惯下 marked=标废（红）；keep 习惯下 marked=标保留（绿）；未点过=中性灰边（还没决定）；trash：蓝=勾选恢复
              const locked = group.locked.has(img.id)
              const on = marked.has(img.id)
              return (
                <button
                  key={img.id}
                  onClick={() => {
                    // 选替身期间：点任意可选张即完成“换一张保留”；锁定帧自己不能顶替自己
                    if (swapFrom !== null && !locked) void doSwap(img.id)
                    else toggle(img.id)
                  }}
                  className={
                    'relative rounded-lg overflow-hidden border-2 aspect-square transition-all ' +
                    // 待废弃只标红框/红角标，不压暗：本来就要看清照片内容才能决定留废
                    // 锁定帧用虚线框区分（不改透明度，照片保持清晰才能对比）
                    (locked
                      ? 'border-dashed border-gray-500 cursor-default'
                      : swapFrom !== null
                        ? 'border-brand'
                        : mode === 'keep'
                          ? on
                            ? pickMode === 'drop'
                              ? 'border-bad'
                              : 'border-good'
                            : 'border-line hover:border-gray-500'
                          : on
                            ? 'border-brand'
                            : 'border-line hover:border-gray-500')
                  }
                  title={locked ? `${img.filename} · 已在${catFull(img.category)}，不参与本组选择` : img.filename}
                >
                  {bigGrid ? <BigCardImg img={img} /> : <img src={src(img)} loading="lazy" className="w-full h-full object-cover" alt={img.filename} draggable={false} />}
                  {/* 锁定帧：告诉用户这张在哪里、为何不可点 */}
                  {locked && (
                    <span className="absolute left-1.5 top-1.5 px-1.5 py-0.5 rounded text-[11px] font-bold text-white shadow bg-gray-600/90">
                      🔒 已在{catShort(img.category)}
                    </span>
                  )}
                  {/* 不喜欢 AI 兜底的这张？先点它、再点任意一张顶替（只 keep 模式）：
                      这是整组唯一的“换人”入口，做成实心蓝底 + 白描边，太小客户根本看不到 */}
                  {locked && mode === 'keep' && swapFrom === null && (
                    <span
                      role="button"
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation()
                        setSwapFrom(img.id)
                      }}
                      className="absolute bottom-12 left-1/2 -translate-x-1/2 z-20 rounded-lg bg-brand hover:bg-blue-600 ring-2 ring-white/80 shadow-lg text-white px-4 py-2 text-sm font-bold backdrop-blur-sm transition-colors cursor-pointer whitespace-nowrap"
                    >
                      🔁 换一张保留
                    </span>
                  )}
                  {/* 未决定不挂角标，避免满屏“未选”干扰；只有点过的才标红/绿 */}
                  {on && (
                    <span
                      className={
                        'absolute left-1.5 top-1.5 px-1.5 py-0.5 rounded text-[11px] font-bold text-white shadow ' +
                        (mode === 'keep' ? (pickMode === 'drop' ? 'bg-bad' : 'bg-good') : 'bg-brand')
                      }
                    >
                      {mode === 'keep' ? (pickMode === 'drop' ? '废' : '留') : '✓ 恢复'}
                    </span>
                  )}
                  {/* 中心放大镜：点它看原图（stopPropagation 避免触发卡片的留/废切换）；
                      锁定卡下方要让给放大的「换一张保留」，所以放大镜上移，窄窗口下两者不致重叠 */}
                  <span
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation()
                      setZoomIdx(idx)
                    }}
                    className={'absolute left-1/2 ' + (locked ? 'top-[34%]' : 'top-1/2') + ' -translate-x-1/2 -translate-y-1/2 z-10 flex items-center gap-1.5 rounded-lg bg-black/55 hover:bg-brand text-white px-3 py-2 text-xs font-medium backdrop-blur-sm transition-colors cursor-zoom-in'}
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

        <div className="px-5 py-3 border-t border-line flex items-center gap-2 flex-wrap">
          {mode === 'keep' ? (
            <>
              {pickMode === 'drop' ? (
                <button className="btn text-xs" onClick={markAll} title="把本组待选的全部标废（只标记、不执行；成品库那张保留帧不受影响）">全标废（只留成品库那张）</button>
              ) : (
                <button className="btn text-xs" onClick={markAll} title="把待选的全部标保留（只标记，不执行）">全部标保留</button>
              )}
              <button className="btn text-xs" onClick={clearMarks} disabled={!marked.size} title="清除本弹窗内所有红/绿标记">清除标记</button>
            </>
          ) : (
            <>
              <button className="btn text-xs" onClick={() => setMarked(new Set(catIds))}>全选</button>
              <button className="btn text-xs" onClick={() => setMarked(new Set())}>全不选</button>
            </>
          )}
          <div className="flex-1" />
          <button className="btn" onClick={onClose} title="不执行任何移动，未处理的图留在重复类里">稍后再说</button>
          {mode === 'keep' ? (
            <>
              {/* 处理未选（整组定案）：drop 习惯下未选=保留→成品库；keep 习惯下未选=废→废弃桶 */}
              <button
                className={'text-xs whitespace-nowrap ' + (pickMode === 'drop' ? 'btn-good' : 'btn-danger')}
                disabled={!unmarkedIds.length}
                onClick={applyUnmarked}
                title={pickMode === 'drop' ? '这一组不用再挑了：把没点过的全部移回成品库（正常导出）' : '这一组定案：把没点到的全部移入废弃桶（永不导出）'}
              >
                {pickMode === 'drop' ? `保留未选 ${unmarkedIds.length} 张→成品库` : `丢弃未选 ${unmarkedIds.length} 张→废弃桶`}
              </button>
              {/* 处理已选（主按钮）：只动点过的，没点过的留在重复类 */}
              <button
                className={pickMode === 'drop' ? 'btn-danger whitespace-nowrap' : 'btn-good whitespace-nowrap'}
                disabled={!marked.size}
                onClick={applyMarked}
                title={pickMode === 'drop' ? '只把标红的移入废弃桶，没点过的不动' : '只把标绿的移回成品库，没点过的不动'}
              >
                {pickMode === 'drop' ? `丢弃已选 ${marked.size} 张→废弃桶` : `保留已选 ${marked.size} 张→成品库`}
              </button>
            </>
          ) : (
            <button className="btn-primary" disabled={!marked.size} onClick={applyMarked}>
              恢复 {marked.size} 张
            </button>
          )}
        </div>
      </div>

      {zoomIdx !== null && (
        <ZoomViewer
          arr={group.arr}
          index={zoomIdx}
          mode={mode}
          marked={marked}
          pickMode={pickMode}
          locked={group.locked}
          onToggle={toggle}
          onNav={nav}
          onClose={() => setZoomIdx(null)}
        />
      )}

      {/* 首次使用引导：讲解两种选图模式与红绿语义，看过一次永久不再提示 */}
      {guide && mode === 'keep' && (
        <div className="absolute inset-0 z-[55] bg-black/70 rounded-xl flex items-center justify-center p-6" onClick={closeGuide}>
          <div
            className="bg-panel border border-line rounded-xl shadow-2xl w-full max-w-lg p-6 fade-in cursor-default"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-lg font-bold text-fg mb-1">👋 第一次整理重复/连拍？两种选图方式随你</div>
            <div className="text-sm text-fg2 leading-relaxed mb-4">每组最早的那张 AI 已默认放进【成品库】兜底（就算你一张没整理，这组也不会整组漏导），弹窗里会把它用<b className="text-fg2">虚线框</b>一起显示供对比，其余多余连拍帧由你决定。选一次习惯就会永远记住（可随时在顶部切换）：</div>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="rounded-lg border border-line bg-panel2 p-3">
                <div className="text-sm font-bold text-brand mb-1">点选要丢弃的</div>
                <div className="text-xs text-fg2 leading-relaxed">
                  点击你不要的照片标<span className="text-bad font-medium">红色（废）</span>，底部<b className="text-fg2">两个按钮分开执行</b>：<span className="text-bad font-medium">丢弃已选</span>→废弃桶，<span className="text-good font-medium">保留未选</span>→成品库。没点过的不算数，下次接着选。
                </div>
              </div>
              <div className="rounded-lg border border-line bg-panel2 p-3">
                <div className="text-sm font-bold text-good mb-1">点选要保留的</div>
                <div className="text-xs text-fg2 leading-relaxed">
                  逐张点击你喜欢的照片标<span className="text-good font-medium">绿色（保留）</span>，同样<b className="text-fg2">两个按钮分开执行</b>：<span className="text-good font-medium">保留已选</span>→成品库，<span className="text-bad font-medium">丢弃未选</span>→废弃桶。这一组没挑完可以先关窗，剩下的明天接着挑。
                </div>
              </div>
            </div>
            <div className="text-xs text-fg3 leading-relaxed mb-4">
              颜色含义永远一致：<span className="text-good font-medium">绿 = 保留 → 回成品库，正常导出</span>；<span className="text-bad font-medium">红 = 废弃 → 进废弃桶，永不导出</span>；<span className="text-fg2 font-medium">没点过 = 还没决定</span>，留在组里下次接着选；<span className="text-fg2 font-medium">虚线框 = 那张兜底帧</span>（已在成品库，只作对比），<span className="text-brand font-medium">不喜欢它就点「🔁 换一张保留」</span>换一张上去。拿不准就点卡片中间的「放大查看」对比原图再定。
            </div>
            <button className="btn-primary w-full text-sm" onClick={closeGuide}>知道了，开始使用</button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function DuplicateGroupsView({ images, mode }: { images: ImageRecord[]; mode: 'keep' | 'trash' }): JSX.Element {
  // 整组补全：本分类只装“多余帧”，同组的 AI 默认保留帧还留在成品库等其它分类。
  // 按 dup_group 向主进程要回整组成员，否则 2 张的组只显示 1 张（退化成所谓的“未成组”孤帧）。
  const gidsKey = useMemo(
    () => [...new Set(images.map((i) => i.dupGroup).filter((g): g is string => !!g))].join('|'),
    [images]
  )
  const [partners, setPartners] = useState<ImageRecord[]>([])
  useEffect(() => {
    const gids = gidsKey ? gidsKey.split('|') : []
    if (!gids.length) {
      setPartners([])
      return
    }
    let alive = true
    void window.api
      .listImagesByGroups(gids)
      .then((rows) => {
        if (alive) setPartners(rows)
      })
      .catch(() => {
        /* 补全失败只影响“看不见同伴”，不阻断本分类自身的留废判定 */
      })
    return () => {
      alive = false
    }
  }, [gidsKey])

  const groups = useMemo<Group[]>(() => {
    const catIds = new Set(images.map((i) => i.id))
    const pool = new Map<number, ImageRecord>()
    for (const img of partners) pool.set(img.id, img)
    for (const img of images) pool.set(img.id, img) // 本分类记录后写：刚被标签/扫描更新过的字段更即时
    const m = new Map<string, ImageRecord[]>()
    for (const img of pool.values()) {
      const key = img.dupGroup || `single:${img.id}`
      const arr = m.get(key)
      if (arr) arr.push(img)
      else m.set(key, [img])
    }
    const gs: Group[] = []
    for (const [gid, arr] of m) {
      // 只列至少有一张落在本分类的组：全组都已处理完的历史组不该再冒出来
      if (!arr.some((i) => catIds.has(i.id))) continue
      gs.push({
        gid,
        arr: [...arr].sort((a, b) => a.id - b.id),
        locked: new Set(arr.filter((i) => !catIds.has(i.id)).map((i) => i.id))
      })
    }
    // 待你决定多的排前面（越需要处理的越靠前），同数量时整组大的靠前
    gs.sort((a, b) => b.arr.length - b.locked.size - (a.arr.length - a.locked.size) || b.arr.length - a.arr.length)
    return gs
  }, [images, partners])

  // 弹窗只记 gid，不存 Group 快照：移动成员后父组件重算出的新组才是最新状态（否则“换一张保留”
  // 之后弹窗里还挂着已经离开的旧卡）；整组处理完时 find 不到 → 弹窗自动关闭
  const [openGid, setOpenGid] = useState<string | null>(null)
  const open = openGid ? groups.find((g) => g.gid === openGid) ?? null : null

  // 顶部说明卡：第一次进来展开全部并给「已阅」；点过已阅后写进设置，
  // 以后再进默认只占一行，但仍可手动展开（已展开时不再出现已阅按钮）
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)
  const [bannerSeen, setBannerSeen] = useState(() => !!settings.dupBannerSeen)
  const [bannerOpen, setBannerOpen] = useState(() => !settings.dupBannerSeen)
  const readBanner = (): void => {
    setBannerSeen(true)
    setBannerOpen(false)
    void saveSettings({ dupBannerSeen: true })
  }

  if (!groups.length) {
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
      {mode === 'keep' ? (
        <div className="mb-4 rounded-lg bg-panel2/60 border border-line px-4 py-2 text-sm text-fg2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-fg">📌 这一页怎么看</span>
            <span className="text-fg3">共 {groups.length} 组</span>
            {/* 收起态只留这一行极简摘要，和标题挤在同一行，不再单独占版面 */}
            {!bannerOpen && (
              <span className="text-fg3">
                每组最早那张已在<b className="text-fg2">成品库</b>兜底；虚线框=它，<span className="text-brand font-medium">可换一张保留</span>；
                <span className="text-good font-medium">绿→成品库</span>·<span className="text-bad font-medium">红→废弃桶</span>·没点过的下次接着挑
              </span>
            )}
            {/* 展开/收起紧跟在文字后面，做成带蓝边的实心按钮：挂行尾没人看得见 */}
            <button
              className="shrink-0 rounded-md border border-brand/60 bg-panel px-2.5 py-1 text-xs font-bold text-brand hover:bg-brand hover:text-white transition-colors cursor-pointer whitespace-nowrap"
              onClick={() => setBannerOpen((v) => !v)}
              title={bannerOpen ? '收起来，不影响正常使用' : '展开完整说明'}
            >
              {bannerOpen ? '▴ 收起说明' : '▾ 展开说明'}
            </button>
            {!bannerSeen && bannerOpen && (
              <button className="btn-good text-xs whitespace-nowrap" onClick={readBanner} title="收起这段说明，以后进来默认只看一行">
                ✓ 已阅，以后默认收起
              </button>
            )}
          </div>
          {bannerOpen && (
            <ul className="space-y-1 mt-1.5 leading-relaxed">
              <li>
                · 每一组连拍/重复，AI 已经先把<b className="text-fg2">最早的那张自动放进【成品库】兜底</b>——你一张都不整理，这组也至少有一张会被导出，<b className="text-fg2">不会整组丢</b>。
              </li>
              <li>
                · 所以点开分组会看到一张<span className="text-fg2 font-medium">虚线框、写着「🔒 已在成品库」</span>的：它就是那张兜底帧，在这里只给你对比，不占“待决定”名额。
              </li>
              <li>
                · <b className="text-fg2">不喜欢 AI 挑的这张？</b>点它上面的<span className="text-brand font-medium">「🔁 换一张保留」</span>，再点任意一张顶上去：新那张进成品库，原那张自动回到本组，跟其它帧一样重新由你决定。
              </li>
              <li>
                · 剩下的多余帧由你定：<span className="text-good font-medium">标绿 → 回成品库（一起导出）</span>；<span className="text-bad font-medium">标红 → 进废弃桶（永不导出）</span>；没点过的留在组里，下次接着挑。
              </li>
              <li>
                · 为什么要有这张兜底：怕你还没整理到这一组就去导出，结果整组一张不剩。真想全清也可以（全标红→废弃桶，随时能恢复），只是那样成品库里这组就没图了。
              </li>
            </ul>
          )}
        </div>
      ) : (
        <div className="mb-5 rounded-lg bg-panel2/60 border border-line px-4 py-2.5 text-sm text-fg2">
          废弃桶共 {groups.length} 组、{images.length} 张。点击叠卡可把照片恢复到【重复/连拍】；此分类永不导出。
        </div>
      )}

      <div className="flex flex-wrap gap-6 gap-y-8 justify-center mb-6 pb-3">
        {groups.map((g) => (
          <StackCard key={g.gid} group={g} onOpen={() => setOpenGid(g.gid)} />
        ))}
      </div>

      {/* key 按组重挂载：否则从 A 组切到 B 组时 marked 不会重新初始化 */}
      {open && <GroupModal key={open.gid} group={open} mode={mode} onClose={() => setOpenGid(null)} />}
    </div>
  )
}
