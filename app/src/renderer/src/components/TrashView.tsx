/**
 * 统一废弃库页面（合并旧「重复照片-废弃」进「废弃库」）
 * - 左侧竖排「来源栏」：按每张丢弃时记录的 trashFrom 聚合，点某一栏只在这一栏里看（纯前端筛选，不重查库）；
 *   顶部「全部」，无来源（历史数据）归入「其他来源」置底。
 * - 右侧图片网格：每张卡底部两个动作——「还原」（按来源从哪来回哪去）与「加入交付库 → 选档」（弹三档，复用交付库放行分支）。
 * - 多选时顶部浮出批量条，支持批量还原 / 批量选档入档。
 * - 遵循既有偏好：层级靠排版、关键按钮够大够实、白底按钮文字一律非白。
 */
import { useMemo, useState } from 'react'
import { useStore } from '../store'
import { toSrc } from './imageSrc'
import type { ImageRecord } from '../../../shared/types'
import {
  CAT_FLAWS,
  CAT_LIBRARY,
  CAT_REVIEW,
  DEFAULT_TIER_NAMES,
  DIMENSION_LABELS,
  estimateTier,
  isBadDim,
  isStructuralDim,
  type TierKey
} from '../../../shared/types'

/** 无来源（历史数据）的聚合键 */
const NO_SOURCE = '__none__'

/** 取缩略图地址：优先已生成的 thumb，回退原图 */
function src(img: ImageRecord): string {
  return img.thumb ? toSrc(img.thumb) : toSrc(img.path)
}

/**
 * 来源栏 key → 中文名。与 store.catLabel 同口径但面向「废弃库来源」这个特定场景：
 * 无来源 / 重复分组 / 瑕疵片虚视图都有专门说法，其余交 DIMENSION_LABELS 与自定义相册名。
 */
function sourceLabel(
  key: string,
  customs: Array<{ id: number; name: string }>,
  tierNames: string[]
): string {
  if (key === NO_SOURCE) return '其他来源'
  if (key === 'duplicate') return '重复照片'
  if (key === CAT_LIBRARY) return '交付库'
  if (key === CAT_REVIEW) return '待确认'
  if (key === CAT_FLAWS) return '瑕疵片'
  const s = key as string
  if (s.startsWith('custom:')) {
    const c = customs.find((x) => x.id === Number(s.slice(7)))
    return c ? `自定义「${c.name}」` : '自定义相册'
  }
  const tn = /^tier:([123])$/.exec(s)
  if (tn) return `交付库/${(tierNames ?? DEFAULT_TIER_NAMES)[Number(tn[1]) - 1] || tn[1]}`
  if (isStructuralDim(s)) return '重复照片'
  if (isBadDim(s)) return DIMENSION_LABELS[s] || '瑕疵照片'
  return DIMENSION_LABELS[s as keyof typeof DIMENSION_LABELS] || s
}

/** 白底选档弹窗里的档位配色（与分组详情选档弹窗一致：优质绿 / 良好蓝 / 一般灰） */
function tierColor(n: number): string {
  return n === 2 ? 'bg-blue-600 hover:bg-blue-700' : n === 3 ? 'bg-gray-500 hover:bg-gray-600' : 'bg-good hover:bg-[#15803d]'
}

