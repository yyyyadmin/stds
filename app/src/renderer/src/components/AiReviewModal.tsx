/**
 * AI 复审在本轮作用域页内的四态呈现（只在待确认页或瑕疵片页渲染）：
 *  running → 进度窗（absolute 只盖内容区，切走本页自动卸载、后台照跑）
 *  settling → 跑完读回建议的收尾遮罩（不可关）
 *  小结     → 居中面板：共复审 N 张（X 张有分歧 / Y 张一致）+ [逐张复核][全部处理][以后再说]
 *  compare  → 逐张：大图 + 差异行（或“与本地一致”）+ 画质盲区提醒 + [上一张][下一张][不采纳][确认保留/采纳这张]
 *
 * 三个口径（用户 10-14 拍板）：
 *  · 一致的图也进队列：复审就是把待确认清干净，一致也得点「确认保留」才算结案；
 *  · 采纳 = 一次性把标签和归属都办完（该去哪栏自动落位）；已结案但身上再没瑕疵、却还停在待确认的
 *    （以前手动停泊的干净图），进队列给一个「归位搬出待确认」按钮——不然它就是“哪儿都不在”的死角；
 *  · 云端不判模糊/曝光（见 aiReviewPrompt.ts），所以这两项不能拿“AI 没意见”当放行依据：
 *    结案后仍带着它们的图会被打上「人工复审」（卡片左上角红底角标、排本栏最前、AI 不再重跑）。
 *
 * 文案原则（用户：话术太多）：同一句话只在一个地方说，不堆叠解释。
 *
 * 尺寸（两轮往回走：先“都看不清”→放大一档，再“不用过于大、要一屏看完不滚动”→收回一档）：
 *  四个面板统一按“正文 text-sm / 面板标题 text-base 加粗 / 逐张标题与计数 text-base”取档，按钮 text-sm + px-4 py-2；
 *  宽度：结果面板 max-w-xl、进度 max-w-lg、逐张 max-w-4xl；图高上限 36vh——保证图 + 左右两栏 + 底部按钮在 92vh 里全露出来。
 *  要看整张原图不必放大弹窗：点图（单击就开，用户 10-14 不再要求双击）开全屏原图遮罩（z-[80]，点任意处或 Esc 关）。
 *
 * 逐张面板图片下方的布局（用户 10-14 指定）：左右两栏，窄窗口自动换行成上下。
 *  左栏＝云端复核范围内四项的「本地检测 / 云端复核」两列并排比对 + 处置说明 + 云端判定依据；
 *  右栏＝云端不覆盖的画质维度（画面模糊 / 曝光异常）：标签块 + 为什么还要人工看 + 红色「人工裁定本张」按钮。
 *  为什么拆两栏：以前三种结论、依据、画质盲区提醒、按钮全部堆成一列，画质这项到底要不要人工定被埋在最后面。
 *  文件名独占一行被判为“占空间”（用户 10-14），已并入顶部标题栏右侧，后面跟一个复制文件名的小按钮——
 *  按钮必须贴着文件名（用户 10-14 反馈它跑到了最右上角）：所以文件名与图标包在一个不拉伸的 inline flex 里，
 *  拉伸交给外层容器，否则 truncate 那一行自带 flex-1 会把图标顶到行尾。
 *
 * 「人工裁定本张」不再抢走主弹窗（用户 10-14）：它打开 ManualVerdictDialog 三选一（合格入交付库选档 /
 *  移入废弃库 / 稍后再判定），小弹窗 z-[80] 压在逐张弹窗之上，关它或选完都不关主弹窗。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, aiReviewDiffRows, aiReviewCompareRows, hasAiReviewDiff, hasAiReviewAction, aiReviewShouldHome, aiReviewBlindSpots } from '../store'
import { isTrashLike, DIMENSION_LABELS } from '../../../shared/types'
import { viewSrc } from './imageSrc'
import ManualVerdictDialog from './ManualVerdictDialog'

export default function AiReviewModal(): JSX.Element | null {
  const activeCategory = useStore((s) => s.activeCategory)
  const images = useStore((s) => s.images)
  const aiReview = useStore((s) => s.aiReview)
  const dismissed = useStore((s) => s.aiReviewSummaryDismissed)
  const settling = useStore((s) => s.aiReviewSettling)
  const dismissSummary = useStore((s) => s.dismissAiReviewSummary)
  const stopAiReview = useStore((s) => s.stopAiReview)
  const adoptAiReview = useStore((s) => s.adoptAiReview)
  const rejectAiReview = useStore((s) => s.rejectAiReview)
  const confirmAiReview = useStore((s) => s.confirmAiReview)
  const homeIfCleanParked = useStore((s) => s.homeIfCleanParked)
  const adoptAll = useStore((s) => s.adoptAllReviewSuggestions)

  const [compareOpen, setCompareOpen] = useState(false)
  const [currentId, setCurrentId] = useState<number | null>(null)
  // 双击图看原图的全屏遮罩（不借道 PreviewModal：它 z-40，会被本弹窗 z-[70] 盖住）
  const [zoomOpen, setZoomOpen] = useState(false)
  // 人工裁定三选一（合格入档 / 废弃 / 稍后），开关都不动本弹窗
  const [verdictOpen, setVerdictOpen] = useState(false)
  // 原图遮罩的开屏时刻：用来兜住“双击习惯”——用户双击时第二次点击会落在刚弹出的遮罩上，
  // 不拦一下就是“开→立刻关”，反而看不到大图（用户 10-14 要单击双击都能放大）。
  const zoomOpenedAt = useRef(0)
  const openZoom = (): void => {
    zoomOpenedAt.current = Date.now()
    setZoomOpen(true)
  }
  const closeZoom = (): void => {
    if (Date.now() - zoomOpenedAt.current < 300) return
    setZoomOpen(false)
  }

  // 复制文件名（顶部标题栏小按钮）：与放大弹窗同一套——只给 toast，不弹任何确认框
  const copyFilename = async (filename: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(filename)
      useStore.setState({ toast: { msg: `已复制文件名：${filename}`, kind: 'success', duration: 1200 } })
    } catch {
      useStore.setState({ toast: { msg: '复制文件名失败，请手动选择复制', kind: 'error' } })
    }
  }

  const running = !!aiReview?.running
  // 带建议且还没结案的图 + 已结案但该归位的图全部进逐张队列（含与本地一致的——它们也等你点一下）
  const pending = useMemo(() => images.filter((i) => hasAiReviewAction(i) && !isTrashLike(i.category)), [images])
  // 其中真正有差异的张数：只用于小结文案（“X 张有不同意见、Y 张与本地一致”）
  const diffCount = useMemo(() => pending.filter(hasAiReviewDiff).length, [pending])
  // 已复核干净、只差一个归位动作的张数（存量手动停泊的干净图）
  const homeCount = useMemo(() => pending.filter(aiReviewShouldHome).length, [pending])
  // 一致 = 队列总数 - 有分歧 - 等你归位（夹 0，同时占两个桶的极少数图不能报负数）
  const agreeCount = Math.max(0, pending.length - diffCount - homeCount)

  // 进入对比时定位第一张；被处理/跳过的图离开队列 → 顺位到下一张，队列空则收起对比
  useEffect(() => {
    if (!compareOpen) return
    if (currentId != null && pending.some((i) => i.id === currentId)) return
    if (!pending.length) {
      setCompareOpen(false)
      setCurrentId(null)
      return
    }
    setCurrentId(pending[0].id)
  }, [compareOpen, currentId, pending])

  // 换张时收起上层的原图遮罩与裁定弹窗；遮罩开着时 Esc 只关遮罩（不泄露到别的层）
  useEffect(() => {
    setZoomOpen(false)
    setVerdictOpen(false)
  }, [currentId])
  useEffect(() => {
    if (!zoomOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setZoomOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [zoomOpen])
  // 裁定弹窗的 Esc = 稍后再判定（什么都不改），同样吞掉事件不往下传
  useEffect(() => {
    if (!verdictOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setVerdictOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [verdictOpen])

  // 有本轮进度态时只在其作用域页渲染（进度窗/小结/对比都跟着本轮走）；重启后无进度态时，待确认/瑕疵片两页仍要能看到待采纳建议的采纳面板
  if (aiReview ? activeCategory !== aiReview.scope : activeCategory !== 'review' && activeCategory !== 'flaws') return null

  const cur = compareOpen ? pending.find((i) => i.id === currentId) ?? null : null

  // —— 1) 独占进度弹窗（复审在跑）——
  if (running) {
    const total = aiReview?.total ?? 0
    const done = aiReview?.done ?? 0
    const pct = total > 0 ? Math.round((done / total) * 100) : 0
    return (
      <div className="absolute inset-0 z-[65] flex items-center justify-center bg-black/70 p-4">
        <div className="w-full max-w-lg rounded-xl border border-line bg-panel shadow-2xl">
          <div className="px-5 py-4 border-b border-line">
            <div className="flex items-center gap-2.5 text-base font-bold text-fg">
              <span className="inline-block w-4 h-4 shrink-0 rounded-full border-2 border-brand border-t-transparent animate-spin" />
              云端复核进行中
            </div>
          </div>
          <div className="px-5 py-4">
            <div className="text-sm text-fg2 tabular-nums">
              共 {total} 张 · 已完成 {done} 张{aiReview?.failCount ? ` · 判定失败 ${aiReview.failCount} 张` : ''}
            </div>
            <div className="mt-3 h-2 bg-panel2 rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-brand transition-all duration-300" style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-2.5 truncate text-sm text-fg3" title={aiReview?.current || ''}>
              当前处理：{aiReview?.current || '准备中…'}
            </div>
          </div>
          <div className="px-5 py-4 flex justify-end border-t border-line">
            <button className="btn text-sm px-4 py-2" title="中止复核：在当前张停止，已生成的结论保留" onClick={() => void stopAiReview()}>
              中止复核
            </button>
          </div>
        </div>
      </div>
    )
  }

  // —— 1b) 收尾整理遮罩：跑完→把库里的结论读回内存的短暂空窗，亮此加载层（不可关），刷完自动收起→结论面板随即弹出 ——
  if (settling) {
    return (
      <div className="absolute inset-0 z-[66] flex items-center justify-center bg-black/70 p-4">
        <div className="flex flex-col items-center gap-3 text-fg">
          <span className="inline-block w-8 h-8 shrink-0 rounded-full border-2 border-brand border-t-transparent animate-spin" />
          <span className="text-base">正在汇总复核结论…</span>
        </div>
      </div>
    )
  }

  // —— 3) 逐张处理（存在分歧→采纳这张；结论一致→确认保留；两者均需确认后才结案）——
  if (compareOpen && cur && cur.ai_review) {
    const rows = aiReviewDiffRows(cur)
    // 左栏四项全列的比对行（含两边一致的项）与其中的分歧项数
    const compareRows = aiReviewCompareRows(cur)
    const diffItems = compareRows.filter((r) => r.diff).length
    const blind = aiReviewBlindSpots(cur)
    // 已复核通过但不含任何瑕疵标签、仍停在待确认：存量人工搁置的图，缺的是一个归档动作
    const shouldHome = aiReviewShouldHome(cur)
    const goto = (delta: number): void => {
      const idx = pending.findIndex((i) => i.id === cur.id)
      const nxt = pending[idx + delta] ?? pending[(idx + delta + pending.length) % pending.length]
      setCurrentId(nxt ? nxt.id : null)
    }
    const onAdopt = async (): Promise<void> => {
      const ok = await adoptAiReview(cur.id)
      if (ok) goto(1)
    }
    // 与本地一致：标签和归属不作改动，仅将本张标记为已复核结案（不再计入待处理、默认复核不再重跑）
    const onConfirm = async (): Promise<void> => {
      await confirmAiReview(cur.id)
      goto(1)
    }
    // 不予采纳：本张保持本地判定不变，仅从本轮队列中剔除（重新复核时会再次提交）
    const onReject = async (): Promise<void> => {
      await rejectAiReview(cur.id)
      goto(1)
    }
    // 归档：标签不变，仅按人数标签将其移出待确认（走 moveIds，写入移动历史可逐条撤销）
    const onHome = async (): Promise<void> => {
      await homeIfCleanParked(cur.id)
      goto(1)
    }
    const pos = pending.findIndex((i) => i.id === cur.id) + 1
    return (
      <>
      <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4">
        <div className="w-full max-w-4xl max-h-[92vh] flex flex-col rounded-xl border border-line bg-panel shadow-2xl fade-in">
          {/* 标题栏：逐张进度 + 文件名 + 复制（三者靠在一起，末尾 ✕ 才靠右） */}
          <div className="px-5 py-3 border-b border-line flex items-center gap-3 shrink-0">
            <span className="text-base font-bold text-fg shrink-0">逐张复核（{pos}/{pending.length}）</span>
            <div className="flex-1 min-w-0 flex items-center gap-1.5">
              <span className="min-w-0 truncate text-sm text-fg2" title={cur.filename}>{cur.filename}</span>
              <button
                className="shrink-0 grid place-items-center w-7 h-7 rounded-md border border-line bg-panel2 text-fg2 hover:text-fg hover:border-fg3 transition-colors cursor-pointer"
                title="复制文件名"
                aria-label="复制文件名"
                onClick={() => void copyFilename(cur.filename)}
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="9" width="11" height="11" rx="2" />
                  <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                </svg>
              </button>
            </div>
            <button className="shrink-0 text-fg3 hover:text-fg text-lg leading-none px-1 cursor-pointer" title="关闭" onClick={() => setCompareOpen(false)}>✕</button>
          </div>
          <div className="px-5 py-4 overflow-y-auto">
            {/* 完整大图：等比缩小居中。高度压到 36vh 是把“图 + 两栏 + 底部按钮”塞进一屏的主代价；
                要看大图不靠把弹窗撑大，点一下图就开全屏原图（用户 10-14：单击双击都要能放大）。
                只挂 onClick、不另挂 onDoubleClick：两个都挂的话双击会先“开”再被第次点击“关”，画面闪。 */}
            <div className="flex justify-center">
              <img
                src={viewSrc(cur)}
                className="max-h-[36vh] max-w-full rounded-lg object-contain ring-1 ring-line bg-panel2 cursor-zoom-in"
                alt={cur.filename}
                draggable={false}
                title="点击查看原图"
                onClick={openZoom}
              />
            </div>
            {/* 左栏：云端复核范围内四项，本地说了什么 / 云端说了什么并排列出 */}
            <div className="mt-3 flex flex-wrap items-stretch gap-3">
              <section className="min-w-[320px] flex-1 rounded-lg border border-line bg-panel2 px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-sm font-bold text-fg">云端复核范围比对</h3>
                  <span className="shrink-0 text-xs tabular-nums text-fg2">{diffItems > 0 ? `${diffItems} 项存在分歧` : '四项结论一致'}</span>
                </div>
                <div className="mt-2 space-y-1">
                  <div className="flex gap-3 text-xs text-fg2">
                    <span className="w-20 shrink-0">检测项</span>
                    <span className="w-24 shrink-0">本地检测</span>
                    <span>云端复核</span>
                  </div>
                  {compareRows.map((r) => (
                    <div key={r.label} className="flex items-center gap-3 text-sm">
                      <span className="w-20 shrink-0 text-fg2">{r.label}</span>
                      <span className="w-24 shrink-0 text-fg">{r.local}</span>
                      <span className={r.diff ? 'font-semibold text-brand' : 'text-fg'}>{r.cloud}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-2.5 border-t border-line pt-2.5 text-sm leading-relaxed text-fg2">
                  {rows.length > 0
                    ? '采纳后上述分歧项按云端结论改判，未标分歧项保持原状。'
                    : shouldHome
                      ? '本张已复核通过且不含瑕疵标签，此前经人工搁置留在待确认；归位后按人数归属归档，标签不作改动。'
                      : '确认后本张结案，标签与归属保持不变。'}
                </div>
                {cur.ai_review.reason && (
                  <div className="mt-1.5 text-sm leading-relaxed text-fg2">云端判定依据：{cur.ai_review.reason}</div>
                )}
              </section>

              {/* 右栏：云端没看过的画质项——只能人工定，所以给足分量 + 红色入口 */}
              {blind.length > 0 && (
                <section className="w-full max-w-[360px] min-w-[280px] shrink-0 basis-[320px] grow rounded-lg border border-bad/30 bg-bad/5 px-4 py-3">
                  <h3 className="text-sm font-bold text-fg">云端不覆盖的画质维度</h3>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {blind.map((d) => (
                      // 文字用 fg 而不是 bad：bad 字 + bad/15 底在两个主题下都只到 3.6:1，14px 看不清（浏览器实测）；
                      // 红色改由描边和底色承担，信号强度不变。
                      <span key={d} className="rounded px-2 py-0.5 text-sm font-semibold text-fg bg-bad/10 border border-bad/40">
                        {DIMENSION_LABELS[d]}
                      </span>
                    ))}
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-fg2">
                    上述维度由<strong className="font-semibold text-fg">本地引擎</strong>判定，云端未参与复核，因此左栏结论一致不代表画质通过。
                  </p>
                  <p className="mt-1 text-sm leading-relaxed text-fg2">
                    结案后本张标记为「人工复审」并置于本栏首位，不再提交云端复核。
                  </p>
                  <button
                    className="btn-danger text-sm px-4 py-2 mt-3 w-full"
                    onClick={() => setVerdictOpen(true)}
                    title="弹出三个选择：合格入交付库（选档）/ 移入废弃库 / 稍后再判定；关它不会关掉逐张复核"
                  >
                    人工裁定本张
                  </button>
                </section>
              )}
            </div>
          </div>
          <div className="px-5 py-4 border-t border-line flex items-center justify-end gap-3 shrink-0">
            <button className="btn text-sm px-4 py-2" onClick={() => goto(-1)} title="看上一张" disabled={pending.length <= 1}>← 上一张</button>
            <button className="btn text-sm px-4 py-2" onClick={() => goto(1)} title="看下一张">下一张 →</button>
            <button className="btn text-sm px-4 py-2" onClick={() => void onReject()} title="不予采纳：保持本地判定不变，本张不计入本轮处理；重新复核时将再次提交">不采纳</button>
            {rows.length > 0 ? (
              <button className="btn-primary text-sm px-4 py-2" onClick={() => void onAdopt()} title="按云端结论更新本张标签（与手动改判等效，可逐条撤销），随后结案">采纳这张</button>
            ) : shouldHome ? (
              <button className="btn-primary text-sm px-4 py-2" onClick={() => void onHome()} title="按人数归属归档并移出待确认（写入移动历史，可撤销）">按人数归位</button>
            ) : (
              <button className="btn-primary text-sm px-4 py-2" onClick={() => void onConfirm()} title="标签与归属均不变动，仅将本张标记为已复核结案">确认保留</button>
            )}
          </div>
        </div>
      </div>
      {/* 人工裁定三选一：压在逐张弹窗之上，关掉/选完都不关主弹窗（用户 10-14） */}
      {verdictOpen && (
        <ManualVerdictDialog
          img={cur}
          onDismiss={() => setVerdictOpen(false)}
          onResolved={() => {
            setVerdictOpen(false)
            // 入档/废弃会把这张移出待确认；先顺位到下一张，避免队列重算那一帧主弹窗空闪一下
            goto(1)
          }}
        />
      )}
      {/* 点图后的全屏原图：z-[80] 压住复核弹窗，点任意处或 Esc 关闭 */}
      {zoomOpen && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/95 p-4 cursor-zoom-out"
          onClick={closeZoom}
          title="点击任意处关闭原图"
        >
          <img src={viewSrc(cur)} className="max-h-full max-w-full object-contain" alt={cur.filename} draggable={false} />
          <span className="absolute bottom-3 left-1/2 -translate-x-1/2 text-sm text-white/70">{cur.filename} · 点击任意处或 Esc 关闭</span>
        </div>
      )}
      </>
    )
  }

  // —— 2) 待确认结论的居中面板（盖内容区、点背景不关，只能选按钮；“稍后处理”收起后由页内复核条重新唤起）
  // 不以 phase==='done' 为条件：重启软件后进度态丢失，但库里的结论仍待确认，入口必须还能把面板打开 ——
  if (pending.length > 0 && !dismissed) {
    return (
      <div className="absolute inset-0 z-[64] flex items-center justify-center bg-black/70 p-4">
        <div className="w-full max-w-xl rounded-xl border border-line bg-panel shadow-2xl fade-in">
          <div className="px-6 py-4 border-b border-line">
            <div className="text-lg font-bold text-fg">云端复核结果待确认</div>
          </div>
          <div className="px-6 py-5 text-base text-fg2 leading-relaxed">
            {aiReview?.total != null ? `本轮复核 ${aiReview.total} 张` : '本栏已完成复核'}
            <div className="mt-2.5 flex flex-wrap items-baseline gap-x-3 tabular-nums text-fg2">
              <span>分歧 <span className="text-xl font-bold text-brand">{diffCount}</span></span>
              <span className="text-fg3">·</span>
              <span>一致 <span className="text-xl font-bold text-brand">{agreeCount}</span></span>
              {homeCount > 0 && <span><span className="text-fg3 mr-3">·</span>待归档 <span className="text-xl font-bold text-brand">{homeCount}</span></span>}
              {!!aiReview?.failCount && <span><span className="text-fg3 mr-3">·</span>判定失败 <span className="text-xl font-bold text-fg2">{aiReview.failCount}</span></span>}
            </div>
            <div className="mt-3 text-sm leading-relaxed text-fg3">全部处理：分歧项按云端结论改判，一致项确认结案，已复核通过者按人数归档；仍含画面模糊/曝光异常者转人工复审并置于本栏首位。所有操作均可逐条撤销。</div>
          </div>
          <div className="px-6 py-4 flex flex-wrap items-center justify-end gap-3 border-t border-line">
            <button className="btn text-sm px-4 py-2" onClick={dismissSummary} title="暂不处理，可经由页顶复核条重新打开">稍后处理</button>
            <button className="btn text-sm px-4 py-2" onClick={() => { setCompareOpen(true); setCurrentId(pending[0].id) }} title="逐项比对本地检测与云端结论后再决定">逐张复核</button>
            <button className="btn-primary text-sm px-4 py-2" onClick={() => void adoptAll()} title={`批量应用 ${pending.length} 张：${diffCount} 张按云端结论改判，其余确认结案或归档（操作可逐条撤销）`}>全部处理 {pending.length} 张</button>
          </div>
        </div>
      </div>
    )
  }

  return null
}
