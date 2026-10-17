/**
 * 重复照片 分组视图（专用定制界面）
 * - 把同一 dupGroup 的重复照片叠成一张"3D 堆叠卡"：后层向左上、前层向右下错开，
 *   每张都露出右下角，一眼看出这一组有几张。
 * - 整组成员 = 本分类的多余帧 + 其它分类里的同伴（聚类时每组按用户权重挑出的代表帧：
 *   本身干净就留在交付库，全组没一张能交时它被停在待确认等你拍板）。
 *   后者由主进程 listImagesByGroups 按 dup_group 补全，在弹窗里以锁定卡展示（虚线框 + “已在交付库”角标）：
 *   这样每组永远看得到完整上下文，2 张的组不会再退化成一张“未成组”孤帧（已彻底取消该分区）。
 * - 点击堆叠卡 → 弹窗平铺该组全部照片，这一页已简化成一条主线（用户 10-13 拍板“要简单易懂好操作”）：
 *   · 排版：已入交付库的那几张永远排最前（绿框 + “✓ 已在交付库”角标），下面一条分割线隔开还没入库的；
 *     只有已入库那张右上角标真实档位（优质/良好/一般）；还没入库的不标档位（免得被误认为已分好，用户 10-13），
 *     它左上角只挂瑕疵标签（闭眼、半截头…），一眼看得懂它为什么没进去；选档时才在弹层里用★提示 AI 预估。
 *   · keep 模式（在【重复照片】分类内）：每张未入库照片下面只有两个动作——
 *     「要这张→选档加进库」（点后弹出优质/良好/一般三档，点其中一档才确认把这张加进交付库，并按你选的档手动定死；
 *       不顶掉库里原来那张——一组可以同时交好几张）与「丢弃」（进废弃桶，永不导出）。
 *     点一下立刻生效，没有标红标绿、没有选图模式切换；单击卡片勾选、双击才放大对比原图（与主图库一致）。
 *     已入库那张带「移出交付库」可退回本组（不自动顶别人上来）；没点过的先留着，下次接着挑。
 *     改档/进库/丢弃都会清 duplicate 标签，重聚类不会再抓回来。
 *   · trash 模式（在【重复照片-废弃】分类内）：仍是勾选 → 批量恢复回【重复照片】（这套本来就简单，保留）。
 * - 双击照片进入原图全屏查看器：键盘上下左右 / 滚轮切换，底部有「要这张（弹三档加库）/ 丢弃 / 移出交付库 / 恢复」按钮。
 * - 两个分类都不允许从别处拖入（在 Sidebar 已禁用 drop），只能经此流程进出。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { toSrc, useBigSrc, Spinner } from './imageSrc'
import { dimTagColor } from './Sidebar'
import type { ImageRecord } from '../../../shared/types'
import {
  BAD_DIMENSIONS,
  CAT_TRASH,
  CAT_LIBRARY,
  CAT_REVIEW,
  DEFAULT_TIER_NAMES,
  DIMENSION_LABELS,
  estimateTier,
  isBadDim,
  isDeliverable,
  isDupRedundant,
  isStructuralDim,
  isTrashLike,
  type DimensionKey,
  type TierKey
} from '../../../shared/types'

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
  /** 不在当前分类、只能看不能选的成员 id（如交付库里的 AI 默认保留帧） */
  locked: Set<number>
}

/**
 * 这张落在哪个相册（与位置短名一致时不重复显示） */
function catAlbum(cat: string): string {
  if (cat === CAT_LIBRARY) return ''
  if (cat.startsWith('custom:')) return '自定义分类'
  return DIMENSION_LABELS[cat as keyof typeof DIMENSION_LABELS] || ''
}

/**
 * 这张是不是“已经在交付库里、会被导出去”。
 * 口径单一真源：直接用主进程导出闸门同一个 isDeliverable（用户 2026-10-15：“在就是在，不在就是不在，
 * 不能乱标”）。旧版只看 category 与冗余标签、完全不查身上的瑕疵标签，于是带着闭眼的代表帧
 * 被角标谎报“已在交付库（会被导出）”，而导出清单里根本没这张。
 * 分组详情页靠它把真正会出口的那几张挑出来排到最前。
 */
function inLibrary(img: ImageRecord): boolean {
  return isDeliverable(img.category, img.tags)
}

/** 角标用的位置短名：只说它真正停在哪，不再把“人数相册”兜底成“交付库” */
function placeShort(img: ImageRecord): string {
  if (isTrashLike(img.category)) return '废弃库'
  if (img.category === CAT_REVIEW) return '待确认'
  if (inLibrary(img)) return '交付库'
  if (isStructuralDim(img.category) || isDupRedundant(img.tags)) return '重复照片'
  if (isBadDim(img.category)) return DIMENSION_LABELS[img.category as DimensionKey] || '问题图区'
  // 主分类是人数/黑白/自定义相册却带中高瑕疵：人在那个相册里，但导出闸门拦着
  return `${catAlbum(img.category) || '相册'}·带瑕疵`
}

/** 弹窗状态行的完整说法：位置 + 会不会被导出，两者必须同时真话 */
function exportStateText(img: ImageRecord): string {
  if (inLibrary(img)) return '已在交付库（会被导出）'
  if (isTrashLike(img.category)) return '已在废弃库（不导出）'
  if (img.category === CAT_REVIEW) return '停在待确认等你拍板（不导出）'
  if (isStructuralDim(img.category) || isDupRedundant(img.tags)) return '还在重复照片里等你决定（不导出）'
  if (isBadDim(img.category)) return `停在${DIMENSION_LABELS[img.category as DimensionKey] || '问题图区'}（不导出）`
  return `带着瑕疵停在${catAlbum(img.category) || '相册'}（不导出）`
}

