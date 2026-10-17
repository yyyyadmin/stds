/**
 * 顶栏：导入（单图/多选/文件夹三合一入口）/ 开始筛选（进度条+百分比+已处理数量+停止）/ 视图切换 / 排序 / 导出 / 设置
 * 引擎状态徽章（Python 完整引擎 / Node 基础引擎 / GPU-CPU）
 *
 * 宽度适配（笔记本上曾经把按钮挤成“一行一个字”，原因见下）：中文可以在任意字间断行，
 * 一旦子项允许收缩，按钮就会被压到一列宽。所以：所有项 shrink-0 不许压、整行 flex-wrap 允许换行、
 * 按钮族在 index.css 里统一 whitespace-nowrap；再以 1760px（自定义断点 3xl）为界分两档：
 * 宽屏按原样铺开，窄屏把撤回/清空图库/大图收进「⋯ 更多」、视图只留图标、搜索与排序框变窄。
 */
import { useEffect, useRef, useState } from 'react'
import { useStore, filterByQuery } from '../store'
import type { SortKey } from '../store'
import { membershipName, isVip } from '../../../shared/membership'

/** 三种主区布局。以前的第四种「大图」与双击小图的放大弹窗功能重叠，已合并到右边那个按钮。
 *  icon 给窄屏（<1760）用：整组只留图标不放文字，能省 80px 左右。用内联 SVG 而不是 ▦☰ 这类字符——
 *  符号字符在部分 Windows 中文字体里会缺字变成方框。 */
const VIEWS: Array<{ m: 'grid' | 'list' | 'masonry'; label: string; key: string; icon: JSX.Element }> = [
  {
    m: 'grid',
    label: '网格',
    key: '1',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </svg>
    )
  },
  {
    m: 'list',
    label: '列表',
    key: '2',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <line x1="8" y1="6" x2="21" y2="6" />
        <line x1="8" y1="12" x2="21" y2="12" />
        <line x1="8" y1="18" x2="21" y2="18" />
        <line x1="3.5" y1="6" x2="3.5" y2="6" />
        <line x1="3.5" y1="12" x2="3.5" y2="12" />
        <line x1="3.5" y1="18" x2="3.5" y2="18" />
      </svg>
    )
  },
  {
    m: 'masonry',
    label: '瀑布流',
    key: '3',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <rect x="3" y="3" width="7" height="10" rx="1" />
        <rect x="14" y="3" width="7" height="6" rx="1" />
        <rect x="3" y="16" width="7" height="5" rx="1" />
        <rect x="14" y="12" width="7" height="9" rx="1" />
      </svg>
    )
  }
]

/** 把剩余秒数格式化为“预计还需 ~X”文案 */
function fmtRemain(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '即将完成…'
  if (sec < 60) return `预计还需 ~${Math.ceil(sec)} 秒`
  return `预计还需 ~${Math.round(sec / 60)} 分钟`
}

