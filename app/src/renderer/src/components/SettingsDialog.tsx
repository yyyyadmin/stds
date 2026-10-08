/**
 * 设置对话框（简化版）
 * - 环境检测：AI 引擎状态 / 设备偏好 / 重新筛选
 * - 高级设置（默认折叠）：阈值分档、场景预设、修正学习微调
 * - 版本更新：调用后台 check_update.php（自动按系统携带 platform），有新版给出下载链接
 * - 底部：技术提供署名
 */
import { useEffect, useState } from 'react'
import { useStore } from '../store'
import {
  BAD_DIMENSIONS,
  DIMENSION_LABELS,
  SCENE_PRESETS,
  STRICTNESS_PRESETS,
  deriveStrictness,
  type DimensionKey
} from '../../../shared/types'
import type { EngineStatus } from '../../../main/engine'
import type { TuneReport } from '../../../main/services/tuner'
import type { UpdateInfo } from '../../../shared/ipc'

export default function SettingsDialog(): JSX.Element {
  const close = (): void => useStore.setState({ showSettings: false })
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)
  const rescanAll = useStore((s) => s.rescanAll)
  const appVersion = useStore((s) => s.appVersion)

  const [engine, setEngine] = useState<EngineStatus | null>(null)
  const [stats, setStats] = useState<{ total: number; perDim: Record<string, { falsePositive: number; truePositive: number; total: number }> } | null>(null)
  const [tuneReport, setTuneReport] = useState<TuneReport | null>(null)
  const [advanced, setAdvanced] = useState(false)

  // 版本更新状态
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkFailed, setCheckFailed] = useState(false)

  useEffect(() => {
    void window.api.engineStatus().then(setEngine)
    void window.api.tuneStats().then(setStats)
  }, [])

  const checkUpdate = (): void => {
    setChecking(true)
    setCheckFailed(false)
    void window.api
      .checkUpdate()
      .then((r) => {
        setUpdate(r)
        setCheckFailed(!r)
      })
      .catch(() => setCheckFailed(true))
      .finally(() => setChecking(false))
  }

  const setThreshold = (key: 'highThreshold' | 'midThreshold', v: number): void => {
    const patch: Record<string, number | string> = { [key]: v, strictness: 'custom' }
    if (key === 'midThreshold' && v >= settings.highThreshold) patch.midThreshold = settings.highThreshold - 0.05
    if (key === 'highThreshold' && v <= settings.midThreshold) patch.highThreshold = settings.midThreshold + 0.05
    void saveSettings(patch, true)
  }

  // 检测程度档位：选档即同步写入对应的两个阈值并立即重分桶
  const strictNow = deriveStrictness(settings.highThreshold, settings.midThreshold)
  const applyStrictness = (k: string): void => {
    const p = STRICTNESS_PRESETS.find((x) => x.key === k)
    if (!p) return
    void saveSettings({ strictness: p.key, highThreshold: p.high, midThreshold: p.mid }, true)
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
      <div className="bg-panel border border-line rounded-xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto fade-in">
        <div className="px-5 py-3 border-b border-line flex items-center justify-between sticky top-0 bg-panel z-10">
          <h2 className="text-fg font-bold">设置</h2>
          <button className="btn-ghost text-fg3" onClick={close}>✕</button>
        </div>

        <div className="p-5 space-y-5 text-sm">
          {/* 环境检测 */}
          <section>
            <h3 className="text-fg2 font-bold mb-2">环境检测</h3>
            <div className="grid grid-cols-2 gap-3 mb-2">
              <label className="flex items-center gap-2 text-fg2">
                引擎偏好
                <select className="input flex-1" value={settings.enginePreference}
                  onChange={(e) => void saveSettings({ enginePreference: e.target.value as 'auto' | 'python' | 'node' })}>
                  <option value="auto">自动（Python 优先）</option>
                  <option value="python">仅 Python AI 引擎</option>
                  <option value="node">仅 Node 基础引擎</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-fg2">
                计算设备
                <select className="input flex-1" value={settings.devicePreference}
                  onChange={(e) => void saveSettings({ devicePreference: e.target.value as 'auto' | 'cpu' | 'cuda' })}>
                  <option value="auto">自动检测</option>
                  <option value="cpu">CPU（省电稳定）</option>
                  <option value="cuda">GPU / CUDA（NVIDIA）</option>
                </select>
              </label>
            </div>
            <div className="rounded-md bg-panel2 border border-line p-3 text-xs space-y-1">
              {engine ? (
                <>
                  <div>
                    当前引擎：<b className={engine.type === 'python' ? 'text-good' : 'text-warn'}>
                      {engine.type === 'python'
                        ? (engine.pythonPath && /screener-engine/.test(engine.pythonPath) ? '自带完整 AI 引擎（12 维）' : 'Python 完整 AI 引擎')
                        : engine.type === 'node' ? 'Node 基础引擎（降级模式）' : '未就绪'}
                    </b> · 设备：<b className="text-fg">{engine.device}</b> · 并行进程：<b className="text-fg">{engine.workers}</b>
                  </div>
                  <div className="text-fg3">{engine.message}</div>
                  {engine.type === 'node' && (
                    <div className="text-warn">
                      降级模式仅支持：模糊 / 曝光 / 黑白照 / 重复连拍。人脸类维度（闭眼/斜眼/狰狞/半截头/人数）需完整引擎：
                      发布版已自带 Python 引擎（无需安装）；若本机为开发版，安装 Python 3.9+ 并 pip install -r ai-engine/requirements.txt，
                      或运行 npm run build:engine 生成自带引擎后重启软件即自动升级为 12 维。
                    </div>
                  )}
                </>
              ) : (
                <div className="text-fg3">引擎状态查询中…</div>
              )}
              <div className="pt-1 flex gap-2">
                <button className="btn text-xs" onClick={() => void window.api.engineStatus().then(setEngine)}>刷新状态</button>
                <button className="btn text-xs" onClick={() => { if (confirm('重新筛选将覆盖 AI 判定（您手动修正过的图片与垃圾桶内容会保留）。继续？')) void rescanAll() }}>
                  重新筛选全部图片
                </button>
              </div>
            </div>
          </section>

          {/* 检测程度 + 阈值调整（主区常驻） */}
          <section>
            <h3 className="text-fg2 font-bold mb-2">检测程度</h3>
            <div className="rounded-md bg-panel2 border border-line p-3 space-y-3">
              <label className="flex items-center justify-between gap-3 text-fg2">
                <span className="whitespace-nowrap">严格程度</span>
                <select className="input flex-1" value={strictNow} onChange={(e) => applyStrictness(e.target.value)}>
                  {STRICTNESS_PRESETS.map((p) => (
                    <option key={p.key} value={p.key}>{p.label}（高 {p.high.toFixed(2)} / 中 {p.mid.toFixed(2)}）</option>
                  ))}
                  {strictNow === 'custom' && <option value="custom">自定义（滑条微调过）</option>}
                </select>
              </label>
              <p className="text-xs text-fg3">
                {strictNow === 'custom'
                  ? '当前为自定义阈值；越严格 → 更多照片被拉进待确认/坏维度，越一般 → 误报更少、绝大多数直接进成品库。'
                  : STRICTNESS_PRESETS.find((p) => p.key === strictNow)?.tip}
              </p>
              <div className="space-y-3">
                <div>
                  <div className="flex justify-between text-xs text-fg3">
                    <span>高置信度阈值（&gt; 直接标记进坏维度分类）</span>
                    <b className="text-fg tabular-nums">{settings.highThreshold.toFixed(2)}</b>
                  </div>
                  <input type="range" min={0.5} max={0.99} step={0.01} value={settings.highThreshold}
                    className="w-full accent-red-500"
                    onChange={(e) => setThreshold('highThreshold', Number(e.target.value))} />
                </div>
                <div>
                  <div className="flex justify-between text-xs text-fg3">
                    <span>中置信度下限（介于中和高之间 → 待确认区）</span>
                    <b className="text-fg tabular-nums">{settings.midThreshold.toFixed(2)}</b>
                  </div>
                  <input type="range" min={0.3} max={0.95} step={0.01} value={settings.midThreshold}
                    className="w-full accent-yellow-500"
                    onChange={(e) => setThreshold('midThreshold', Number(e.target.value))} />
                </div>
                <p className="text-xs text-fg3">
                  低于 {settings.midThreshold.toFixed(2)} 的判定不标记，图片默认留在成品库。调整阈值/严格程度<b>无需重新检测</b>，立即按已存的原始置信度重新分桶。
                </p>
              </div>
            </div>
          </section>

          {/* 高级设置（默认折叠） */}
          <section>
            <button className="w-full flex items-center justify-between text-fg2 font-bold" onClick={() => setAdvanced((v) => !v)}>
              <span>高级设置（场景 / 修正学习）</span>
              <span className="text-fg3">{advanced ? '▲ 收起' : '▼ 展开'}</span>
            </button>
            {advanced && (
              <div className="mt-3 space-y-5">
                {/* 场景预设 */}
                <div>
                  <h4 className="text-fg2 font-bold mb-2">场景预设</h4>
                  <div className="grid grid-cols-2 gap-2">
                    {SCENE_PRESETS.map((p) => (
                      <button
                        key={p.key}
                        className={
                          'px-3 py-2 rounded-md border text-left ' +
                          (settings.scene === p.key ? 'border-brand bg-brand/10 text-brand' : 'border-line bg-panel2 text-fg2 hover:text-fg')
                        }
                        onClick={() => void saveSettings({ scene: p.key }, true)}
                        title={Object.entries(p.overrides).map(([d, v]) => `${DIMENSION_LABELS[d as DimensionKey]}: ${v[0]}~${v[1]}`).join('\n') || '使用全局阈值'}
                      >
                        <div className="font-bold">{p.label}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* 修正学习 */}
                <div>
                  <h4 className="text-fg2 font-bold mb-2">修正学习 · 阈值微调</h4>
                  <label className="flex items-center gap-2 text-fg2 mb-2 cursor-pointer">
                    <input type="checkbox" checked={settings.autoTune} onChange={(e) => void saveSettings({ autoTune: e.target.checked })} />
                    修正记录积累后自动微调阈值
                  </label>
                  <div className="rounded-md bg-panel2 border border-line p-3 text-xs space-y-2">
                    <div className="text-fg3">
                      累计修正记录：<b className="text-fg tabular-nums">{stats?.total ?? '…'}</b> 条（达到 200 条后生效）
                    </div>
                    {stats && Object.keys(stats.perDim).length > 0 && (
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                        {Object.entries(stats.perDim)
                          .sort((a, b) => b[1].total - a[1].total)
                          .slice(0, 8)
                          .map(([d, s]) => (
                            <div key={d} className="flex justify-between text-fg3">
                              <span>{DIMENSION_LABELS[d as DimensionKey] || d}</span>
                              <span className="tabular-nums">
                                误判 {s.falsePositive} / 正确 {s.truePositive}
                              </span>
                            </div>
                          ))}
                      </div>
                    )}
                    {tuneReport && (
                      <div className="text-fg2">
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
                </div>

                {/* 维度阈值明细 */}
                <div>
                  <h4 className="text-fg2 font-bold mb-2">各维度当前生效阈值</h4>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    {BAD_DIMENSIONS.map((d) => {
                      const tuned = settings.tunedThresholds?.[d]
                      const scene = SCENE_PRESETS.find((p) => p.key === settings.scene)?.overrides[d]
                      const t = tuned || scene || [settings.midThreshold, settings.highThreshold]
                      const src = tuned ? '微调' : scene ? '场景' : '全局'
                      return (
                        <div key={d} className="flex justify-between text-fg3 border-b border-line/40 py-0.5">
                          <span>{DIMENSION_LABELS[d]}</span>
                          <span className="tabular-nums">
                            {Number(t[0]).toFixed(2)} ~ {Number(t[1]).toFixed(2)}
                            <span className="text-fg3 opacity-60 ml-1">({src})</span>
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* 版本更新 */}
          <section>
            <h3 className="text-fg2 font-bold mb-2">版本更新</h3>
            <div className="rounded-md bg-panel2 border border-line p-3 text-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-fg2">
                  当前版本：<b className="text-fg tabular-nums">v{update?.current_version || appVersion || '—'}</b>
                  <span className="text-fg3 ml-2">{update ? `（${update.platform === 'windows' ? 'Windows' : update.platform === 'arm' ? 'macOS Apple 芯片' : 'macOS Intel'}）` : ''}</span>
                </span>
                <button className="btn text-xs" disabled={checking} onClick={checkUpdate}>
                  {checking ? '检查中…' : '检查更新'}
                </button>
              </div>
              {checkFailed && <div className="text-bad">检查失败：请确认网络后重试</div>}
              {update && !update.has_update && !checkFailed && !checking && (
                <div className="text-good">已是最新版本 ✓</div>
              )}
              {update && update.has_update && (
                <div className="space-y-2">
                  <div className="text-fg">
                    🎉 发现新版本 <b className="text-brand tabular-nums">v{update.latest_version}</b>
                    {update.file_size_mb ? <span className="text-fg3 ml-2">约 {update.file_size_mb.toFixed(0)} MB</span> : null}
                  </div>
                  {update.notes && <div className="text-fg3 whitespace-pre-wrap">更新内容：{update.notes}</div>}
                  {update.download_url && (
                    <button
                      className="btn-primary text-xs"
                      onClick={() => void window.api.openExternal(update.download_url as string)}
                    >
                      ⬇ 下载新版本安装包
                    </button>
                  )}
                  <div className="text-fg3">下载后运行安装包即可完成升级覆盖，图库与修正记录保留。</div>
                </div>
              )}
            </div>
          </section>

          {/* ④ 数据管理：清缓存（含重试解码失败项）/ 清图库重新开始 */}
          <section>
            <h3 className="text-sm font-semibold mb-2 text-fg">数据管理</h3>
            <div className="rounded-md bg-panel2 border border-line p-3 text-xs">
              <div className="flex items-center justify-between gap-3">
                <div className="text-fg3 min-w-0">清除缓存：重建全部缩略图，并重试之前提示“无法解码”的照片（如 CR3/ARW），已有的检测分类结果保留。清空图库已移至顶栏「导入文件夹」旁。</div>
                <button className="btn text-xs whitespace-nowrap" onClick={() => void useStore.getState().clearCacheAll()}>
                  清除缓存
                </button>
              </div>
            </div>
          </section>

          {/* 底部 */}
          <div className="pt-1 flex flex-col items-center gap-3">
            <button className="btn-primary w-40" onClick={close}>完成</button>
            <div className="text-xs text-fg3">技术提供：唐古拉网络</div>
          </div>
        </div>
      </div>
    </div>
  )
}
