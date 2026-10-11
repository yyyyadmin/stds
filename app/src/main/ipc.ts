/**
 * IPC 注册：串联渲染层与主进程服务
 */
import { ipcMain, dialog, shell, app } from 'electron'
import type { BrowserWindow } from 'electron'
import os from 'os'
import { renameSync, existsSync, mkdirSync } from 'fs'
import { basename, join } from 'path'
import { CH, type BootstrapInfo, type CorrectRequest, type MoveRequest } from '../shared/ipc'
import {
  listByCategory,
  listByCategoryIds,
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
  resetSkipped,
  resetForRescan,
  processChunked
} from './db'
import { scanner, reclassifyAll, type ScanProgress } from './services/scanner'
import { exporter, type ExportOptions } from './services/exporter'
import { importPaths, backfillThumbnails, backfillSmallThumbs, clearThumbCache } from './services/importer'
import { ensureBigPreview, clearBigCache } from './services/big'
import { clearEngineInputCache } from './services/rawPreview'
import { authManager } from './services/auth'
import { engineManager } from './engine'
import { autoTune, resetTuned, TUNE_MIN_CORRECTIONS } from './services/tuner'
import { CAT_LIBRARY, isBadDim, isTrashLike, BAD_DIMENSIONS, SUPPORTED_EXTS, PERSON_DIMS, type CategoryKey, type DimensionKey, type ImageRecord } from '../shared/types'

/**
 * 人数维度互斥：一张图只能属于 单人照/多人合拍照/多人混合照/无人物场景 之一。
 * 用户把图归入某个人数分类（拖到侧栏/移动到/加标签）时：清掉其它互斥标签并写入目标标签，
 * 否则旧标签会让图片继续出现在错误分类的并集视图里（“改了分类但旧标签还在”）。
 * 互斥表 PERSON_DIMS 统一住在 shared/types（单一来源），db 层写 tags 时也会再过一次闸。
 */