/** 右上角档位角标（优质/绿、良好/蓝、一般/灰）：与网格图右上角标同一命名与配色 */
function TierBadge({ img, tierNames }: { img: ImageRecord; tierNames: string[] }): JSX.Element {
  const tier = estimateTier(img.tags, img.tier)
  const text = tier ? tierNames[tier - 1] || String(tier) : '未评档'
  const cls = tier === 2 ? 'bg-blue-600/90' : tier === 3 ? 'bg-gray-500/90' : 'bg-good'
  return (
    <span
      className={'absolute right-1.5 top-1.5 z-10 px-1.5 py-0.5 rounded text-[11px] font-bold text-white shadow-[0_1px_3px_rgba(0,0,0,0.65)] ' + cls}
      title={
        img.tier
          ? img.tierBy === 'user'
            ? `档位：${text}（你手动定过，重筛不会改）`
            : `档位：${text}（按引擎实测清晰度分的）`
          : `这张现在不在交付库，预计入库后档位：${text}（拿不到清晰度实测时归中间档）`
      }
    >
      {text}
    </span>
  )
}

/**
 * 卡片下沿的标签条：把“这张为什么没进库”直接写在图上（用户 10-13 指定：下面那批要显示瑕疵标签，比如闭眼）。
 * 只读不折行：人数/黑白这类客观事实标签在这页不决定去留，占位反而噪，所以只取坏维度 + 冗余。
 * belowBadge：左上已有一枚“在待确认/废弃”位置标时，标签条往下让开一行，别被它盖住。
 */
function TagStrip({ img, belowBadge }: { img: ImageRecord; belowBadge?: boolean }): JSX.Element | null {
  const dims = (BAD_DIMENSIONS as string[]).filter((d) => {
    const t = img.tags[d as DimensionKey]
    return !!t && t.level !== 'low'
  })
  const dupTag = img.tags.duplicate
  if (dupTag && dupTag.level !== 'low') dims.push('duplicate')
  if (!dims.length) return null
  return (
    <span className={'absolute left-1 z-10 flex flex-wrap gap-1 max-w-[72%] pointer-events-none ' + (belowBadge ? 'top-8' : 'top-1.5')}>
      {dims.map((d) => {
        const c = dimTagColor(d)
        const high = img.tags[d as DimensionKey]?.level === 'high'
        return (
          <span
            key={d}
            className="px-1.5 py-0.5 rounded-[5px] text-[11px] leading-none font-medium border shadow-[0_1px_3px_rgba(0,0,0,0.65)]"
            style={{ color: '#fff', background: c + (high ? 'E6' : 'B3'), borderColor: 'rgba(255,255,255,.55)' }}
            title={`${DIMENSION_LABELS[d as keyof typeof DIMENSION_LABELS] || d}：${img.tags[d as DimensionKey]?.reason || ''}`}
          >
            {DIMENSION_LABELS[d as keyof typeof DIMENSION_LABELS] || d}
          </span>
        )
      })}
    </span>
  )
}

