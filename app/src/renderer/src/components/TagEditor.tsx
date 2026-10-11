/**
 * 标签编辑器（大图右侧栏 / 列表端标签管理器共用）
 *
 * 设计模型：一张图 = 一组标签 + 一个状态分类。
 * 维度分类页是「主分类 ∪ 中/高标签」的并集视图，所以：
 * - 添加标签 = 图同时出现在该维度分类并排到第一张（不是移动，原状态不变）
 *   例外：人数三分类（单人/多人/无人物）互斥，添加等于替换——旧标签清掉，
 *   旧标签是主分类时归属一并换过来（否则图会同时留在两个互斥相册），并先弹确认条
 * - 删除标签 = 从该维度分类消失；若图的主分类就是该维度，会连带移出该分类
 * 两者都记一条修正样本喂阈值自学习（删=误判→少标，加=漏检→更早召回）。
 * 支持多选批量：传入多张图时，添加/删除对全部图生效。
 *
 * 添加面板一律用「文档流内展开」（不做 absolute/portal）：宿主容器都是 overflow 滚动区，
 * 浮层会被裁切且定位飘忽（历史上弹层跑到弹窗外面压住脚注），内联展开既不被裁也永远贴着按钮。
 * 所有面板都支持“点外面就关”；背景一律不透明（半透明白叠在照片上等于看不见）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { dimTagColor } from './Sidebar'
import { toSrc } from './imageSrc'
import { useOutsideClose } from './useOutsideClose'
import {
  BAD_DIMENSIONS,
  DIMENSION_LABELS,
  NEUTRAL_DIMENSIONS,
  PERSON_DIMS,
  isBadDim,
  type DimensionKey,
  type ImageRecord
} from '../../../shared/types'

/** 人数四维度互斥（一张图只能属于其中之一）：互斥表与主进程共用 shared/types 里的 PERSON_DIMS */

/** 可手动添加的维度：重复由重复分组视图管理，不出现在这里 */
const ADDABLE: DimensionKey[] = [...BAD_DIMENSIONS.filter((d) => d !== 'duplicate'), ...NEUTRAL_DIMENSIONS]

/** 参与展示的标签（低置信度不标记，与视图/徽章口径一致） */
function shownTags(img: ImageRecord): DimensionKey[] {
  return Object.entries(img.tags || {})
    .filter(([, v]) => v && v.level !== 'low')
    .map(([d]) => d as DimensionKey)
}

/**
 * 浏览中的分类若是“可打标维度”（坏维度/人数/黑白，重复除外）→ 返回该维度 = 当前列表的
 * 锚点标签：图靠它才出现在这个并集视图里，删了图就移出当前分类（TagEditor 据此标定位针 + 二次确认）。
 * 状态分类（交付库/待确认/垃圾桶/自定义）按主分类字段过滤，删标签不会移出列表 → 返回 null 不标。
 */
export function anchorDimOfCategory(category: string | null | undefined): DimensionKey | null {
  return category && (ADDABLE as string[]).includes(category) ? (category as DimensionKey) : null
}

