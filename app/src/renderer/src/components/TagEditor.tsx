/**
 * 标签编辑器（大图右侧栏 / 标签管理器弹窗共用）—— 单页三区布局（用户拍板 2026-10-12：
 * 不做点击展开，一屏看全，少废话）
 *
 * ① 当前标签：人物分类永远排第一（实心蓝，只能切换不能删），其余标签带 ✕ 直接删；
 * ② 人物分类：四个互斥按钮，点谁切谁（添加即替换，主进程 enforcePersonMutex 兜底）；
 * ③ 其他标签：点一下加上，已有该标签的压暗打 ✓；删除动作统一回到第①区那枚 ✕。
 *
 * 设计模型不变：一张图 = 一组标签 + 一个状态分类。维度分类页是「主分类 ∪ 中/高标签」
 * 并集视图，所以添加标签 = 图同时出现在该维度分类并排第一（不是移动）；删除 = 从该
 * 分类消失，主分类恰为该维度时连带移出。两者都记修正样本喂阈值自学习。
 * 支持多选批量：传入多张图时按钮/芯片上的 n/m 计数说明覆盖几张。
 *
 * 背景一律不透明（半透明白叠在照片上等于看不见）；危险删除（当前分类锚点/批量多张）
 * 保留一条就地确认，其余全部单击直达。
 */
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { dimTagColor } from './Sidebar'
import { toSrc } from './imageSrc'
import {
  UI_BAD_DIMENSIONS,
  DIMENSION_LABELS,
  NEUTRAL_DIMENSIONS,
  PERSON_DIMS,
  type DimensionKey,
  type ImageRecord
} from '../../../shared/types'

/** 可手动添加的维度：重复由重复分组视图管理，也不出现泛化「瑕疵」（只给精简模式移入瑕疵片用） */
const ADDABLE: DimensionKey[] = [...UI_BAD_DIMENSIONS.filter((d) => d !== 'duplicate'), ...NEUTRAL_DIMENSIONS]

/** 人物之外的可加标签（黑白是影调事实，跟瑕疵标签同区管理；人数四维走中间的切换按钮区） */
const TAG_DIMS: DimensionKey[] = ADDABLE.filter((d) => !PERSON_DIMS.includes(d))

/** 参与展示的标签（低置信度不标记，与视图/徽章口径一致） */
function shownTags(img: ImageRecord): DimensionKey[] {
  return Object.entries(img.tags || {})
    .filter(([, v]) => v && v.level !== 'low')
    .map(([d]) => d as DimensionKey)
}

/**
 * 浏览中的分类若是“可打标维度”（坏维度/人数/黑白，重复除外）→ 返回该维度 = 当前列表的
 * 锚点标签：图靠它才出现在这个并集视图里，删了图就移出当前分类（TagEditor 据此标定位针 + 二次确认）。
 * 状态分类（交付库/待确认/废弃库/自定义）按主分类字段过滤，删标签不会移出列表 → 返回 null 不标。
 */
export function anchorDimOfCategory(category: string | null | undefined): DimensionKey | null {
  return category && (ADDABLE as string[]).includes(category) ? (category as DimensionKey) : null
}

/** 分类 key → 界面名（自定义分类取真实名字，null = 全部）：大图顶部计数器与标签管理器共用 */
export function categoryDisplayName(cat: string | null | undefined, custom: Array<{ id: number; name: string }>): string {
  if (!cat) return '全部文件'
  if (cat.startsWith('custom:')) return custom.find((x) => `custom:${x.id}` === cat)?.name ?? cat
  return (
    (DIMENSION_LABELS as Record<string, string>)[cat] ??
    ({ library: '交付库', review: '待确认', trash: '废弃库', dup_trash: '重复/连拍-废弃', flaws: '瑕疵片' } as Record<string, string>)[cat] ??
    cat
  )
}

/**
 * 当前分类锚点图标：地图定位针（“你在这里”的通用符号）。删除它会把图移出正在浏览的
 * 分类，所以带针的标签删除前要先确认。SVG 描维度色，与标签芯片同源。
 */
export function CatPinIcon({ dim, color, className }: { dim?: DimensionKey; color?: string; className?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke={color ?? dimTagColor(dim!)}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  )
}

const isPersonDim = (d: DimensionKey): boolean => (PERSON_DIMS as string[]).includes(d)

/** 三区共用的节标题：小字浅色，主词后跟一句极短的操作提示，不解释机制 */
function SectionLabel(props: { title: string; hint?: string }): JSX.Element {
  return (
    <div className="text-xs text-fg3 mb-1.5">
      {props.title}
      {props.hint && <span className="opacity-70"> · {props.hint}</span>}
    </div>
  )
}

