/**
 * 导出交付对话框（V2 改版）
 * - 四种导出方式（library / include / exclude / all）
 * - library 模式专属：档位勾选 + 目录结构（合并 or 按档位建子目录）+ 可编辑文件夹名
 * - 底部导出按钮绿色强调
 * - 去掉冗余说明文字，界面干净
 *
 * 精简模式（settings.uiMode==='slim'）：交付库不再分档，也不按分类勾选——
 *   只留「仅交付库 / 全部文件」两项，档位勾选、目录结构、三档统计、包含待确认全部不渲染；
 *   待确认的拦截弹窗也跳过（那一栏本来就交给 AI 自动复审）。
 * 带预设打开（侧栏人物分类行的小「导出」）：导出方式锁死为勾选分类，范围就是预设那一行，
 *   且只导能交付的图（deliverableOnly，瑕疵片/待确认/废片自动跳过）。
 */
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import type { ExportOptions } from '../../../main/services/exporter'
import {
  UI_BAD_DIMENSIONS,
  CAT_LIBRARY,
  CAT_REVIEW,
  CAT_TRASH,
  CAT_DUP_TRASH,
  DIMENSION_LABELS,
  NEUTRAL_DIMENSIONS,
  STRUCTURAL_DIMENSIONS,
  DEFAULT_TIER_NAMES,
  type CategoryKey,
  type TierKey
} from '../../../shared/types'

const MODES: { key: ExportOptions['mode']; label: string }[] = [
  { key: 'library', label: '仅交付库' },
  { key: 'include', label: '只导勾选分类' },
  { key: 'exclude', label: '排除勾选分类' },
  { key: 'all', label: '全部文件' }
]