function applyPersonTag(id: number, target: string, taggedAt?: number): void {
  if (!(PERSON_DIMS as string[]).includes(target)) return
  // 先直接删旧标签再写目标：不能依赖 setDimTag 里的互斥收口自动顶掉——两个旧标签
  // 可能都是 method:'user'，按“人工判定优先”的规则反而会留下用户刚刚改掉的那个。
  for (const d of PERSON_DIMS) if (d !== target) setDimTag(id, d, null)
  setDimTag(id, target as DimensionKey, { confidence: 1, level: 'high', reason: '用户修正指定', method: 'user', taggedAt })
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

  // 差量刷新：操作（移动/标签/撤回）只回拉受影响 id，不再整分类重拉几千行（低配机“点一下卡一下”的主因）
  ipcMain.handle(CH.listByIds, (_e, req: { category: CategoryKey; ids: number[] }) => listByCategoryIds(req.category, req.ids))

  // 整组重复/连拍成员：分组视图要把留在交付库的“第一张”也显示出来，否则短组退化成孤帧
  ipcMain.handle(CH.listImagesByGroups, (_e, gids: string[]) => listImagesByDupGroups(gids))

  ipcMain.handle(CH.categoryCounts, () => categoryCounts())

  // 机器性能探测（第二档 A1）：渲染层启动时调一次，结合 perfMode 决定是否进精简模式。
  // 窗口出来后才调，getGPUFeatureStatus 此时已填充；合成不启用=软件渲染/省电模式，低配机最典型的信号
  ipcMain.handle(CH.perfHint, () => {
    const st = app.getGPUFeatureStatus() as unknown as Record<string, string>
    return {
      cores: os.cpus().length,
      memGB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
      gpuSoftware: String(st['gpu_compositing'] ?? 'unknown') !== 'enabled'
    }
  })

  // 移动（逻辑/物理），9.3
  ipcMain.handle(CH.moveImages, async (_e, req: MoveRequest) => {
    const s = getSettings()
    void s
    // 单图移动处理（第二档 A3）：旧内联 for 逐条 auto-commit 全程占住主进程事件循环，
    // 几千 id 时窗口连缩放都卡；现在每 500 条一个事务、块间让出，单条读改写仍在一块内同步完成
    const moveOne = (id: number): void => {
      const rec = getImage(id)
      if (!rec) return
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
      // 移动到 = 手动归类。clearBadTags 时只清「坏维度」标签（闭眼/斜眼/表情/模糊/曝光/半截头/重复）：
      // 移入交付库/待确认等于人工担保这条缺陷判定作废，删掉它它才会从各坏图并集视图消失，
      // 误判样本已经另记进 corrections 喂阈值自学习，信息没丢。
      // 人数三标签与黑白**一律保留**：它们是“这张图里有几个人/是不是黑白”的客观事实，不是缺陷。
      // 导出“只导出勾选分类”对维度分类走标签并集口径（exporter.matchesCat），删了就永久捞不出来——
      // 把一张单人照放行进交付库，不该顺手让它再也进不了“单独导出单人照”的清单。
      // 垃圾桶不清任何标签（保留废弃原因）；目标是坏维度时再补一个用户高置信标签。
      if (req.clearBadTags !== false) {
        for (const dim of Object.keys(rec.tags)) {
          if (!isBadDim(dim)) continue
          const tag = rec.tags[dim]
          setDimTag(id, dim as DimensionKey, null)
          // 误判样本：AI 判了该维度有缺陷（只记 AI 标的，method=user 的是用户自己放的，不算 AI 误判），
          // 人工担保移出。旧注释声称“误判样本已经另记进 corrections”但这条路径根本没写——
          // 人工复审最强的信号一直在丢，这里补上（撤回移动不回滚样本：它记录的是用户当时的真实意图）
          if (tag && tag.method !== 'user') {
            addCorrection({
              imageId: id,
              origDim: dim as DimensionKey,
              origConfidence: tag.confidence,
              newCategory: req.category,
              action: 'wrong',
              timestamp: Date.now()
            })
          }
        }
      }
      if (isBadDim(req.category)) {
        const had = rec.tags[req.category]
        setDimTag(id, req.category as DimensionKey, { confidence: 1, level: 'high', reason: '用户手动放置', method: 'user' })
        // 漏检样本：AI 没标（或只标了不可见的低置信）这个缺陷维度，用户却手动把图移进来
        // → 与 addDimTag 补标同口径计入 movedInCounts，驱动该维度下调召回阈值
        if (!had || had.level === 'low') {
          addCorrection({
            imageId: id,
            origDim: null,
            origConfidence: null,
            newCategory: req.category,
            action: 'wrong',
            timestamp: Date.now()
          })
        }
      }
      // 人数维度互斥换标 + 学习样本。样本必须在这里也写：以前只有 addDimTag（标签路径）写，
      // 侧栏拖进人数分类走的是这条移动路径，“换了标但没学习”——用户拿来攒真值的两个入口只剩一半管用。
      // 口径与 addDimTag 一致：顶掉旧人数标签 = 旧判定是误判（origDim 记旧维度）；
      // AI 根本没标人数（或只有不可见的低置信）而用户把图移进来 = 漏检。
      // 目标标签已经是用户可见标（比如刚拖过一次、或走过加标签路径）则不重复计。
      if ((PERSON_DIMS as string[]).includes(req.category)) {
        const pTarget = req.category as DimensionKey
        const cur = rec.tags[pTarget]
        const oldPerson = PERSON_DIMS.find((d) => d !== pTarget && rec.tags[d] && rec.tags[d]!.level !== 'low')
        if (oldPerson) {
          addCorrection({
            imageId: id,
            origDim: oldPerson,
            origConfidence: rec.tags[oldPerson]!.confidence,
            newCategory: req.category,
            action: 'wrong',
            timestamp: Date.now()
          })
        } else if (!cur || cur.level === 'low') {
          addCorrection({
            imageId: id,
            origDim: null,
            origConfidence: null,
            newCategory: req.category,
            action: 'wrong',
            timestamp: Date.now()
          })
        }
      }
      applyPersonTag(id, req.category)
      setCategory(id, req.category, 'user')
    }
    await processChunked(req.ids, moveOne)
    send(CH.E_scanProgress, scanner.getProgress())
  })

  // 撤回移动：按移动前快照原样还原分类/标签/categoryBy（不做反向推断）
  ipcMain.handle(CH.restoreImages, async (_e, snapshots: ImageRecord[]) => {
    await processChunked(snapshots, (rec) => {
      getDb()
        .prepare('UPDATE images SET category = ?, category_by = ?, tags = ?, status = ?, cat_changed_at = ? WHERE id = ?')
        .run(rec.category, rec.categoryBy, JSON.stringify(rec.tags), rec.status, Date.now(), rec.id)
    })
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
      // 目标是人数维度（单人照/多人合拍照/多人混合照/无人物）：写目标标签 + 清互斥人数标签，
      // 一次修正即可把“闭眼+多人合拍照”的误判图彻底改判成干净的“单人照”。
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
  // 否则并集视图仍靠主分类命中，在用户看来就是“删了没反应”。挪向：剩余最高置信坏维度 → 否则交付库。
  ipcMain.handle(CH.removeDimTag, async (_e, ids: number[], dim: DimensionKey) => {
    const removeOne = (id: number): void => {
      const rec = getImage(id)
      if (!rec) return
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
    await processChunked(ids, removeOne)
    send(CH.E_scanProgress, scanner.getProgress())
  })

  // 添加标签（可多选批量）：用户认为 AI 漏了某个维度——写一个用户高置信标签，
  // 图立即出现在该维度分类（并集视图）并排到第一张；普通维度不动主分类（不是移动）。
  // 例外：人数四分类互斥，加新人数标签等于换掉旧的，旧标签是主分类时归属跟着换。
  // 学习信号：补标 origDim=null 只计“漏检”；人数替换记旧维度=误判。
  ipcMain.handle(CH.addDimTag, async (_e, ids: number[], dim: DimensionKey) => {
    const addOne = (id: number): void => {
      const rec = getImage(id)
      if (!rec) return
      // 只有“已经作为可见标签展示”的维度才跳过；低置信度标签在视图/管理器里本来就看不到，
      // 用户点添加就必须覆盖成用户高置信，否则就是“点了没反应也没报错”。
      const cur = rec.tags[dim]
      if (cur && cur.level !== 'low') return
      // 人数四分类互斥：加新人数标签 = 换掉旧人数标签。旧标签若正好是主分类，归属要一起换，
      // 否则并集视图里它会同时留在旧相册（“改成多人合拍照了，可单人照里还找得到它”）
      const isPersonDim = (PERSON_DIMS as string[]).includes(dim)
      const oldPerson = isPersonDim
        ? PERSON_DIMS.find((d) => d !== dim && rec.tags[d] && rec.tags[d]!.level !== 'low')
        : undefined
      if (isPersonDim) {
        // 人数四维度互斥：清掉另外三个，否则图会同时出现在两个互斥分类；
        // taggedAt 盖在新标签上：图只在该人数分类排第一，不顶动它其它所属分类的位置
        applyPersonTag(id, dim, Date.now())
        if (oldPerson && rec.category === oldPerson) setCategory(id, dim, 'user')
      } else {
        setDimTag(id, dim, { confidence: 1, level: 'high', reason: '用户手动添加', method: 'user', taggedAt: Date.now() })
      }
      // 不刷 cat_changed_at：那是“进入主分类”的时间，加标签不是移动——以前靠它让新标签
      // 分类排第一，代价是图在当前浏览的分类里也跳到顶部（用户反馈：位置不该动）。
      // 按分类区分的位置由上面盖在标签上的 taggedAt 承担（见渲染层 sortKey='time'）。
      addCorrection({
        imageId: id,
        // 普通补标：origDim=null 只计“漏检”；人数替换：旧标签确实是误判，记旧维度才能把方
        // 向喂回去（人数错判的主要形态是“两个人只标了单人照”，不纠正旧维度阈值就永远不改）
        origDim: oldPerson ?? null,
        origConfidence: oldPerson ? (rec.tags[oldPerson]!.confidence ?? null) : null,
        newCategory: dim,
        action: 'wrong',
        timestamp: Date.now()
      })
    }
    await processChunked(ids, addOne)
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
  ipcMain.handle(CH.scanRescanAll, async () => {
    // 先把上一轮 AI 归属与标签归位（归属不动的：人工两个桶 + 用户手动放置），再起跑
    const reset = resetForRescan()
    const r = await scanner.start()
    return { ...r, reset }
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
  // 老库小档补齐：已有 @960 但缺 @320 的静默后台缩一张，不报进度（渲染层 onError 回退大档兜底）
  void backfillSmallThumbs()
}

/** 启动后台缩略图回填：逐批通知刷新 + 进度事件（完成时发 null 清除 UI） */
function runBackfill(send: (channel: string, ...args: unknown[]) => void): void {
  void backfillThumbnails(
    (n) => send(CH.E_thumbsReady, n),
    (p) => send(CH.E_thumbsProgress, p.total > 0 && p.done < p.total ? p : null)
  )
}