export default function TagEditor({
  imgs,
  anchorDim = null,
  size = 'lg',
  showReason = false
}: {
  imgs: ImageRecord[]
  /** 当前分类对应的维度：删除它会把图移出当前分类，需二次确认 */
  anchorDim?: DimensionKey | null
  size?: 'sm' | 'lg'
  /** 是否展开判定理由长句（给调阈值的人看，默认关；三个客户入口都不显示） */
  showReason?: boolean
}): JSX.Element {
  const addTag = useStore((s) => s.addTag)
  const removeTag = useStore((s) => s.removeTag)
  const tagBusy = useStore((s) => s.tagBusy)
  const [confirmDim, setConfirmDim] = useState<DimensionKey | null>(null)

  const ids = useMemo(() => imgs.map((i) => i.id), [imgs])
  const multi = imgs.length > 1
  const big = size === 'lg'

  // 某维度在这批图上已有几张
  const hasCount = (dim: DimensionKey): number => imgs.filter((i) => shownTags(i).includes(dim)).length

  // 当前标签汇总：人物排第一（永远），其余按最高置信降序；批量时计数 + 取最高置信做 tooltip
  const rows = useMemo(() => {
    const m = new Map<DimensionKey, { dim: DimensionKey; count: number; conf: number; reason: string }>()
    for (const img of imgs) {
      for (const d of shownTags(img)) {
        const t = img.tags[d]!
        const cur = m.get(d)
        if (cur) {
          cur.count += 1
          if (t.confidence > cur.conf) {
            cur.conf = t.confidence
            cur.reason = t.reason ?? ''
          }
        } else {
          m.set(d, { dim: d, count: 1, conf: t.confidence, reason: t.reason ?? '' })
        }
      }
    }
    return [...m.values()].sort((a, b) => {
      const pa = isPersonDim(a.dim) ? 0 : 1
      const pb = isPersonDim(b.dim) ? 0 : 1
      if (pa !== pb) return pa - pb
      return b.conf - a.conf
    })
  }, [imgs])

  // 换图 / 图数变化时收起确认条，避免带着上一张图的确认继续操作
  useEffect(() => setConfirmDim(null), [ids.join(',')])

  const personRow = rows.find((r) => isPersonDim(r.dim))
  const otherRows = rows.filter((r) => !isPersonDim(r.dim))
  const present = new Set(rows.map((r) => r.dim))

  const doRemove = (dim: DimensionKey): void => {
    setConfirmDim(null)
    void removeTag(ids, dim)
  }
  /** 锚点标签（删了图就移出当前分类）和批量多张删除要先确认，其余单击直达 */
  const tryRemove = (dim: DimensionKey, count: number): void => {
    if (dim === anchorDim || (multi && count > 1)) setConfirmDim(dim)
    else doRemove(dim)
  }

  const chipPad = big ? 'px-2.5 py-1.5 text-sm' : 'px-2 py-1 text-xs'

  return (
    <div className="flex flex-col gap-3 min-w-0">
      {/* 写入中：进度提示（乐观更新已先把标签加/删到位，这里让“正在落库”可见） */}
      {tagBusy && (
        <div className="flex items-center gap-2 rounded-lg border border-brand/40 bg-brand/10 px-2.5 py-1.5 text-xs text-brand">
          <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-brand border-t-transparent animate-spin shrink-0" />
          {tagBusy}
        </div>
      )}

      {/* ① 当前标签：人物第一且不可删（只能切换），其余 ✕ 直接删 */}
      <section>
        <SectionLabel title="当前标签" hint="点 ✕ 删除" />
        <div className="flex flex-wrap gap-1.5">
          {personRow &&
            (() => {
              const c = dimTagColor(personRow.dim)
              return (
                <span
                  className={
                    'inline-flex items-center gap-1.5 rounded-md leading-none font-medium text-white shadow-sm cursor-default ' +
                    chipPad
                  }
                  style={{ background: c }}
                  title={`人物分类只能切换、不能删除——用下面的按钮换${multi ? `（${personRow.count}/${imgs.length} 张带此标签）` : ''}`}
                >
                  {DIMENSION_LABELS[personRow.dim]}
                  {multi && <span className="text-white/70 text-[10px] tabular-nums">{personRow.count}/{imgs.length}</span>}
                </span>
              )
            })()}
          {otherRows.map((r) => {
            const c = dimTagColor(r.dim)
            return (
              <button
                key={r.dim}
                className={
                  'inline-flex items-center gap-1.5 rounded-md border leading-none font-medium transition-colors cursor-pointer hover:brightness-95 active:scale-95 ' +
                  chipPad
                }
                style={{ color: c, borderColor: c + '66', background: c + '14' }}
                disabled={!!tagBusy}
                title={`删除「${DIMENSION_LABELS[r.dim]}」标签${multi ? `（当前 ${r.count}/${imgs.length} 张带此标签）` : ''}；删掉后这张图不再算这一类`}
                onClick={() => tryRemove(r.dim, r.count)}
              >
                {r.dim === anchorDim && <CatPinIcon dim={r.dim} className="w-3.5 h-3.5 shrink-0" />}
                {DIMENSION_LABELS[r.dim]}
                {multi && <span className="opacity-60 text-[10px] tabular-nums">{r.count}/{imgs.length}</span>}
                <span className="opacity-70">✕</span>
              </button>
            )
          })}
          {!rows.length && <span className="text-xs text-fg3">暂无标签（AI 认为没有问题，或置信度未过线）</span>}
        </div>
        {showReason &&
          rows
            .filter((r) => r.reason)
            .map((r) => (
              <div key={r.dim} className="text-[11px] text-fg3 mt-1 break-all leading-relaxed">
                {DIMENSION_LABELS[r.dim]}：{r.reason}
              </div>
            ))}
        {confirmDim &&
          (() => {
            const r = rows.find((x) => x.dim === confirmDim)
            if (!r) return null
            return (
              <div className="mt-2 rounded-md border border-warn/50 bg-warn/10 px-2.5 py-2 text-xs text-warn">
                <div>
                  {r.dim === anchorDim
                    ? `「${DIMENSION_LABELS[r.dim]}」是当前分类的标签——删除后这 ${r.count} 张图会移出当前分类${multi ? '' : '并自动切换到下一张图'}。`
                    : `将从选中的 ${r.count} 张图上删除「${DIMENSION_LABELS[r.dim]}」标签。`}
                </div>
                <div className="mt-2 flex items-center justify-end gap-2">
                  <button className="btn-danger !py-1 !text-xs" onClick={() => doRemove(r.dim)}>确认删除</button>
                  <button className="btn !py-1 !text-xs" onClick={() => setConfirmDim(null)}>取消</button>
                </div>
              </div>
            )
          })()}
      </section>

      {/* ② 人物分类：四个互斥按钮，点谁切谁；替换语义由主进程互斥收口，不用先删再加 */}
      <section>
        <SectionLabel title="人物分类" hint="四选一，点一下切换" />
        <div className="grid grid-cols-2 gap-1.5">
          {PERSON_DIMS.map((d) => {
            const n = hasCount(d)
            const active = n === imgs.length && n > 0
            const c = dimTagColor(d)
            return (
              <button
                key={d}
                className={
                  'inline-flex items-center justify-center gap-1.5 rounded-md border leading-none font-medium transition-all ' +
                  chipPad +
                  (active ? ' cursor-default shadow-sm' : ' cursor-pointer hover:brightness-95 active:scale-95')
                }
                style={
                  active
                    ? { color: '#fff', borderColor: c, background: c }
                    : { color: c, borderColor: c + '66', background: c + '14' }
                }
                disabled={active || !!tagBusy}
                title={
                  active
                    ? '当前就是它'
                    : n > 0
                      ? `把这 ${imgs.length - n} 张换成「${DIMENSION_LABELS[d]}」（已有 ${n} 张不动）`
                      : `设为「${DIMENSION_LABELS[d]}」${multi ? `（对全部 ${imgs.length} 张生效）` : ''}`
                }
                onClick={() => void addTag(ids, d)}
              >
                {DIMENSION_LABELS[d]}
                {active && <span className="text-white/80">✓</span>}
                {!active && multi && n > 0 && <span className="opacity-60 text-[10px] tabular-nums">{n}/{imgs.length}</span>}
              </button>
            )
          })}
        </div>
      </section>

      {/* ③ 其他标签：单击加上；这批图全都已有的压暗打 ✓（要删回第①区点 ✕） */}
      <section>
        <SectionLabel title="其他标签" hint="点一下加上" />
        <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))' }}>
          {TAG_DIMS.map((d) => {
            const n = hasCount(d)
            const all = n === imgs.length && n > 0
            const c = dimTagColor(d)
            return (
              <button
                key={d}
                className={
                  'inline-flex items-center justify-center gap-1.5 rounded-md border leading-none font-medium transition-all ' +
                  chipPad +
                  (all ? ' cursor-not-allowed opacity-40' : ' cursor-pointer hover:brightness-95 active:scale-95')
                }
                style={
                  all
                    ? { color: 'rgb(var(--c-fg3))', borderColor: 'rgb(var(--c-line))', background: 'rgb(var(--c-panel))' }
                    : { color: c, borderColor: c + '66', background: c + '14' }
                }
                disabled={all || !!tagBusy}
                title={
                  all
                    ? '已有该标签（到上面删除）'
                    : n > 0
                      ? `为缺少的 ${imgs.length - n} 张补上「${DIMENSION_LABELS[d]}」（已有 ${n} 张不动）`
                      : `加上「${DIMENSION_LABELS[d]}」标签${multi ? `（对全部 ${imgs.length} 张生效）` : ''}`
                }
                onClick={() => void addTag(ids, d)}
              >
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: all ? 'rgb(var(--c-fg3))' : c }} />
                {DIMENSION_LABELS[d]}
                {all && <span className="opacity-70">✓</span>}
                {!all && multi && n > 0 && <span className="opacity-60 text-[10px] tabular-nums">{n}/{imgs.length}</span>}
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}

/**
 * 标签管理器弹窗：网格/列表/瀑布流卡片上的「标签管理」按钮打开，
 * 不必进大图右侧栏也能给单张或多张图增删标签。
 * 取数双轨：优先用 store.images（带乐观更新，所以标签秒变），
 * 并用 getImage 逐张兑底权威值——删掉主分类标签后图已离开当前分类列表，
 * 只靠 store.images 会拿不到它（表现为“删了但标签还在”）。
 */
export function TagManagerModal(): JSX.Element | null {
  const tagManagerIds = useStore((s) => s.tagManagerIds)
  const images = useStore((s) => s.images)
  const tagBusy = useStore((s) => s.tagBusy)
  const activeCategory = useStore((s) => s.activeCategory)
  const closeTagManager = useStore((s) => s.closeTagManager)
  const customCategories = useStore((s) => s.customCategories)
  const [byId, setById] = useState<Record<number, ImageRecord>>({})

  const key = (tagManagerIds ?? []).join(',')
  useEffect(() => {
    // 写入中不取：那时点库里还是旧值，取回来会把乐观结果覆盖回去（闪回旧标签）
    if (!key || tagBusy) return
    let alive = true
    void (async () => {
      const ids = key.split(',').map(Number)
      const got = (await Promise.all(ids.map((id) => window.api.getImage(id)))).filter(Boolean) as ImageRecord[]
      if (!alive) return
      setById((prev) => {
        const next = { ...prev }
        for (const r of got) next[r.id] = r
        return next
      })
    })()
    return () => {
      alive = false
    }
  }, [key, tagBusy, images])

  if (!tagManagerIds?.length) return null
  const imgs = tagManagerIds
    .map((id) => images.find((i) => i.id === id) ?? byId[id])
    .filter(Boolean) as ImageRecord[]
  if (!imgs.length) return null
  const anchorDim = anchorDimOfCategory(activeCategory)
  const catName = (c: string): string =>
    c.startsWith('custom:')
      ? customCategories.find((x) => `custom:${x.id}` === c)?.name ?? c
      : DIMENSION_LABELS[c as keyof typeof DIMENSION_LABELS] ??
        ({ library: '交付库', review: '待确认', trash: '废弃库', dup_trash: '重复/连拍-废弃' } as Record<string, string>)[c] ??
        c

  return (
    <div
      className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
      onClick={(e) => e.target === e.currentTarget && closeTagManager()}
    >
      <div className="w-full max-w-lg max-h-[88vh] overflow-y-auto rounded-xl border border-line bg-panel shadow-2xl fade-in">
        {/* 头部 */}
        <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-3 bg-panel border-b border-line">
          <img
            src={imgs[0].thumb ? toSrc(imgs[0].thumb) : toSrc(imgs[0].path)}
            className="w-12 h-12 rounded-lg object-cover ring-1 ring-line shrink-0 bg-panel2"
            alt=""
            draggable={false}
          />
          <div className="flex-1 min-w-0">
            <div className="text-base text-fg truncate" title={imgs[0].path}>
              {imgs.length === 1 ? imgs[0].filename : `已选中 ${imgs.length} 张图`}
            </div>
            <div className="text-xs text-fg3 mt-0.5 flex items-center gap-1.5 flex-wrap">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: dimTagColor(imgs[0].category) }} />
              当前分类：{catName(imgs[0].category)}
              {imgs.length > 1 && <span className="text-fg2">· 操作对全部选中图生效</span>}
            </div>
          </div>
          {/* 关闭按钮：36×36 带边框底色，悬停转红——一眼看见、好点 */}
          <button
            className="shrink-0 grid place-items-center w-9 h-9 rounded-lg border border-line bg-panel2 text-fg2 hover:bg-bad hover:border-bad hover:text-white transition-colors cursor-pointer"
            onClick={closeTagManager}
            title="关闭（Esc）"
            aria-label="关闭"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        {/* 单页三区：当前标签 / 人物切换 / 标签点加（无展开收起，无机制说明） */}
        <div className="px-4 py-3">
          <TagEditor imgs={imgs} anchorDim={anchorDim} size="lg" />
        </div>
      </div>
    </div>
  )
}
