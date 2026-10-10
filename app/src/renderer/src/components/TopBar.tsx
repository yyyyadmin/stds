/**
 * 顶栏：导入（单图/多选/文件夹三合一入口）/ 开始筛选（进度条+百分比+已处理数量+停止）/ 视图切换 / 排序 / 导出 / 设置
 * 引擎状态徽章（Python 完整引擎 / Node 基础引擎 / GPU-CPU）
 */
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import type { SortKey } from '../store'

const VIEWS: Array<{ m: 'grid' | 'list' | 'masonry' | 'large'; label: string; key: string }> = [
  { m: 'grid', label: '网格', key: '1' },
  { m: 'list', label: '列表', key: '2' },
  { m: 'masonry', label: '瀑布流', key: '3' },
  { m: 'large', label: '大图', key: '4' }
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
  // 每秒重渲染一次，驱动倒计时刷新（仅运行中计时，停止即停）
  const [now, setNow] = useState(() => Date.now())
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
  const sceneLabels: Record<string, string> = { wedding: '婚礼跟拍', studio: '棚拍写真', kids: '儿童抓拍', default: '通用' }
  const auth = s.auth
  const user = auth.user
  const isMember = auth.loggedIn && (user?.membership.level || 'free') !== 'free' && !user?.membership.is_expired
  const balance = user?.points.balance ?? 0
  const dark = s.settings.theme === 'dark'
  // 导入菜单：一个入口按钮，弹开后选“图片（可多选）”或“文件夹”
  const [importMenu, setImportMenu] = useState(false)
  const importRef = useRef<HTMLDivElement>(null)
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

  return (
    <header className="shrink-0 bg-panel border-b border-line px-3 py-2 flex items-center gap-2 text-sm">
      <div className="font-bold text-fg mr-1 whitespace-nowrap">
        筛图大师 <span className="text-[10px] font-normal text-fg3">v2.0</span>
      </div>
      <div className="relative" ref={importRef}>
        <button
          className="btn"
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
        <button className="btn-danger" title="取消导入（已导入的记录保留）" onClick={() => void window.api.importCancel()}>
          取消导入
        </button>
      )}
      {!running ? (
        <button className="btn-primary" onClick={() => void s.startScan()} disabled={s.engineBusy}>
          {s.engineBusy ? '引擎启动中…' : '开始筛选'}
        </button>
      ) : (
        <button className="btn-danger" onClick={() => void s.stopScan()}>
          停止
        </button>
      )}
      {!running && (
        <span className="chip bg-panel2 text-fg2 border border-line tabular-nums whitespace-nowrap" title="当前图库共导入多少张照片">
          图库 {s.counts.all ?? 0} 张
        </span>
      )}
      {(running || (p && p.total > 0)) && (
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
      )}
      {!running && p?.message && !p.total && <span className="text-xs text-gray-500 truncate flex-1">{p.message}</span>}
      <div className="flex-1" />

      {/* 当前筛选目录：仅当本次导入来自“选择/拖入目录”时显示（纯选照片不显示） */}
      {s.settings.lastImportDir && (
        <span
          className="inline-flex items-center max-w-[280px] px-2 py-1 rounded-md text-xs bg-panel2 text-fg2 border border-line"
          title={`当前筛选目录：${s.settings.lastImportDir}`}
        >
          <span className="shrink-0">📂 当前筛选目录：</span>
          <span className="truncate min-w-0">{s.settings.lastImportDir}</span>
        </span>
      )}

      {/* 撤回移动：仅在有可撤回的移动操作时高亮可点 */}
      <button
        className={
          'text-xs whitespace-nowrap ' +
          (s.undoSnapshots.length === 0
            ? 'btn border-line text-gray-500 opacity-50 cursor-not-allowed'
            : 'btn')
        }
        title={
          s.undoSnapshots.length === 0
            ? '暂无可撤回的移动操作（移动过图片后这里会变亮）'
            : `点击撤回最近一次移动（共 ${s.undoSnapshots.length} 步可依次撤回），会提示撤回几张、移回哪里`
        }
        onClick={() => void s.undoMove()}
        disabled={s.undoSnapshots.length === 0}
      >
        ↩ 撤回{(() => {
          const l = s.undoSnapshots[s.undoSnapshots.length - 1]
          return l ? ` (${l.ids.length}张)` : ''
        })()}
      </button>

      <button
        className="btn-danger text-xs whitespace-nowrap"
        title="删光软件里的导入记录与修正记录（不会删除磁盘上的原始照片），导入错了想重新来时用"
        onClick={() => void s.clearLibraryAll()}
        disabled={running || (s.counts.all ?? 0) === 0}
      >
        清空图库
      </button>

      <select
        className="input text-xs w-24"
        title="场景预设：针对婚礼/棚拍/儿童摄影等场景，对部分维度的判定阈值做针对性微调（在设置→高级设置里可看具体覆盖项）"
        value={s.settings.scene}
        onChange={(e) => void s.saveSettings({ scene: e.target.value }, true)}
      >
        {Object.entries(sceneLabels).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>

      <select
        className="input text-xs w-28"
        title="排序方式"
        value={s.sortKey}
        onChange={(e) => s.setSort(e.target.value as SortKey)}
      >
        <option value="default">默认顺序</option>
        <option value="name">按文件名</option>
        <option value="name-desc">文件名倒序</option>
        <option value="conf-asc">置信度↑（优先抽查）</option>
        <option value="conf-desc">置信度↓</option>
        <option value="time">按导入时间</option>
      </select>

      <div className="flex items-center border border-line rounded-md overflow-hidden">
        {VIEWS.map((v) => (
          <button
            key={v.m}
            className={
              'px-2 py-1 text-xs border-r border-line last:border-r-0 transition-colors ' +
              (s.viewMode === v.m ? 'bg-brand text-white' : 'bg-panel2 hover:bg-line text-gray-400')
            }
            onClick={() => void s.setViewMode(v.m)}
            title={`${v.label}视图（快捷键 ${v.key}）`}
          >
            {v.label}
          </button>
        ))}
      </div>

      <button className="btn" onClick={() => void useStore.setState({ showExport: true })} disabled={s.counts.all === 0}>
        导出交付
      </button>
      <button className="btn-ghost text-xl leading-none px-2" title="设置" onClick={() => void useStore.setState({ showSettings: true })}>
        ⚙️
      </button>
      <span
        className={
          'chip ' +
          (s.engineBusy
            ? 'bg-yellow-900/60 text-yellow-200'
            : 'bg-emerald-900/60 text-emerald-200')
        }
        title={s.toast?.msg || 'AI 引擎状态：' + (s.engineBusy ? '启动中' : '引擎已在后台就绪（见设置）')}
      >
        <span className={'w-1.5 h-1.5 rounded-full ' + (s.engineBusy ? 'bg-yellow-400' : 'bg-emerald-400')} />
        AI引擎
      </span>

      {/* 主题切换 */}
      <button
        className="btn-ghost text-fg2 text-xl leading-none px-2"
        title={dark ? '切换到简白主题' : '切换到暗夜主题'}
        onClick={() => void s.toggleTheme()}
      >
        {dark ? '☀️' : '🌙'}
      </button>

      {/* 积分 / 会员 / 登录入口 */}
      {auth.loggedIn ? (
        <button
          className={
            'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-base font-semibold cursor-pointer transition-colors ' +
            (isMember ? 'bg-warn/15 text-warn border-warn/40' : 'bg-panel2 text-fg2 border-line hover:bg-line')
          }
          title="打开会员中心：查看积分、开通会员"
          onClick={() => useStore.setState({ showMember: true })}
        >
          {isMember && <span className="text-lg leading-none">👑</span>}
          <span className="tabular-nums">{balance}</span>
          <span className="opacity-70 text-sm">积分</span>
        </button>
      ) : (
        <button className="btn-primary text-sm py-1.5" onClick={() => useStore.setState({ showLogin: true })}>
          登录 / 注册
        </button>
      )}
    </header>
  )
}
