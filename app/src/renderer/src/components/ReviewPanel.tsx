/**
 * 待确认重判面板（D2 §8）——「此判定错误」的落地入口。
 *
 * 与"标签管理"的差别：标签管理是随时随地的增删；这里是**结案动作**——把一张（或一批）
 * 待确认图重判清楚：人数是什么、哪些瑕疵真有、哪些没有，提交后图离开待确认。
 *
 * 交互模型（批量 D3 增量式，绝不覆盖式压平）：
 * - 人数：单选 4 项（单人/多人合拍/多人混合/无人物），默认"不改"；单张且已有人数标签时预填当前。
 *   人数是"待确认只由瑕疵派生、绝不由人数不确定派生"的纠偏入口——AI 没标人数（597 那批）
 *   手动停泊的图，靠这里选定人数归位。
 * - 瑕疵：5 项多选（闭眼/表情崩坏/模糊/曝光/半截头；重复归分组视图管，不在此列）。
 *   每项三态：✓该有（补标）/ ✗不该有（删标）/ 未动（保留）。
 *   未动的中置信瑕疵在提交时按 D1"用户判定"提为高置信（存疑→确定，图落瑕疵片）；
 *   黑白开关没有——黑白是客观事实标签，与"这图有没有毛病"的判定无关。
 * - 提交顺序：删标 → 补标 → 逐张把剩余中置信瑕疵提为高置信（记"判对"样本）→ 人数移动（若选）。
 */
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { dimTagColor } from './Sidebar'
import { toSrc } from './imageSrc'
import {
  BAD_DIMENSIONS,
  DIMENSION_LABELS,
  PERSON_DIMS,
  isTrashLike,
  type DimensionKey,
  type ImageRecord
} from '../../../shared/types'

/** 可逐项重判的瑕疵维度：重复由重复/连拍分组管理，不出现在这里（共 5 项） */
const FLAW_CHOICES: DimensionKey[] = BAD_DIMENSIONS.filter((d) => d !== 'duplicate')

/** 图当前可见的人数标签（低置信不视为已判）；旧数据 category 恰为人数维时兜底 */
function visiblePerson(img: ImageRecord): DimensionKey | null {
  const d = PERSON_DIMS.find((p) => img.tags?.[p] && img.tags[p]!.level !== 'low')
  if (d) return d
  return (PERSON_DIMS as string[]).includes(img.category) ? (img.category as DimensionKey) : null
}

type FlawChoice = 'same' | 'add' | 'remove'

