/**
 * IPC 注册：串联渲染层与主进程服务
 */
import { ipcMain, dialog, shell, app, session } from 'electron'
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
  countStaleImages,
  resetStaleForRescan,
  setAiReview,
  rejectAiReview,
  confirmAiReview,
  markQcDecided,
  processChunked
} from './db'
import { scanner, reclassifyAll, type ScanProgress } from './services/scanner'
import { aiReview } from './services/aiReview'
import { exporter, type ExportOptions } from './services/exporter'
import { importPaths, backfillThumbnails, backfillSmallThumbs, clearThumbCache } from './services/importer'
import { ensureBigPreview, clearBigCache } from './services/big'
import { readImageMeta } from './services/exifMeta'
import { clearEngineInputCache } from './services/rawPreview'
import { sweepCaches } from './services/cleanup'
import { authManager } from './services/auth'
import { engineManager } from './engine'
import { CAT_LIBRARY, CAT_TRASH, CAT_FLAWS, CAT_REVIEW, MANUAL_FLAW_DIM, isBadDim, isStructuralDim, isTrashLike, BAD_DIMENSIONS, SUPPORTED_EXTS, PERSON_DIMS, guessMidDim, tierOfCat, isDeliverable, flawLevel, type CategoryKey, type DimensionKey, type ImageRecord } from '../shared/types'
import { computeCategory } from './classify'

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
  // 引擎状态实时推送：握手完成（none→python/node）那一刻主动发给界面，顶栏徒章即时刷新，
  // 不必等用户打开设置才拉到（修慢机器上旧轮询 40 秒放弃导致徒章长期卡“初始化中”的问题）。
  engineManager.onStatusChange((st) => send(CH.E_engineStatus, st))
  let importCancelRequested = false

  // 事件桥接
  scanner.on('progress', (p: ScanProgress) => {
    send(CH.E_scanProgress, p)
    if (!p.running && (p.phase === 'done' || p.phase === 'stopped')) {
      // v7（2026-10-14）阈值锁定：不再在筛选结束自动微调阈值。判定线只认代码里的基线表
      // （effectiveThresholds 已忽略 tunedThresholds），自学习这条腿从写入源头就断掉。
      // 积分消费（API 文档 3.3）：只计蓝色“开始筛选”这类计费轮次（p.billable），重筛不收费；
      // 只按本次「检测成功」的张数扣，失败的不扣；会员免扣
      if (p.billable && p.ok > 0 && authManager.state().loggedIn) {
        void authManager
          .consume(p.ok)
          .then((r) => send(CH.E_authChanged, authManager.state(), r))
          .catch(() => undefined)
      }
    }
  })
  scanner.on('image', (img) => send(CH.E_scanImage, img))
  exporter.on('progress', (p) => send(CH.E_exportProgress, p))
  // AI 复审事件桥：主进程后台任务的进度单向推给渲染层（不阻塞、不劫持界面）
  aiReview.on('progress', (p) => send(CH.E_aiReviewProgress, p))

  ipcMain.handle(CH.appBootstrap, (): BootstrapInfo => ({
    settings: getSettings(),
    counts: categoryCounts(),
    customCategories: listCustomCategories(),
    engine: engineManager.getStatus(),
    progress: scanner.getProgress(),
    version: app.getVersion(),
    platform: process.platform,
    isDev: !app.isPackaged
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

  ipcMain.handle(CH.listErrorImages, () =>
    getDb().prepare(`SELECT id, filename, dir FROM images WHERE status = 'error' ORDER BY id`).all() as Array<{ id: number; filename: string; dir: string }>
  )

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

  // 界面缩放（见 AppSettings.uiScale）：倍率由渲染层算好（自动档要看窗口宽度，那是渲染层才知道的事），
  // 主进程只负责 setZoomFactor。用 Chromium 整页缩放而不是 CSS zoom：弹层定位、框选、
  // 拖拽那些按坐标算的代码不用改——缩放后坐标体系仍是统一的 CSS px。
  ipcMain.handle(CH.setUiZoom, (_e, factor: number) => {
    const f = Math.min(2, Math.max(0.5, Number(factor) || 1))
    if (!win.isDestroyed()) win.webContents.setZoomFactor(f)
  })

  // 移动（逻辑/物理），9.3
  ipcMain.handle(CH.moveImages, async (_e, req: MoveRequest) => {
    const s = getSettings()
    // 单图移动处理（第二档 A3）：旧内联 for 逐条 auto-commit 全程占住主进程事件循环，
    // 几千 id 时窗口连缩放都卡；现在每 500 条一个事务、块间让出，单条读改写仍在一块内同步完成
    const moveOne = (id: number): void => {
      const rec = getImage(id)
      if (!rec) return
      // 精简模式「移入瑕疵片」（用户 2026-10-20 定）：瑕疵片是“高置信瑕疵标签”派生的虚视图，
      // 不能把 category 写成 'flaws'（会破坏“主分类=人数”不变式）。这里把用户这一次表态落成瑕疵标签：
      //  · 已有可见瑕疵（闭眼/模糊/曝光/半截头/表情）→ 把最高置信那条提为高置信（人工确认）；
      //  · 不论有没有具体瑕疵，都再补一枚泛化「瑕疵」标记（manual_flaw）——它是用户“这张归瑕疵片”的
      //    明确表态，也保证没有人脸归属、主分类还停在待确认的图能真正落进瑕疵片（并在待确认里让位）。
      // 随后按人数重算主分类——原本停在待确认的图会回落到人数栏；仍无人数归属的留在待确认，
      // 由 db.matchesView 的 manual_flaw 分支保证它只出现在瑕疵片、不在待确认重复占位。
      if (req.category === CAT_FLAWS) {
        const visible = BAD_DIMENSIONS.filter((d) => d !== MANUAL_FLAW_DIM && rec.tags[d] && rec.tags[d]!.level !== 'low')
        const top = visible.sort((a, b) => (rec.tags[b]!.confidence ?? 0) - (rec.tags[a]!.confidence ?? 0))[0]
        if (top) {
          const tag = rec.tags[top]!
          setDimTag(id, top, { confidence: 1, level: 'high', reason: '用户移入瑕疵片', method: 'user', taggedAt: Date.now() })
          // “这确实是坏片”＝ AI 判对了；手动标的标签不重复计样本
          if (tag.method !== 'user') {
            addCorrection({ imageId: id, origDim: top, origConfidence: tag.confidence, newCategory: CAT_FLAWS, action: 'correct', timestamp: Date.now() })
          }
        }
        setDimTag(id, MANUAL_FLAW_DIM, { confidence: 1, level: 'high', reason: '用户移入瑕疵片', method: 'user', taggedAt: Date.now() })
        const fresh = getImage(id)
        if (fresh) setCategory(id, computeCategory(fresh.tags, s, { ...fresh, categoryBy: null } as ImageRecord), 'user')
        return
      }
      // 档位目标（D4 + 用户 10-13 规则：交付库不再是可直接移入的栏，只能移入它下面三个档位之一）。
      // 于是“移入档位”按图当前是否已在交付库分两种语义：
      //  · 已在交付库：只是改档（第三条轴 tier），不碰 category/tags/学习样本——与旧行为一致；
      //  · 还不在交付库（瑕疵片/待确认/废片里拖入或移动到档位）：等同“人工担保放行 + 归档”，
      //    走与 moveTo(交付库) 完全相同的放行口径——清掉全部坏维度标签（并记误判样本喂自学习）、
      //    落回交付库，再定档；人数/黑白等客观事实标签一律保留（导出按标签并集捞图，删了捞不回）。
      // 档位只做逻辑改档/放行，不搬物理文件（改档不代表换目录）。
      const tierN = tierOfCat(req.category)
      if (tierN) {
        if (!isDeliverable(rec.category, rec.tags)) {
          for (const dim of Object.keys(rec.tags || {})) {
            if (!isBadDim(dim) && !isStructuralDim(dim)) continue
            const tag = rec.tags[dim]
            setDimTag(id, dim as DimensionKey, null)
            // 结构维度（重复/连拍）不记误判样本：拖进档位 = “这张我要留”，不等于“AI 判错了”
            if (!isBadDim(dim)) continue
            if (tag && tag.method !== 'user') {
              addCorrection({
                imageId: id,
                origDim: dim as DimensionKey,
                origConfidence: tag.confidence,
                newCategory: CAT_LIBRARY,
                action: 'wrong',
                timestamp: Date.now()
              })
            }
          }
          // 主分类落回交付库：与 moveTo(CAT_LIBRARY) 同一 setCategory 路径，categoryBy=user
          setCategory(id, CAT_LIBRARY, 'user')
        }
        getDb().prepare(`UPDATE images SET tier = ?, tier_by = 'user' WHERE id = ?`).run(tierN, id)
        return
      }
      // 丢进废弃库 = 用户对这张图最明确的“不要”表态：若它带着 AI 判的瑕疵标签，等于认可了这条瑕疵
      // → 给每个 AI 瑕疵维度记一条 action='correct'（判对/truePositive）样本。这是“此判定正确”按钮
      // 下线后（用户 10-13：真实用户只用“要→交付库 / 不要→废弃库”两个动作）判对信号的新来源，
      // 与“放行→交付库记 wrong（误判）”配成一对，喂 tuner 的误检率 = 误判 /(判对 + 误判)。
      // 只记 AI 标的（method!=='user'）中/高置信瑕疵：用户自己手动加的标签不算 AI 判对，低置信不可见不记。
      // 只针对普通废弃库；重复/连拍-废弃桶是按“冗余”丢弃，与瑕疵质量无关，不记。
      if (req.category === CAT_TRASH && rec.category !== CAT_TRASH) {
        // 从重复分组丢弃（source==='duplicate'）是按“冗余”丢弃，与瑕疵质量无关，不记 correct
        // 样本，维持旧 dup_trash 不产冗余/误判样本的口径（避免行为回归）。
        if (req.source !== 'duplicate') {
          for (const [dim, tag] of Object.entries(rec.tags || {})) {
            if (!isBadDim(dim) || !tag || tag.method === 'user' || tag.level === 'low') continue
            addCorrection({
              imageId: id,
              origDim: dim as DimensionKey,
              origConfidence: tag.confidence,
              newCategory: CAT_TRASH,
              action: 'correct',
              timestamp: Date.now()
            })
          }
        }
        setCategory(id, CAT_TRASH, 'user')
        // 记录丢弃时所在来源栏，供废弃库“从哪来回哪去”还原；历史/未知来源存 null
        getDb().prepare(`UPDATE images SET trash_from = ? WHERE id = ?`).run(req.source ?? null, id)
        return
      }
      if (req.physical && !isTrashLike(req.category)) {
        // 物理移动：移动到 <原目录>/筛图结果/<分类名>/
        // 注意：这是真剪切（renameSync），原路径下文件不再——以前底部“移动到”面板里那个
        // 「同时移动物理文件（…不删除原图）」的勾文案与行为不符，该面板连同这个入口已于 10-14 下线，
        // 渲染层现在没人再传 physical=true；通道保留（导出弹窗自己那套物理移动走另一条路），删了怕断旧数据。
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
      // 废弃库不清任何标签（保留废弃原因）；目标是坏维度时再补一个用户高置信标签。
      // 精简模式「移入交付库」：已经能交付的图（含干净的重复帧）再点一次不该重跑“人工担保清标签”——
      // 那会顺手把重复/连拍的分组标签抹掉。只对还差一口气的图清瑕疵标签放行。
      // （正常模式走档位分支，从不直接发 CAT_LIBRARY，所以这条卫兵不影响旧行为）
      const alreadyDelivered = req.category === CAT_LIBRARY && isDeliverable(rec.category, rec.tags)
      if (req.clearBadTags !== false && !alreadyDelivered) {
        for (const dim of Object.keys(rec.tags)) {
          if (!isBadDim(dim) && !isStructuralDim(dim)) continue
          const tag = rec.tags[dim]
          setDimTag(id, dim as DimensionKey, null)
          // v2.0.67：结构维度（重复/连拍）只清标签、不记误判样本。“这张我也要不要”是选片意图，
          // 不是“AI 把不重复的当重复了”；早先批量点“保留”把全库刷出上千条 duplicate=wrong
          // 假负样本（污染自学习）就是这个坑，不能因为把 duplicate 摘出瑕疵表就叉回来。
          if (!isBadDim(dim)) continue
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
      if (isBadDim(req.category) || isStructuralDim(req.category)) {
        const had = rec.tags[req.category]
        setDimTag(id, req.category as DimensionKey, { confidence: 1, level: 'high', reason: isStructuralDim(req.category) ? '用户判定：这张是同组多余帧' : '用户手动放置', method: 'user', taggedAt: Date.now() })
        // 漏检样本：AI 没标（或只标了不可见的低置信）这个缺陷维度，用户却手动把图移进来
        // → 与 addDimTag 补标同口径计入 movedInCounts，驱动该维度下调召回阈值。
        // 结构维度不记：重复组是聚类算出来的结构结论，用户把图挪进重复类不等于 AI 漏判了某个缺陷。
        if (isBadDim(req.category) && (!had || had.level === 'low')) {
          addCorrection({
            imageId: id,
            origDim: null,
            origConfidence: null,
            newCategory: req.category,
            action: 'wrong',
            timestamp: Date.now()
          })
        }
        // D2：瑕疵只作标签、绝不充当主分类。写高置信瑕疵标签后，category 用最新 tags 重算回人数身份
        // （图随即由 flawLevel=high 落入瑕疵片视图、退出交付库，无需把 category 设成坏维度）。
        const fresh = getImage(id)
        if (fresh) setCategory(id, computeCategory(fresh.tags, s, { ...fresh, categoryBy: null } as ImageRecord), 'user')
        return
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

  // 撤回移动：按移动前快照原样还原分类/标签/categoryBy/档位（不做反向推断）；
  // tier 两列一并还原，改档/移入被撤回后档位随之回到移动前（含 user 标记）
  ipcMain.handle(CH.restoreImages, async (_e, snapshots: ImageRecord[]) => {
    await processChunked(snapshots, (rec) => {
      getDb()
        .prepare('UPDATE images SET category = ?, category_by = ?, tags = ?, status = ?, cat_changed_at = ?, tier = ?, tier_by = ? WHERE id = ?')
        .run(rec.category, rec.categoryBy, JSON.stringify(rec.tags), rec.status, Date.now(), rec.tier ?? null, rec.tierBy ?? null, rec.id)
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
      // D1 一步结案（修"只记不动"缺口）：待确认里的图，AI 判定正确 → 把中置信瑕疵提为高置信（确认瑕疵），
      // 图随即由 flawLevel=high 落入瑕疵片、退出待确认（不导出）；若只是手动停泊无瑕疵则原样仅记样本。
      const midDim = guessMidDim(rec.tags || {})
      let promoted = false
      if (midDim && isBadDim(midDim)) {
        setDimTag(rec.id, midDim as DimensionKey, { confidence: 1, level: 'high', reason: '用户确认判定', method: 'user', taggedAt: Date.now() })
        promoted = true
      }
      addCorrection({
        imageId: rec.id,
        origDim: req.origDim ?? (promoted ? ((midDim as DimensionKey) ?? null) : null),
        origConfidence: req.origConfidence,
        newCategory: rec.category,
        action: 'correct',
        timestamp: Date.now()
      })
      if (promoted) {
        const fresh = getImage(rec.id)
        if (fresh) setCategory(rec.id, computeCategory(fresh.tags, getSettings(), { ...fresh, categoryBy: null } as ImageRecord), 'user')
        send(CH.E_scanProgress, scanner.getProgress())
        return getImage(rec.id)
      }
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
        // D2：category 恒为人数身份。删掉的若正是当前主分类（人数维或旧数据坏维度），
        // 用剩余 tags 重算回人数（无人数标签则回落待确认），不再挪到"剩余坏维度/library"。
        const nextTags = { ...rec.tags }
        delete nextTags[dim]
        newCat = computeCategory(nextTags as ImageRecord['tags'], getSettings(), { ...rec, categoryBy: null } as ImageRecord)
        setCategory(id, newCat, 'user')
      } else if (rec.category === CAT_REVIEW && rec.categoryBy !== 'user' && (isBadDim(dim) || isStructuralDim(dim))) {
        // 重复组代表帧“全组没一张能交”时被 AI 停到待确认拍板（原因就是身上那条中高瑕疵）。
        // 用户删掉这条瑕疵 = 认定它没拍坏，图得自己回落相册——不补这一步它会赖在待确认出不去。
        // 只动 AI 停泊的（人工搁置在待确认的一律尊重），删完确实没中高瑕疵就重算回落。
        // v2.0.93 反转后不再拿"是否冗余帧"卡住回落：干净冗余帧删完瑕疵本就该进交付库。
        const nextTags = { ...rec.tags }
        delete nextTags[dim]
        if (flawLevel(nextTags) === 'none') {
          const nc = computeCategory(nextTags as ImageRecord['tags'], getSettings(), { ...rec, categoryBy: null } as ImageRecord)
          if (nc !== CAT_REVIEW) {
            setCategory(id, nc, 'ai')
            newCat = nc
          }
        }
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
    const r = await scanner.start(false)
    return { ...r, reset }
  })
  // 引擎签名过期信息：直接数出"旧引擎结果"的张数。引入签名机制前从未盖过签名的存量图（engine_sig
  // IS NULL）如实计为旧结果——客户升级到新引擎一打开就被提示重扫，不再回填掩盖。
  ipcMain.handle(CH.scanStaleInfo, () => {
    const sig = engineManager.getEngineSig()
    return { ready: sig != null, sig, staleCount: countStaleImages(sig) }
  })
  // 只重扫旧引擎结果的图（非全库）：按全量重扫同等语义把过期 done 图置 pending，再起跑仅重扫这批。
  ipcMain.handle(CH.scanRescanStale, async () => {
    const reset = resetStaleForRescan(engineManager.getEngineSig())
    const r = await scanner.start(false)
    return { ...r, reset }
  })
  ipcMain.handle(CH.reclassify, () => reclassifyAll())

  // ---------- AI 复审（会员专属·后台任务）----------
  ipcMain.handle(CH.aiReviewStart, (_e, scope?: 'review' | 'flaws', opts?: { force?: boolean }) => aiReview.start(scope, opts))
  ipcMain.handle(CH.aiReviewStop, () => {
    aiReview.stop()
  })
  // 采纳/跳过后清掉某张图的只读建议（走 Task2 的 setAiReview，不碰 tags/category）
  ipcMain.handle(CH.aiReviewClear, (_e, id: number) => setAiReview(id, null))
  // 用户"不采纳"某张的建议：只在建议 JSON 上打标记，不改任何判定；这张仍会被下一轮复审重判
  ipcMain.handle(CH.aiReviewReject, (_e, id: number) => rejectAiReview(id))
  // 用户确认某张已结案（一致时保留现状、采纳后留痕）：只打标记，不改 tags/category
  ipcMain.handle(CH.aiReviewConfirm, (_e, id: number) => confirmAiReview(id))
  // 人在判定面板里提交过画质裁定：只清红标（qcDecided 留痕），不碰标签、归属和结案状态
  ipcMain.handle(CH.aiReviewQcDecided, (_e, id: number) => markQcDecided(id))

  ipcMain.handle(CH.exportPreview, (_e, opts: ExportOptions) => exporter.previewCount(opts))
  ipcMain.handle(CH.exportRun, (_e, opts: ExportOptions) => exporter.run(opts))
  ipcMain.handle(CH.exportCancel, () => exporter.cancel())

  ipcMain.handle(CH.engineStatus, () => engineManager.getStatus())

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
  // 验证码登录：成功才广播登录态（失败时登录态没变，发一次只会让渲染层白白重算）
  ipcMain.handle(CH.authLoginCode, async (_e, req: { phone?: string; email?: string; code: string }) => {
    const r = await authManager.loginWithCode(req)
    if (r.ok) send(CH.E_authChanged, r.state)
    return r
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
  ipcMain.handle(
    CH.pointsHistory,
    (_e, params: { type?: string; page?: number; page_size?: number }) =>
      authManager.pointsHistory(params?.type ?? '', params?.page ?? 1, params?.page_size ?? 10)
  )
  ipcMain.handle(CH.authRedeem, (_e, code: string) => authManager.redeemCode(String(code ?? '')))
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
  ipcMain.handle(CH.cacheClear, async () => {
    const retried = resetSkipped() // “无法解码”项重置为待处理，重试新版 RAW 内嵌预览提取
    // 全量清理：缩略图 / 大图预览 / 引擎中间图 / 日志 / Electron 缓存 / 引擎模型副本
    const sweep = sweepCaches()
    // 主 Cache 目录此时正被 Chromium 持有句柄，删不动；走官方接口清内存+磁盘缓存
    try {
      await session.defaultSession.clearCache()
    } catch (e) {
      console.error('session.clearCache failed', e)
    }
    getDb().prepare(`UPDATE images SET thumb = ''`).run() // 缓存文件已删，清空指向以触发全量重建
    runBackfill(send)
    return { retried, files: sweep.thumbs, freedMB: sweep.freedMB, logs: sweep.logs, big: sweep.big, engineInput: sweep.engineInput }
  })

  // RAW/HEIC 大图原图高清预览（普通格式直接用原文件，不走这里）
  ipcMain.handle(CH.bigPreview, (_e, id: number) => ensureBigPreview(id))

  // 原图拍摄参数（EXIF）：大图右栏「拍摄参数」区（主进程按路径缓存，见 services/exifMeta）
  ipcMain.handle(CH.imgMeta, (_e, path: string) => readImageMeta(path))

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

  // 安装 / 覆盖升级后首次启动：自动做一次全量清理（缩略图、大图、中间图、日志、
  // Electron 缓存、引擎模型副本）。门控按版本号——同一个版本只清一次，之后每次启动
  // 都走缓存命中，不会反复重建缩略图。
  // 为什么必须有：旧版缓存 / 模型副本是按旧逻辑生成的，覆盖安装后会直接被新版复用，
  // 用户看到的就是“更新了却没新功能、界面还是老样子”；图库（screener.db）与登录态
  // （auth.json）不在此列，一个字节都不动。
  const cacheSweepVersion = app.getVersion()
  if (getSettings().cacheSweepVersion !== cacheSweepVersion) {
    const sweep = sweepCaches()
    getDb().prepare(`UPDATE images SET thumb = ''`).run() // 缩略图指向重置，紧随的 runBackfill 全量重建
    saveSettings({ cacheSweepVersion })
    console.log(
      `[cleanup] 升级/首启自动清理完成：缩略图 ${sweep.thumbs}、大图 ${sweep.big}、中间图 ${sweep.engineInput}、日志 ${sweep.logs}、Electron缓存 ${sweep.electronCache}、模型副本 ${sweep.modelCopies}，释放 ${sweep.freedMB}MB`
    )
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