/** 单张堆叠卡：最多叠 4 层，右下角错开露出，营造 3D 层叠感 */
function StackCard({ group, onOpen }: { group: Group; onOpen: () => void }): JSX.Element {
  const layers = group.arr.slice(0, 4)
  const n = group.arr.length
  const libCount = group.arr.filter(inLibrary).length
  // 待决定 = 没入库的张数（上面那段），已入库 = 入库张数（下面那段）；哪个为 0 卡片上就不显示哪个
  const todo = n - libCount
  const step = 14
  return (
    <button
      className="relative text-left focus:outline-none group"
      style={{ width: 168 + step * (layers.length - 1), height: 168 + step * (layers.length - 1) }}
      onClick={onOpen}
      title={`这一组共 ${n} 张重复照片，${libCount ? `已入交付库 ${libCount} 张` : '一张都还没入交付库'}，其中 ${todo} 张等你决定，点击逐张处理`}
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
      {/* 两个数永远都显示（0 也照写）：待决定（未入库）几张 · 已入库几张 */}
      <span className="absolute left-1/2 -translate-x-1/2 -bottom-2.5 z-20 whitespace-nowrap rounded-full bg-panel border border-line px-2 py-0.5 text-[11px] text-fg2 shadow">
        待决定 {todo} · <span className="text-good font-bold">已入库 {libCount}</span>
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
  locked,
  tierNames,
  onToggle,
  onKeep,
  onTrash,
  onUnkeep,
  onRestore,
  onNav,
  onClose
}: {
  arr: ImageRecord[]
  index: number
  mode: 'keep' | 'trash'
  marked: Set<number>
  locked: Set<number>
  tierNames: string[]
  onToggle: (id: number) => void
  onKeep: (id: number, tier: TierKey) => void
  onTrash: (id: number) => void
  onUnkeep: (id: number) => void
  onRestore: (id: number) => void
  onNav: (delta: number) => void
  onClose: () => void
}): JSX.Element {
  const img = arr[index]
  const big = useBigSrc(img)
  const lastWheel = useRef(0)
  // 进库前先让用户在三档里点一档确认（用户 10-13：交付库保留优质/良好/一般三个子分类）
  const [tierPick, setTierPick] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (tierPick) setTierPick(false)
        else onClose()
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
  }, [onClose, onNav, tierPick])

  // 换到别张时收起可能开着的选档面板
  useEffect(() => setTierPick(false), [index])

  const onWheel = (e: React.WheelEvent): void => {
    const now = Date.now()
    if (now - lastWheel.current < 250) return
    if (Math.abs(e.deltaY) < 5) return
    lastWheel.current = now
    onNav(e.deltaY > 0 ? 1 : -1)
  }

  const on = marked.has(img.id)
  const inLib = inLibrary(img)
  const isLocked = locked.has(img.id)
  const isTrash = isTrashLike(img.category)
  // keep 主线：未入库且非废弃库的那张才能“加进库/丢弃”（含待确认/瑕疵分类，都就地可收）；已入库=移出；废弃库/废弃桶=恢复
  const canKeep = mode === 'keep' && !inLib && !isTrash
  const statusText = isLocked && !inLib
    ? `当前：${exportStateText(img)}${mode === 'keep' ? '（可就地处理）' : '（不参与本组）'}`
    : inLib
      ? '当前：已在交付库（会被导出）'
      : mode !== 'keep'
        ? on
          ? '当前：已勾选，将恢复'
          : '当前：未勾选'
        : '当前：待你决定'
  const statusCls = inLib
    ? 'bg-good/90 text-white'
    : isLocked
      ? 'bg-white/10 text-white/60'
      : mode !== 'keep'
        ? on
          ? 'bg-brand text-white'
          : 'bg-white/15 text-white/70'
        : 'bg-white/15 text-white/70'
  const selectCls =
    'px-5 py-2 rounded-md text-lg font-bold border transition-colors ' +
    (isLocked
      ? 'bg-white/5 text-white/45 border-white/15 cursor-not-allowed'
      : on
        ? 'bg-brand text-white border-brand'
        : 'bg-white/10 text-white/85 border-white/25 hover:border-white/70')
  // AI 看这张像哪一档，给那一档加个★当推荐（不替用户拍板，只是提示）
  const est = estimateTier(img.tags, img.tier)
  const tierColor = (n: number): string => (n === 2 ? 'bg-blue-600 hover:bg-blue-700' : n === 3 ? 'bg-gray-500 hover:bg-gray-600' : 'bg-good hover:bg-[#15803d]')

  return (
    <div className="fixed inset-0 z-[60] bg-black/95 flex flex-col fade-in" onClick={(e) => e.target === e.currentTarget && onClose()} onWheel={onWheel}>
      {/* 顶栏：居中大字显示“第 N / 总数 · 文件名”与当前状态 */}
      <div className="shrink-0 relative flex items-center gap-3 px-4 py-3 border-b border-white/10 bg-black/40">
        <span className="text-white/90 font-bold text-lg">{mode === 'keep' ? '放大对比' : '放大查看 · 选择恢复'}</span>
        <div className="flex-1" />
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-3 max-w-[50%]">
          <span className="text-white/90 text-lg truncate" title={img.path}>第 {index + 1} / {arr.length} 张 · {img.filename}</span>
          <span className={'px-2.5 py-1 rounded text-base font-bold whitespace-nowrap ' + statusCls}>{statusText}</span>
        </div>
        <div className="flex-1" />
        <button className="px-3 py-1.5 rounded-md text-base font-bold text-white bg-bad hover:bg-red-600 transition-colors" onClick={onClose} title="关闭（ESC）">ESC关闭</button>
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

      {/* 底栏：上一张 / 主操作 / 下一张 / 关闭。keep 模式点“要这张”先弹三档，点一档才确认进库 */}
      <div className="shrink-0 flex items-center justify-center gap-3 px-4 py-3.5 border-t border-white/10 bg-black/50 flex-wrap">
        <button className="btn text-lg px-4 py-2" onClick={() => onNav(-1)} disabled={index <= 0}>← 上一张</button>
        {mode === 'keep' ? (
          canKeep ? (
            <>
              <button className="px-5 py-2 rounded-md text-lg font-bold text-white bg-good hover:bg-[#15803d] transition-colors" onClick={() => setTierPick(true)}>要这张 → 选档加进库</button>
              <button className="px-5 py-2 rounded-md text-lg font-bold text-white bg-bad/90 hover:bg-bad transition-colors" onClick={() => onTrash(img.id)}>丢弃</button>
            </>
          ) : inLib ? (
            <button className="px-5 py-2 rounded-md text-lg font-bold border border-brand text-brand hover:bg-brand hover:text-white transition-colors" onClick={() => onUnkeep(img.id)}>移出交付库</button>
          ) : isTrash ? (
            <button className="px-5 py-2 rounded-md text-lg font-bold text-white bg-amber-500 hover:bg-amber-600 transition-colors" onClick={() => onRestore(img.id)}>恢复回本组</button>
          ) : (
            <span className="px-5 py-2 rounded-md text-lg text-white/45 border border-white/15">🔒 已在{placeShort(img)}</span>
          )
        ) : (
          <button className={selectCls} onClick={() => onToggle(img.id)} disabled={isLocked}>{on ? '取消选中' : '选中恢复'}</button>
        )}
        <button className="btn text-lg px-4 py-2" onClick={() => onNav(1)} disabled={index >= arr.length - 1}>下一张 →</button>
        <div className="w-3" />
        <button className="btn text-lg px-4 py-2" onClick={onClose}>关闭</button>
      </div>

      {/* 点“要这张”后弹出的三档选择弹窗（用户 10-13：不再在底栏同行展开，改成居中弹窗）；白底面板，按钮文字一律非白 */}
      {tierPick && canKeep && (
        <div className="fixed inset-0 z-[65] bg-black/70 flex items-center justify-center p-6" onClick={(e) => e.target === e.currentTarget && setTierPick(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-6">
            <div className="text-lg font-bold text-gray-900 mb-1">放进交付库哪一档？</div>
            <div className="text-sm text-gray-500 mb-5">选一档就把这张加进交付库，不会顶掉已入库那张。</div>
            <div className="flex flex-col gap-2.5">
              {tierNames.map((name, i) => {
                const n = (i + 1) as TierKey
                return (
                  <button
                    key={name}
                    className={'w-full rounded-md px-4 py-3 text-base font-bold text-white transition-colors ' + tierColor(i + 1) + (est === n ? ' ring-2 ring-gray-900' : '')}
                    onClick={() => { setTierPick(false); onKeep(img.id, n) }}
                    title={est === n ? 'AI 按实测清晰度看这张像这一档' : undefined}
                  >
                    {name}
                    {est === n ? ' ★ 推荐' : ''}
                  </button>
                )
              })}
            </div>
            {/* 颜色写死：面板本身 bg-white（不随主题），而项目的 gray-* 已重映射为主题令牌
                （bg-gray-100 在浅色主题下是近黑），不写死会变成黑底灰字。 */}
            <button className="mt-4 w-full rounded-md px-4 py-2.5 text-base font-bold text-[#374151] bg-[#f3f4f6] hover:bg-[#e5e7eb] border border-[#d1d5db] transition-colors" onClick={() => setTierPick(false)}>取消</button>
          </div>
        </div>
      )}
    </div>
  )
}

/** 组内详情弹窗：逐张标记留/废（keep）或勾选恢复（trash）；每卡可放大看原图 */
function GroupModal({ group, mode, onClose }: { group: Group; mode: 'keep' | 'trash'; onClose: () => void }): JSX.Element {
  const moveIds = useStore((s) => s.moveIds)
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)
  // 简化后 marked 只服务 trash 模式（勾选→批量恢复）；keep 模式改成每张直接按钮，不再用它做三态。
  const [marked, setMarked] = useState<Set<number>>(() => new Set())
  // keep 模式：点「要这张→选档进库」后，这张卡上弹出优质/良好/一般三档，点一档才确认。pickerId 记住是哪张在选档。
  const [pickerId, setPickerId] = useState<number | null>(null)
  // 就地确认（应用内弹窗，Electron 禁 window.confirm）：两种待确认动作——
  //   removeLast：移出本组在库里的最后一张（删完这组库里 0 张）；restore：把废弃库/废弃桶里那张恢复回本组。
  const [pending, setPending] = useState<{ id: number; kind: 'removeLast' | 'restore' } | null>(null)
  // 宫格密度（全局记忆）：默认每排 4 张；切换后每排 2 张大图，看得更清方便辨认
  const [bigGrid, setBigGrid] = useState(() => settings.dupGridBig ?? false)
  const toggleGrid = (): void => {
    const next = !bigGrid
    setBigGrid(next)
    void saveSettings({ dupGridBig: next })
  }
  const [zoomIdx, setZoomIdx] = useState<number | null>(null)
  // 已入交付库的那几张（排在最前那段）：它们不是“锁定看不了”，而是可以随时被移出交付库（不自动顶别人上来）；
  // 但在废弃桶视图里它们仍只作对比（那里的主流程是“勾选→移回重复照片”），不混进勾选。
  const libImgs = useMemo(() => group.arr.filter(inLibrary), [group])
  const restImgs = useMemo(() => group.arr.filter((i) => !inLibrary(i)), [group])
  // 弹窗里“不可点选”的那几张：同组但不在本分类的同伴，加上废弃桶视图里已入库那张（那里只作对比）
  const lockedIds = useMemo(() => {
    const s = new Set<number>()
    for (const img of group.arr) {
      if (group.locked.has(img.id) || (mode !== 'keep' && inLibrary(img))) s.add(img.id)
    }
    return s
  }, [group, mode])
  // 卡片展示顺序：keep 模式下"未入库在上、已入库在下"（与下面分段渲染一致，放大查看器序号不会打架）；
  // trash 模式沿用旧顺序（已入库作对比在前、废弃成员在后）。
  const ordered: ImageRecord[] = mode === 'keep' ? [...restImgs, ...libImgs] : [...libImgs, ...restImgs]
  const tierNames: string[] = settings.tierNames ?? DEFAULT_TIER_NAMES
  // 把这张“加”进交付库的某一档（用户 10-13：交付库保留优质/良好/一般三个子分类，点进库先选档再确认）：
  // moveIds 到 'tier:N' 走主进程档位分支——不在库的先清瑕疵/冗余标签、落回交付库、按你选的档手动定死（tier_by=user，重筛不改）。
  // 这是“加一张”，不顶掉库里原来那张——同一组可以同时交好几张；哪张不想要了就点它的“移出交付库”。
  const keepOne = (img: ImageRecord, tier: TierKey): void => {
    void moveIds([img.id], `tier:${tier}`)
  }
  // 一键把这张丢进统一废弃库（永不导出）：下面那批除了“选档进库”，另一条路就是丢弃，一步到位。
  // moveIds 会带上当前分类 duplicate 作为 source，后端据此不记冗余/误判样本，废弃库还原时又能“从哪来回哪去”回到本组。
  const trashOne = (img: ImageRecord): void => {
    void moveIds([img.id], CAT_TRASH)
  }
  // 把已入库这张移出交付库、退回本组（用户 10-13）：不自动顶别人上来，一组几张都人工自定，删到 0 张也允许
  const removeFromLibrary = (img: ImageRecord): void => {
    void moveIds([img.id], 'duplicate')
  }
  // 点“移出交付库”：若这是该组在库里的最后一张，先弹应用内确认（删完这组库里就 0 张），否则直接移
  const requestRemove = (img: ImageRecord): void => {
    if (libImgs.length <= 1) setPending({ id: img.id, kind: 'removeLast' })
    else removeFromLibrary(img)
  }
  // 把废弃库/废弃桶里这张恢复回本组（用户 10-13：同组的图不必换个分类去捞）：moveIds 到 'duplicate' 把它捣回待选区，加回组
  const doRestore = (img: ImageRecord): void => {
    void moveIds([img.id], 'duplicate')
  }
  // 点“恢复”：低危但用户要求“+提示确实”，统一走应用内确认
  const requestRestore = (img: ImageRecord): void => {
    setPending({ id: img.id, kind: 'restore' })
  }
  const toggle = (id: number): void => {
    // keep 多选：只要不是已经在废弃库的就能勾（已入库的=勾了批量移入垃圾桶，未入库的=勾了批量丢弃）；
    // 废弃库成员没有"再丢一次"的意义，排除。trash 模式沿用旧规则：锁定帧不参与勾选。
    const img = group.arr.find((x) => x.id === id)
    if (mode === 'keep' ? !!img && isTrashLike(img.category) : group.locked.has(id)) return
    setMarked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  // keep 批量：勾了哪几张就一次性丢进统一废弃库（moveIds 带 source=duplicate，不记误判样本，废弃库可"从哪来回哪去"还原）
  const trashSelected = (): void => {
    if (!marked.size) return
    void moveIds([...marked], CAT_TRASH)
    setMarked(new Set())
  }
  // 某一段"全选"：把这段里能勾的（非废弃库成员）并进 marked
  const selectSegment = (list: ImageRecord[]): void => {
    const ids = list.filter((i) => !isTrashLike(i.category)).map((i) => i.id)
    setMarked((prev) => new Set([...prev, ...ids]))
  }
  const clearMarked = (): void => setMarked(new Set())
  const nav = (delta: number): void =>
    setZoomIdx((cur) => (cur === null ? cur : Math.min(group.arr.length - 1, Math.max(0, cur + delta))))

  // 可选成员（落在本分类的）：所有计数、“未选”批量定案都只算它们，锁定帧不背锅
  const catIds = useMemo(() => group.arr.filter((i) => !group.locked.has(i.id)).map((i) => i.id), [group])
  // trash 模式：把勾选的几张批量恢复回【重复照片】（keep 模式已改成每张直接按钮，不再走这里）
  const applyMarked = (): void => {
    if (marked.size) void moveIds([...marked], 'duplicate')
    onClose()
  }

  // 卡面渲染器（“要这张 / 丢弃”主线）：已入库一段、待处理一段共用同一套；base 是这一段在 ordered 里的起始偏移，保证放大查看器序号对齐
  const renderGrid = (list: ImageRecord[], base: number): JSX.Element => (
    <div className="grid gap-4" style={{ gridTemplateColumns: bigGrid ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))' }}>
      {list.map((img, j) => {
        const idx = base + j
        const inLib = inLibrary(img)
        const noClick = mode !== 'keep' && inLib
        const locked = group.locked.has(img.id) || noClick
        const on = marked.has(img.id)
        // 用户 10-13：同组的图不管现在停在哪个分类，都就地可操作——
        //   已在库→移出；在废弃库/废弃桶→恢复回本组；其余（本组待选 / 待确认 / 瑕疵分类）→要这张（选档加进库）/丢弃
        const isTrash = isTrashLike(img.category)
        const canKeep = mode === 'keep' && !inLib && !isTrash
        const est = estimateTier(img.tags, img.tier)
        return (
          <div
            key={img.id}
            className={
              'relative rounded-lg overflow-hidden border-2 aspect-square transition-all ' +
              (mode === 'keep'
                ? on
                  ? 'border-brand ring-2 ring-brand/60'
                  : inLib
                    ? 'border-good'
                    : isTrash
                      ? 'border-dashed border-gray-500'
                      : 'border-line'
                : inLib
                  ? 'border-good'
                  : locked
                    ? 'border-dashed border-gray-500'
                    : on
                      ? 'border-brand'
                      : 'border-line hover:border-gray-500')
            }
            title={inLib ? `${img.filename} · 已在交付库（会被导出），点「移出交付库」可退回本组` : mode === 'keep' && isTrash ? `${img.filename} · 已在${placeShort(img)}，点「恢复」可挪回本组` : mode === 'keep' && group.locked.has(img.id) ? `${img.filename} · ${exportStateText(img)}，可就地收进库或丢弃` : img.filename}
          >
            {/* 图片本体：与主图库一致——单击切换勾选，双击放大对比（不再一点就弹大窗） */}
            <button
              className={'absolute inset-0 w-full h-full ' + (locked ? 'cursor-default' : 'cursor-pointer')}
              onClick={() => toggle(img.id)}
              onDoubleClick={() => setZoomIdx(idx)}
              aria-label={img.filename}
            >
              {bigGrid ? <BigCardImg img={img} /> : <img src={src(img)} loading="lazy" className="w-full h-full object-cover" alt={img.filename} draggable={false} />}
            </button>
            {/* 只有真进了交付库的那张才标档位（是事实）；待选那张不挂角标，免得被误认为已分好档（用户 10-13） */}
            {inLib && <TierBadge img={img} tierNames={tierNames} />}
            {inLib && (
              <span className="absolute left-1.5 top-1.5 z-20 flex items-center gap-1 rounded-md bg-good px-2 py-1 text-[12px] font-bold text-white shadow-[0_2px_6px_rgba(0,0,0,0.55)] ring-2 ring-white/85">
                ✓ 已在交付库
              </span>
            )}
            {!inLib && group.locked.has(img.id) && (
              <span className={'absolute left-1.5 top-1.5 z-20 px-1.5 py-0.5 rounded text-[11px] font-bold text-white shadow ' + (mode === 'keep' ? (isTrash ? 'bg-amber-600/90' : 'bg-gray-600/90') : 'bg-gray-600/90')}>{mode === 'keep' ? '在' + placeShort(img) : '🔒 已在' + placeShort(img)}</span>
            )}
            {mode !== 'keep' && on && !inLib && (
              <span className="absolute left-1.5 top-1.5 z-20 px-1.5 py-0.5 rounded text-[11px] font-bold text-white shadow bg-brand">✓ 恢复</span>
            )}
            {/* 待收那张：左上挂瑕疵标签（它为什么没进库）；若同位叠了“在待确认/废弃”位置标则往下让一行 */}
            {canKeep && <TagStrip img={img} belowBadge={!inLib && group.locked.has(img.id)} />}
            {/* keep 多选勾选圈：浮在卡片右缘中部，避开右上档位/左上标签/底部按钮；点它只切换勾选，不放大 */}
            {mode === 'keep' && !isTrash && (
              <button
                className={'absolute right-1 top-1/2 -translate-y-1/2 z-40 w-6 h-6 rounded-full border-2 flex items-center justify-center text-[13px] font-bold leading-none transition-colors ' + (on ? 'bg-brand border-brand text-white' : 'bg-black/55 border-white/70 text-transparent hover:border-white')}
                onClick={(e) => { e.stopPropagation(); toggle(img.id) }}
                title={inLib ? '勾选：批量把这【张已入库】的移入垃圾桶（从交付库丢弃）' : '勾选：批量把这张丢弃到垃圾桶'}
                aria-label="选择"
              >✓</button>
            )}
            {/* keep 底部操作条：已入库=移出交付库；废弃库/废弃桶=恢复回本组；其余=要这张（选档加进库，7）/丢弃（3） */}
            {mode === 'keep' && (
              <div className="absolute left-1 right-1 bottom-1 z-30 flex items-center gap-1">
                {inLib ? (
                  <button className="flex-1 rounded-md bg-panel/95 ring-1 ring-brand/70 px-2 py-2 text-[11px] font-bold text-brand shadow hover:bg-brand hover:text-white transition-colors whitespace-nowrap" onClick={() => requestRemove(img)} title="这张不交了：从交付库移回本组（不会自动顶别人上来）；若是本组最后一张会先问你一下">移出交付库</button>
                ) : isTrash ? (
                  <button className="flex-1 rounded-md bg-amber-500/95 ring-1 ring-white/70 px-2 py-2 text-[11px] font-bold text-white shadow hover:bg-amber-600 transition-colors whitespace-nowrap" onClick={() => requestRestore(img)} title={`这张现在在${placeShort(img)}：恢复后回到本组，重新由你决定要不要进交付库`}>恢复回本组</button>
                ) : (
                  <>
                    <button className="flex-[7] rounded-md bg-good/95 ring-1 ring-white/70 px-2 py-2 text-[11px] font-bold text-white shadow hover:bg-[#15803d] transition-colors whitespace-nowrap" onClick={() => setPickerId(img.id)} title="就要这张：先选放优质/良好/一般哪一档再确认——是往交付库里多加一张，不会顶掉上面那张">要这张→</button>
                    <button className="flex-[3] rounded-md bg-bad/90 ring-1 ring-white/50 px-2 py-2 text-[11px] font-bold text-white shadow hover:bg-bad transition-colors whitespace-nowrap" onClick={() => trashOne(img)} title="这张不要了：丢进废弃桶，永不导出">丢弃</button>
                  </>
                )}
              </div>
            )}
            {/* 点“要这张”后在这张卡上弹出三档，点其中一档才确认加进库（保留交付库三个子分类） */}
            {canKeep && pickerId === img.id && (
              <div className="absolute inset-0 z-40 bg-black/80 flex flex-col items-center justify-center gap-1.5 p-2">
                <div className="text-[11px] text-white/85 font-medium">放进交付库哪一档？</div>
                {tierNames.map((name, i) => {
                  const n = (i + 1) as TierKey
                  const bg = n === 2 ? 'bg-blue-600 hover:bg-blue-700' : n === 3 ? 'bg-gray-500 hover:bg-gray-600' : 'bg-good hover:bg-[#15803d]'
                  return (
                    <button
                      key={name}
                      className={'w-full rounded-md px-2 py-3 text-[13px] font-bold text-white transition-colors ring-1 ' + bg + (est === n ? ' ring-white' : ' ring-white/30 hover:ring-white/70')}
                      onClick={() => { setPickerId(null); keepOne(img, n) }}
                      title={est === n ? 'AI 按实测清晰度看这张像这一档' : undefined}
                    >
                      {name}
                      {est === n ? ' ★' : ''}
                    </button>
                  )
                })}
                <button className="mt-0.5 text-[11px] text-white/60 hover:text-white" onClick={() => setPickerId(null)}>取消</button>
              </div>
            )}
            {/* trash 底部：文件名 + 放大 */}
            {mode !== 'keep' && (
              <>
                <span className="absolute left-1 bottom-1 right-9 z-10 truncate text-[10px] text-white/90 bg-black/45 rounded px-1 py-0.5 pointer-events-none">{img.filename}</span>
                <button className="absolute right-1 bottom-1 z-20 flex items-center rounded-md bg-black/60 px-1.5 py-1 text-white hover:bg-brand transition-colors" onClick={() => setZoomIdx(idx)} title="放大看原图"><ZoomIcon /></button>
              </>
            )}
          </div>
        )
      })}
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-3" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="relative bg-panel border border-line rounded-xl shadow-2xl w-[95vw] max-w-[1600px] max-h-[94vh] flex flex-col fade-in">
        <div className="px-5 py-3 border-b border-line relative flex items-center">
          <h2 className="text-fg font-bold">
            {mode === 'keep' ? '重复照片 · 干净的已自动进库，勾掉不要的' : '重复照片-废弃 · 选择恢复'}
            <span className="text-fg3 font-normal ml-2 text-sm">
              本组 {group.arr.length} 张 · 已入交付库 {libImgs.length} 张 · 待你决定 {catIds.length} 张
            </span>
          </h2>
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
              <>这一组里干净的几张已经自动收进交付库（绿框、在下方）；上面带瑕疵/停在待确认的默认不入库。要删哪几张，单击卡片勾选（或点右边的✓），右下角一键“移入垃圾桶”；双击卡片放大对比原图。</>
            ) : (
              '单击卡片勾选要恢复的，双击放大看原图（或点右下角放大镜）；确认后移回【重复照片】。'
            )}
          </div>
          {mode === 'keep' ? (
            <>
              {restImgs.length > 0 && (
                <div className="mb-2 flex items-center gap-2 text-sm flex-wrap">
                  <span className="font-bold text-bad">🔴 未入交付库 {restImgs.length} 张</span>
                  <span className="text-fg3">判到瑕疵 / 停在待确认，默认不导出；想收哪张点它下面「要这张→」</span>
                  <div className="flex-1" />
                  <button className="btn text-xs" onClick={() => selectSegment(restImgs)}>全选这段</button>
                </div>
              )}
              {restImgs.length > 0 && renderGrid(restImgs, 0)}
              {restImgs.length > 0 && libImgs.length > 0 && <div className="my-3 border-t border-line" />}
              {libImgs.length > 0 && (
                <div className="mb-2 flex items-center gap-2 text-sm flex-wrap">
                  <span className="font-bold text-good">🟢 已入交付库 {libImgs.length} 张</span>
                  <span className="text-fg3">干净的那几张 AI 已自动收进库、会导出；勾选不要的，一键移入垃圾桶</span>
                  <div className="flex-1" />
                  <button className="btn text-xs" onClick={() => selectSegment(libImgs)}>全选这段</button>
                </div>
              )}
              {libImgs.length > 0 && renderGrid(libImgs, restImgs.length)}
            </>
          ) : (
            <>
              {libImgs.length > 0 && (
                <div className="mb-2 text-sm"><span className="font-bold text-good">✓ 已入交付库 {libImgs.length} 张</span></div>
              )}
              {renderGrid(libImgs, 0)}
              {libImgs.length > 0 && restImgs.length > 0 && <div className="my-3 border-t border-line" />}
              {restImgs.length > 0 && (
                <div className="mb-2 text-sm"><span className="font-bold text-fg2">废弃桶 {restImgs.length} 张</span></div>
              )}
              {renderGrid(restImgs, libImgs.length)}
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-line flex items-center gap-2 flex-wrap">
          {mode === 'keep' ? (
            <>
              <button className="btn text-xs" onClick={() => selectSegment(restImgs)}>全选未入库</button>
              <button className="btn text-xs" onClick={() => selectSegment(libImgs)}>全选已入库</button>
              <button className="btn text-xs" onClick={clearMarked}>全不选</button>
              {marked.size > 0 && <span className="text-sm text-fg2 ml-1">已勾选 <b className="text-fg">{marked.size}</b> 张</span>}
            </>
          ) : (
            <>
              <button className="btn text-xs" onClick={() => setMarked(new Set(catIds))}>全选</button>
              <button className="btn text-xs" onClick={() => setMarked(new Set())}>全不选</button>
            </>
          )}
          <div className="flex-1" />
          <button className="btn" onClick={onClose} title="不执行任何移动，未处理的照片留在重复照片里">{mode === 'keep' ? '关闭' : '稍后再说'}</button>
          {mode === 'keep' ? (
            <button className="px-4 py-2 rounded-md text-sm font-bold text-white bg-bad/90 hover:bg-bad transition-colors disabled:opacity-40 disabled:cursor-not-allowed" disabled={!marked.size} onClick={trashSelected} title="把勾选的这几张一次性丢进废弃桶（永不导出，之后可在废弃库还原）">移入垃圾桶（丢弃 {marked.size} 张）</button>
          ) : (
            <button className="btn-primary" disabled={!marked.size} onClick={applyMarked}>
              恢复 {marked.size} 张
            </button>
          )}
        </div>
      </div>

      {zoomIdx !== null && (
        <ZoomViewer
          arr={ordered}
          index={zoomIdx}
          mode={mode}
          marked={marked}
          locked={lockedIds}
          tierNames={tierNames}
          onToggle={toggle}
          onKeep={(id, tier) => { const im = group.arr.find((x) => x.id === id); if (im) keepOne(im, tier) }}
          onTrash={(id) => { const im = group.arr.find((x) => x.id === id); if (im) trashOne(im) }}
          onUnkeep={(id) => { const im = group.arr.find((x) => x.id === id); if (im) requestRemove(im) }}
          onRestore={(id) => { const im = group.arr.find((x) => x.id === id); if (im) requestRestore(im) }}
          onNav={nav}
          onClose={() => setZoomIdx(null)}
        />
      )}

      {/* 就地确认（应用内弹窗，Electron 禁 window.confirm）：移出最后一张 / 从废弃库恢复 */}
      {pending !== null && (() => {
        const img = group.arr.find((x) => x.id === pending.id)
        if (!img) return null
        const isRestore = pending.kind === 'restore'
        return (
          <div className="fixed inset-0 z-[70] bg-black/70 flex items-center justify-center p-6" onClick={(e) => e.target === e.currentTarget && setPending(null)}>
            <div className="bg-panel border border-line rounded-xl shadow-2xl w-full max-w-md p-6 fade-in">
              <div className="text-base font-bold text-fg mb-2">{isRestore ? '把这张从废弃库恢复回本组？' : '这是本组在交付库里的最后一张'}</div>
              <div className="text-sm text-fg2 leading-relaxed mb-5">
                {isRestore ? (
                  <>《{img.filename}》现在在<span className="font-bold">{placeShort(img)}</span>。恢复后它会回到【重复照片】本组，重新由你决定要不要进交付库。</>
                ) : (
                  <>移除后，这一组在交付库里就<span className="text-bad font-bold"> 0 张</span>了（整组不会被导出）。确定要把《{img.filename}》移出交付库、退回本组吗？</>
                )}
              </div>
              <div className="flex items-center gap-2 justify-end">
                <button className="btn text-sm" onClick={() => setPending(null)}>取消</button>
                {isRestore ? (
                  <button className="px-4 py-2 rounded-md text-sm font-bold text-white bg-amber-500 hover:bg-amber-600 transition-colors" onClick={() => { setPending(null); doRestore(img) }}>确认恢复</button>
                ) : (
                  <button className="px-4 py-2 rounded-md text-sm font-bold text-white bg-bad/90 hover:bg-bad transition-colors" onClick={() => { setPending(null); removeFromLibrary(img) }}>确认移除</button>
                )}
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

export default function DuplicateGroupsView({ images, mode }: { images: ImageRecord[]; mode: 'keep' | 'trash' }): JSX.Element {
  // 整组补全：本分类只装“多余帧”，同组的 AI 默认保留帧还留在交付库等其它分类。
  // 按 dup_group 向主进程要回整组成员，否则 2 张的组只显示 1 张（退化成所谓的“未成组”孤帧）。
  const gidsKey = useMemo(
    () => [...new Set(images.map((i) => i.dupGroup).filter((g): g is string => !!g))].join('|'),
    [images]
  )
  const [partners, setPartners] = useState<ImageRecord[]>([])
  // 数据对账版本号：组内某成员被要进交付库后会离开当前分类列表，但它的 dup_group 还在（同组别几张仍在），
  // gidsKey 不变 → 光靠它不会重拉整组成员，弹窗就会拿着那条旧记录（还带着冗余标签）一直卡在下面。
  // 靠 dataRev 变化补一次重拉，拿回它移动后的新状态（已清冗余标签、category=交付库），才会正确升到上面。
  const dataRev = useStore((s) => s.dataRev)
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
  }, [gidsKey, dataRev])

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
    // 待你决定多的排前面（越需要处理的越靠前），同数量时整组大的靠前（组内展示序在弹窗里另定：已入库的在前）
    gs.sort((a, b) => b.arr.length - b.locked.size - (a.arr.length - a.locked.size) || b.arr.length - a.arr.length)
    return gs
  }, [images, partners])

  // 弹窗只记 gid，不存 Group 快照：移动成员后父组件重算出的新组才是最新状态（否则换人之后
  // 弹窗里还挂着已经离开的旧卡）；整组处理完时 find 不到 → 弹窗自动关闭
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
        <div className="text-lg text-fg">{mode === 'keep' ? '没有检测到重复照片' : '废弃桶是空的'}</div>
        <div className="text-xs text-fg3 mt-1">{mode === 'keep' ? '筛选完成后，同一瞬间多出来的那几张会自动归到这里（干净的那几张会自动进交付库）' : '在【重复照片】分组里丢弃的多余图会集中到这里，永不导出'}</div>
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
                同一组里<b className="text-good">干净的那几张会自动进交付库</b>（绿框、排在弹窗下方），<span className="text-brand font-medium">不要的勾上批量移入垃圾桶</span>；
                带瑕疵/待确认的默认不入库，想收可单张「要这张→」
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
              <li>· 新规则（反选）：一组重复/连拍照，<b className="text-fg2">只要它本身没拍坏，就自动跟着一起进【交付库】、正常导出</b>——你再不用为"想多留几张"逐张点进库，想删哪几张反而更快。</li>
              <li>· 点开分组：<span className="text-good font-medium">横线下面</span>是已经自动入库的那几张（绿框 + 档位角标），<span className="text-bad font-medium">横线上面</span>是判到瑕疵 / 停在待确认、默认没入库的。</li>
              <li>· <b className="text-fg2">快速删不要的：</b>勾选卡片右边的 ✓（一段可点“全选这段”），右下角<span className="text-bad font-medium">「移入垃圾桶」</span>一键把勾着的都丢进废弃桶（永不导出，之后能在废弃库还原）。</li>
              <li>· 上面带瑕疵那批想收某张：点它下面<span className="text-good font-medium">「要这张→」</span>选优质/良好/一般一档，就单独加进交付库；也可勾 ✓ 批量丢弃。</li>
              <li>· 闭眼 / 半截头 / 表情崩坏 / 模糊 / 曝光 这五个瑕疵都会自动把那张挡在库外（高置信进瑕疵片、拿不准的进待确认），不用担心糊片混进交付。</li>
              <li>· 一组可以同时交好几张，也能一张都不留（全丢也行）；单张还可点它下面“移出交付库”退回本组重新决定。</li>
            </ul>
          )}
        </div>
      ) : (
        <div className="mb-5 rounded-lg bg-panel2/60 border border-line px-4 py-2.5 text-sm text-fg2">
          废弃桶共 {groups.length} 组、{images.length} 张。点击叠卡可把照片恢复到【重复照片】；此分类永不导出。
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