export default function ReviewPanel(): JSX.Element | null {
  const reviewPanelIds = useStore((s) => s.reviewPanelIds)
  const images = useStore((s) => s.images)
  const closeReviewPanel = useStore((s) => s.closeReviewPanel)
  const moveIds = useStore((s) => s.moveIds)

  const ids = useMemo(() => reviewPanelIds ?? [], [reviewPanelIds])
  const key = ids.join(',')
  // 双轨取数（同标签管理器）：store.images 带乐观更新，但图一旦移出当前分类就不在里面了，
  // 用 getImage 逐张兑底权威值，避免"面板里看到的标签是旧的"
  const [byId, setById] = useState<Record<number, ImageRecord>>({})
  useEffect(() => {
    if (!key) return
    let alive = true
    void (async () => {
      const got = (await Promise.all(key.split(',').map(Number).map((id) => window.api.getImage(id))))
        .filter(Boolean) as ImageRecord[]
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
  }, [key])

  const imgs = useMemo(
    () => ids.map((id) => images.find((i) => i.id === id) ?? byId[id]).filter(Boolean) as ImageRecord[],
    [ids, images, byId]
  )

  const [person, setPerson] = useState<DimensionKey | 'same'>('same')
  const [flaw, setFlaw] = useState<Record<string, FlawChoice>>({})
  const [busy, setBusy] = useState(false)

  // 换图（或兑底数据到达后图集合变化）时重置选择：单张预填它当前的人数；批量人数不一致则"不改"
  const imgKey = imgs.map((i) => i.id).join(',')
  useEffect(() => {
    const ps = imgs.map(visiblePerson).filter(Boolean) as DimensionKey[]
    setPerson(ps.length === 1 && imgs.length === 1 ? ps[0] : 'same')
    setFlaw(Object.fromEntries(FLAW_CHOICES.map((d) => [d, 'same' as FlawChoice])))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgKey])

  // Esc 关闭（与标签管理器同样的浮层优先级；提交中不允许关，避免写一半留个"看起来没保存"）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) closeReviewPanel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, closeReviewPanel])

  if (!imgs.length) return null
  const multi = imgs.length > 1

  /** 各瑕疵维度在这批图上的现状：带可见标签的张数 / 其中中置信（存疑）张数 */
  const flawStats = new Map<DimensionKey, { has: number; mid: number }>()
  for (const d of FLAW_CHOICES) {
    let has = 0
    let mid = 0
    for (const img of imgs) {
      const t = img.tags?.[d]
      if (t && t.level !== 'low') {
        has++
        if (t.level === 'mid') mid++
      }
    }
    flawStats.set(d, { has, mid })
  }

  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const idList = imgs.map((i) => i.id)
      // 1) 先删（判错的瑕疵）再补（漏检的瑕疵）：与"未动"互不干扰，批量异构走增量式
      for (const d of FLAW_CHOICES) if (flaw[d] === 'remove') await window.api.removeDimTag(idList, d)
      for (const d of FLAW_CHOICES) if (flaw[d] === 'add') await window.api.addDimTag(idList, d)
      // 2) 保持"未动"的中置信瑕疵 → 按 D1 提为高置信（用户确认了这条存疑判定），逐张逐维度
      let confirmed = 0
      for (const img of imgs) {
        const eff: Record<string, string | undefined> = {}
        for (const d of BAD_DIMENSIONS) {
          const lvl = img.tags?.[d]?.level
          const c = (FLAW_CHOICES as string[]).includes(d) ? flaw[d] : 'same'
          eff[d] = c === 'remove' ? undefined : c === 'add' ? 'high' : lvl
        }
        let guard = 0
        while (guard++ < BAD_DIMENSIONS.length) {
          const mid = BAD_DIMENSIONS.find((d) => eff[d] === 'mid')
          if (!mid) break
          await window.api.correctImage({
            imageId: img.id,
            action: 'correct',
            origDim: mid,
            origConfidence: img.tags?.[mid]?.confidence ?? null
          })
          eff[mid] = 'high'
          confirmed++
        }
      }
      // 3) 人数归位（选了才动；moveIds 对人数维不清瑕疵标签，只互斥换人数标 + category=user）
      if (person !== 'same') await moveIds(idList, person)
      // 兑底：没选人数的图也已被 2) 的结案重算 category（主进程侧 computeCategory），这里统一刷新即可
      await useStore.getState().refreshImagesFor(idList)
      await useStore.getState().refreshCounts()
      const parked = imgs.filter((i) => person === 'same' && !isTrashLike(i.category) && flawStatsGet(i) === 0 && !wasMid(i)).length
      useStore.setState({
        toast: {
          msg: `重判已保存（${imgs.length} 张）${confirmed ? `：${confirmed} 条存疑瑕疵确认为瑕疵片` : ''}${
            person !== 'same' ? `，归属改为「${DIMENSION_LABELS[person]}」` : ''
          }${parked ? `；${parked} 张无瑕疵也没选人数的仍留在待确认（想搁置请用侧栏拖入）` : ''}`,
          kind: 'success',
          duration: 2000
        }
      })
      closeReviewPanel()
    } finally {
      setBusy(false)
    }
  }

  // toast 里"仍留待确认"的粗估：提交前静态判断不了全部路径，只作提示性说明
  const flawStatsGet = (img: ImageRecord): number => {
    let n = 0
    for (const d of FLAW_CHOICES) {
      const st = flaw[d]
      const lvl = img.tags?.[d]?.level
      if (st === 'remove') continue
      if (st === 'add') n++
      else if (lvl && lvl !== 'low') n++
    }
    return n
  }
  const wasMid = (img: ImageRecord): boolean => BAD_DIMENSIONS.some((d) => flaw[d] !== 'remove' && img.tags?.[d]?.level === 'mid')

  const segCls = (on: boolean, tone: 'good' | 'bad' | 'idle'): string =>
    'px-2 py-1 rounded-md border text-xs font-medium transition-all cursor-pointer ' +
    (on
      ? tone === 'good'
        ? 'border-good/60 bg-good/15 text-good'
        : tone === 'bad'
          ? 'border-bad/60 bg-bad/15 text-bad'
          : 'border-brand/60 bg-brand/15 text-brand'
      : 'border-line bg-panel text-fg3 hover:border-fg3')

  return (
    <div className="fixed inset-0 z-[60] bg-black/75 flex items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && !busy && closeReviewPanel()}>
      <div className="w-full max-w-lg max-h-[88vh] overflow-y-auto rounded-xl border border-line bg-panel shadow-2xl fade-in">
        {/* 头部：缩略图 + 张数（同标签管理器版式） */}
        <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-3 bg-panel border-b border-line">
          <img
            src={imgs[0].thumb ? toSrc(imgs[0].thumb) : toSrc(imgs[0].path)}
            className="w-12 h-12 rounded-lg object-cover ring-1 ring-line shrink-0 bg-panel2"
            alt=""
            draggable={false}
          />
          <div className="flex-1 min-w-0">
            <div className="text-base text-fg truncate" title={imgs[0].path}>
              {multi ? `重判 ${imgs.length} 张图` : imgs[0].filename}
            </div>
            <div className="text-xs text-fg3 mt-0.5">逐项改正 AI 判定，提交后这些图离开待确认{multi ? '；勾加 / 叉删 / 没动保留，不会把每张图压平成同一组标签' : ''}</div>
          </div>
          <button
            className="shrink-0 grid place-items-center w-9 h-9 rounded-lg border border-line bg-panel2 text-fg2 hover:bg-bad hover:border-bad hover:text-white transition-colors cursor-pointer"
            onClick={() => !busy && closeReviewPanel()}
            title="关闭（Esc）"
            aria-label="关闭"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <div className="px-4 py-3">
          {/* 人数：单选（互斥身份，只能选一个或不动） */}
          <div className="text-xs text-fg3 mb-1.5 uppercase tracking-wide">人数归属（单选）</div>
          <div className="grid grid-cols-5 gap-1.5 mb-1">
            <button className={segCls(person === 'same', 'idle')} onClick={() => setPerson('same')} title="不改现有归属">
              不改
            </button>
            {PERSON_DIMS.map((d) => {
              const c = dimTagColor(d)
              return (
                <button
                  key={d}
                  className={segCls(person === d, 'idle')}
                  style={person === d ? { color: c, borderColor: c + '99', background: c + '1f' } : undefined}
                  onClick={() => setPerson(d)}
                  title={`把这张${multi ? '批' : ''}图归为「${DIMENSION_LABELS[d]}」（人数标签互斥替换，并离开待确认）`}
                >
                  {DIMENSION_LABELS[d]}
                </button>
              )
            })}
          </div>

          {/* 瑕疵：逐项三态 */}
          <div className="text-xs text-fg3 mt-3 mb-1.5 uppercase tracking-wide">瑕疵逐项判定（✓该有 / ✗不该有 / 未动保留）</div>
          <div className="flex flex-col gap-1.5">
            {FLAW_CHOICES.map((d) => {
              const st = flawStats.get(d)!
              const cur = flaw[d]
              const c = dimTagColor(d)
              return (
                <div key={d} className="flex items-center gap-2 rounded-lg border border-line bg-panel2 px-2.5 py-1.5">
                  <span className="shrink-0 rounded px-2 py-0.5 leading-none text-[11px] font-medium text-white" style={{ background: c }}>
                    {DIMENSION_LABELS[d]}
                  </span>
                  <span className="text-[11px] text-fg3 flex-1 min-w-0 truncate">
                    {st.has ? `已标 ${st.has}/${imgs.length} 张${st.mid ? `（其中 ${st.mid} 张存疑）` : ''}` : '未标'}
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      className={segCls(cur === 'add', 'good')}
                      disabled={busy || st.has === imgs.length}
                      title={`补标：给${multi ? '缺这个标签的图' : '这张图'}加上「${DIMENSION_LABELS[d]}」；加完它算这一类瑕疵，默认不导出`}
                      onClick={() => setFlaw((f) => ({ ...f, [d]: 'add' }))}
                    >
                      ✓ 该有
                    </button>
                    <button
                      className={segCls(cur === 'same', 'idle')}
                      disabled={busy}
                      title={st.mid ? `未动：${st.mid} 张存疑的图提交后按“这条瑕疵算数”处理，留在瑕疵片` : '未动：标签与位置都不变'}
                      onClick={() => setFlaw((f) => ({ ...f, [d]: 'same' }))}
                    >
                      未动
                    </button>
                    <button
                      className={segCls(cur === 'remove', 'bad')}
                      disabled={busy || st.has === 0}
                      title={`删标：把「${DIMENSION_LABELS[d]}」从${multi ? '已有这个标签的图' : '这张图'}上移除；没别的瑕疵它就回交付库方向`}
                      onClick={() => setFlaw((f) => ({ ...f, [d]: 'remove' }))}
                    >
                      ✗ 不该有
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
          <div className="text-[11px] text-fg3 mt-2 leading-relaxed">
            提交后：标“不该有”的删掉这个瑕疵标签，标“该有”的补上；“未动”的按你的确认处理。
            确认下来没有瑕疵的图回【交付库】方向，由人数标签自动归位。黑白照是事实标签，不在这个判定里。
          </div>
        </div>

        {/* 底部动作 */}
        <div className="px-4 py-3 border-t border-line flex items-center gap-2">
          <button className="btn flex-1 !py-2 text-sm bg-emerald-700 hover:bg-emerald-600 text-white border-transparent font-medium" disabled={busy} onClick={() => void submit()}>
            {busy ? '保存中…' : '提交重判（离开待确认）'}
          </button>
          <button className="btn !py-2 text-sm" disabled={busy} onClick={() => closeReviewPanel()}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
