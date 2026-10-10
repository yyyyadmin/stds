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
  listImagesByDupGroups,
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
import { clearEngineInputCache } from './services/rawPreview'
import { authManager } from './services/auth'
import { engineManager } from './engine'
import { autoTune, resetTuned, TUNE_MIN_CORRECTIONS } from './services/tuner'
import { CAT_LIBRARY, isBadDim, isTrashLike, BAD_DIMENSIONS, SUPPORTED_EXTS, type DimensionKey, type ImageRecord } from '../shared/types'

/**
 * 人数维度互斥：一张图只能属于 单人照/多人合照/无人物场景 之一。
 * 用户把图归入某个人数分类（判定错误/移动到）时：清掉另外两个互斥标签并写入目标标签，
 * 否则旧标签会让图片继续出现在错误分类的并集视图里（“改了分类但旧标签还在”）。
 */
const PERSON_DIMS: DimensionKey[] = ['single_person', 'group_photo', 'no_person']
function applyPersonTag(id: number, target: string): void {
  if (!(PERSON_DIMS as string[]).includes(target)) return
  for (const d of PERSON_DIMS) if (d !== target) setDimTag(id, d, null)
  setDimTag(id, target as DimensionKey, { confidence: 1, level: 'high', reason: '用户修正指定', method: 'user' })
}

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

  // 整组重复/连拍成员：分组视图要把留在成品库的“第一张”也显示出来，否则短组退化成孤帧
  ipcMain.handle(CH.listImagesByGroups, (_e, gids: string[]) => listImagesByDupGroups(gids))

  ipcMain.handle(CH.categoryCounts, () => categoryCounts())

  // 移动（逻辑/物理），9.3
  ipcMain.handle(CH.moveImages, (_e, req: MoveRequest) => {
    const s = getSettings()
    void s
    for (const id of req.ids) {
      const rec = getImage(id)
      if (!rec) continue
      if (req.physical && !isTrashLike(req.category)) {
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
      // 移动到 = 手动归类。先按 clearBadTags 决定是否清掉坏维度/人数标签（移入成品库/待确认
      // 等于人工担保这张干净，应同时从各坏图并集视图消失；垃圾桶保留标签作为废弃原因），
      // 若目标是坏维度/人数维度，再补一个用户高置信标签，使其出现在目标视图。
      if (req.clearBadTags !== false) {
        for (const dim of Object.keys(rec.tags)) {
          if (isBadDim(dim) || (PERSON_DIMS as string[]).includes(dim)) setDimTag(id, dim as DimensionKey, null)
        }
      }
      if (isBadDim(req.category)) {
        setDimTag(id, req.category as DimensionKey, { confidence: 1, level: 'high', reason: '用户手动放置', method: 'user' })
      }
      applyPersonTag(id, req.category)
      setCategory(id, req.category, 'user')
    }
    send(CH.E_scanProgress, scanner.getProgress())
  })

  // 撤回移动：按移动前快照原样还原分类/标签/categoryBy（不做反向推断）
  ipcMain.handle(CH.restoreImages, (_e, snapshots: ImageRecord[]) => {
    for (const rec of snapshots) {
      getDb()
        .prepare('UPDATE images SET category = ?, category_by = ?, tags = ?, status = ?, cat_changed_at = ? WHERE id = ?')
        .run(rec.category, rec.categoryBy, JSON.stringify(rec.tags), rec.status, Date.now(), rec.id)
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
      // 目标是人数维度（单人照/多人合照/无人物）：写目标标签 + 清互斥人数标签，
      // 一次修正即可把“闭眼+多人合照”的误判图彻底改判成干净的“单人照”。
      applyPersonTag(rec.id, target)
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

  // 删除标签（可多选批量）：一张图带多个标签时只删其中某一个，其它标签不变。
  // 边界：图的主分类就是该维度（AI 归入或之前移动过），必须连带把主分类挪走——
  // 否则并集视图仍靠主分类命中，在用户看来就是“删了没反应”。挪向：剩余最高置信坏维度 → 否则成品库。
  ipcMain.handle(CH.removeDimTag, (_e, ids: number[], dim: DimensionKey) => {
    for (const id of ids) {
      const rec = getImage(id)
      if (!rec) continue
      const conf = rec.tags[dim]?.confidence ?? 1
      setDimTag(id, dim, null)
      let newCat = rec.category
      if (rec.category === dim) {
        const rest = Object.entries({ ...rec.tags })
          .filter(([d, v]) => d !== dim && v && v.level !== 'low' && isBadDim(d))
          .sort((a, b) => (b[1]?.confidence || 0) - (a[1]?.confidence || 0))
        newCat = rest.length ? rest[0][0] : CAT_LIBRARY
        setCategory(id, newCat, 'user')
      }
      addCorrection({
        imageId: id,
        origDim: dim,
        origConfidence: conf,
        newCategory: newCat,
        action: 'wrong',
        timestamp: Date.now()
      })
    }
    send(CH.E_scanProgress, scanner.getProgress())
  })

  // 添加标签（可多选批量）：用户认为 AI 漏了某个维度——写一个用户高置信标签，
  // 图立即出现在该维度分类（并集视图）并排到第一张；主分类不变（不是移动）。
  // 学习信号：origDim 置 null 只计入“漏检”（下调召回阈值），不污染误检率。
  ipcMain.handle(CH.addDimTag, (_e, ids: number[], dim: DimensionKey) => {
    for (const id of ids) {
      const rec = getImage(id)
      if (!rec) continue
      // 只有“已经作为可见标签展示”的维度才跳过；低置信度标签在视图/管理器里本来就看不到，
      // 用户点添加就必须覆盖成用户高置信，否则就是“点了没反应也没报错”。
      const cur = rec.tags[dim]
      if (cur && cur.level !== 'low') continue
      if ((PERSON_DIMS as string[]).includes(dim)) {
        // 人数三维度互斥：清掉另外两个，否则图会同时出现在两个互斥分类
        applyPersonTag(id, dim)
      } else {
        setDimTag(id, dim, { confidence: 1, level: 'high', reason: '用户手动添加', method: 'user' })
      }
      // 刷新“进入分类时间”：不改变主分类，但让它在目标维度分类排第一
      getDb().prepare('UPDATE images SET cat_changed_at = ? WHERE id = ?').run(Date.now(), id)
      addCorrection({
        imageId: id,
        origDim: null,
        origConfidence: null,
        newCategory: dim,
        action: 'wrong',
        timestamp: Date.now()
      })
    }
    send(CH.E_scanProgress, scanner.getProgress())
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
  const THUMB_ORIENT_VERSION = 7
  if (getSettings().thumbOrientVersion !== THUMB_ORIENT_VERSION) {
    clearThumbCache()
    clearBigCache() // 旧版 RAW/HEIC 大图预览也是侧躺的，一并清掉强制重建
    clearEngineInputCache() // 旧版归一化 JPEG 也是侧躺的，一并清掉，避免引擎复用侧躺输入
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