/**
 * 当前分类锚点图标：地图定位针（“你在这里”的通用符号，比图钉📌语义准——
 * 图钉读作“置顶/固定”，而这里要表达的是“图就定位在这个分类里”）。
 * 用 SVG 不用 emoji：emoji 自带彩色不随主题，SVG 描维度色与左侧标签色块同源。
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

interface Row {
  dim: DimensionKey
  count: number
  conf: number
  level: 'high' | 'mid' | 'low'
  reason: string
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
  /**
   * 是否展开判定理由长句（“头部贴边出框（右），脸框占图高12%”这类）。**默认不展开**：
   * 大图右栏、单个图右下角“标签管理”弹窗、底部工具条“批量标签管理”弹窗三个入口都不显示——
   * 那是给调阈值的人看的，客户与摄影师复审时看不懂也不需要看。理由与置信度照旧写进库里的
   * tags JSON（跟阈值自学习用的 corrections 一起留着），只是不渲染；要排查时显式传 true 即可恢复。
   */
  showReason?: boolean
}): JSX.Element {
  const addTag = useStore((s) => s.addTag)
  const removeTag = useStore((s) => s.removeTag)
  const tagBusy = useStore((s) => s.tagBusy)
  const [picker, setPicker] = useState(false)
  const [confirmDim, setConfirmDim] = useState<DimensionKey | null>(null)
  // 待确认的人数替换：点下带 ⇄ 的按钮先落到这里，确认条就在面板底部，不直接写库
  const [pendingReplace, setPendingReplace] = useState<DimensionKey | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const pickerWrapRef = useRef<HTMLDivElement>(null)
  useOutsideClose(picker, () => setPicker(false), pickerWrapRef)

  const ids = useMemo(() => imgs.map((i) => i.id), [imgs])
  const multi = imgs.length > 1

  // 各标签汇总：批量时统计有几张图带该标签，取最高置信作为代表
  const rows = useMemo<Row[]>(() => {
    const m = new Map<DimensionKey, Row>()
    for (const img of imgs) {
      for (const d of shownTags(img)) {
        const t = img.tags[d]!
        const cur = m.get(d)
        if (cur) {
          cur.count += 1
          if (t.confidence > cur.conf) {
            cur.conf = t.confidence
            cur.level = t.level
            cur.reason = t.reason ?? ''
          }
        } else {
          m.set(d, { dim: d, count: 1, conf: t.confidence, level: t.level, reason: t.reason ?? '' })
        }
      }
    }
    return [...m.values()].sort((a, b) => b.conf - a.conf)
  }, [imgs])

  // 换图 / 图数变化时收起展开态，避免带着上一张图的确认条继续操作
  useEffect(() => {
    setPicker(false)
    setConfirmDim(null)
    setPendingReplace(null)
  }, [ids.join(',')])

  /**
   * 该维度对这批图是否可加。人数三分类互斥不等于“不能加”，而是“换掉”：
   * 旧分类的图删掉才能加新分类是死路（删了就离开当前相册，再也找不到入口），
   * 所以这里把冲突当成一种可执行动作报出去，由确认条承担风险告知。
   */
  const addState = (
    dim: DimensionKey
  ): { ok: boolean; why: string; has: number; missing: number; replaceCount: number; oldLabels: string } => {
    const has = imgs.length - imgs.filter((i) => !shownTags(i).includes(dim)).length
    const missing = imgs.length - has
    if (!PERSON_DIMS.includes(dim)) {
      if (!missing) return { ok: false, why: '选中的图都已有该标签', has, missing, replaceCount: 0, oldLabels: '' }
      return { ok: true, why: `为 ${missing} 张图补上该标签（已有该标签的 ${has} 张跳过）`, has, missing, replaceCount: 0, oldLabels: '' }
    }
    // 每张图冲突的旧分类可能不同（批量时既有单人照也有无人物），按维度分别计数
    const others = PERSON_DIMS.filter((d) => d !== dim)
    const hits = new Map<DimensionKey, number>()
    for (const i of imgs) {
      const o = shownTags(i).find((d) => others.includes(d))
      if (o) hits.set(o, (hits.get(o) ?? 0) + 1)
    }
    const replaceCount = [...hits.values()].reduce((a, b) => a + b, 0)
    const oldLabels = [...hits.keys()].map((d) => `「${DIMENSION_LABELS[d]}」`).join('、')
    if (!missing && !replaceCount) return { ok: false, why: '选中的图都已有该标签', has, missing, replaceCount: 0, oldLabels: '' }
    const parts: string[] = []
    if (missing) parts.push(`为 ${missing} 张补上`)
    if (replaceCount) parts.push(`把 ${replaceCount} 张的 ${oldLabels} 换成该标签`)
    return {
      ok: true,
      why: parts.join('，') + (replaceCount ? '（被换的图会离开旧人数相册）' : ''),
      has,
      missing,
      replaceCount,
      oldLabels
    }
  }

  const big = size === 'lg'
  const doRemove = (dim: DimensionKey): void => {
    setConfirmDim(null)
    void removeTag(ids, dim)
  }

  return (
    <div ref={wrapRef} className="flex flex-col gap-2 min-w-0">
      {/* 写入中：进度提示（乐观更新已经先把标签加/删到位，这里只是让“正在喂 AI”这件事可见） */}
      {tagBusy && (
        <div className="flex items-center gap-2 rounded-lg border border-brand/40 bg-brand/10 px-2.5 py-1.5 text-xs text-brand">
          <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-brand border-t-transparent animate-spin shrink-0" />
          {tagBusy}
        </div>
      )}
      {/* 已有标签：一行一张卡片，删除按钮带文字（纯图标太小、看不见也猜不到） */}
      {rows.map((r) => {
        const needConfirm = r.dim === anchorDim || (multi && r.count > 1)
        return (
          <div key={r.dim} className="rounded-lg border border-line bg-panel2 px-2.5 py-2">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={'shrink-0 rounded px-2 py-1 leading-none font-medium text-white ' + (big ? 'text-sm' : 'text-[11px]')}
                style={{ background: dimTagColor(r.dim) }}
              >
                {DIMENSION_LABELS[r.dim]}
              </span>
              {/* 定位针：当前分类的锚点标签——图就是靠这个标签才在正在浏览的分类里，删了就移出列表。
                  以前只有点删除弹确认条才知道这件事，现在提前标在行上（悬停有解释） */}
              {r.dim === anchorDim && (
                <span
                  className="shrink-0 inline-flex items-center"
                  title={`图就定位在「${DIMENSION_LABELS[r.dim]}」分类里（靠这枚标签）——删除后图将移出当前分类`}
                >
                  <CatPinIcon dim={r.dim} className={big ? 'w-4 h-4' : 'w-3 h-3'} />
                </span>
              )}
              <div className={'shrink-0 bg-line rounded-full overflow-hidden ' + (big ? 'w-20 h-2' : 'w-12 h-1.5')}>
                <div className={isBadDim(r.dim) ? 'h-full bg-red-500' : 'h-full bg-blue-500'} style={{ width: `${r.conf * 100}%` }} />
              </div>
              <span className={'shrink-0 tabular-nums ' + (big ? 'text-sm text-fg2' : 'text-[11px] text-fg3')}>
                {(r.conf * 100).toFixed(0)}%
              </span>
              {multi && (
                <span className="shrink-0 text-[11px] text-fg3 tabular-nums" title={`选中的 ${imgs.length} 张里有 ${r.count} 张带该标签`}>
                  {r.count}/{imgs.length}
                </span>
              )}
              <button
                className={
                  'ml-auto shrink-0 flex items-center gap-1 rounded-md border border-bad/60 text-bad ' +
                  'hover:bg-bad/15 hover:border-bad cursor-pointer transition-colors ' +
                  (big ? 'px-2.5 py-1.5 text-xs' : 'px-1.5 py-0.5 text-[11px]')
                }
                title={`这标签不对：从 ${r.count} 张图移除「${DIMENSION_LABELS[r.dim]}」（记为误判，喂 AI 学习）`}
                disabled={!!tagBusy}
                onClick={() => (needConfirm ? setConfirmDim(r.dim) : doRemove(r.dim))}
              >
                ✕ 删除
              </button>
            </div>
            {showReason && r.reason && (
              <div className={'text-fg3 break-all leading-relaxed pl-0.5 ' + (big ? 'mt-1 text-xs' : 'mt-0.5 text-[11px]')}>{r.reason}</div>
            )}
            {confirmDim === r.dim && (
              <div className="mt-1.5 rounded-md border border-warn/50 bg-warn/10 px-2.5 py-2 text-xs text-warn flex flex-wrap items-center gap-2">
                <span className="flex-1 min-w-[180px]">
                  {r.dim === anchorDim
                    ? `「${DIMENSION_LABELS[r.dim]}」是当前分类的标签——删除后这 ${r.count} 张图会移出当前分类${multi ? '' : '并自动切换到下一张图'}。`
                    : `将从选中的 ${r.count} 张图上删除「${DIMENSION_LABELS[r.dim]}」标签。`}
                </span>
                <button className="btn-danger !py-1 !text-xs" onClick={() => doRemove(r.dim)}>
                  确认删除
                </button>
                <button className="btn !py-1 !text-xs" onClick={() => setConfirmDim(null)}>
                  取消
                </button>
              </div>
            )}
          </div>
        )
      })}
      {!rows.length && (
        <div className={'rounded-lg border border-dashed border-line px-3 py-3 text-center ' + (big ? 'text-fg2 text-sm' : 'text-fg2 text-xs')}>
          暂无标签（未筛选，或所有维度置信度低于阈值 → 视为正常图）
        </div>
      )}

      {/* 添加标签：按钮 + 文档流内展开的面板（不浮动，永不被裁切） */}
      <div ref={pickerWrapRef}>
        <button
        className={
          'btn w-full border-dashed ' +
          (picker ? 'border-brand text-brand' : 'border-line text-fg2 hover:border-brand hover:text-brand') +
          (big ? ' !py-2.5 !text-sm' : ' !py-1.5 !text-xs')
        }
        onClick={() => setPicker((v) => !v)}
        title="AI 漏检的维度手动补上：图会同时出现在该维度分类（不是移动）；人数/黑白这类互斥分类已存在的，点面板里带 ⇄ 的那枚就是替换（一次点一枚，先确认）"
      >
        {/* 按钮同时露出两个动作（添加/替换）：以前只写“添加标签”，用户找不到“替换”在哪——
            其实互斥分类的替换就在这个面板里（带 ⇄ 的按钮），现在把入口语义直接写上。
            图标用 ⇄ 字符不用 emoji：面板里替换按钮用的就是它，两处同一符号才能对上 */}
        {picker ? '▴ 收起' : '＋ 添加标签 ｜ ⇄ 替换标签'}
      </button>
      {picker && (
        <div className="rounded-lg border border-line bg-panel2 p-2.5 mt-2">
          <div className="text-fg2 text-xs mb-2">
            添加到{multi ? `全部 ${imgs.length} 张选中图` : '这张图'}——图同时出现在该维度分类并排到第一张，
            <span className="text-fg">它当前所属分类不变</span>（人数三个分类例外：只能留一个，带 ⇄ 的就是替换）：
          </div>
          <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))' }}>
            {ADDABLE.map((d) => {
              const st = addState(d)
              const c = dimTagColor(d)
              return (
                <button
                  key={d}
                  className={
                    'flex items-center justify-center gap-1 whitespace-nowrap rounded-md border px-2 py-1.5 text-xs font-medium transition-all ' +
                    (st.ok ? 'cursor-pointer hover:brightness-95 active:scale-95' : 'opacity-40 cursor-not-allowed')
                  }
                  // 白底面板专用配色：维度色做文字/描边/浅同色底，比灰字灰底的 .btn 在白色面板上清楚得多
                  style={
                    st.ok
                      ? { color: c, borderColor: c + '66', background: c + '14' }
                      : { color: 'rgb(var(--c-fg3))', borderColor: 'rgb(var(--c-line))', background: 'rgb(var(--c-panel))' }
                  }
                  disabled={!st.ok || !!tagBusy}
                  title={st.why}
                  onClick={() => {
                    if (!st.ok) return
                    // 人数替换会连带把图送出旧相册，且标签操作不在 ↩ 撤回栈里，先确认再写
                    if (st.replaceCount) {
                      setPendingReplace(d)
                      return
                    }
                    setPendingReplace(null)
                    void addTag(ids, d)
                  }}
                >
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: c }} />
                  {DIMENSION_LABELS[d]}
                  {st.replaceCount > 0 && <span className="opacity-90">⇄</span>}
                  {!st.ok && st.has > 0 && <span className="opacity-70">✓</span>}
                </button>
              )
            })}
          </div>
          {pendingReplace &&
            (() => {
              const st = addState(pendingReplace)
              if (!st.replaceCount) return null
              return (
                <div className="mt-2 rounded-md border border-warn/50 bg-warn/10 px-2.5 py-2 text-xs text-warn">
                  <div>
                    人数分类只能留一个：这 {st.replaceCount} 张会从 {st.oldLabels} 改成「{DIMENSION_LABELS[pendingReplace]}」，
                    改完它们就离开 {st.oldLabels} 相册
                    {st.missing ? `（另外 ${st.missing} 张是纯新增，不受影响）` : ''}。标签操作不能用顶栏 ↩ 撤回，只能再改回去。
                  </div>
                  {/* 说明占满一行，两个按钮单独一行右对齐：以前 flex-wrap 让“取消”被挤到
                      第三行左对齐，读起来像两个按钮各管一摊 */}
                  <div className="mt-2 flex items-center justify-end gap-2">
                    <button
                      className="btn !py-1 !text-xs bg-good/15 border-good/50 text-good"
                      disabled={!!tagBusy}
                      onClick={() => {
                        void addTag(ids, pendingReplace)
                        setPendingReplace(null)
                      }}
                    >
                      确认替换
                    </button>
                    <button className="btn !py-1 !text-xs" onClick={() => setPendingReplace(null)}>
                      取消
                    </button>
                  </div>
                </div>
              )
            })()}
          <div className="text-[11px] text-fg2 mt-2">
            彩色 = 可添加；带 ⇄ = 会替换掉现有的人数标签（点一下先问确认）；灰显✓ = 已有该标签
          </div>
        </div>
      )}
      </div>
    </div>
  )
}

