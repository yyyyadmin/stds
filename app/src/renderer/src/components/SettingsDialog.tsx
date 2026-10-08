/**
 * 设置对话框（第四章 + 8.4 + 10 章）
 * - 置信度三级分档阈值滑条（保存后无需重检，直接重分桶）
 * - 场景预设 / 引擎与设备偏好 / 自动阈值微调开关
 * - 阈值微调面板：修正记录统计、立即微调、重置微调
 * - 引擎状态与能力显示（Python 完整 / Node 降级）
 */
import { useEffect, useState } from 'react'
import { useStore } from '../store'
import {
  BAD_DIMENSIONS,
  DIMENSION_LABELS,
  SCENE_PRESETS,
  type DimensionKey
} from '../../../shared/types'
import type { EngineStatus } from '../../../main/engine'
import type { TuneReport } from '../../../main/services/tuner'

export default function SettingsDialog(): JSX.Element {
  const close = (): void => useStore.setState({ showSettings: false })
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)
  const rescanAll = useStore((s) => s.rescanAll)

  const [engine, setEngine] = useState<EngineStatus | null>(null)
  const [stats, setStats] = useState<{ total: number; perDim: Record<string, { falsePositive: number; truePositive: number; total: number }> } | null>(null)
  const [tuneReport, setTuneReport] = useState<TuneReport | null>(null)

  useEffect(() => {
    void window.api.engineStatus().then(setEngine)
    void window.api.tuneStats().then(setStats)
  }, [])

  const setThreshold = (key: 'highThreshold' | 'midThreshold', v: number): void => {
    const patch = { [key]: v }
    if (key === 'midThreshold' && v >= settings.highThreshold) patch.midThreshold = settings.highThreshold - 0.05
    if (key === 'highThreshold' && v <= settings.midThreshold) patch.highThreshold = settings.midThreshold + 0.05
    void saveSettings(patch, true)
  }

  const tuneNow = (): void => {
    void window.api.tuneNow().then((r) => {
      setTuneReport(r)
      void useStore.getState().saveSettings({})
      void useStore.getState().refreshImages()
      void useStore.getState().refreshCounts()
    })
  }
  const tuneReset = (): void => {
    void window.api.tuneReset().then(() => {
      setTuneReport(null)
      void useStore.getState().saveSettings({})
      void useStore.getState().refreshImages()
      void useStore.getState().refreshCounts()
    })
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/70 flex items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="bg-panel border border-line rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto fade-in">
        <div className="px-5 py-3 border-b border-line flex items-center justify-between sticky top-0 bg-panel z-10">
          <h2 className="text-fg font-bold">设置</h2>
          <button className="btn-ghost text-gray-400" onClick={close}>✕</button>
        </div>

        <div className="p-5 space-y-5 text-sm">
          {/* 置信度阈值 */}
          <section>
            <h3 className="text-gray-300 font-bold mb-2">置信度三级分档阈值（第四章）</h3>
            <div className="space-y-3">
              <div>
                <div className="flex justify-between text-xs text-gray-400">
                  <span>高置信度阈值（&gt; 直接标记进坏维度分类）</span>
                  <b className="text-fg tabular-nums">{settings.highThreshold.toFixed(2)}</b>
                </div>
                <input type="range" min={0.5} max={0.99} step={0.01} value={settings.highThreshold}
                  className="w-full accent-red-500"
                  onChange={(e) => setThreshold('highThreshold', Number(e.target.value))} />
              </div>
              <div>
                <div className="flex justify-between text-xs text-gray-400">
                  <span>中置信度下限（介于中和高之间 → 待确认区，黄色高亮）</span>
                  <b className="text-fg tabular-nums">{settings.midThreshold.toFixed(2)}</b>
                </div>
                <input type="range" min={0.3} max={0.95} step={0.01} value={settings.midThreshold}
                  className="w-full accent-yellow-500"
                  onChange={(e) => setThreshold('midThreshold', Number(e.target.value))} />
              </div>
              <p className="text-xs text-gray-500">
                低于 {settings.midThreshold.toFixed(2)} 的判定不标记，图片默认留在成品库。调整阈值<b>无需重新检测</b>，立即按已存的原始置信度重新分桶。
              </p>
            </div>
          </section>

          {/* 场景预设 */}
          <section>
            <h3 className="text-gray-300 font-bold mb-2">场景预设（9.1）</h3>
            <div className="grid grid-cols-2 gap-2">
              {SCENE_PRESETS.map((p) => (
                <button
                  key={p.key}
                  className={
                    'px-3 py-2 rounded-md border text-left ' +
                    (settings.scene === p.key ? 'border-brand bg-brand/10 text-brand' : 'border-line bg-panel2 text-gray-400 hover:text-gray-200')
                  }
                  onClick={() => void saveSettings({ scene: p.key }, true)}
                  title={Object.entries(p.overrides).map(([d, v]) => `${DIMENSION_LABELS[d as DimensionKey]}: ${v[0]}~${v[1]}`).join('\n') || '使用全局阈值'}
                >
                  <div className="font-bold">{p.label}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {Object.keys(p.overrides).length
                      ? Object.entries(p.overrides).map(([d, v]) => `${DIMENSION_LABELS[d as DimensionKey]}(${v[0]}-${v[1]})`).join(' ')
                      : '全局默认阈值'}
                  </div>
                </button>
              ))}
            </div>
          </section>

          {/* 引擎与设备 */}
          <section>
            <h3 className="text-gray-300 font-bold mb-2">AI 引擎与设备（8.4 多进程 / GPU-CPU 自动切换）</h3>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex items-center gap-2 text-gray-300">
                引擎偏好
                <select className="input flex-1" value={settings.enginePreference}
                  onChange={(e) => void saveSettings({ enginePreference: e.target.value as 'auto' | 'python' | 'node' })}>
                  <option value="auto">自动（Python 优先）</option>
                  <option value="python">仅 Python AI 引擎</option>
                  <option value="node">仅 Node 基础引擎</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-gray-300">
                计算设备
                <select className="input flex-1" value={settings.devicePreference}
                  onChange={(e) => void saveSettings({ devicePreference: e.target.value as 'auto' | 'cpu' | 'cuda' })}>
                  <option value="auto">自动检测</option>
                  <option value="cpu">CPU（省电稳定）</option>
                  <option value="cuda">GPU / CUDA（NVIDIA）</option>
                </select>
              </label>
            </div>
            <div className="mt-2 rounded-md bg-panel2 border border-line p-3 text-xs space-y-1">
              {engine ? (
                <>
                  <div>
                    当前引擎：<b className={engine.type === 'python' ? 'text-good' : 'text-warn'}>
                      {engine.type === 'python'
                        ? (engine.pythonPath && /screener-engine/.test(engine.pythonPath) ? '自带完整 AI 引擎（12 维）' : 'Python 完整 AI 引擎')
                        : engine.type === 'node' ? 'Node 基础引擎（降级模式）' : '未就绪'}
                    </b> · 设备：<b className="text-fg">{engine.device}</b> · 并行进程：<b className="text-fg">{engine.workers}</b>
                  </div>
                  <div className="text-gray-500">{engine.message}</div>
                  {engine.type === 'node' && (
                    <div className="text-warn">
                      降级模式仅支持：模糊 / 曝光 / 黑白照 / 重复连拍。人脸类维度（闭眼/斜眼/狰狞/半截头/人数）需完整引擎：
                      发布版已自带 Python 引擎（无需安装）；若本机为开发版，安装 Python 3.9+ 并 pip install -r ai-engine/requirements.txt，
                      或运行 npm run build:engine 生成自带引擎后重启软件即自动升级为 12 维。
                    </div>
                  )}
                </>
              ) : (
                <div className="text-gray-500">引擎状态查询中…</div>
              )}
              <div className="pt-1 flex gap-2">
                <button className="btn text-xs" onClick={() => void window.api.engineStatus().then(setEngine)}>刷新状态</button>
                <button className="btn text-xs" onClick={() => { if (confirm('重新筛选将覆盖 AI 判定（您手动修正过的图片与垃圾桶内容会保留）。继续？')) void rescanAll() }}>
                  重新筛选全部图片
                </button>
              </div>
            </div>
          </section>

          {/* 阈值微调（5.4） */}
          <section>
            <h3 className="text-gray-300 font-bold mb-2">修正学习 · 阈值微调（第五章 5.4）</h3>
            <label className="flex items-center gap-2 text-gray-300 mb-2 cursor-pointer">
              <input type="checkbox" checked={settings.autoTune} onChange={(e) => void saveSettings({ autoTune: e.target.checked })} />
              修正记录积累后自动微调阈值（不重新训练模型，仅按维度调整分档线）
            </label>
            <div className="rounded-md bg-panel2 border border-line p-3 text-xs space-y-2">
              <div className="text-gray-400">
                累计修正记录：<b className="text-fg tabular-nums">{stats?.total ?? '…'}</b> 条（达到 200 条后生效）
              </div>
              {stats && Object.keys(stats.perDim).length > 0 && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  {Object.entries(stats.perDim)
                    .sort((a, b) => b[1].total - a[1].total)
                    .slice(0, 8)
                    .map(([d, s]) => (
                      <div key={d} className="flex justify-between text-gray-400">
                        <span>{DIMENSION_LABELS[d as DimensionKey] || d}</span>
                        <span className="tabular-nums">
                          误判 {s.falsePositive} / 正确 {s.truePositive}
                          {s.total > 0 && (
                            <span className={s.falsePositive / s.total > 0.35 ? 'text-red-400' : 'text-gray-600'}>
                              {' '}({Math.round((s.falsePositive / s.total) * 100)}%)
                            </span>
                          )}
                        </span>
                      </div>
                    ))}
                </div>
              )}
              {Object.keys(settings.tunedThresholds || {}).length > 0 && (
                <div className="text-emerald-400">
                  已微调维度：{Object.entries(settings.tunedThresholds).map(([d, v]) => `${DIMENSION_LABELS[d as DimensionKey] || d}(${(v as number[])[0].toFixed(2)}~${(v as number[])[1].toFixed(2)})`).join('、')}
                </div>
              )}
              {tuneReport && (
                <div className="text-gray-300">
                  {tuneReport.tuned.length
                    ? '本次微调：' + tuneReport.tuned.map((t) => `${DIMENSION_LABELS[t.dim as DimensionKey] || t.dim} → ${t.to[0].toFixed(2)}~${t.to[1].toFixed(2)}（${t.reason}）`).join('；')
                    : tuneReport.skippedReason || '暂无可微调项'}
                </div>
              )}
              <div className="flex gap-2 pt-1">
                <button className="btn text-xs" onClick={tuneNow}>立即微调</button>
                <button className="btn text-xs" onClick={tuneReset}>重置微调</button>
              </div>
            </div>
          </section>

          {/* 维度阈值明细（坏维度） */}
          <section>
            <h3 className="text-gray-300 font-bold mb-2">各维度当前生效阈值</h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              {BAD_DIMENSIONS.map((d) => {
                const tuned = settings.tunedThresholds?.[d]
                const scene = SCENE_PRESETS.find((p) => p.key === settings.scene)?.overrides[d]
                const t = tuned || scene || [settings.midThreshold, settings.highThreshold]
                const src = tuned ? '微调' : scene ? '场景' : '全局'
                return (
                  <div key={d} className="flex justify-between text-gray-400 border-b border-line/40 py-0.5">
                    <span>{DIMENSION_LABELS[d]}</span>
                    <span className="tabular-nums">
                      {Number(t[0]).toFixed(2)} ~ {Number(t[1]).toFixed(2)}
                      <span className="text-gray-600 ml-1">({src})</span>
                    </span>
                  </div>
                )
              })}
            </div>
          </section>

          <div className="flex justify-end pt-1">
            <button className="btn-primary" onClick={close}>完成</button>
          </div>
        </div>
      </div>
    </div>
  )
}
