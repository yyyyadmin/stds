/**
 * 启动自动更新弹窗：检测到新版本时弹出，一键跳转下载新版安装包。
 * - 「立即下载」用系统浏览器打开后台返回的对应平台安装包地址（保留图库/修正记录，覆盖安装即可）
 * - 「跳过此版本」记住 latest_version，同一版本不再自动弹（下次发新版仍会弹）
 */
import { useStore } from '../store'

export default function UpdateDialog(): JSX.Element | null {
  const info = useStore((s) => s.updateInfo)
  const appVersion = useStore((s) => s.appVersion)
  const saveSettings = useStore((s) => s.saveSettings)
  if (!info || !info.has_update || !info.latest_version) return null

  const close = (): void => useStore.setState({ showUpdate: false })
  const skip = (): void => {
    void saveSettings({ skipUpdateVersion: info.latest_version as string })
    close()
  }
  const download = (): void => {
    if (info.download_url) void window.api.openExternal(info.download_url)
  }

  const plat =
    info.platform === 'windows'
      ? 'Windows'
      : info.platform === 'arm'
        ? 'macOS（Apple 芯片）'
        : info.platform === 'mac'
          ? 'macOS（Intel）'
          : ''

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="bg-panel border border-line rounded-xl shadow-2xl w-full max-w-md fade-in">
        <div className="px-5 py-3 border-b border-line flex items-center gap-2">
          <span className="text-lg">🎉</span>
          <h2 className="text-fg font-bold">发现新版本</h2>
          {plat && <span className="ml-auto text-xs text-fg3">{plat}</span>}
        </div>

        <div className="p-5 space-y-3 text-sm">
          <div className="text-fg">
            新版本 <b className="text-brand tabular-nums">v{info.latest_version}</b>
            <span className="text-fg3 ml-2 tabular-nums">（当前 v{info.current_version || appVersion || '—'}）</span>
            {info.file_size_mb ? <span className="text-fg3 ml-2">约 {info.file_size_mb.toFixed(0)} MB</span> : null}
          </div>
          {info.notes && (
            <div className="rounded-md bg-panel2 border border-line p-3 text-fg2 max-h-48 overflow-y-auto whitespace-pre-wrap leading-relaxed">
              {info.notes}
            </div>
          )}
          <div className="text-fg3 text-xs">下载后运行安装包覆盖安装即可升级，图库与修正记录自动保留。</div>

          <div className="flex items-center justify-between pt-1 gap-2">
            <button className="btn text-xs" onClick={skip} title="跳过此版本，下次发布更新时再提醒">
              跳过此版本
            </button>
            <div className="flex items-center gap-2">
              <button className="btn-ghost text-fg3 text-xs" onClick={close}>
                稍后再说
              </button>
              <button className="btn-primary text-sm px-4 py-1.5 disabled:opacity-50" onClick={download} disabled={!info.download_url}>
                ⬇ 立即下载
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