/**
 * 列表端标签管理器：网格/列表/瀑布流卡片上的 🏷 按钮打开，
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
        ({ library: '交付库', review: '待确认', trash: '垃圾桶', dup_trash: '重复/连拍-废弃' } as Record<string, string>)[c] ??
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
              {imgs.length > 1 && <span className="text-fg2">· 增删标签对全部选中图生效</span>}
            </div>
          </div>
          {/* 关闭按钮：以前是一枚 text-fg3 的淡灰小✕（无尺寸无底色，用户反馈“太小不明显”），
              改成 36×36 带边框底色的按钮，悬停转红白——一眼看见、好点，红色也符合“关闭/退出”预期。
              图标用 SVG 描边而非✕字符：字符在不同字体下粗细/居中不一致，SVG 线条干净且真正居中 */}
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

        {/* 已有标签 */}
        <div className="px-4 pt-3">
          <div className="text-xs text-fg3 mb-2 flex items-center gap-1.5">
            <span className="uppercase tracking-wide">AI 标记的标签</span>
          </div>
        </div>
        <div className="px-4">
          <TagEditor imgs={imgs} anchorDim={anchorDim} size="lg" />
        </div>

        {/* 脚注 */}
        <div className="px-4 py-3 mt-2 border-t border-line text-[11px] text-fg3 leading-relaxed">
          添加标签 → 图同时出现在该维度分类的第一张（不是移动，原分类不变）；删除标签 → 从该维度分类消失，
          若它本来就归在该分类下则一并移出。
        </div>
      </div>
    </div>
  )
}
