/**
 * IPC 注册：串联渲染层与主进程服务
 */
import { ipcMain, dialog, shell, app } from 'electron'
import type { BrowserWindow } from 'electron'
import { renameSync, existsSync, mkdirSync } from 'fs'
import { basename, join } from 'path'
import { CH, type BootstrapInfo, type CorrectRequest, type MoveRequest } from '../shared/ipc'
import {
  listByCategory,
  getImage,
  categoryCounts,
  setCategory,
  deleteImages,
  addCorrection,
  correctionStats,
  totalCorrections,
  listCustomCategories,
  addCustomCategory,
  removeCustomCategory,
  getSettings,
  saveSettings,
  setDimTag,
  setSortOrder,
  getDb,
  clearLibrary,
  resetSkipped
} from './db'
import { scanner, reclassifyAll, type ScanProgress } from './services/scanner'
import { exporter, type ExportOptions } from './services/exporter'
import { importPaths, backfillThumbnails, clearThumbCache } from './services/importer'
import { ensureBigPreview, clearBigCache } from './services/big'
import { authManager } from './services/auth'
import { engineManager } from './engine'
import { autoTune, resetTuned, TUNE_MIN_CORRECTIONS } from './services/tuner'
import { CAT_LIBRARY, CAT_TRASH, isBadDim, BAD_DIMENSIONS, SUPPORTED_EXTS, type DimensionKey, type ImageRecord } from '../shared/types'

