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
import { getSettings, saveSettings, backfillTiers } from './db'
import { setupErrorLogger, getLogRoot, logRendererError } from './logger'
import { dumpCalibration } from './services/calib'
import { harmonizePersonCountOnce } from './services/personHarmony'
import { reclassifyAll, regradeAll, reclusterStored } from './services/scanner'
import { REGRADE_VERSION } from '../shared/types'

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

    // 老库无需重跑 AI：按版本号补跑一次连拍人数一致化（幂等），让渲染层首屏读到的就是修正后的分类
    try {
      harmonizePersonCountOnce()
    } catch (e) {
      console.error('person harmony on startup failed', e)
    }

    // D2 一次性 recompute（版本门控，不重跑引擎）：把旧库"主分类=最坏瑕疵"的行按新规则从已存 tags
    // 重算回人数身份，让 App 在整库重筛前就自洽（交付库/瑕疵片/待确认三档虚视图口径一致）。
    try {
      const st = getSettings()
      if ((st.d2Migration ?? 0) < 1) {
        reclassifyAll()
        saveSettings({ d2Migration: 1 })
        console.log('[d2] 主分类人数化 recompute 完成（旧库 category 从瑕疵维度回落到人数身份）')
      }
    } catch (e) {
      console.error('d2 recompute on startup failed', e)
    }

    // D4 一次性 backfill（版本门控，不重跑引擎）：给存量行按已存 tags 补算交付库档位，
    // 新列上线后旧库立刻有优质/良好/一般分布（重筛后的新行由 updateDetectResult 自动打分）。
    try {
      const st = getSettings()
      if ((st.tierMigration ?? 0) < 1) {
        const n = backfillTiers()
        saveSettings({ tierMigration: 1 })
        console.log(`[d4] 交付库档位 backfill 完成（补算 ${n} 行）`)
      }
    } catch (e) {
      console.error('d4 tier backfill on startup failed', e)
    }

    // 阈值台阶基线一次性重算（版本门控，不重跑引擎）：存量 tags 里的瑕疵 level 是检测时写死的，
    // 不重算的话新基线在界面上完全看不出来（用户会被迫整库重筛才能验证参数）。
    // regrade 之后必须补跑一次重聚类：v4 改了“每组该留哪张”，而代表帧是靠 phash 成组选出来的，
    // 不重聚类存量库里的旧代表帧不会自己换人（窗口建立前跑完，首屏读到的就是新结果）。
    try {
      const st = getSettings()
      if ((st.regradeVersion ?? 0) < REGRADE_VERSION) {
        const n = regradeAll()
        saveSettings({ regradeVersion: REGRADE_VERSION })
        console.log(`[regrade] 按台阶基线重算完成（改动 ${n} 行，未重跑引擎）`)
        try {
          const r = await reclusterStored()
          console.log(`[dup-cluster] 按新权重重选代表帧完成（${r.groups} 组 / 改动 ${r.changed} 张，未重跑引擎）`)
        } catch (e) {
          console.error('dup recluster on startup failed', e)
        }
      }
    } catch (e) {
      console.error('threshold regrade on startup failed', e)
    }

    // 重复组停泊规则一次性补跑（版本门控，不重跑引擎）：2026-10-15 取消“每组必须有一张进交付库”，
    // 但存量库里的旧代表帧不会自己改位置，不补跑的话用户看到的还是老结果（只能整库重筛）。
    // reclusterStored 幂等：只动“组号变了 / 标签该有却没有 / 代表帧还挂着冗余”的行。
    try {
      const st = getSettings()
      if ((st.dupParkMigration ?? 0) < 1) {
        const r = await reclusterStored()
        saveSettings({ dupParkMigration: 1 })
        console.log(`[dup-park] 按新停泊规则重聚类完成（${r.groups} 组 / 改动 ${r.changed} 张，未重跑引擎）`)
      }
    } catch (e) {
      console.error('dup park migration on startup failed', e)
    }

    const iconCandidates = [
      join(process.resourcesPath || '', 'build', 'icon.ico'),
      join(app.getAppPath(), '..', 'build', 'icon.ico'),
      join(__dirname, '..', '..', 'build', 'icon.ico')
    ]
    const winIcon = iconCandidates.find((p) => p && existsSync(p))

    // 默认窗口：屏幕居中，占工作区 90%（小屏不低于最小尺寸，大屏不超工作区）
    const wa = screen.getPrimaryDisplay().workAreaSize
    const winW = Math.max(1024, Math.min(Math.round(wa.width * 0.9), wa.width))
    const winH = Math.max(680, Math.min(Math.round(wa.height * 0.9), wa.height))

    mainWindow = new BrowserWindow({
      width: winW,
      height: winH,
      x: Math.round((wa.width - winW) / 2),
      y: Math.round((wa.height - winH) / 2),
      center: true,
      minWidth: 1024,
      minHeight: 680,
      title: '筛片大师',
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
    // 退出前最后一次校准落盘：带上扫描结束后用户的全部手动纠错（category_by='user'），必须在 closeDb 之前
    dumpCalibration()
    closeDb()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
