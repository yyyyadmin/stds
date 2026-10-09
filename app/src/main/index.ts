/**
 * Electron 主进程入口
 * - 单实例锁
 * - 窗口 + 安全策略（contextIsolation，无 nodeIntegration）
 * - localfile:// 自定义协议：渲染层展示本地缩略图/大图（dev http 与生产 file 均可用）
 */
import { app, BrowserWindow, shell, protocol, net, screen } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { pathToFileURL } from 'url'
import { initDbAsync } from './db'
import { flushDb, closeDb } from './sqlite'
import { registerIpc } from './ipc'
import { engineManager } from './engine'
import { pruneMissing } from './services/importer'
import { getSettings } from './db'
import { setupErrorLogger, getLogRoot, logRendererError } from './logger'

// 尽早安装错误日志（捕获启动期异常），在所有逻辑之前
setupErrorLogger()
console.log('[logger] 错误日志目录:', getLogRoot())

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

    // 默认窗口：屏幕居中，占工作区 80%（小屏不低于最小尺寸，大屏不超工作区）
    const wa = screen.getPrimaryDisplay().workAreaSize
    const winW = Math.max(1024, Math.min(Math.round(wa.width * 0.8), wa.width))
    const winH = Math.max(680, Math.min(Math.round(wa.height * 0.8), wa.height))

    mainWindow = new BrowserWindow({
      width: winW,
      height: winH,
      x: Math.round((wa.width - winW) / 2),
      y: Math.round((wa.height - winH) / 2),
      center: true,
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

    // 渲染进程控制台 error 汇入主进程错误日志（兼容 Electron 33 对象签名与旧版位参签名）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mainWindow.webContents.on('console-message', ((...a: any[]) => {
      const first = a[0]
      let level: number | string | undefined
      let message = ''
      let source: string | undefined
      let line: number | undefined
      if (first && typeof first === 'object' && a.length === 1 && 'level' in first) {
        level = first.level
        message = first.message ?? ''
        source = first.location?.filePath ?? first.sourceId
        line = first.location?.lineNumber
      } else {
        // 旧版：(event, level, message, line, sourceId)
        level = a[1]
        message = a[2] ?? ''
        line = a[3]
        source = a[4]
      }
      const isError = level === 3 || level === 'error'
      if (isError && message) logRendererError(String(message), source, line)
    }) as (...args: unknown[]) => void)

    // 外部链接交给系统浏览器
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })

    // 白屏防护一：禁止任何页面外导航（拖拽图片/文件落到窗口时 Chromium 会尝试导航到该文件 → 整页白屏）
    const selfUrl = () => process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href
    mainWindow.webContents.on('will-navigate', (e, url) => {
      if (url !== selfUrl()) e.preventDefault()
    })
    // 白屏防护二：渲染进程崩溃（GPU 等）时自动恢复，不依赖用户重启
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      console.error('[renderer] process gone:', details.reason, details.exitCode, '- auto reloading')
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload()
      }, 300)
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