export function registerIpc(win: BrowserWindow): void {
  const send = (ch: string, ...args: unknown[]) => {
    if (!win.isDestroyed()) win.webContents.send(ch, ...args)
  }
  let importCancelRequested = false

  // 事件桥接
  scanner.on('progress', (p: ScanProgress) => {
    send(CH.E_scanProgress, p)
    if (!p.running && (p.phase === 'done' || p.phase === 'stopped')) {
      // 筛选结束自动尝试阈值微调（第五章 5.4）
      const s = getSettings()
      if (s.autoTune && totalCorrections() >= TUNE_MIN_CORRECTIONS) {
        try {
          autoTune()
        } catch {
          /* ignore */
        }
      }
      // 积分消费（API 文档 3.3）：本次实际处理张数，会员免扣
      if (p.done > 0 && authManager.state().loggedIn) {
        void authManager
          .consume(p.done)
          .then((r) => send(CH.E_authChanged, authManager.state(), r))
          .catch(() => undefined)
      }
    }
  })
  scanner.on('image', (img) => send(CH.E_scanImage, img))
  exporter.on('progress', (p) => send(CH.E_exportProgress, p))

  ipcMain.handle(CH.appBootstrap, (): BootstrapInfo => ({
    settings: getSettings(),
    counts: categoryCounts(),
    customCategories: listCustomCategories(),
    engine: engineManager.getStatus(),
    progress: scanner.getProgress(),
    version: app.getVersion(),
    platform: process.platform
  }))

  ipcMain.handle(CH.pickFolder, async () => {
    const r = await dialog.showOpenDialog(win, { title: '选择照片文件夹', properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  // 多选图片：单张、Ctrl/Shift 多张均可；后端 importPaths 同时兼容文件与目录
  ipcMain.handle(CH.pickImages, async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择照片（可多选，支持 RAW/HEIC）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '图片', extensions: SUPPORTED_EXTS.map((x) => x.slice(1)) },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    return r.canceled ? null : r.filePaths
  })

  ipcMain.handle(CH.importPaths, async (_e, paths: string[]) => {
    importCancelRequested = false
    const r = await importPaths(paths, (p) => send(CH.E_importProgress, p), () => importCancelRequested)
    importCancelRequested = false
    // 秒入库后，后台低优先级回填缩略图，逐批通知渲染层刷新 + 上报进度
    runBackfill(send)
    return r
  })
  ipcMain.handle(CH.importCancel, () => {
    importCancelRequested = true
  })

  ipcMain.handle(CH.listImages, (_e, filter: { category?: string; status?: string }) => {
    if (filter.category) return listByCategory(filter.category)
    return listByCategory('all')
  })

  ipcMain.handle(CH.imageGet, (_e, id: number) => getImage(id))

  ipcMain.handle(CH.categoryCounts, () => categoryCounts())

  // 移动（逻辑/物理），9.3
  ipcMain.handle(CH.moveImages, (_e, req: MoveRequest) => {
    const s = getSettings()
    void s
    for (const id of req.ids) {
      const rec = getImage(id)
      if (!rec) continue
      if (req.physical && req.category !== CAT_TRASH) {
        // 物理移动：移动到 <原目录>/筛图结果/<分类名>/
        try {
          const label = exporter.categoryLabel(req.category)
          const targetDir = join(rec.dir, '筛图结果', label.replace(/[\\/:*?"<>|]/g, '_'))
          mkdirSync(targetDir, { recursive: true })
          const target = join(targetDir, basename(rec.path))
          if (!existsSync(target)) {
            renameSync(rec.path, target)
            getDb().prepare('UPDATE images SET path = ?, dir = ?, filename = ? WHERE id = ?').run(target, targetDir, basename(target), id)
          }
        } catch {
          /* 物理移动失败退回逻辑移动 */
        }
      }
      // 移入成品库/中性分类时可清除对应坏标签；移入坏维度分类时补一个高置信用户标签
      if (req.clearBadTags) {
        for (const dim of Object.keys(rec.tags)) {
          if (isBadDim(dim)) setDimTag(id, dim as DimensionKey, null)
        }
      }
      setCategory(id, req.category, 'user')
      addCorrection({
        imageId: id,
        origDim: isBadDim(rec.category) ? rec.category : null,
        origConfidence: isBadDim(rec.category) ? rec.tags[rec.category as DimensionKey]?.confidence ?? null : null,
        newCategory: req.category,
        action: 'wrong',
        timestamp: Date.now()
      })
    }
    send(CH.E_scanProgress, scanner.getProgress())
  })

  // 撤回移动：按移动前快照原样还原分类/标签/categoryBy（不做反向推断）
  ipcMain.handle(CH.restoreImages, (_e, snapshots: ImageRecord[]) => {
    for (const rec of snapshots) {
      getDb()
        .prepare('UPDATE images SET category = ?, category_by = ?, tags = ?, status = ? WHERE id = ?')
        .run(rec.category, rec.categoryBy, JSON.stringify(rec.tags), rec.status, rec.id)
    }
  })

  ipcMain.handle(CH.deleteImages, (_e, ids: number[]) => deleteImages(ids))

  // 手动拖拽排序：按传入 id 顺序持久化 sort_order
  ipcMain.handle(CH.reorderImages, (_e, ids: number[]) => setSortOrder(ids))

  // 一键修正（第五章）
  ipcMain.handle(CH.correctImage, (_e, req: CorrectRequest) => {
    const rec = getImage(req.imageId)
    if (!rec) return null
    if (req.action === 'correct') {
      // 判定正确：保留分类，写修正记录，积累学习
      addCorrection({
        imageId: rec.id,
        origDim: req.origDim,
        origConfidence: req.origConfidence,
        newCategory: rec.category,
        action: 'correct',
        timestamp: Date.now()
      })
      return rec
    }
    // 判定错误：按目标面板选择移动
    const target = req.targetCategory || CAT_LIBRARY
    if (target !== rec.category) {
      if (isBadDim(target)) {
        setDimTag(rec.id, target as DimensionKey, { confidence: 1, level: 'high', reason: '用户修正指定', method: 'user' })
      } else if (req.origDim && isBadDim(req.origDim)) {
        setDimTag(rec.id, req.origDim as DimensionKey, null)
      }
      setCategory(rec.id, target, 'user')
    } else if (req.origDim && isBadDim(req.origDim)) {
      setDimTag(rec.id, req.origDim as DimensionKey, null)
      setCategory(rec.id, target, 'user')
    }
    addCorrection({
      imageId: rec.id,
      origDim: req.origDim,
      origConfidence: req.origConfidence,
      newCategory: target,
      action: 'wrong',
      timestamp: Date.now()
    })
    send(CH.E_scanProgress, scanner.getProgress())
    return getImage(rec.id)
  })

  ipcMain.handle(CH.customList, () => listCustomCategories())
  ipcMain.handle(CH.customAdd, (_e, name: string) => addCustomCategory(name))
  ipcMain.handle(CH.customRemove, (_e, id: number) => removeCustomCategory(id))

  ipcMain.handle(CH.settingsGet, () => getSettings())
  ipcMain.handle(CH.settingsSave, (_e, s: Partial<import('../shared/types').AppSettings>) => {
    saveSettings(s)
    // 阈值变化：无需重新检测，直接按现存标签重算分档（第四章 4.3）
    if (s.highThreshold !== undefined || s.midThreshold !== undefined || s.scene !== undefined || s.tunedThresholds !== undefined) {
      reclassifyAll()
    }
    return getSettings()
  })

  ipcMain.handle(CH.scanStart, () => scanner.start())
  ipcMain.handle(CH.scanStop, () => scanner.stop())
  ipcMain.handle(CH.scanProgress, () => scanner.getProgress())
  ipcMain.handle(CH.scanRescanAll, () => {
    getDb().prepare(`UPDATE images SET status = 'pending' WHERE status != 'skip' AND NOT (category = 'trash' AND category_by = 'user')`).run()
    return scanner.start()
  })
  ipcMain.handle(CH.reclassify, () => reclassifyAll())

  ipcMain.handle(CH.exportPreview, (_e, opts: ExportOptions) => exporter.previewCount(opts))
  ipcMain.handle(CH.exportRun, (_e, opts: ExportOptions) => exporter.run(opts))
  ipcMain.handle(CH.exportCancel, () => exporter.cancel())

  ipcMain.handle(CH.engineStatus, () => engineManager.getStatus())
  ipcMain.handle(CH.tuneNow, () => autoTune())
  ipcMain.handle(CH.tuneReset, () => resetTuned())
  ipcMain.handle(CH.tuneStats, () => ({
    total: totalCorrections(),
    perDim: correctionStats()
  }))

  ipcMain.handle(CH.fileUrl, (_e, p: string) => 'localfile://x/' + encodeURIComponent(p))
  ipcMain.handle(CH.revealInFolder, (_e, p: string) => shell.showItemInFolder(p))

  // ---------- 账号 / 会员 / 积分 ----------
  ipcMain.handle(CH.authBootstrap, () => authManager.bootstrap())
  ipcMain.handle(CH.authSendCaptcha, (_e, req: { phone?: string; email?: string; type: string }) => authManager.sendCaptcha(req))
  ipcMain.handle(CH.authRegister, (_e, req: { phone?: string; email?: string; password: string; code: string }) => authManager.register(req))
  ipcMain.handle(CH.authLogin, async (_e, account: string, password: string) => {
    const state = await authManager.login(account, password)
    send(CH.E_authChanged, state)
    return state
  })
  ipcMain.handle(CH.authLogout, () => {
    const state = authManager.logout()
    send(CH.E_authChanged, state)
    return state
  })
  ipcMain.handle(CH.authMe, async () => {
    const state = await authManager.me()
    send(CH.E_authChanged, state)
    return state
  })
  ipcMain.handle(CH.plansList, () => authManager.plans())
  ipcMain.handle(CH.orderCreate, (_e, productType: string, productId: string) => authManager.createOrder(productType, productId))
  ipcMain.handle(CH.sysConfig, () => authManager.config())
  ipcMain.handle(CH.consumePoints, async (_e, count: number) => {
    const r = await authManager.consume(count)
    send(CH.E_authChanged, authManager.state(), r)
    return r
  })
  ipcMain.handle(CH.checkUpdate, () => authManager.checkUpdate())
  ipcMain.handle(CH.openExternal, (_e, url: string) => {
    // 仅允许 http/https，防止任意协议注入
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url)
    return undefined
  })

  // ---------- 数据管理（问题一/四） ----------
  ipcMain.handle(CH.libraryClear, () => {
    const cleared = clearLibrary()
    clearThumbCache()
    return { cleared }
  })
  ipcMain.handle(CH.cacheClear, () => {
    const retried = resetSkipped() // “无法解码”项重置为待处理，重试新版 RAW 内嵌预览提取
    const files = clearThumbCache()
    getDb().prepare(`UPDATE images SET thumb = ''`).run() // 缓存文件已删，清空指向以触发全量重建
    runBackfill(send)
    return { retried, files }
  })

  // RAW/HEIC 大图原图高清预览（普通格式直接用原文件，不走这里）
  ipcMain.handle(CH.bigPreview, (_e, id: number) => ensureBigPreview(id))

  // 一次性迁移：旧版缩略图未应用 EXIF 方向（竖拍被显示成横拍）。升级后清空缩略图缓存
  // 并重置指向，触发全量重建为正确方向；仅跑一次（thumbOrientVersion 记录已迁移）。
  const THUMB_ORIENT_VERSION = 3
  if (getSettings().thumbOrientVersion !== THUMB_ORIENT_VERSION) {
    clearThumbCache()
    clearBigCache() // 旧版 RAW/HEIC 大图预览也是侧躺的，一并清掉强制重建
    getDb().prepare(`UPDATE images SET thumb = ''`).run()
    saveSettings({ thumbOrientVersion: THUMB_ORIENT_VERSION })
  }

  // 启动时补齐上次遗留的缩略图（幂等；无遗留则不产生 UI 进度）
  runBackfill(send)
}

/** 启动后台缩略图回填：逐批通知刷新 + 进度事件（完成时发 null 清除 UI） */
function runBackfill(send: (channel: string, ...args: unknown[]) => void): void {
  void backfillThumbnails(
    (n) => send(CH.E_thumbsReady, n),
    (p) => send(CH.E_thumbsProgress, p.total > 0 && p.done < p.total ? p : null)
  )
}