export default function TopBar(): JSX.Element {
  const s = useStore()
  const p = s.scanProgress
  const running = p?.running
  const pct = p && p.total > 0 ? Math.round((p.done / p.total) * 100) : 0
  const isInit = p?.phase === 'init'
  const isIndeterminate = isInit || p?.phase === 'dup-cluster'
  // 还没跑过 AI 的张数（主进程 categoryCounts 算好的 pending，已剔除废弃库与失败图）：
  // 它们不为 0 就不许报“本次筛选完成”（用户 2026-10-15 指出：筛完又导了新图，那句绿字就成了假话）
  const pendingN = s.counts.pending ?? 0
  // 每秒重渲染一次，驱动倒计时刷新（仅运行中计时，停止即停）
  const [now, setNow] = useState(() => Date.now())
  // 清空图库的确认弹窗开关：风险操作必须用户在应用内弹窗上点「确认清空」才执行。
  // 不用 window.confirm：Electron 长期不支持原生对话框（官方曾标注 will not be supported，
  // 不同版本下要么弹不出要么返回 undefined 让守卫形同虚设），行为不可依赖；应用内弹窗还能跟随主题。
  // SettingsDialog 里的重扫 confirm 同样有这问题，待后续一并换
  const [confirmClear, setConfirmClear] = useState(false)
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running])
  // 扫描阶段：按已完成速率估算剩余时间
  const scanEta =
    p && p.phase === 'scanning' && p.startedAt && p.done > 0
      ? fmtRemain(((now - p.startedAt) / 1000 / p.done) * (p.total - p.done))
      : ''
  // 聚类阶段：无确定百分比，按图量粗估一个倒计时（实际完成即停）
  const dupEta =
    p && p.phase === 'dup-cluster' && p.phaseStartedAt
      ? (() => {
          const est = Math.min(240, Math.max(8, (p.total || 0) * 0.04))
          return fmtRemain(est - (now - p.phaseStartedAt!) / 1000)
        })()
      : ''
  const auth = s.auth
  const user = auth.user
  const isMember = auth.loggedIn && isVip(user)
  // 身份名单一取数口（后端 membership.is_vip / name 优先，见 shared/membership.ts）；积分数字不再上顶栏（用户 10-15 定）
  const memberLabel = membershipName(user)
  const dark = s.settings.theme === 'dark'
  // 导入菜单：一个入口按钮，弹开后选“图片（可多选）”或“文件夹”
  const [importMenu, setImportMenu] = useState(false)
  const importRef = useRef<HTMLDivElement>(null)
  // 「⋯ 更多」菜单：窄屏（<1760）时把低频动作收进去，腾出顶栏横向空间
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!moreOpen) return
    const onDown = (e: MouseEvent): void => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [moreOpen])
  useEffect(() => {
    if (!importMenu) return
    const onDown = (e: MouseEvent): void => {
      if (importRef.current && !importRef.current.contains(e.target as Node)) setImportMenu(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setImportMenu(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [importMenu])

  // 低频动作（撤回 / 清空图库 / 看大图）：大屏（≥1760）行内铺开，笔记本宽度收进「⋯ 更多」。
  // 描述只写一份，行内按钮和菜单行都从它生成，禁用条件与提示不会两边漂移。
  const undoSnap = s.undoSnapshots[s.undoSnapshots.length - 1]
  const secondary = [
    {
      key: 'undo',
      label: `↩ 撤回${undoSnap ? ` (${undoSnap.ids.length}张)` : ''}`,
      title:
        s.undoSnapshots.length === 0
          ? '暂无可撤回的移动操作（移动过图片后这里会变亮）'
          : `点击撤回最近一次移动（共 ${s.undoSnapshots.length} 步可依次撤回），会提示撤回几张、移回哪里`,
      disabled: s.undoSnapshots.length === 0,
      run: (): void => {
        void s.undoMove()
      },
      cls: 'text-xs ' + (s.undoSnapshots.length === 0 ? 'btn border-line text-gray-500 opacity-50 cursor-not-allowed' : 'btn')
    },
    {
      key: 'clear',
      label: '清空图库',
      title: '删光软件里的导入记录与修正记录（不会删除磁盘上的原始照片），导入错了想重新来时用',
      disabled: running || (s.counts.all ?? 0) === 0,
      run: (): void => setConfirmClear(true),
      cls: 'btn-danger text-xs'
    }
  ]
  // 「看大图」大屏仍摆在视图组旁边（老用户肌肉记忆），窄屏只出现在「⋯ 更多」里
  const largeView = {
    label: '大图',
    title: '看大图（快捷键 4）：从当前选中的第一张开始，没选中就从列表第一张；← → 翻页，跟双击小图是同一个窗口',
    disabled: !s.images.length,
    run: (): void => s.openLargePreview()
  }

  return (
    <header className="shrink-0 bg-panel border-b border-line px-3 py-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
      <div className="relative shrink-0" ref={importRef}>
        <button
          className="btn"
          data-tour="import"
          disabled={!!s.importProgress}
          onClick={() => setImportMenu((v) => !v)}
          title="支持单张、多选图片，也支持整个文件夹（或直接把照片拖进窗口）"
        >
          {s.importProgress ? `导入中 ${s.importProgress.done}/${s.importProgress.total}` : '导入照片 ▾'}
        </button>
        {importMenu && (
          <div className="absolute left-0 top-full mt-1 z-40 w-64 rounded-md border border-line bg-panel shadow-xl py-1">
            <button
              className="w-full text-left px-3 py-2 text-sm hover:bg-panel2 transition-colors"
              onClick={() => {
                setImportMenu(false)
                void s.pickAndImportImages()
              }}
            >
              选择图片…
              <span className="block text-[11px] text-fg3 mt-0.5">单张或 Ctrl/Shift 多选</span>
            </button>
            <button
              className="w-full text-left px-3 py-2 text-sm hover:bg-panel2 transition-colors"
              onClick={() => {
                setImportMenu(false)
                void s.pickAndImport()
              }}
            >
              选择文件夹…
              <span className="block text-[11px] text-fg3 mt-0.5">递归导入全部照片</span>
            </button>
            {/* 格式推荐：按检测可靠性分三档（不支持的格式导入时会自动过滤，不入库） */}
            <div className="mt-1 border-t border-line px-3 py-2 text-[11px] leading-relaxed">
              <div className="text-good mb-0.5">✓ 推荐（检测最稳）</div>
              <div className="text-fg2">JPG · JPEG · PNG · TIFF · BMP · WebP</div>
              <div className="text-brand mt-1.5 mb-0.5">✓ 完整支持</div>
              <div className="text-fg2">相机 RAW（CR2/CR3/NEF/ARW/DNG…）· iPhone HEIC · AVIF / JXL</div>
              <div className="text-fg3 mt-1.5">设计/矢量/医疗格式（PSD·AI·SVG·ICO…）非照片，不支持，导入时自动跳过</div>
            </div>
          </div>
        )}
      </div>
      {s.importProgress && (
        <button className="btn-danger shrink-0" title="取消导入（已导入的记录保留）" onClick={() => void window.api.importCancel()}>
          取消导入
        </button>
      )}
      {!running ? (
        <button
          className={'btn-primary shrink-0' + (pendingN > 0 && !s.engineBusy && !s.importProgress && !s.thumbsProgress ? ' btn-nudge' : '')}
          data-tour="scan"
          onClick={() => void s.startScan()}
          disabled={s.engineBusy || !!s.importProgress || !!s.thumbsProgress}
          title={
            s.importProgress || s.thumbsProgress
              ? '图库导入/缩略图生成中，完成后可开始筛选'
              : pendingN > 0
                ? `有 ${pendingN} 张还没筛（含刚拖进来的），点这里只补跑这批：已筛过的不重跑、也不重复扣次数`
                : undefined
          }
        >
          {s.importProgress
            ? `导入中 ${s.importProgress.done}/${s.importProgress.total}…`
            : s.thumbsProgress
              ? `生成缩略图 ${s.thumbsProgress.done}/${s.thumbsProgress.total}…`
              : s.engineBusy
                ? '引擎启动中…'
                : '开始筛选'}
        </button>
      ) : (
        <button className="btn-danger shrink-0" onClick={() => void s.stopScan()}>
          停止
        </button>
      )}
      {/* 图库张数 + 失败张数：大屏一行并排（xl 及以上，维持原样），小屏叠成两行省横向空间；无失败时只剩图库一行 */}
      {(!running || (s.counts.error ?? 0) > 0) && (
        <div className="flex flex-col items-start gap-1 shrink-0 xl:flex-row xl:items-center xl:gap-2">
          {!running && (
            <span
              className="chip hidden 3xl:inline-flex bg-panel2 text-fg2 border border-line tabular-nums whitespace-nowrap"
              title="当前图库共导入多少张照片（窄屏不占顶栏位置，左侧栏里一样看得到总数）"
            >
              图库 {s.counts.all ?? 0} 张
            </span>
          )}
          {/* 失败照片徒章：本轮筛选没跑成（无法解码/文件损坏等）的张数，常驻至 error 归零；点开定位并重试 */}
          {(s.counts.error ?? 0) > 0 && (
            <button
              className="chip bg-bad/15 text-bad border border-bad/40 tabular-nums whitespace-nowrap hover:bg-bad/25 transition-colors"
              title={`有 ${s.counts.error} 张没跑成（读不出/已移动删除），点开查看并重试`}
              onClick={() => void useStore.setState({ showFailedImages: true })}
            >
              ⚠ {s.counts.error} 张没跑成
            </button>
          )}
        </div>
      )}
      {/* 收尾状态（用户 2026-10-15）：进度条走完了就不该继续杵在顶栏占位置，换成一句绿色的「本次筛选完成」。
          但只要库里还有没筛的图，这句就得改口成蓝色的“新导入 N 张还没筛选”（蓝=要你动手，跟开始筛选同色）；
          中途停止/出错例外：那里留着进度条，因为当时真正要说的是“停在半截，下次会自动续跑”；
          total 为 0 是“还没筛过”的初始态（刚开软件时主进程回传的就是它），不能报完成。 */}
      {!running && pendingN > 0 && p?.phase !== 'stopped' && p?.phase !== 'error' ? (
        <span
          className="shrink-0 text-xs font-medium text-brand whitespace-nowrap tabular-nums"
          title={`还有 ${pendingN} 张没跑过 AI（刚拖进来的也算）。点左边「开始筛选」只补跑这批，已筛过的不重跑、也不重复扣次数`}
        >
          新导入 {pendingN} 张还没筛选，点「开始筛选」
        </span>
      ) : !running && p?.phase === 'done' && p.total > 0 ? (
        <span
          className="shrink-0 text-xs font-medium text-good whitespace-nowrap"
          title={`本轮 ${p.done}/${p.total} 张已筛完${p.current ? `，最后一张：${p.current}` : ''}（新导入照片后这句会改成提醒你去筛）`}
        >
          ✓ 本次筛选完成
        </span>
      ) : (running || (p && p.total > 0)) ? (
        <div className="flex items-center gap-2 min-w-0 flex-1 max-w-md" title={p?.message || ''}>
          {isIndeterminate ? (
            <>
              {/* 无确定百分比的阶段（引擎启动/加载模型、重复聚类）：spinner + 可见文案 + 左右滑动不确定进度条，避免停在 0%/100% 像卡死 */}
              <span className="inline-block w-3.5 h-3.5 shrink-0 rounded-full border-2 border-brand border-t-transparent animate-spin" />
              <span className="text-xs text-fg2 whitespace-nowrap">{isInit ? p?.message || '正在启动 AI 引擎…' : '重复/连拍 聚类整理中…'}</span>
              {!isInit && dupEta && <span className="text-xs text-fg3 whitespace-nowrap tabular-nums">{dupEta}</span>}
              <div className="flex-1 h-2 bg-panel2 rounded-full overflow-hidden min-w-24">
                <div className="h-full w-1/4 rounded-full bg-brand bar-indeterminate" />
              </div>
            </>
          ) : (
            <>
              <div className="flex-1 h-2 bg-panel2 rounded-full overflow-hidden min-w-24">
                <div
                  className={
                    'h-full rounded-full transition-all duration-300 ' +
                    (p?.phase === 'done' ? 'bg-good' : p?.phase === 'stopped' || p?.phase === 'error' ? 'bg-bad' : 'bg-brand')
                  }
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-xs text-gray-400 whitespace-nowrap tabular-nums">
                {`${pct}% · ${p?.done || 0}/${p?.total || 0}`}
              </span>
              {scanEta && <span className="text-xs text-brand whitespace-nowrap tabular-nums hidden md:inline">{scanEta}</span>}
              <span className="text-xs text-gray-500 truncate hidden lg:inline">{p?.current}</span>
            </>
          )}
        </div>
      ) : null}
      {!running && p?.message && !p.total && <span className="text-xs text-gray-500 truncate flex-1">{p.message}</span>}
      {/* 弹性占位：把右侧那组（复审/搜索/视图/导出/账号）顶到窗口右边。
          以前只在 xl 以上开，窄屏会出现「整排靠左、右边空一大块」的失衡，改成一直开：
          真装不下时它的假想宽度是 0，不影响换行判定。 */}
      <div className="flex-1" />

      {/* AI 复审开关（会员专属）：放在筛选目录前。非会员灰锁按钮→会员中心；会员真开关（首次开启弹授权） */}
      {(() => {
        const enabled = !!s.settings.aiReviewEnabled
        // 今日剩余复审张数：只在“正在跑”时用进度里的实时值（它逐批刷新，比再发一次 /me 及时）；
        // 跑完就改回登录态里 user_info 的 ai_review.remaining——那是后端记账的权威值，收尾时已重拉过。
        // 上一版不分在跑/已停：进度对象跑完并不清空，于是一整轮后顶栏永远拿着进度里那个数，
        // 后端实际扣了多少再也上不了屏（用户 10-15：“复审完顶部今日额度没扣除”）。
        const live = s.aiReview?.running && s.aiReview.dailyLimit > 0 ? Math.max(0, s.aiReview.dailyLimit - s.aiReview.usedToday) : null
        const remaining = live ?? user?.ai_review?.remaining ?? null
        const cls =
          'inline-flex items-center gap-1 shrink-0 rounded-md border px-2 py-1 text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ' +
          (!isMember
            ? 'border-line bg-panel2 text-fg3 hover:text-fg2'
            : enabled
              ? 'border-good/50 bg-good/10 text-good'
              : 'border-line bg-panel2 text-fg2 hover:border-fg3')
        return (
          <button
            className={cls}
            title={
              !isMember
                ? s.auth.loggedIn
                  ? 'AI 复审为会员专属功能，点击了解会员'
                  : 'AI 复审为会员专属功能：未登录看不到套餐列表，点这里直接扫码问客服怎么开通'
                : enabled
                  ? `AI 复审已开启：分类完成后自动将「待确认」照片提交云端复核，仅生成结论，经确认后方写回判定${remaining != null ? `；今日额度剩 ${remaining} 张` : ''}`
                  : `开启 AI 复审：分类完成后自动将「待确认」照片提交云端模型二次核验，仅生成结论，经确认后方写回判定${remaining != null ? `；今日额度剩 ${remaining} 张` : ''}`
            }
            onClick={() => {
              if (isMember) s.toggleAiReview()
              // 未登录：会员中心里根本没摆套餐（用户 2026-10-15 定），把他丢过去只能看到一句“去登录”，
              // 想当场问清怎么开通没有出路；已登录：还是进会员中心看价目表，点「开通」才弹码。
              else if (!s.auth.loggedIn) s.openContactQr()
              else useStore.setState({ showMember: true })
            }}
          >
            {isMember && (
              <span className={'inline-block w-7 h-3.5 rounded-full transition-colors ' + (enabled ? 'bg-good' : 'bg-line')}>
                <span className={'block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ' + (enabled ? 'translate-x-3.5' : 'translate-x-0')} />
              </span>
            )}
            {isMember ? (
              <>
                AI 复审
                {/* 窄屏不再把「今日剩 N 张」摊在按钮上（顶栏宽度不够）：数字挪进鼠标悬停提示 */}
                {remaining != null && (
                  <span className="hidden 3xl:inline ml-0.5 font-normal text-fg3 tabular-nums">· 今日额度剩 {remaining} 张</span>
                )}
              </>
            ) : (
              'AI 复审 🔒'
            )}
          </button>
        )
      })()}

      {/* 顶部非阻塞进度小字：复核在后台跑且用户不在本轮作用域页（待确认/瑕疵片）时显示，切走不遮挡、可点中止；
          停在该作用域页时由页内独占弹窗接管（Task9），这里不重复显示 */}
      {s.aiReview?.running && s.activeCategory !== (s.aiReview?.scope ?? 'review') && (
        <div className="inline-flex items-center gap-2 shrink-0 text-xs whitespace-nowrap">
          <span className="inline-block w-3 h-3 shrink-0 rounded-full border-2 border-brand border-t-transparent animate-spin" />
          <span className="text-fg2 tabular-nums">
            云端复核中 {s.aiReview.done}/{s.aiReview.total}
            {s.aiReview.current ? ` · ${s.aiReview.current}` : ''}
          </span>
          <button className="btn text-xs py-0.5" title="中止复核：在当前张停止，已生成的结论保留" onClick={() => void s.stopAiReview()}>
            停止
          </button>
        </div>
      )}

      {/* 当前筛选目录：仅当本次导入来自“选择/拖入目录”时显示（纯选照片不显示）；
          窄屏没地方摆一条路径，收进下面的「⋯ 更多」里给一行完整显示 */}
      {s.settings.lastImportDir && (
        <span
          className="inline-flex items-center shrink-0 max-w-[200px] px-2 py-1 rounded-md text-xs bg-panel2 text-fg2 border border-line max-3xl:hidden"
          title={`当前筛选目录：${s.settings.lastImportDir}`}
        >
          <span className="shrink-0">📂 当前筛选目录：</span>
          <span className="truncate min-w-0">{s.settings.lastImportDir}</span>
        </span>
      )}

      {/* 次要操作行内版（只≥1760 的宽度才摆得开）：窄屏时整组隐藏，改由下面的「⋯ 更多」承载 */}
      <div className="hidden 3xl:flex items-center gap-x-2 shrink-0">
        {secondary.map((a) => (
          <button key={a.key} className={a.cls} title={a.title} disabled={a.disabled} onClick={a.run}>
            {a.label}
          </button>
        ))}
      </div>

      {/* 「⋯ 更多」：笔记本 / 小屏宽度下收纳撤回、清空图库、看大图这几个低频动作，
          菜单靠右展开，免得被窗口右边缘裁掉。 */}
      <div className="relative shrink-0 3xl:hidden" ref={moreRef}>
        <button
          className={'btn text-xs ' + (moreOpen ? 'bg-line' : '')}
          title="更多操作：撤回 / 清空图库 / 看大图"
          onClick={() => setMoreOpen((v) => !v)}
        >
          ⋯ 更多
        </button>
        {moreOpen && (
          <div className="absolute right-0 top-full mt-1 z-40 w-64 rounded-md border border-line bg-panel shadow-xl py-1">
            {[...secondary, { key: 'large', label: largeView.label, title: largeView.title, disabled: largeView.disabled, run: largeView.run }].map((a) => (
              <button
                key={a.key}
                className="w-full text-left px-3 py-2 text-sm hover:bg-panel2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                title={a.title}
                disabled={a.disabled}
                onClick={() => {
                  setMoreOpen(false)
                  a.run()
                }}
              >
                {a.label}
              </button>
            ))}
            {s.settings.lastImportDir && (
              <div className="mt-1 border-t border-line px-3 py-2 text-[11px]">
                <div className="text-fg3 mb-0.5">当前筛选目录</div>
                <div className="break-all leading-relaxed text-fg2" title={s.settings.lastImportDir}>
                  {s.settings.lastImportDir}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="relative flex items-center shrink-0">
        <input
          className="input text-xs w-24 xl:w-28 3xl:w-40 pr-5"
          placeholder="搜文件名"
          title="按文件名过滤当前相册（只影响显示，不改库里的分类与标签）。可以一次粘多个名字，用空格、逗号或换行分隔——比如从复查清单里整段粘过来。Esc 清空。"
          value={s.query}
          onChange={(e) => s.setQuery(e.target.value)}
          onPaste={(e) => {
            // 单行 input 粘多行文本时浏览器会把换行直接去掉，名字会粘成一串连着的字串→一个也搜不到，
            // 所以粘贴带换行的清单时必须自己把换行换成空格
            const text = e.clipboardData.getData('text')
            if (/[\r\n]/.test(text)) {
              e.preventDefault()
              s.setQuery((s.query + ' ' + text.replace(/[\r\n]+/g, ' ')).trim())
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') s.setQuery('')
          }}
        />
        {!!s.query && (
          <button
            className="absolute right-1 top-1/2 -translate-y-1/2 px-1 text-xs text-fg3 hover:text-fg"
            title="清除搜索（或按 Esc）"
            onClick={() => s.setQuery('')}
          >
            ✕
          </button>
        )}
      </div>

      {!!s.query.trim() && (
        <span className="text-xs text-fg3 whitespace-nowrap shrink-0" title="当前相册里命中的张数 / 本相册总张数">
          命中 {filterByQuery(s.images, s.query).length}/{s.images.length}
        </span>
      )}

      {/* 窄屏只给 96px，选项文案因此压短（完整解释走 title 鼠标悬停） */}
      <select
        className="input text-xs w-24 3xl:w-28 shrink-0"
        title="排序方式。最新在前 = 按最近移动/导入的时间；置信度↑ = 把 AI 最没把握的排前面，优先人工抽查"
        value={s.sortKey}
        onChange={(e) => s.setSort(e.target.value as SortKey)}
      >
        <option value="default">默认顺序</option>
        <option value="name">按文件名</option>
        <option value="name-desc">文件名倒序</option>
        <option value="conf-asc">置信度↑ 抽查</option>
        <option value="conf-desc">置信度↓</option>
        <option value="time">最新在前</option>
      </select>

      <div className="flex items-center shrink-0 border border-line rounded-md overflow-hidden">
        {VIEWS.map((v) => (
          <button
            key={v.m}
            className={
              'inline-flex items-center px-2 py-1 text-xs border-r border-line last:border-r-0 transition-colors ' +
              (s.viewMode === v.m ? 'bg-brand text-white' : 'bg-panel2 hover:bg-line text-gray-400')
            }
            onClick={() => void s.setViewMode(v.m)}
            title={`${v.label}视图（快捷键 ${v.key}）`}
          >
            <span className="hidden 3xl:inline">{v.label}</span>
            <span className="3xl:hidden">{v.icon}</span>
          </button>
        ))}
      </div>

      {/* 「大图」不再是一种布局，而是一个动作：直接打开与双击小图完全相同的放大弹窗。
          两套“大图”各带一套操作太难记，而且原大图视图里的图不如弹窗清楚（弹窗会加载原图）。
          仍放在视图组旁边，保留老用户“右上角切大图”的肌肉记忆（快捷键 4 也照旧）。 */}
      <button
        className="hidden 3xl:inline-block shrink-0 px-2 py-1 text-xs bg-panel2 hover:bg-line text-gray-400 border border-line rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-panel2"
        onClick={largeView.run}
        disabled={largeView.disabled}
        title={largeView.title}
      >
        {largeView.label}
      </button>

      <button
        className="btn-primary shrink-0 inline-flex items-center gap-1.5 disabled:opacity-45 disabled:cursor-not-allowed disabled:hover:bg-brand"
        data-tour="export"
        onClick={() => void useStore.setState({ showExport: true })}
        disabled={s.counts.all === 0}
        title="导出交付：把选中的分类导出到指定文件夹"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        导出交付
      </button>
      <button className="btn-ghost shrink-0 text-xl leading-none px-2" title="设置" onClick={() => void useStore.setState({ showSettings: true })}>
        ⚙️
      </button>
      {/* AI 引擎状态徽章（三态动效）：
          扫描中 = 青→蓝→紫流动渐变 + 外发光呼吸 + 斜光扫过 + 均衡器跳动条（「正在使用 AI 引擎」）
          启动中 = 琥珀脉冲；空闲就绪 = 青绿柔和呼吸。
          用户 10-18 拍板：“运行中”只许完整 Python 引擎戴——降级成 node 基础引擎的机器
          常显黄色“引擎异常”（扫描动画照跑，但文字/颜色如实报病，不能让人误以为全功能在干活）。 */}
      <span
        className={
          'chip shrink-0 !gap-1.5 !border-0 !py-1.5 ' +
          (s.engineType !== 'python' && s.engineType !== 'none'
            ? 'engine-busy-glow bg-yellow-900/60 text-yellow-200 !px-2.5 !text-[12px]'
            : running
              ? 'engine-live engine-glow engine-sheen text-white !px-3 !text-[13px] font-bold tracking-wide'
              : s.engineBusy
                ? 'engine-busy-glow bg-yellow-900/60 text-yellow-200 !px-2.5 !text-[12px]'
                : 'engine-ready-glow bg-emerald-900/60 text-emerald-200 !px-2.5 !text-[12px]')
        }
        title={
          s.engineType === 'node'
            ? '完整 AI 引擎没能启动，已降级为基础引擎：只会查重复/模糊/曝光/黑白，人物分类和闭眼、半截头这些全不会。Mac 客户按安装教程“常见问题”里那条处理，或联系提供方'
            : s.toast?.msg ||
              (running
                ? 'AI 引擎正在实时处理照片…'
                : s.engineBusy || s.engineType === 'none'
                  ? 'AI 引擎启动中…'
                  : 'AI 引擎已就绪（后台运行，详见设置）')
        }
      >
        {running ? (
          <span className="engine-eq inline-flex items-end h-[11px] leading-none" aria-hidden>
            <i /><i /><i />
          </span>
        ) : (
          <span
            className={
              'w-1.5 h-1.5 rounded-full ' +
              (s.engineType !== 'python'
                ? 'bg-yellow-400 animate-pulse'
                : s.engineBusy
                  ? 'bg-yellow-400 animate-pulse'
                  : 'bg-emerald-400')
            }
          />
        )}
        {/* 徽章只说状态：「AI 引擎」四个字靠鼠标提示讲（提示里本来就有），窄屏不必再让位 */}
        <span>
          {s.engineType === 'node' ? '引擎异常' : s.engineType === 'none' ? '启动中' : s.engineBusy ? '启动中' : '运行中'}
        </span>
      </span>

      {/* 主题切换入口（用户拍板 2026-10-14：默认就是简白主题，顶栏不摆月亮）。
          刻意不是直接删，而是只在“当前是黑主题”时才显示：
          主题是会存库的（setTheme → saveSettings），而设置弹窗里没有第二个主题入口，
          彻底删掉会把以前手滑切过酷黑的机器永久锁在黑主题。
          要彻底隐藏：把下面的 `dark && (` 改成 `false && (`；要恢复常显：去掉这个条件即可。 */}
      {dark && (
        <button
          className="btn-ghost shrink-0 text-fg2 text-xl leading-none px-2"
          title="切换到简白主题"
          onClick={() => void s.toggleTheme()}
        >
          ☀️
        </button>
      )}

      {/* 会员身份 / 登录入口（2026-10-15 起：登录后只摆身份名不摆积分数，积分去会员中心看）。
          名字是后端下发什么就显示什么；普通会员/未登录走灰底，付费身份金色+皇冠 */}
      {auth.loggedIn ? (
        <button
          data-tour="account"
          className={
            'inline-flex items-center gap-1.5 shrink-0 rounded-md border px-2.5 py-1 text-base font-semibold cursor-pointer transition-colors ' +
            (isMember ? 'bg-warn/15 text-warn border-warn/40' : 'bg-panel2 text-fg2 border-line hover:bg-line')
          }
          title="打开会员中心：查看积分、开通会员"
          onClick={() => useStore.setState({ showMember: true })}
        >
          {memberLabel.paid && <span className="text-lg leading-none">👑</span>}
          <span className="whitespace-nowrap">{memberLabel.text}</span>
        </button>
      ) : (
        <button className="btn-primary shrink-0 text-sm py-1.5" data-tour="account" onClick={() => useStore.setState({ showLogin: true })}>
          登录 / 注册
        </button>
      )}

      {/* 清空图库二次确认：点遮罩/取消都是放弃，只有「确认清空」才调 clearLibraryAll */}
      {confirmClear && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setConfirmClear(false)}>
          <div className="w-[420px] rounded-xl border border-line bg-panel p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="text-base font-bold text-fg">确认清空图库？</div>
            <div className="mt-2 text-sm leading-relaxed text-fg2">
              将删除软件内 {(s.counts.all ?? 0).toLocaleString()} 条图片记录与全部修正/学习记录，
              磁盘上的原始照片文件不会被删除。清空后需重新导入并重新筛选，此操作不可撤回。
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn text-sm" onClick={() => setConfirmClear(false)}>取消</button>
              <button
                className="btn-danger text-sm px-4 whitespace-nowrap"
                onClick={() => {
                  setConfirmClear(false)
                  void s.clearLibraryAll()
                }}
              >
                确认清空
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  )
}
