/**
 * 导出交付对话框
 * - 六种导出方式：成品库导出 / 包含式 / 排除式 / 全部（+待确认开关，垃圾桶永远排除）
 * - 快捷预设：只导成品库 / 排除坏图导其余 / 全部不含垃圾桶
 * - 选项：目标目录、格式、按分类子文件夹、保留原文件名、物理移动、重名处理
 * - 实时"将导出 N 张（共 M 张）"、进度条 + 取消
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
  type CategoryKey
} from '../../../shared/types'

const MODE_LABELS: Record<ExportOptions['mode'], string> = {
  library: '仅成品库（推荐）',
  include: '包含式：只导出勾选分类',
  exclude: '排除式：导出除勾选外的全部',
  all: '全部文件（自动排除垃圾桶）'
}

export default function ExportDialog(): JSX.Element {
  const close = (): void => useStore.setState({ showExport: false })
  const counts = useStore((s) => s.counts)
  const customCategories = useStore((s) => s.customCategories)
  const settings = useStore((s) => s.settings)
  const exportProgress = useStore((s) => s.exportProgress)
  const runExport = useStore((s) => s.runExport)
  const cancelExport = useStore((s) => s.cancelExport)

  const [mode, setMode] = useState<ExportOptions['mode']>('library')
  const [cats, setCats] = useState<Set<CategoryKey>>(new Set())
  const [includeReview, setIncludeReview] = useState(false)
  const [targetDir, setTargetDir] = useState(settings.lastExportDir || '')
  const [format, setFormat] = useState<ExportOptions['format']>('original')
  const [subfolders, setSubfolders] = useState(true)
  const [keepNames, setKeepNames] = useState(true)
  const [physicalMove, setPhysicalMove] = useState(false)
  const [conflict, setConflict] = useState<ExportOptions['conflict']>('number')

  const opts: ExportOptions = useMemo(
    () => ({ mode, categories: [...cats], includeReview, targetDir, format, subfolders, keepNames, physicalMove, conflict }),
    [mode, cats, includeReview, targetDir, format, subfolders, keepNames, physicalMove, conflict]
  )

  const [preview, setPreview] = useState<{ will: number; total: number } | null>(null)
  useEffect(() => {
    const t = setTimeout(() => void window.api.exportPreview(opts).then(setPreview), 200)
    return () => clearTimeout(t)
  }, [opts])

  const running = exportProgress?.running
  const pct = exportProgress && exportProgress.total > 0 ? Math.round((exportProgress.done / exportProgress.total) * 100) : 0
  const canRun = !!targetDir && !running && (preview?.will ?? 0) > 0

  const toggleCat = (c: CategoryKey): void => {
    const next = new Set(cats)
    if (next.has(c)) next.delete(c)
    else next.add(c)
    setCats(next)
  }

  const applyPreset = (p: 'library' | 'excludeBad' | 'allNoTrash'): void => {
    if (p === 'library') {
      setMode('library')
      setCats(new Set())
      setIncludeReview(false)
    } else if (p === 'excludeBad') {
      setMode('exclude')
      setCats(new Set(BAD_DIMENSIONS))
      setIncludeReview(false)
    } else {
      setMode('all')
      setCats(new Set())
      setIncludeReview(true)
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/70 flex items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="bg-panel border border-line rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto fade-in">
        <div className="px-5 py-3 border-b border-line flex items-center justify-between sticky top-0 bg-panel z-10">
          <h2 className="text-fg font-bold">导出交付</h2>
          <button className="btn-ghost text-gray-400" onClick={close}>✕</button>
        </div>

        <div className="p-5 space-y-4 text-sm">
          {/* 快捷预设 */}
          <div>
            <div className="text-gray-400 text-xs mb-1.5">快捷预设：</div>
            <div className="flex gap-2 flex-wrap">
              <button className="btn" onClick={() => applyPreset('library')}>只导成品库</button>
              <button className="btn" onClick={() => applyPreset('excludeBad')}>排除坏图，导其余全部</button>
              <button className="btn" onClick={() => applyPreset('allNoTrash')}>全部（不含垃圾桶）</button>
            </div>
          </div>

          {/* 导出方式 */}
          <div>
            <div className="text-gray-400 text-xs mb-1.5">导出方式：</div>
            <div className="grid grid-cols-2 gap-1.5">
              {(Object.keys(MODE_LABELS) as ExportOptions['mode'][]).map((m) => (
                <button
                  key={m}
                  className={
                    'px-3 py-2 rounded-md border text-left transition-colors ' +
                    (mode === m ? 'border-brand bg-brand/10 text-brand' : 'border-line bg-panel2 text-gray-400 hover:text-gray-200')
                  }
                  onClick={() => setMode(m)}
                >
                  {MODE_LABELS[m]}
                </button>
              ))}
            </div>
            {(mode === 'include' || mode === 'exclude') && (
              <div className="mt-2 grid grid-cols-4 gap-1 text-xs">
                <span className="col-span-4 text-gray-500">{mode === 'include' ? '勾选要导出的分类：' : '勾选要排除的分类：'}</span>
                {BAD_DIMENSIONS.map((d) => (
                  <label key={d} className="flex items-center gap-1.5 text-gray-300 cursor-pointer">
                    <input type="checkbox" checked={cats.has(d)} onChange={() => toggleCat(d)} />
                    {DIMENSION_LABELS[d]} <span className="text-gray-600">({counts[d] || 0})</span>
                  </label>
                ))}
                {NEUTRAL_DIMENSIONS.map((d) => (
                  <label key={d} className="flex items-center gap-1.5 text-gray-300 cursor-pointer">
                    <input type="checkbox" checked={cats.has(d)} onChange={() => toggleCat(d)} />
                    {DIMENSION_LABELS[d]} <span className="text-gray-600">({counts[d] || 0})</span>
                  </label>
                ))}
                <label className="flex items-center gap-1.5 text-gray-300 cursor-pointer">
                  <input type="checkbox" checked={cats.has(CAT_LIBRARY)} onChange={() => toggleCat(CAT_LIBRARY)} />
                  成品库 <span className="text-gray-600">({counts[CAT_LIBRARY] || 0})</span>
                </label>
                {customCategories.map((c) => (
                  <label key={c.id} className="flex items-center gap-1.5 text-gray-300 cursor-pointer">
                    <input type="checkbox" checked={cats.has(`custom:${c.id}`)} onChange={() => toggleCat(`custom:${c.id}`)} />
                    {c.name} <span className="text-gray-600">({counts[`custom:${c.id}`] || 0})</span>
                  </label>
                ))}
                <span className="col-span-4 text-gray-600 flex items-center gap-1.5">
                  <input type="checkbox" checked disabled title="垃圾桶永不导出（6.3 双保险）" />
                  垃圾桶（{counts[CAT_TRASH] || 0}）—— 永不导出
                </span>
                <span className="col-span-4 text-gray-600 flex items-center gap-1.5">
                  <input type="checkbox" checked disabled title="重复/连拍-废弃永不导出（专放重复分组里丢弃的多余图）" />
                  重复/连拍-废弃（{counts[CAT_DUP_TRASH] || 0}）—— 永不导出
                </span>
              </div>
            )}
            <label className="flex items-center gap-1.5 text-red-400 font-medium mt-2 cursor-pointer text-xs">
              <input type="checkbox" checked={includeReview} onChange={(e) => setIncludeReview(e.target.checked)} />
              包含"待确认"图片（{counts[CAT_REVIEW] || 0} 张）—— 默认不导出，防止误交付
            </label>
          </div>

          {/* 实时统计 */}
          <div className="rounded-lg bg-panel2 border border-line px-4 py-2.5 text-gray-300">
            将导出 <b className="text-brand tabular-nums text-base">{preview?.will ?? '…'}</b> 张
            <span className="text-gray-500">（库内共 {preview?.total ?? 0} 张可导出，垃圾桶与未勾选部分已排除）</span>
          </div>

          {/* 选项 */}
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <div className="text-gray-400 text-xs mb-1">目标目录：</div>
              <div className="flex gap-2">
                <input className="input flex-1" placeholder="选择导出文件夹…" value={targetDir} onChange={(e) => setTargetDir(e.target.value)} />
                <button
                  className="btn whitespace-nowrap"
                  onClick={() => void window.api.pickFolder().then((d) => d && setTargetDir(d))}
                >
                  浏览…
                </button>
              </div>
            </div>
            <label className="flex items-center gap-2 text-gray-300">
              格式
              <select className="input flex-1" value={format} onChange={(e) => setFormat(e.target.value as ExportOptions['format'])}>
                <option value="original">原格式</option>
                <option value="jpg">转 JPG</option>
                <option value="png">转 PNG</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-gray-300">
              重名处理
              <select className="input flex-1" value={conflict} onChange={(e) => setConflict(e.target.value as ExportOptions['conflict'])}>
                <option value="number">自动加序号</option>
                <option value="skip">跳过</option>
                <option value="overwrite">覆盖</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-gray-300 cursor-pointer">
              <input type="checkbox" checked={subfolders} onChange={(e) => setSubfolders(e.target.checked)} />
              按分类建子文件夹
            </label>
            <label className="flex items-center gap-2 text-gray-300 cursor-pointer">
              <input type="checkbox" checked={keepNames} onChange={(e) => setKeepNames(e.target.checked)} />
              保留原文件名
            </label>
            <label className="flex items-center gap-2 text-gray-300 cursor-pointer col-span-2" title="剪切而非复制：导出后原文件移入目标目录">
              <input type="checkbox" checked={physicalMove} onChange={(e) => setPhysicalMove(e.target.checked)} />
              物理移动文件（剪切而非复制，谨慎使用）
            </label>
          </div>

          {/* 进度 */}
          {exportProgress && (exportProgress.running || exportProgress.total > 0) && (
            <div className="space-y-1">
              <div className="h-2 bg-panel2 rounded-full overflow-hidden">
                <div className={'h-full transition-all ' + (exportProgress.finished ? 'bg-good' : 'bg-brand')} style={{ width: `${pct}%` }} />
              </div>
              <div className="flex items-center justify-between text-xs text-gray-400">
                <span>
                  {exportProgress.finished
                    ? `完成：成功 ${exportProgress.finished.success} / 跳过 ${exportProgress.finished.skipped} / 失败 ${exportProgress.finished.failed}`
                    : `${exportProgress.done}/${exportProgress.total} · ${exportProgress.current}`}
                </span>
                {exportProgress.running && (
                  <button className="btn-danger py-0.5" onClick={() => void cancelExport()}>取消导出</button>
                )}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button className="btn" onClick={close}>关闭</button>
            <button className="btn-primary" disabled={!canRun} onClick={() => void runExport(opts)}>
              {running ? '导出中…' : `开始导出${preview?.will ? ` ${preview.will} 张` : ''}`}
            </button>
          </div>
          {!targetDir && <div className="text-xs text-yellow-500 text-right">请先选择目标目录</div>}
        </div>
      </div>
    </div>
  )
}
