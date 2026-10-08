/**
 * Electron 主进程入口
 * - 单实例锁
 * - 窗口 + 安全策略（contextIsolation，无 nodeIntegration）
 * - localfile:// 自定义协议：渲染层展示本地缩略图/大图（dev http 与生产 file 均可用）
 */
import { app, BrowserWindow, shell, protocol, net } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { pathToFileURL } from 'url'
import { initDbAsync } from './db'
import { flushDb, closeDb } from './sqlite'
import { registerIpc } from './ipc'
import { engineManager } from './engine'
import { pruneMissing } from './services/importer'
import { getSettings } from './db'

// 特权 scheme 必须在 ready 之前注册
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'localfile',
    privileges: { stream: true, bypassCSP: true, supportFetchAPI: true, standard: false }
  }
])

let mainWindow: BrowserWindow | null = null

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    // 格式：localfile://x/<encodeURIComponent(绝对路径)>
    protocol.handle('localfile', (req) => {
      const prefix = 'localfile://x/'
      const raw = req.url.startsWith(prefix) ? req.url.slice(prefix.length) : decodeURIComponent(req.url)
      const p = decodeURIComponent(raw).replace(/^\//, '') // Windows 盘符前导斜杠兼容
      return net.fetch(pathToFileURL(p).href)
    })

    await initDbAsync()
    pruneMissing()

    const iconCandidates = [
      join(process.resourcesPath || '', 'build', 'icon.ico'),
      join(app.getAppPath(), '..', 'build', 'icon.ico'),
      join(__dirname, '..', '..', 'build', 'icon.ico')
    ]
    const winIcon = iconCandidates.find((p) => p && existsSync(p))

    mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1024,
      minHeight: 680,
      title: '筛图大师',
      icon: winIcon,
      backgroundColor: '#f5f6f8',
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webSecurity: true
      }
    })

    registerIpc(mainWindow)

    // 外部链接交给系统浏览器
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })

    if (process.env.ELECTRON_RENDERER_URL) {
      mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }

    // 后台预热引擎（不阻塞 UI）
    setTimeout(() => {
      const s = getSettings()
      engineManager.init(s.enginePreference, s.devicePreference).catch(() => undefined)
    }, 1500)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) app.relaunch()
    })
  })

  app.on('before-quit', () => {
    engineManager.shutdown()
    flushDb()
    closeDb()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
