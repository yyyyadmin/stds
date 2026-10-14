/**
 * 待确认重判面板（D2 §8）——「此判定错误」的落地入口。
 *
 * 与"标签管理"的差别：标签管理是随时随地的增删；这里是**结案动作**——把一张（或一批）
 * 待确认图重判清楚：人数是什么、哪些瑕疵真有、哪些没有，提交后图离开待确认。
 *
 * 交互模型（批量 D3 增量式，绝不覆盖式压平）：
 * - 人数：单选 4 项（单人/多人合拍/多人混合/无人物）。这批图有统一的人数标签时**直接预选它、不给
 *   「不改」按钮**（用户 10-14：人数必须一个且只能一个，「不改」和高亮中的当前值是同一句话，摆两个
 *   反而像 bug）；只有「多张人数不一致」或「这张压根没标人数」时才留「保持现状」——没得预选的情况下
 *   只剩 4 个按钮，面板一开随手点一个就把整批压平成同一类了。
 *   人数是"待确认只由瑕疵派生、绝不由人数不确定派生"的纠偏入口——AI 没标人数（597 那批）
 *   手动停泊的图，靠这里选定人数归位。
 * - 瑕疵：5 项多选（闭眼/表情崩坏/模糊/曝光/半截头；重复归分组视图管，不在此列）。
 *   每项三态：✓该有（补标）/ ✗不该有（删标）/ 未动（保留）。
 *   未动的中置信瑕疵在提交时按 D1"用户判定"提为高置信（存疑→确定，图落瑕疵片）；
 *   黑白开关没有——黑白是客观事实标签，与"这图有没有毛病"的判定无关。
 * - 提交顺序：删标 → 补标 → 逐张把剩余中置信瑕疵提为高置信（记"判对"样本）→ 人数移动（只移动
 *   「选的和当前不一样」的那几张，见 submit 第 3 步）。
 *
 * 入口有三个，都是这同一个组件：卡片底部工具栏「此判定错误（重判）」、多选工具条的批量版、
 * 逐张复核弹窗里人工裁定的「逐项改判」；卡片左上角红角标（人工复审）点的也是它。
 *
 * 尺寸（用户 10-14：太小了，按钮也要大点）：宽 max-w-2xl，正文与按钮一律 text-sm，
 * 段标题 text-sm 加粗（不得小于它管辖的内容行），说明文字 text-sm；按钮 padding px-3 py-2。
 * 层级 z-[75]：要能从逐张复核弹窗（z-[70]）上面打开而不把主弹窗挤走，压在它下面等于没给入口。
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

  const imgKey = imgs.map((i) => i.id).join(',')
  /**
   * 这批图是否共用同一个人数标签（每张都有、且是同一个）。是 → 预选它并且不显示「保持现状」；
   * 否（多张之间不一致 / 有图压根没标）→ 才显示「保持现状」，因为它没有"当前值"可以高亮。
   */
  const commonPerson = useMemo<DimensionKey | null>(() => {
    if (!imgs.length) return null
    const ps = imgs.map(visiblePerson)
    if (ps.some((p) => !p)) return null
    const first = ps[0] as DimensionKey
    return ps.every((p) => p === first) ? first : null
    // 依赖 imgKey 而非 imgs：后者会随乐观更新换引用，边改选边被重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgKey])
  // 换图（或兑底数据到达后图集合变化）时重置选择：有统一当前值就预选它，否则「保持现状」
  useEffect(() => {
    setPerson(commonPerson ?? 'same')
    const fl = Object.fromEntries(FLAW_CHOICES.map((d) => [d, 'same' as FlawChoice])) as Record<string, FlawChoice>
    setFlaw(fl)
    // AI 复审"改一改"入口：单张且有预填建议时，人数按建议预选、内容型瑕疵三态按建议+现状设好（用户可微调）
    const prefill = useStore.getState().reviewPanelPrefill
    if (prefill && imgs.length === 1) {
      const img = imgs[0]
      setPerson(prefill.person)
      const wantByDim: Record<string, boolean> = {
        eyes_closed: prefill.flaws.eyes_closed,
        half_head: prefill.flaws.half_head,
        face_ugly: prefill.flaws.expression
      }
      const next = { ...fl }
      for (const d of Object.keys(wantByDim) as DimensionKey[]) {
        const want = wantByDim[d]
        const has = !!img.tags?.[d] && img.tags[d]!.level !== 'low'
        next[d] = want ? 'add' : has ? 'remove' : 'same'
      }
      setFlaw(next)
    }
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
  const showKeep = commonPerson === null
  // 「保持现状」出现时把原因写在标题旁（而不是让用户猜为什么多一个按钮）：这批各自是什么 / 有几张没标
  const keepNote = (() => {
    if (!showKeep) return ''
    const parts = PERSON_DIMS.map((d) => ({ d, n: imgs.filter((i) => visiblePerson(i) === d).length }))
      .filter((x) => x.n > 0)
      .map((x) => `${DIMENSION_LABELS[x.d]} ${x.n}`)
    const none = imgs.filter((i) => !visiblePerson(i)).length
    if (!multi) return '这张还没标人数，选一个即归位'
    return `这 ${imgs.length} 张人数不一样：${[...parts, ...(none ? [`未标 ${none}`] : [])].join(' · ')}`
  })()

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
      // 3) 人数归位：只动“选的和当前不一样”的那几张。预选就是当前值，点回它等于没改——
      //    真去走一次移动会白写一条人工改标记录、白刷 cat_changed_at（图跳列表最前），所以逐张比一下再筛。
      //    （moveIds 对人数维不清瑕疵标签，只互斥换人数标 + category=user）
      let personIds: number[] = []
      if (person !== 'same') {
        personIds = imgs.filter((i) => visiblePerson(i) !== person).map((i) => i.id)
        if (personIds.length) await moveIds(personIds, person)
      }
      // 兑底：没选人数的图也已被 2) 的结案重算 category（主进程侧 computeCategory），这里统一刷新即可
      await useStore.getState().refreshImagesFor(idList)
      await useStore.getState().refreshCounts()
      const parked = imgs.filter((i) => person === 'same' && !visiblePerson(i) && !isTrashLike(i.category) && flawStatsGet(i) === 0 && !wasMid(i)).length
      useStore.setState({
        toast: {
          msg: `重判已保存（${imgs.length} 张）${confirmed ? `：${confirmed} 条存疑瑕疵确认为瑕疵片` : ''}${
            personIds.length ? `，${personIds.length} 张归属改为「${DIMENSION_LABELS[person as DimensionKey]}」` : ''
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
    // 选中态的文字用 fg，不用 good/bad/brand 本身：彩色字 + 同色 15% 底在两个主题下都只到 3.3~3.6:1，
    // 14px 看不清（逐张复核弹窗里同问题已实测过）；颜色信号由描边与底色承担，按钮上本来就写着“该有/不该有/未动”。
    'px-3 py-2 rounded-md border text-sm font-medium transition-all cursor-pointer ' +
    (on
      ? tone === 'good'
        ? 'border-good/60 bg-good/15 text-fg'
        : tone === 'bad'
          ? 'border-bad/60 bg-bad/15 text-fg'
          : 'border-brand/60 bg-brand/15 text-fg'
      : 'border-line bg-panel text-fg2 hover:border-fg3')

  return (
    <div className="fixed inset-0 z-[75] bg-black/75 flex items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && !busy && closeReviewPanel()}>
      <div className="w-full max-w-2xl max-h-[88vh] overflow-y-auto rounded-xl border border-line bg-panel shadow-2xl fade-in">
        {/* 头部：缩略图 + 张数（同标签管理器版式） */}
        <div className="sticky top-0 z-10 flex items-center gap-3 px-5 py-4 bg-panel border-b border-line">
          <img
            src={imgs[0].thumb ? toSrc(imgs[0].thumb) : toSrc(imgs[0].path)}
            className="w-14 h-14 rounded-lg object-cover ring-1 ring-line shrink-0 bg-panel2"
            alt=""
            draggable={false}
          />
          <div className="flex-1 min-w-0">
            <div className="text-base font-bold text-fg truncate" title={imgs[0].path}>
              {multi ? `重判 ${imgs.length} 张图` : imgs[0].filename}
            </div>
            <div className="text-sm text-fg2 mt-0.5">逐项改正 AI 判定，提交后这些图离开待确认{multi ? '；勾加 / 叉删 / 没动保留，不会把每张图压平成同一组标签' : ''}</div>
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

        <div className="px-5 py-4">
          {/* 人数：单选（互斥身份，必须且只能一个）。有统一当前值时直接预选它、不再摆「不改」；
              整批不一致 / 这张没标 才多一个「保持现状」，并把原因写在标题旁，不让人猜为何多一个按钮 */}
          <div className="flex items-baseline gap-2 mb-2 flex-wrap">
            <span className="text-sm font-semibold text-fg2 tracking-wide">人数归属（单选）</span>
            {keepNote && <span className="text-sm text-fg2">{keepNote}</span>}
          </div>
          <div className={`grid ${showKeep ? 'grid-cols-5' : 'grid-cols-4'} gap-2 mb-1`}>
            {showKeep && (
              <button className={segCls(person === 'same', 'idle')} onClick={() => setPerson('same')} title="人数按每张现状保留，只提交下面的瑕疵判定">
                保持现状
              </button>
            )}
            {PERSON_DIMS.map((d) => {
              const c = dimTagColor(d)
              return (
                <button
                  key={d}
                  className={segCls(person === d, 'idle')}
                  // 选中态只换描边与底色，不换字色：人数用的蓝（#3b82f6）叠在 12% 同色底上实测只 3.2:1（浅色）/ 4.07:1（深色），
                  // 14px 中等字没到 4.5 线（与逐张复核弹窗同一类坑）；改文本色后 14.0 / 10.7，颜色身份由底/框承担。
                  style={person === d ? { borderColor: c + '99', background: c + '1f' } : undefined}
                  onClick={() => setPerson(d)}
                  title={
                    d === commonPerson
                      ? `当前就是「${DIMENSION_LABELS[d]}」：不点别的即保持不变${multi ? '' : '（提交时不会重走一次移动）'}`
                      : `把这张${multi ? '批' : ''}图归为「${DIMENSION_LABELS[d]}」（人数标签互斥替换，并离开待确认）`
                  }
                >
                  {DIMENSION_LABELS[d]}
                </button>
              )
            })}
          </div>

          {/* 瑕疵：逐项三态 */}
          <div className="text-sm font-semibold text-fg2 mt-4 mb-2 tracking-wide">瑕疵逐项判定（✓该有 / ✗不该有 / 未动保留）</div>
          <div className="flex flex-col gap-2">
            {FLAW_CHOICES.map((d) => {
              const st = flawStats.get(d)!
              const cur = flaw[d]
              const c = dimTagColor(d)
              return (
                <div key={d} className="flex items-center gap-3 rounded-lg border border-line bg-panel2 px-3 py-2.5">
                  <span className="shrink-0 rounded px-2.5 py-1 leading-none text-sm font-medium text-white" style={{ background: c }}>
                    {DIMENSION_LABELS[d]}
                  </span>
                  <span className="text-sm text-fg2 flex-1 min-w-0 truncate">
                    {st.has ? `已标 ${st.has}/${imgs.length} 张${st.mid ? `（其中 ${st.mid} 张存疑）` : ''}` : '未标'}
                  </span>
                  <div className="flex items-center gap-1.5 shrink-0">
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
          <div className="text-sm text-fg2 mt-3 leading-relaxed">
            提交后：标“不该有”的删掉这个瑕疵标签，标“该有”的补上；“未动”的按你的确认处理。
            确认下来没有瑕疵的图回【交付库】方向，由人数标签自动归位。黑白照是事实标签，不在这个判定里。
          </div>
        </div>

        {/* 底部动作 */}
        <div className="px-5 py-4 border-t border-line flex items-center gap-3">
          <button className="btn flex-1 text-base px-4 py-2.5 bg-emerald-700 hover:bg-emerald-600 text-white border-transparent font-medium" disabled={busy} onClick={() => void submit()}>
            {busy ? '保存中…' : '提交重判（离开待确认）'}
          </button>
          <button className="btn text-base px-5 py-2.5" disabled={busy} onClick={() => closeReviewPanel()}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
