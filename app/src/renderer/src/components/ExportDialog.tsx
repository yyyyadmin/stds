/**
 * 导出交付对话框（V2 改版）
 * - 四种导出方式（library / include / exclude / all）
 * - library 模式专属：档位勾选 + 目录结构（合并 or 按档位建子目录）+ 可编辑文件夹名
 * - 底部导出按钮绿色强调
 * - 去掉冗余说明文字，界面干净
 */
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import type { ExportOptions } from '../../../main/services/exporter'
import {
  BAD_DIMENSIONS,
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
  const close = (): void => useStore.setState({ showExport: false })
  const counts = useStore((s) => s.counts)
  const customCategories = useStore((s) => s.customCategories)
  const settings = useStore((s) => s.settings)
  const exportProgress = useStore((s) => s.exportProgress)
  const runExport = useStore((s) => s.runExport)
  const cancelExport = useStore((s) => s.cancelExport)
  const tierNames = settings.tierNames?.length === 3 ? settings.tierNames : DEFAULT_TIER_NAMES

  const [mode, setMode] = useState<ExportOptions['mode']>('library')
  const [cats, setCats] = useState<Set<CategoryKey>>(new Set())
  const [includeReview, setIncludeReview] = useState(false)
  const [targetDir, setTargetDir] = useState(settings.lastExportDir || '')
  const [format, setFormat] = useState<ExportOptions['format']>('original')
  const [keepNames, setKeepNames] = useState(true)
  const [physicalMove, setPhysicalMove] = useState(false)
  const [conflict, setConflict] = useState<ExportOptions['conflict']>('number')
  // 档位控制
  const [selectedTiers, setSelectedTiers] = useState<Set<TierKey>>(new Set([1, 2, 3]))
  const [tierLayout, setTierLayout] = useState<'flat' | 'subdirs'>('flat')
  const [folderName, setFolderName] = useState('交付库')

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
    tiers: mode === 'library' ? [...selectedTiers].sort() : undefined,
    tierLayout: mode === 'library' ? tierLayout : undefined,
    folderName: mode === 'library' && tierLayout === 'flat' ? folderName : undefined
  }), [mode, cats, includeReview, targetDir, format, tierLayout, keepNames, physicalMove, conflict, selectedTiers, folderName])

  const [preview, setPreview] = useState<{ will: number; total: number; byTier: Record<1 | 2 | 3, number>; sizeMB: number | null } | null>(null)
  useEffect(() => {
    const t = setTimeout(() => void window.api.exportPreview(opts).then(setPreview), 200)
    return () => clearTimeout(t)
  }, [opts])

  const running = exportProgress?.running
  const pct = exportProgress && exportProgress.total > 0 ? Math.round((exportProgress.done / exportProgress.total) * 100) : 0
  const tiersEmpty = mode === 'library' && selectedTiers.size === 0
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

  return (
    <div className="fixed inset-0 z-40 bg-black/70 flex items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="bg-panel border border-line rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto fade-in">
        {/* 标题栏 */}
        <div className="px-6 py-4 border-b border-line flex items-center justify-between sticky top-0 bg-panel z-10">
          <h2 className="text-fg font-bold text-base">导出交付</h2>
          <button className="text-fg3 hover:text-fg text-xl leading-none px-1" onClick={close}>×</button>
        </div>

        <div className="px-6 py-5 space-y-5 text-sm">
          {/* 导出方式 */}
          <div>
            <div className="text-fg3 text-xs mb-2">导出方式</div>
            <div className="grid grid-cols-4 gap-1.5">
              {MODES.map((m) => (
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

          {/* 仅交付库：档位控制区 */}
          {mode === 'library' && (
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
              {tierLayout === 'flat' && (
                <div>
                  <div className="text-fg3 text-xs mb-1.5">文件夹名称</div>
                  <input
                    className="input w-48 text-[13px]"
                    value={folderName}
                    onChange={(e) => setFolderName(e.target.value)}
                    placeholder="交付库"
                  />
                </div>
              )}
              {tierLayout === 'subdirs' && (
                <div className="text-xs text-fg3">
                  将创建 {selectedTiers.size} 个子目录：{[...selectedTiers].sort().map((t) => `${tierNames[t - 1]}(${counts[`tier:${t}`] || 0})`).join(' / ')}
                </div>
              )}
            </div>
          )}

          {/* 包含/排除式：分类勾选 */}
          {(mode === 'include' || mode === 'exclude') && (
            <div>
              <div className="text-fg3 text-xs mb-1.5">{mode === 'include' ? '勾选要导出的分类' : '勾选要排除的分类'}</div>
              <div className="grid grid-cols-3 gap-1 text-[13px]">
                {BAD_DIMENSIONS.map((d) => (
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

          {/* 待确认开关 */}
          <label className="flex items-center gap-2 text-fg3 cursor-pointer text-xs">
            <input type="checkbox" checked={includeReview} onChange={(e) => setIncludeReview(e.target.checked)} />
            包含"待确认"（{counts[CAT_REVIEW] || 0} 张）
          </label>

          {/* 实时统计（交付清单） */}
          <div className="rounded-lg bg-panel2 border border-line px-4 py-2.5 text-fg2 leading-relaxed">
            将导出 <b className="text-good tabular-nums text-base">{preview?.will ?? '…'}</b> 张
            {preview?.sizeMB != null && preview.sizeMB > 0 && (
              <span className="text-fg3"> · 约 {preview.sizeMB >= 1024 ? (preview.sizeMB / 1024).toFixed(1) + ' GB' : preview.sizeMB.toFixed(1) + ' MB'}</span>
            )}
            {mode === 'library' && preview && (
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