export default function ExportDialog(): JSX.Element {
  // 关闭同时清预设：否则下次从顶栏/交付库打开导出，会莫名地继续锁在上一次的人物分类上
  const close = (): void => useStore.setState({ showExport: false, exportPreset: null })
  const counts = useStore((s) => s.counts)
  const openCategory = useStore((s) => s.openCategory)
  const customCategories = useStore((s) => s.customCategories)
  const settings = useStore((s) => s.settings)
  const exportProgress = useStore((s) => s.exportProgress)
  const runExport = useStore((s) => s.runExport)
  const cancelExport = useStore((s) => s.cancelExport)
  const preset = useStore((s) => s.exportPreset)
  const slim = useStore((s) => s.settings.uiMode === 'slim')
  const tierNames = settings.tierNames?.length === 3 ? settings.tierNames : DEFAULT_TIER_NAMES
  /** 精简没有分档也没有分类表，导出方式只留两个口径 */
  const modes = slim ? MODES.filter((m) => m.key === 'library' || m.key === 'all') : MODES

  const [mode, setMode] = useState<ExportOptions['mode']>(preset ? 'include' : 'library')
  const [cats, setCats] = useState<Set<CategoryKey>>(() => new Set(preset?.categories ?? []))
  const [includeReview, setIncludeReview] = useState(false)
  const [targetDir, setTargetDir] = useState(settings.lastExportDir || '')
  const [format, setFormat] = useState<ExportOptions['format']>('original')
  const [keepNames, setKeepNames] = useState(true)
  const [physicalMove, setPhysicalMove] = useState(false)
  const [conflict, setConflict] = useState<ExportOptions['conflict']>('number')
  // 档位控制
  const [selectedTiers, setSelectedTiers] = useState<Set<TierKey>>(new Set([1, 2, 3]))
  const [tierLayout, setTierLayout] = useState<'flat' | 'subdirs'>('flat')
  const [folderName, setFolderName] = useState(() => {
    const d = new Date()
    return `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}交付库`
  })

  // 导出前提醒（用户 2026-10-15 定）：点「导出交付」时若「待确认」还有没审核的照片，先弹一句警告——
  // 这些照片不在交付库里、本次导出默认不带它们，其中可能存在可交付的优质照片；待确认空了就不打扰。
  // 两个入口（顶栏按钮 + 侧栏交付库「导出」小字）都走本弹窗，拦在这里一处管住。
  const reviewPending = counts[CAT_REVIEW] || 0
  // 精简模式不拦：那一栏就是交给 AI 自动复审的；带预设的小导出更不该被别栏卡住
  const [guard, setGuard] = useState(() => reviewPending > 0 && !slim && !preset)

  const opts: ExportOptions = useMemo(() => ({
    mode,
    categories: [...cats],
    includeReview,
    targetDir,
    format,
    subfolders: mode === 'library' ? tierLayout === 'subdirs' : true,
    keepNames,
    physicalMove,
    conflict,
    // 人物分类行的小导出：只导这一栏能交付的图（与交付库闸门同一口径）
    deliverableOnly: !!preset || undefined,
    tiers: mode === 'library' ? [...selectedTiers].sort() : undefined,
    tierLayout: mode === 'library' ? tierLayout : undefined,
    folderName: mode === 'library' ? folderName : undefined
  }), [mode, cats, includeReview, targetDir, format, tierLayout, keepNames, physicalMove, conflict, selectedTiers, folderName, preset])

  const [preview, setPreview] = useState<{ will: number; total: number; byTier: Record<1 | 2 | 3, number>; sizeMB: number | null } | null>(null)
  useEffect(() => {
    const t = setTimeout(() => void window.api.exportPreview(opts).then(setPreview), 200)
    return () => clearTimeout(t)
  }, [opts])

  const running = exportProgress?.running
  const pct = exportProgress && exportProgress.total > 0 ? Math.round((exportProgress.done / exportProgress.total) * 100) : 0
  const tiersEmpty = !slim && mode === 'library' && selectedTiers.size === 0
  const canRun = !!targetDir && !running && !tiersEmpty && (preview?.will ?? 0) > 0

  const toggleCat = (c: CategoryKey): void => {
    const next = new Set(cats)
    if (next.has(c)) next.delete(c)
    else next.add(c)
    setCats(next)
  }
  const toggleTier = (t: TierKey): void => {
    const next = new Set(selectedTiers)
    if (next.has(t)) next.delete(t)
    else next.add(t)
    setSelectedTiers(next)
  }

  // 警告层：只挡住导出面板的打开，点空白/关闭 = 整个导出取消（没看完提醒就不进面板）
  if (guard) {
    return (
      <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && close()}>
        <div className="bg-panel border border-line rounded-xl shadow-2xl w-full max-w-md fade-in">
          <div className="px-6 pt-6 pb-1 text-[16px] font-bold text-fg">待确认里还有 {reviewPending} 张未审核</div>
          <div className="px-6 py-4 space-y-2 text-[13px] text-fg2 leading-relaxed">
            <p>「待确认」是 AI 判定存疑、等待人工审核的照片，<b className="text-fg">不在交付库中，本次导出默认不包含这些照片</b>。</p>
            <p>其中可能存在可以交付的优质照片，直接导出可能漏交；建议先完成审核再导出。</p>
            <p className="text-xs text-fg3">如需带上这些照片，也可以在导出面板勾选「包含“待确认”」。</p>
          </div>
          <div className="px-6 py-4 border-t border-line flex items-center justify-end gap-2">
            <button className="btn px-4 py-2" onClick={() => setGuard(false)}>仍然导出</button>
            <button
              className="btn-primary px-4 py-2"
              title="关闭导出并跳到「待确认」相册，逐张审核"
              onClick={() => { close(); void openCategory(CAT_REVIEW) }}
            >
              先去确认
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/70 flex items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="bg-panel border border-line rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto fade-in">
        {/* 标题栏 */}
        <div className="px-6 py-4 border-b border-line flex items-center justify-between sticky top-0 bg-panel z-10">
          <h2 className="text-fg font-bold text-base">导出交付</h2>
          <button className="text-fg3 hover:text-fg text-xl leading-none px-1" onClick={close}>×</button>
        </div>

        <div className="px-6 py-5 space-y-5 text-sm">
          {/* 导出方式：带预设（人物分类行的小导出）时锁死范围，不再给选 */}
          {preset ? (
            <div>
              <div className="text-fg3 text-xs mb-2">导出范围</div>
              <div className="rounded-lg bg-panel2 border border-line px-4 py-2.5 text-[13px] text-fg2">
                <b className="text-fg">{preset.label}</b>
                <span className="text-fg3"> · 只导这一栏能交付的照片（瑕疵片、待确认自动跳过）</span>
              </div>
            </div>
          ) : (
            <div>
              <div className="text-fg3 text-xs mb-2">导出方式</div>
              <div className={'grid gap-1.5 ' + (modes.length === 2 ? 'grid-cols-2' : 'grid-cols-4')}>
                {modes.map((m) => (
                  <button
                    key={m.key}
                    className={
                      'px-3 py-2 rounded-md border text-center text-[13px] transition-colors ' +
                      (mode === m.key ? 'border-brand bg-brand/10 text-brand font-semibold' : 'border-line bg-panel2 text-fg3 hover:text-fg2')
                    }
                    onClick={() => setMode(m.key)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 仅交付库：档位控制区（精简模式不分档，整块不渲染） */}
          {mode === 'library' && !slim && (
            <div className="space-y-3 rounded-lg bg-panel2/40 p-4">
              <div>
                <div className="text-fg3 text-xs mb-1.5">导出档位</div>
                <div className="flex gap-4">
                  {([1, 2, 3] as TierKey[]).map((t) => (
                    <label key={t} className="flex items-center gap-1.5 cursor-pointer text-fg2">
                      <input type="checkbox" checked={selectedTiers.has(t)} onChange={() => toggleTier(t)} />
                      {tierNames[t - 1]}
                      <span className="text-fg3 tabular-nums">({counts[`tier:${t}`] || 0})</span>
                    </label>
                  ))}
                </div>
                <div className="text-fg3 text-xs mt-1.5">三档按引擎实测的画面清晰度排队，只用来决定先交哪批；取消勾选某个档只是不出这一批，<b>不代表那些图有瑕疵</b>。</div>
                {tiersEmpty && <div className="text-xs text-bad mt-1">请至少勾选一个档位</div>}
              </div>
              <div>
                <div className="text-fg3 text-xs mb-1.5">目录结构</div>
                <div className="flex gap-5">
                  <label className="flex items-center gap-1.5 cursor-pointer text-fg2">
                    <input type="radio" name="tierLayout" checked={tierLayout === 'flat'} onChange={() => setTierLayout('flat')} />
                    合并为一个文件夹
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer text-fg2">
                    <input type="radio" name="tierLayout" checked={tierLayout === 'subdirs'} onChange={() => setTierLayout('subdirs')} />
                    按档位建子文件夹
                  </label>
                </div>
              </div>
              {tierLayout === 'subdirs' && (
                <div className="text-xs text-fg3">
                  将创建 {selectedTiers.size} 个子目录：{[...selectedTiers].sort().map((t) => `${tierNames[t - 1]}(${counts[`tier:${t}`] || 0})`).join(' / ')}
                </div>
              )}
              {/* 文件夹名称：两种布局都显示——flat 是包有文件的目录名，subdirs 是外层父目录名 */}
              <div>
                <div className="text-fg3 text-xs mb-1.5">文件夹名称</div>
                <input
                  className="input w-48 text-[13px]"
                  value={folderName}
                  onChange={(e) => setFolderName(e.target.value)}
                  placeholder="1020交付库"
                />
              </div>
            </div>
          )}

          {/* 包含/排除式：分类勾选（带预设时范围已锁死，不出选择表） */}
          {(mode === 'include' || mode === 'exclude') && !preset && (
            <div>
              <div className="text-fg3 text-xs mb-1.5">{mode === 'include' ? '勾选要导出的分类' : '勾选要排除的分类'}</div>
              <div className="grid grid-cols-3 gap-1 text-[13px]">
                {UI_BAD_DIMENSIONS.map((d) => (
                  <label key={d} className="flex items-center gap-1.5 text-fg2 cursor-pointer">
                    <input type="checkbox" checked={cats.has(d)} onChange={() => toggleCat(d)} />
                    {DIMENSION_LABELS[d]} <span className="text-fg3 tabular-nums">({counts[d] || 0})</span>
                  </label>
                ))}
                {NEUTRAL_DIMENSIONS.map((d) => (
                  <label key={d} className="flex items-center gap-1.5 text-fg2 cursor-pointer">
                    <input type="checkbox" checked={cats.has(d)} onChange={() => toggleCat(d)} />
                    {DIMENSION_LABELS[d]} <span className="text-fg3 tabular-nums">({counts[d] || 0})</span>
                  </label>
                ))}
                {/* 结构维度（重复/连拍 v2.0.67）：不是缺陷，但作为一个可选的分类仍然存在（勾它 = 把组里多余的那几张也交出去） */}
                {STRUCTURAL_DIMENSIONS.map((d) => (
                  <label key={d} className="flex items-center gap-1.5 text-fg2 cursor-pointer" title="重复/连拍组里被判定多余的那几张（每组代表帧已包含在交付库里）">
                    <input type="checkbox" checked={cats.has(d)} onChange={() => toggleCat(d)} />
                    {DIMENSION_LABELS[d]} <span className="text-fg3 tabular-nums">({counts[d] || 0})</span>
                  </label>
                ))}
                <label className="flex items-center gap-1.5 text-fg2 cursor-pointer">
                  <input type="checkbox" checked={cats.has(CAT_LIBRARY)} onChange={() => toggleCat(CAT_LIBRARY)} />
                  交付库 <span className="text-fg3 tabular-nums">({counts[CAT_LIBRARY] || 0})</span>
                </label>
                {([1, 2, 3] as TierKey[]).map((t) => (
                  <label key={t} className="flex items-center gap-1.5 pl-4 text-fg3 cursor-pointer">
                    <input type="checkbox" checked={cats.has(`tier:${t}`)} onChange={() => toggleCat(`tier:${t}`)} />
                    {tierNames[t - 1]} <span className="tabular-nums">({counts[`tier:${t}`] || 0})</span>
                  </label>
                ))}
                {customCategories.map((c) => (
                  <label key={c.id} className="flex items-center gap-1.5 text-fg2 cursor-pointer">
                    <input type="checkbox" checked={cats.has(`custom:${c.id}`)} onChange={() => toggleCat(`custom:${c.id}`)} />
                    {c.name} <span className="text-fg3 tabular-nums">({counts[`custom:${c.id}`] || 0})</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* 待确认开关：精简模式不提供（那一栏交给 AI 自动复审，不靠导出顺手带走） */}
          {!slim && (
            <label className="flex items-center gap-2 text-fg3 cursor-pointer text-xs">
              <input type="checkbox" checked={includeReview} onChange={(e) => setIncludeReview(e.target.checked)} />
              包含"待确认"（{counts[CAT_REVIEW] || 0} 张）
            </label>
          )}

          {/* 实时统计（交付清单） */}
          <div className="rounded-lg bg-panel2 border border-line px-4 py-2.5 text-fg2 leading-relaxed">
            将导出 <b className="text-good tabular-nums text-base">{preview?.will ?? '…'}</b> 张
            {preview?.sizeMB != null && preview.sizeMB > 0 && (
              <span className="text-fg3"> · 约 {preview.sizeMB >= 1024 ? (preview.sizeMB / 1024).toFixed(1) + ' GB' : preview.sizeMB.toFixed(1) + ' MB'}</span>
            )}
            {mode === 'library' && preview && !slim && (
              <span className="text-fg3"> · 优质 {preview.byTier[1]} / 良好 {preview.byTier[2]} / 一般 {preview.byTier[3]}</span>
            )}
            <span className="text-fg3">（共 {preview?.total ?? 0} 张可导出）</span>
          </div>

          {/* 目标目录 + 选项 */}
          <div className="space-y-3">
            <div>
              <div className="text-fg3 text-xs mb-1">目标目录</div>
              <div className="flex gap-2">
                <input className="input flex-1" placeholder="选择导出文件夹…" value={targetDir} onChange={(e) => setTargetDir(e.target.value)} />
                <button className="btn whitespace-nowrap" onClick={() => void window.api.pickFolder().then((d) => d && setTargetDir(d))}>
                  浏览…
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex items-center gap-2 text-fg2">
                <span className="text-fg3 text-xs shrink-0">格式</span>
                <select className="input flex-1 text-[13px]" value={format} onChange={(e) => setFormat(e.target.value as ExportOptions['format'])}>
                  <option value="original">原格式</option>
                  <option value="jpg">转 JPG</option>
                  <option value="png">转 PNG</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-fg2">
                <span className="text-fg3 text-xs shrink-0">重名</span>
                <select className="input flex-1 text-[13px]" value={conflict} onChange={(e) => setConflict(e.target.value as ExportOptions['conflict'])}>
                  <option value="number">自动加序号</option>
                  <option value="skip">跳过</option>
                  <option value="overwrite">覆盖</option>
                </select>
              </label>
            </div>
            <div className="flex gap-5 text-xs text-fg3">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={keepNames} onChange={(e) => setKeepNames(e.target.checked)} />
                保留原文件名
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={physicalMove} onChange={(e) => setPhysicalMove(e.target.checked)} />
                物理移动（剪切）
              </label>
            </div>
          </div>

          {/* 进度 */}
          {exportProgress && (exportProgress.running || exportProgress.total > 0) && (
            <div className="space-y-1">
              <div className="h-2 bg-panel2 rounded-full overflow-hidden">
                <div className={'h-full transition-all ' + (exportProgress.finished ? 'bg-good' : 'bg-brand')} style={{ width: `${pct}%` }} />
              </div>
              <div className="flex items-center justify-between text-xs text-fg3">
                <span>
                  {exportProgress.finished
                    ? `完成：成功 ${exportProgress.finished.success} / 跳过 ${exportProgress.finished.skipped} / 失败 ${exportProgress.finished.failed}`
                    : `${exportProgress.done}/${exportProgress.total} · ${exportProgress.current}`}
                </span>
                {exportProgress.running && (
                  <button className="text-bad hover:underline" onClick={() => void cancelExport()}>取消</button>
                )}
              </div>
            </div>
          )}

          {/* 底部按钮 */}
          <div className="flex items-center justify-between pt-1 border-t border-line">
            <span className="text-xs text-fg3">{!targetDir ? '请先选择目标目录' : tiersEmpty ? '请至少勾选一个档位' : ''}</span>
            <div className="flex gap-2">
              <button className="btn" onClick={close}>关闭</button>
              <button
                className="px-4 py-2 rounded-md bg-good text-white font-semibold text-sm hover:bg-good/85 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                disabled={!canRun}
                onClick={() => void runExport(opts)}
              >
                {running ? '导出中…' : `开始导出${preview?.will ? ` ${preview.will} 张` : ''}`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
