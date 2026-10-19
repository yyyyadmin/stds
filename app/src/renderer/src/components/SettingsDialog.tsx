/**
 * 设置对话框（简化版）
 * - 环境检测：AI 引擎状态 / 设备偏好 / 重新筛选
 * - 交付库档位目录名：三档子文件夹名可自定义
 * - 判定线：v7 阈值锁定后由代码基线表统一标定，本对话框不再有阈值/力度/自学习控件（tuneNow 等通道已撤，学习逻辑留在 services/tuner.ts 供离线标定参考）
 * - 版本更新：调用后台 check_update.php（自动按系统携带 platform），有新版给出下载链接
 * - 底部：技术提供署名
 */
import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { effectiveUiScale } from '../uiScale'
import type { UiScaleSetting } from '../uiScale'
import { DEFAULT_TIER_NAMES } from '../../../shared/types'
import type { EngineStatus } from '../../../main/engine'
import type { UpdateInfo } from '../../../shared/ipc'

export default function SettingsDialog(): JSX.Element {
  const close = (): void => useStore.setState({ showSettings: false })
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)
  const rescanAll = useStore((s) => s.rescanAll)
  const appVersion = useStore((s) => s.appVersion)
  const perfHint = useStore((s) => s.perfHint)
  const perfAutoLean = useStore((s) => s.perfAutoLean)

  const [engine, setEngine] = useState<EngineStatus | null>(null)
  // 档位目录名草稿（D4）：失焦/回车时保存，留空回退默认名
  const [tierDraft, setTierDraft] = useState<string[] | null>(null)

  // 版本更新状态
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkFailed, setCheckFailed] = useState(false)

  useEffect(() => {
    void window.api.engineStatus().then(setEngine)
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
              {/* 两列 grid 每列仅 ~290px：select 必须 min-w-0 + truncate 才能缩到选项文字
                  的最小内容宽度以下，否则长选项（"GPU / CUDA（NVIDIA）"）会把左边标签
                  挤成两行（用户实测 2026-10-11）；选中的长文案靠 title 悬停看全 */}
              <label className="flex items-center gap-2 text-fg2 min-w-0">
                <span className="whitespace-nowrap">引擎偏好</span>
                <select className="input flex-1 min-w-0 truncate" value={settings.enginePreference}
                  onChange={(e) => void saveSettings({ enginePreference: e.target.value as 'auto' | 'python' | 'node' })}>
                  <option value="auto">自动（Python 优先）</option>
                  <option value="python">仅 Python AI 引擎</option>
                  <option value="node">仅 Node 基础引擎</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-fg2 min-w-0">
                <span className="whitespace-nowrap">计算设备</span>
                <select className="input flex-1 min-w-0 truncate" value={settings.devicePreference}
                  onChange={(e) => void saveSettings({ devicePreference: e.target.value as 'auto' | 'cpu' | 'cuda' })}>
                  <option value="auto">自动检测</option>
                  <option value="cpu">CPU（省电稳定）</option>
                  <option value="cuda">GPU / CUDA（NVIDIA）</option>
                </select>
              </label>
            </div>
            {/* 性能模式（第二档 A1）：默认自动——只有探测到低配（≤ 4 核 / < 8G / 软件渲染）才精简；
                精简只砍动画毛玻璃并强制小档缩略图，功能一项不少。好机器上选了也白选，故给出手动档 */}
            <label className="flex items-center gap-2 text-fg2 min-w-0 mb-2" title="精简只去掉动画过渡、毛玻璃等装饰效果并强制用小档缩略图，功能不变；低配机器启动时会自动精简">
              <span className="whitespace-nowrap">性能模式</span>
              <select className="input flex-1 min-w-0 truncate" value={settings.perfMode ?? 'auto'}
                onChange={(e) => void saveSettings({ perfMode: e.target.value as 'auto' | 'full' | 'lean' })}>
                <option value="auto">自动（低配机器自动精简）</option>
                <option value="full">全特效（低配也不精简）</option>
                <option value="lean">精简（好机器也追求更跟手）</option>
              </select>
            </label>
            {/* 界面缩放：整屏等比例缩（文字/按钮/标签/格子一起缩，比例不变）。
                小屏笔记本上“字大图小标签挤不下”的兼容开关；4K 大屏自动保持 100% 不动 */}
            <label className="flex items-center gap-2 text-fg2 min-w-0 mb-2" title="整个界面等比例放大缩小：文字、按钮、标签、图片格子一起缩，比例不变。自动档按屏幕分辨率选：小屏笔记本缩到 85~90%，大屏保持 100%">
              <span className="whitespace-nowrap">界面缩放</span>
              <select className="input flex-1 min-w-0 truncate" value={settings.uiScale ?? 'auto'}
                onChange={(e) => void saveSettings({ uiScale: e.target.value as UiScaleSetting })}>
                <option value="auto">自动（按屏幕大小）</option>
                <option value="80%">80%</option>
                <option value="85%">85%</option>
                <option value="90%">90%</option>
                <option value="100%">100%（原始大小）</option>
              </select>
            </label>
            <div className="text-xs text-fg3 mb-2">
              当前实际缩放：约 {Math.round(effectiveUiScale(settings.uiScale) * 100)}%
              {!settings.uiScale || settings.uiScale === 'auto' ? '（自动档：屏幕越小缩得越多，按屏幕分辨率定，拖窗口不会反复变）' : '（已手动钉死，不再随屏幕变化）'}
            </div>
            {/* 本机档位常驻展示（与下拉选项无关）：用户要的是“知道自己的电脑是什么级别”，
                哪怕手动选了全特效/精简，探测结论也照实说。层级靠排版：小字浅色fg3，
                只有结论那一个词着色 */}
            <div className="text-xs text-fg3 mb-2">
              {perfHint ? (
                <>
                  本机探测：{perfHint.cores} 核 · {Math.round(perfHint.memGB)}GB 内存 ·{' '}
                  {perfHint.gpuSoftware ? '软件渲染' : '硬件加速渲染'} ——{' '}
                  <b className={perfAutoLean ? 'text-warn' : 'text-good'}>{perfAutoLean ? '低配（选自动会精简）' : '高配（选自动保全特效）'}</b>
                </>
              ) : (
                '本机档位：启动时探测中，稍后重开设置可见'
              )}
            </div>
            <div className="rounded-md bg-panel2 border border-line p-3 text-xs space-y-1">
              {engine ? (
                <>
                  {/* 用户 10-18 拍板：只留“当前引擎”这一整行，下面那行 message 解释与降级长文说明全取消——
                      引擎状态顶栏徽章已会直接报“运行中/引擎异常”，设置里不再重复铺文字。 */}
                  <div>
                    当前引擎：<b className={engine.type === 'python' ? 'text-good' : engine.type === 'node' ? 'text-warn' : 'text-fg'}>
                      {engine.type === 'python'
                        ? (engine.pythonPath && /screener-engine/.test(engine.pythonPath) ? '自带完整 AI 引擎（12 维）' : 'Python 完整 AI 引擎')
                        : engine.type === 'node' ? 'Node 基础引擎（降级模式）' : '系统检测环境加载中'}
                    </b> · 设备：<b className="text-fg">{engine.device}</b> · 并行进程：<b className="text-fg">{engine.workers}</b>
                  </div>
                </>
              ) : (
                <div className="text-fg3">引擎状态查询中…</div>
              )}
              <div className="pt-1 flex gap-2">
                <button className="btn text-xs" onClick={() => void window.api.engineStatus().then(setEngine)}>刷新状态</button>
                <button
                  className="btn text-xs"
                  onClick={() => {
                    if (confirm('重新筛选会先把上一轮的 AI 分类清零重算（您手动放置的图片、手动加的标签，以及废弃库/废弃桶内容都会保留不受影响）。继续？')) void rescanAll()
                  }}
                >
                  重新筛选全部图片
                </button>
              </div>
            </div>
          </section>

          {/* 交付库档位目录名（D4）：侧栏三行子档与导出二级子目录共用这几个名字，
              改完立即可见（无需重筛）；导出时按 交付库/优质|良好|一般/ 分 folder。
              v3：档位的依据已从“离瑕疵线多远”换成引擎实测清晰度，无需重跑引擎即可重算 */}
          <section>
            <h3 className="text-fg2 font-bold mb-2">交付库档位目录名</h3>
            <div className="rounded-md bg-panel2 border border-line p-3 space-y-2">
              <div className="flex items-center gap-2">
                {(tierDraft ?? settings.tierNames ?? DEFAULT_TIER_NAMES).map((n, i) => (
                  <input
                    key={i}
                    className="input flex-1 min-w-0 text-sm"
                    value={n}
                    maxLength={12}
                    onChange={(e) => {
                      const base = [...(tierDraft ?? settings.tierNames ?? DEFAULT_TIER_NAMES)]
                      base[i] = e.target.value
                      setTierDraft(base)
                    }}
                    onBlur={() => {
                      if (!tierDraft) return
                      const next = tierDraft.map((x, i) => x.trim() || DEFAULT_TIER_NAMES[i])
                      setTierDraft(null)
                      void saveSettings({ tierNames: next })
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    }}
                  />
                ))}
              </div>
              <p className="text-xs text-fg3">三档按引擎实测的<b>画面清晰度</b>（细节量 + 高频占比）排队，侧栏与导出子目录共用这几个名字（如改成 精修/初修/直出）。它只告诉你先看哪批，<b>不影响哪张照片被拦下来</b>；拿不到清晰度实测的老图一律先归中间档，不擅自抬也不擅自压。</p>
            </div>
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
                <div className="text-fg3 min-w-0">清除缓存：一次清掉缩略图、大图预览、AI 中间图、运行日志和程序缓存（都会自动重建），并重试之前提示“无法解码”的照片（如 CR3/ARW）。图库、检测分类结果与登录状态保留。安装/升级新版本后软件会自动清一次，不必手动点。清空图库已移至顶栏「导入文件夹」旁。</div>
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