export function TrashView({ images }: { images: ImageRecord[] }): JSX.Element {
  const customCategories = useStore((s) => s.customCategories)
  const settingsTierNames = useStore((s) => s.settings.tierNames)
  const tierNames = settingsTierNames && settingsTierNames.length ? settingsTierNames : DEFAULT_TIER_NAMES
  const restoreTrash = useStore((s) => s.restoreTrash)
  const promoteTrashToTier = useStore((s) => s.promoteTrashToTier)

  const [filterSource, setFilterSource] = useState<string | null>(null) // null = 全部
  const [sel, setSel] = useState<Set<number>>(new Set())
  const [pickerIds, setPickerIds] = useState<number[] | null>(null)

  // 左栏来源聚合：按张数降序，「其他来源」恒置底
  const sourceRows = useMemo(() => {
    const m = new Map<string, number>()
    for (const img of images) {
      const k = img.trashFrom ?? NO_SOURCE
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    const rows = [...m.entries()].map(([k, n]) => ({ key: k, count: n }))
    rows.sort((a, b) => {
      if (a.key === NO_SOURCE) return 1
      if (b.key === NO_SOURCE) return -1
      return b.count - a.count || a.key.localeCompare(b.key)
    })
    return rows
  }, [images])

  const shown = filterSource === null ? images : images.filter((i) => (i.trashFrom ?? NO_SOURCE) === filterSource)

  // 选中集随可见列表裁剪：还原 / 入档后图离开本视图，残留 id 会被下一次批量误作用
  const liveSel = useMemo(() => {
    const present = new Set(shown.map((i) => i.id))
    return [...sel].filter((id) => present.has(id))
  }, [sel, shown])

  const toggle = (id: number): void => {
    setSel((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  const clearSel = (): void => setSel(new Set())

  const doRestore = (ids: number[]): void => {
    if (!ids.length) return
    void restoreTrash(ids)
    clearSel()
  }
  const openPicker = (ids: number[]): void => {
    if (!ids.length) return
    setPickerIds(ids)
  }
  const doPromote = (tier: TierKey): void => {
    const ids = pickerIds ?? []
    setPickerIds(null)
    if (!ids.length) return
    void promoteTrashToTier(ids, tier)
    clearSel()
  }

  if (!images.length) {
    return (
      <div className="h-full overflow-auto flex flex-col items-center justify-center gap-2 text-fg2 p-6">
        <div className="text-5xl">🗑️</div>
        <div className="text-lg text-fg">废弃库是空的</div>
        <div className="text-xs text-fg3">你在任何相册里点「丢弃」的图都会集中到这里，可按来源还原或直接选档加入交付库</div>
      </div>
    )
  }

  return (
    <div className="h-full flex">
      {/* 左栏：来源导航 */}
      <aside className="w-40 shrink-0 border-r border-line overflow-auto py-2">
        <div className="px-3 pb-1.5 text-[11px] font-bold tracking-widest text-fg3">来源</div>
        <button
          className={
            'w-full text-left px-3 py-2 text-[13px] transition-colors ' +
            (filterSource === null ? 'bg-brand/10 text-brand font-bold' : 'text-fg2 hover:bg-panel2')
          }
          onClick={() => setFilterSource(null)}
        >
          <span className="block truncate">全部</span>
          <span className="text-[11px] text-fg3">{images.length} 张</span>
        </button>
        {sourceRows.map((r) => (
          <button
            key={r.key}
            className={
              'w-full text-left px-3 py-2 text-[13px] transition-colors ' +
              (filterSource === r.key ? 'bg-brand/10 text-brand font-bold' : 'text-fg2 hover:bg-panel2')
            }
            onClick={() => setFilterSource(r.key)}
            title={sourceLabel(r.key, customCategories, tierNames)}
          >
            <span className="block truncate">{sourceLabel(r.key, customCategories, tierNames)}</span>
            <span className="text-[11px] text-fg3">{r.count} 张</span>
          </button>
        ))}
      </aside>

      {/* 右栏：图片网格 */}
      <div className="relative flex-1 overflow-auto p-3">
        {/* 批量条：选中 ≥1 时浮出 */}
        {liveSel.length > 0 && (
          <div className="sticky top-0 z-30 mb-2 flex items-center gap-2 rounded-lg bg-panel2/95 ring-1 ring-brand/40 px-3 py-2 shadow">
            <span className="text-[13px] font-bold text-fg">已选 {liveSel.length} 张</span>
            <button className="ml-auto rounded-md bg-good px-3 py-2 text-[13px] font-bold text-white shadow hover:bg-[#15803d] transition-colors" onClick={() => doRestore(liveSel)}>
              ♻️ 还原（各回来源）
            </button>
            <button className="rounded-md bg-brand px-3 py-2 text-[13px] font-bold text-white shadow hover:brightness-110 transition-colors" onClick={() => openPicker(liveSel)}>
              加入交付库 → 选档
            </button>
            <button className="rounded-md border border-line bg-white/0 px-3 py-2 text-[13px] font-bold text-fg2 hover:bg-panel transition-colors" onClick={clearSel}>
              取消选择
            </button>
          </div>
        )}

        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(6, minmax(0, 1fr))' }}>
          {shown.map((img) => {
            const selected = sel.has(img.id)
            const est = estimateTier(img.tags, img.tier)
            const flaws = (Object.keys(img.tags || {}) as (keyof typeof img.tags)[]).filter((d) => isBadDim(d) && img.tags[d] && img.tags[d]!.level !== 'low')
            return (
              <div
                key={img.id}
                onClick={() => toggle(img.id)}
                className={
                  'group relative overflow-hidden rounded-lg bg-panel2 ring-1 transition-shadow cursor-pointer ' +
                  (selected ? 'ring-2 ring-brand shadow-lg' : 'ring-line hover:ring-brand/60')
                }
              >
                <div className="relative aspect-[4/3] w-full">
                  <img src={src(img)} loading="lazy" className="w-full h-full object-cover" alt={img.filename} draggable={false} />
                  {/* 左上：来源角标 */}
                  <span className="absolute left-1 top-1 z-10 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-bold text-white shadow">
                    {sourceLabel(img.trashFrom ?? NO_SOURCE, customCategories, tierNames)}
                  </span>
                  {/* 右上：AI 预估档位提示（仅提示，不代表已入档） */}
                  {est && (
                    <span className={'absolute right-1 top-1 z-10 rounded px-1.5 py-0.5 text-[11px] font-bold text-white shadow ' + (est === 2 ? 'bg-blue-600/90' : est === 3 ? 'bg-gray-500/90' : 'bg-good')}>
                      {tierNames[est - 1]}?
                    </span>
                  )}
                  {/* 瑕疵标签 */}
                  {flaws.length > 0 && (
                    <div className="absolute left-1 bottom-1 z-10 flex flex-wrap gap-1">
                      {flaws.slice(0, 3).map((d) => (
                        <span key={d} className="rounded bg-bad/85 px-1.5 py-0.5 text-[10px] font-bold text-white">{DIMENSION_LABELS[d] || d}</span>
                      ))}
                    </div>
                  )}
                  {selected && (
                    <div className="absolute inset-0 z-20 flex items-center justify-center bg-brand/20">
                      <span className="rounded-full bg-brand px-2 py-0.5 text-xs font-bold text-white">✓ 已选</span>
                    </div>
                  )}
                </div>

                <div className="px-2 py-1.5">
                  <div className="truncate text-[11px] text-fg3" title={img.filename}>{img.filename}</div>
                  {/* 卡片操作条 */}
                  <div className="mt-1.5 flex items-center gap-1">
                    <button
                      className="flex-[1] rounded-md bg-good/95 ring-1 ring-white/60 px-2 py-2 text-[11px] font-bold text-white shadow hover:bg-[#15803d] transition-colors whitespace-nowrap"
                      onClick={(e) => { e.stopPropagation(); doRestore([img.id]) }}
                      title="按来源还原：从哪丢的就回哪去"
                    >
                      ♻️ 还原
                    </button>
                    <button
                      className="flex-[1.2] rounded-md bg-brand/95 ring-1 ring-white/60 px-2 py-2 text-[11px] font-bold text-white shadow hover:brightness-110 transition-colors whitespace-nowrap"
                      onClick={(e) => { e.stopPropagation(); openPicker([img.id]) }}
                      title="选一档把这张加入交付库"
                    >
                      加入交付库 →
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* 选档弹窗：白底面板，按钮文字一律非白（遵循用户规则：白底按钮不能白字，档位按钮本身是彩底白字属深色底） */}
      {pickerIds && (
        <div className="fixed inset-0 z-[65] bg-black/70 flex items-center justify-center p-6" onClick={(e) => e.target === e.currentTarget && setPickerIds(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-6">
            <div className="text-lg font-bold text-gray-900 mb-1">放进交付库哪一档？</div>
            <div className="text-sm text-gray-500 mb-5">选一档就把这 {pickerIds.length} 张加进交付库，会清掉瑕疵/冗余标签并人工定档。</div>
            <div className="flex flex-col gap-2.5">
              {tierNames.map((name, i) => {
                const n = (i + 1) as TierKey
                return (
                  <button
                    key={name}
                    className={'w-full rounded-md px-4 py-3 text-base font-bold text-white transition-colors ' + tierColor(i + 1)}
                    onClick={() => doPromote(n)}
                  >
                    {name}
                  </button>
                )
              })}
            </div>
            <button className="mt-4 w-full rounded-md px-4 py-2.5 text-base font-bold text-gray-700 bg-gray-100 hover:bg-gray-200 border border-gray-300 transition-colors" onClick={() => setPickerIds(null)}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
