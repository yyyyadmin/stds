/**
 * SQLite 数据层
 * 表：images / corrections / custom_categories / settings
 * 断点续跑：images.status 保持 pending，软件重启后继续筛选
 */
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import type {
  AppSettings,
  CategoryKey,
  CorrectionRecord,
  DimResult,
  DimensionKey,
  ImageRecord,
  TierKey
} from '../shared/types'
import {
  BAD_DIMENSIONS,
  NEUTRAL_DIMENSIONS,
  STRUCTURAL_DIMENSIONS,
  PERSON_DIMS,
  CAT_LIBRARY,
  CAT_FLAWS,
  CAT_REVIEW,
  CAT_TRASH,
  CAT_DUP_TRASH,
  isTrashLike,
  isBadDim,
  flawLevel,
  isDeliverable,
  enforcePersonMutex,
  tierOfCat,
  isDupRedundant,
  DUP_REDUNDANT_KEY,
  DEFAULT_SETTINGS
} from '../shared/types'
import { scoreTier, computeCategory } from './classify'

import { openDb, type SqlDb } from './sqlite'

let db: SqlDb

export async function initDbAsync(): Promise<void> {
  const dir = join(app.getPath('userData'), 'data')
  mkdirSync(dir, { recursive: true })
  db = await openDb(join(dir, 'screener.db'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      filename TEXT NOT NULL,
      dir TEXT NOT NULL,
      width INTEGER DEFAULT 0,
      height INTEGER DEFAULT 0,
      format TEXT DEFAULT '',
      file_size INTEGER DEFAULT 0,
      thumb TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      category TEXT DEFAULT 'library',
      tags TEXT DEFAULT '{}',
      details TEXT DEFAULT NULL,
      dup_group TEXT DEFAULT NULL,
      scene TEXT DEFAULT NULL,
      category_by TEXT DEFAULT NULL,
      added_at INTEGER,
      scanned_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_images_status ON images(status);
    CREATE INDEX IF NOT EXISTS idx_images_category ON images(category);
    CREATE TABLE IF NOT EXISTS corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_id INTEGER NOT NULL,
      orig_dim TEXT,
      orig_confidence REAL,
      new_category TEXT NOT NULL,
      action TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS custom_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `)
  // 手动拖拽排序字段（一次性迁移）：老库无此列则新增，并把已有行按 id 初始化
  try {
    db.exec(`ALTER TABLE images ADD COLUMN sort_order INTEGER`)
  } catch {
    /* 列已存在，忽略 */
  }
  db.exec(`UPDATE images SET sort_order = id WHERE sort_order IS NULL`)
  // 一次性迁移：“进入当前分类”的时间戳（导入/AI 归入/手动移动/判定错误时刷新），
  // 支撑“最新在前”排序：刚移动进闭眼分类的图立即排在分类第一张。
  try {
    db.exec(`ALTER TABLE images ADD COLUMN cat_changed_at INTEGER`)
  } catch {
    /* 列已存在，忽略 */
  }
  // 一次性迁移（D4）：交付库档位第三条轴。tier 1/2/3，tier_by 区分 AI 预分与人工改档；
  // 默认 NULL，存量行由启动时 backfillTiers 按已存 tags 补算（不重跑引擎）。
  try {
    db.exec(`ALTER TABLE images ADD COLUMN tier INTEGER`)
    db.exec(`ALTER TABLE images ADD COLUMN tier_by TEXT`)
  } catch {
    /* 列已存在，忽略 */
  }
  // 一次性迁移（统一废弃库）：trash_from 记录图片被丢弃时所在的来源栏（如
  // library/review/duplicate/flaws/eyes_closed/custom:3），供废弃库按来源还原。
  try {
    db.exec(`ALTER TABLE images ADD COLUMN trash_from TEXT`)
  } catch {
    /* 列已存在，忽略 */
  }
  // 把历史的“重复照片-废弃”(dup_trash) 并入统一废弃库(trash)，来源标为 duplicate；
  // 还原时可回到重复分组。历史 trash 行 trash_from 保持 NULL，页面归入“其他来源”。
  db.exec(`UPDATE images SET category = 'trash', trash_from = 'duplicate' WHERE category = 'dup_trash'`)
  // 一次性迁移：产品决策取消“双人照”类型，2 人并入“多人合拍照”。老库中归在 two_person 桶的图片迁到 group_photo，
  // 避免出现无对应 tab 的孤儿图片。（tags 里残留的 two_person 键被 classify 忽略，重扫即覆盖，无需单独处理）
  db.exec(`UPDATE images SET category = 'group_photo' WHERE category = 'two_person'`)
}

export function getDb(): SqlDb {
  return db
}

/** thumbnails 目录（缓存缩略图，处理完可清理） */
export function thumbDir(): string {
  const dir = join(app.getPath('userData'), 'data', 'thumbs')
  mkdirSync(dir, { recursive: true })
  return dir
}

// ---------- 行 → 记录转换 ----------

function rowToImage(r: Record<string, unknown>, slim = false): ImageRecord {
  return {
    id: r.id as number,
    path: r.path as string,
    filename: r.filename as string,
    dir: r.dir as string,
    width: (r.width as number) || 0,
    height: (r.height as number) || 0,
    format: (r.format as string) || '',
    fileSize: (r.file_size as number) || 0,
    thumb: (r.thumb as string) || '',
    status: r.status as ImageRecord['status'],
    category: r.category as CategoryKey,
    tags: JSON.parse((r.tags as string) || '{}'),
    // 列表接口用 slim：details 里是人脸框/关键点/phash，几千行逐条 JSON.parse 再过 IPC
    // 是低配机“操作后卡一下”的大头；渲染层唯一消费者是放大弹窗的人脸叠加，那边改成按需单取。
    details: !slim && r.details ? JSON.parse(r.details as string) : null,
    dupGroup: (r.dup_group as string) || null,
    scene: (r.scene as string) || null,
    addedAt: r.added_at as number,
    catChangedAt: (r.cat_changed_at as number) ?? null,
    scannedAt: (r.scanned_at as number) || null,
    categoryBy: (r.category_by as ImageRecord['categoryBy']) || null,
    tier: ((r.tier as number) === 1 || (r.tier as number) === 2 || (r.tier as number) === 3 ? (r.tier as TierKey) : null),
    tierBy: (r.tier_by as ImageRecord['tierBy']) || null,
    trashFrom: (r.trash_from as string) ?? null
  }
}

// ---------- 图片 ----------

export function insertImage(rec: Omit<ImageRecord, 'id' | 'tags' | 'details' | 'categoryBy' | 'dupGroup' | 'scene' | 'scannedAt' | 'tier' | 'tierBy'> & { tags?: ImageRecord['tags'] }): number {
  const stmt = db.prepare(`
    INSERT INTO images (path, filename, dir, width, height, format, file_size, thumb, status, category, tags, added_at)
    VALUES (@path, @filename, @dir, @width, @height, @format, @file_size, @thumb, @status, @category, @tags, @added_at)
    ON CONFLICT(path) DO NOTHING
  `)
  const info = stmt.run({
    path: rec.path,
    filename: rec.filename,
    dir: rec.dir,
    width: rec.width,
    height: rec.height,
    format: rec.format,
    file_size: rec.fileSize,
    thumb: rec.thumb,
    status: rec.status,
    category: rec.category,
    tags: JSON.stringify(rec.tags ?? {}),
    added_at: rec.addedAt
  })
  return Number(info.lastInsertRowid)
}

export function imageExists(path: string): boolean {
  return !!db.prepare('SELECT 1 FROM images WHERE path = ?').get(path)
}

export function getImage(id: number): ImageRecord | null {
  const r = db.prepare('SELECT * FROM images WHERE id = ?').get(id)
  return r ? rowToImage(r as Record<string, unknown>) : null
}

export function listImages(filter: { category?: CategoryKey; status?: string; dir?: string } = {}): ImageRecord[] {
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (filter.category) {
    where.push(virtualCategorySql(filter.category))
  }
  if (filter.status) {
    where.push('status = @status')
    params.status = filter.status
  }
  if (filter.dir) {
    where.push('dir = @dir')
    params.dir = filter.dir
  }
  const sql = `SELECT * FROM images ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id`
  return (db.prepare(sql).all(params) as Array<Record<string, unknown>>).map((r) => rowToImage(r, true))
}

/**
 * 交付库 / 瑕疵片 / 待确认 / 废弃库 是“虚拟桶”：
 * D2 后前三档由“主分类(人数) + 瑕疵等级(flawLevel)”派生，SQL 只取候选集，
 * 精确门槛交给 matchesView（与 categoryCounts / exporter 同一口径）。
 */
function virtualCategorySql(cat: CategoryKey): string {
  if (cat === 'all') return '1=1'
  if (cat === CAT_TRASH || cat === CAT_DUP_TRASH) return `category = '${cat}'`
  // 交付库候选：非 review/trash 的行（人数图都带瑕疵标签、由 matchesView 筛掉）
  if (cat === CAT_LIBRARY) return `category NOT IN ('${CAT_REVIEW}','${CAT_TRASH}','${CAT_DUP_TRASH}')`
  // 档位子视图（D4）：候选集同交付库，精确按 tier 交给 matchesView
  if (tierOfCat(cat)) return `category NOT IN ('${CAT_REVIEW}','${CAT_TRASH}','${CAT_DUP_TRASH}')`
  // 瑕疵片/待确认候选：需含“主分类=人数但带瑕疵标签”的行，只排除废弃库
  if (cat === CAT_FLAWS || cat === CAT_REVIEW) return `category NOT IN ('${CAT_TRASH}','${CAT_DUP_TRASH}')`
  return `category = @cat_${cat.replace(/[^a-z0-9]/gi, '')}`
}

export function categoryParams(cat: CategoryKey, params: Record<string, unknown>): Record<string, unknown> {
  if (cat === CAT_LIBRARY || cat === CAT_FLAWS || cat === CAT_REVIEW || cat === CAT_TRASH || tierOfCat(cat)) return params
  params[`cat_${cat.replace(/[^a-z0-9]/gi, '')}`] = cat
  return params
}

export function listByCategory(cat: CategoryKey): ImageRecord[] {
  const where = virtualCategorySql(cat)
  const params: Record<string, unknown> = {}
  if (cat !== 'all' && cat !== CAT_LIBRARY && cat !== CAT_FLAWS && cat !== CAT_REVIEW && cat !== CAT_TRASH && cat !== CAT_DUP_TRASH && !tierOfCat(cat)) {
    params[`cat_${cat.replace(/[^a-z0-9]/gi, '')}`] = cat
  }
  const tagLike = '%"' + cat + '":{%'
  const rows = db.prepare(`SELECT * FROM images WHERE (${where}) OR (status = 'done' AND tags LIKE @tagLike) ORDER BY COALESCE(sort_order, id), id`).all({ ...params, tagLike }) as Array<Record<string, unknown>>
  const out = rows.map((r) => rowToImage(r, true))
  return out.filter((r) => matchesView(r, cat))
}

function isDimCat(cat: CategoryKey): boolean {
  // 结构维度（重复/连拍）也算视图维度：它不是瑕疵，但侧栏要能点开它、要能计数
  return (BAD_DIMENSIONS as string[]).includes(cat) || (NEUTRAL_DIMENSIONS as string[]).includes(cat) || (STRUCTURAL_DIMENSIONS as string[]).includes(cat)
}

/**
 * 一张图是否属于 cat 视图的单一真源：listByCategory（全量）和 listByCategoryIds（差量）共用，
 * 避免两处口径漂移。D2 三档状态视图互斥可求和，内容维度视图为标签并集：
 * - 交付库：非 trash/review/坏维度 且无任何中/高瑕疵（干净人数图；干净的自定义相册图也归在这里，保证上段可求和）
 * - 瑕疵片：非 trash 且有高置信瑕疵（flaw high）
 * - 待确认：非 trash 且非 flaw high，且（手动停泊 review ∪ 有中置信瑕疵 mid）
 * - 内容维度（坏/中性）：主分类===dim ∪ 该 dim 非 low 标签（并集，允许重叠）
 */
function matchesView(r: ImageRecord, cat: CategoryKey): boolean {
  if (cat === 'all') return true
  if (isTrashLike(cat)) return r.category === cat
  const fl = flawLevel(r.tags)
  if (cat === CAT_LIBRARY) {
    // 单一真源 isDeliverable（与导出闸门完全同一函数）：非 trash/review/flaws/坏维度且 flaw none
    return isDeliverable(r.category, r.tags)
  }
  // 档位子视图（D4）：交付库 ∩ 档位相等（档位在 isDeliverable 内部，不另判 trash/review）
  const tierN = tierOfCat(cat)
  if (tierN) return isDeliverable(r.category, r.tags) && r.tier === tierN
  if (cat === CAT_FLAWS) return !isTrashLike(r.category) && fl === 'high'
  if (cat === CAT_REVIEW) {
    if (isTrashLike(r.category) || fl === 'high') return false
    return r.category === CAT_REVIEW || fl === 'mid'
  }
  if (isDimCat(cat)) {
    return r.category === cat || (!isTrashLike(r.category) && !!r.tags[cat as DimensionKey] && r.tags[cat as DimensionKey]!.level !== 'low')
  }
  return r.category === cat // 自定义分类等按归属精确匹配（SQL 已限定）
}

/**
 * 差量刷新用：给定当前视图分类与受影响 id，只回“仍属于该视图”的精简记录（无 details）。
 * SQL 的 OR 条件与 listByCategory 完全一致，再过同一 matchesView；
 * IN 按 500 分块，避免撞 SQLite 预处理语句变量数上限（同 listImagesByDupGroups）。
 */
export function listByCategoryIds(cat: CategoryKey, ids: number[]): ImageRecord[] {
  if (!ids.length) return []
  const out: ImageRecord[] = []
  const where = virtualCategorySql(cat)
  const tagLike = '%"' + cat + '":{%'
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const params: Record<string, unknown> = { tagLike }
    if (cat !== 'all' && cat !== CAT_LIBRARY && cat !== CAT_FLAWS && cat !== CAT_REVIEW && cat !== CAT_TRASH && cat !== CAT_DUP_TRASH && !tierOfCat(cat)) {
      params[`cat_${cat.replace(/[^a-z0-9]/gi, '')}`] = cat
    }
    chunk.forEach((id, j) => {
      params[`v${j}`] = id
    })
    const ph = chunk.map((_, j) => `@v${j}`).join(',')
    const rows = db.prepare(`SELECT * FROM images WHERE id IN (${ph}) AND ((${where}) OR (status = 'done' AND tags LIKE @tagLike))`).all(params) as Array<Record<string, unknown>>
    for (const r of rows) {
      const rec = rowToImage(r, true)
      if (matchesView(rec, cat)) out.push(rec)
    }
  }
  return out
}

export function updateDetectResult(
  id: number,
  tags: ImageRecord['tags'],
  details: ImageRecord['details'],
  dupGroup: string | null,
  category: CategoryKey,
  categoryBy: ImageRecord['categoryBy'],
  status: ImageRecord['status']
): void {
  // 分类真正变化才算“刚进入这个分类”（刷新 cat_changed_at）；同分类重扫保留旧值，
  // 避免每次改阈值/重扫把全库排序时戳刷成同一时刻。
  const prev = (db.prepare('SELECT category FROM images WHERE id = ?').get(id) as { category: string } | undefined)?.category
  // 人数标签互斥收口：不管上游是引擎新结果、连拍一致化还是聚类补标，落库前再过一次闸，
  // 杜绝同一张图带着两个互斥人数标签进库（卡片上会同时挂「合拍照 + 混合照」两枚打脸的标签）。
  const safeTags = enforcePersonMutex(tags)
  // 人数一致性硬约束（v2.0.75）：调用方算 category 时用的是互斥收口**前**的 tags；若引擎同时给了
  // 两个非 low 人数标签，computeCategory 按 PERSON_DIMS 顺序取靠前的（如 mixed_photo），而 enforcePersonMutex
  // 只留置信/级别更高的那个（如 single_person）——category 便指着那个被删掉的标签，图赖在错误的并集
  // 视图里。tags 是唯一真源：只要传入的 category 是人数维度，就用收口后实际胜出的人数标签校正它。
  let finalCategory = category
  if ((PERSON_DIMS as string[]).includes(finalCategory)) {
    const recomputed = computeCategory(safeTags, getSettings(), { category, categoryBy } as ImageRecord)
    if ((PERSON_DIMS as string[]).includes(recomputed) && recomputed !== finalCategory) finalCategory = recomputed
  }
  // 档位随新 tags 重算（D4）；人工改过的档位（tier_by='user'）永不被重筛/重算覆盖
  const tier = status === 'done' ? scoreTier(safeTags, getSettings()) : null
  db.prepare(`
    UPDATE images SET tags = ?, details = ?, dup_group = ?, category = ?, category_by = ?, status = ?, scanned_at = ?,
      cat_changed_at = COALESCE(?, cat_changed_at),
      tier = CASE WHEN tier_by = 'user' THEN tier ELSE ? END,
      tier_by = CASE WHEN tier_by = 'user' THEN tier_by ELSE ? END
    WHERE id = ?
  `).run(JSON.stringify(safeTags), JSON.stringify(details), dupGroup, finalCategory, categoryBy, status, Date.now(), prev === finalCategory ? null : Date.now(), tier, tier ? 'ai' : null, id)
}

export function setCategory(id: number, category: CategoryKey, categoryBy: 'ai' | 'user' | null): void {
  // 任何显式设分类（移动到/判定错误）都刷新“进入分类时间”，图立刻排到目标分类第一张
  db.prepare('UPDATE images SET category = ?, category_by = ?, cat_changed_at = ? WHERE id = ?').run(category, categoryBy, Date.now(), id)
}

/**
 * 持久化手动拖拽排序：按传入 id 的先后顺序写入递增 sort_order（1..n）。
 * 列表读取用 ORDER BY COALESCE(sort_order,id)，故本次涉及到的图严格按此顺序展示，
 * 未参与本次排序的图（不在当前视图）不受影响。
 */
export function setSortOrder(ids: number[]): void {
  const stmt = db.prepare('UPDATE images SET sort_order = ? WHERE id = ?')
  const tx = db.transaction((list: number[]) => list.forEach((id, i) => stmt.run(i + 1, id)))
  tx(ids)
}

export function setThumb(id: number, thumb: string): void {
  db.prepare('UPDATE images SET thumb = ? WHERE id = ?').run(thumb, id)
}

/** 后台缩略图回填：写入尺寸 + 缩略图路径（不改变 status） */
export function setImageMeta(id: number, width: number, height: number, thumb: string): void {
  db.prepare('UPDATE images SET width = ?, height = ?, thumb = ? WHERE id = ?').run(width, height, thumb, id)
}

export function setImageStatus(id: number, status: ImageRecord['status']): void {
  db.prepare('UPDATE images SET status = ? WHERE id = ?').run(status, id)
}

/**
 * 后台回填：待生成缩略图的记录（含 done 但缩略图丢失的；skip 项由 resetSkipped 转 pending 后一并重试）。
 * 传 okSuffix（当前档位后缀，如 '@960.jpg'）时，旧档缩略图（后缀不匹配）也算待重建——
 * 老库因此能在后台无感升级成清晰版：不重置指针、不清缓存，升级期间界面全程都有图可看。
 */
export function listPendingThumbs(limit: number, okSuffix?: string): Array<{ id: number; path: string }> {
  const cond = okSuffix ? "(thumb = '' OR thumb IS NULL OR thumb NOT LIKE ?) AND status != 'skip'" : "(thumb = '' OR thumb IS NULL) AND status != 'skip'"
  const stmt = db.prepare(`SELECT id, path FROM images WHERE ${cond} ORDER BY id LIMIT ?`)
  return (okSuffix ? stmt.all(`%${okSuffix}`, limit) : stmt.all(limit)) as Array<{ id: number; path: string }>
}

export function setDimTag(id: number, dim: DimensionKey, tag: DimResult | null): void {
  const r = getImage(id)
  if (!r) return
  const tags = { ...r.tags }
  if (tag) tags[dim] = tag
  else delete tags[dim]
  // 写入人数维度时自动顶掉其它人数维度（互斥），调用方不必各自记这份清单。
  // 黑白照与人数正交，不在这组里，不受影响。
  enforcePersonMutex(tags)
  // 人数一致性硬约束（v2.0.75）：写/删人数标签会顶掉其它人数标签。若当前主分类正指着被顶掉的那个维度，
  // 图会赖在错误的并集视图里（实测：用户把“多人混合照”手动改成“单人照”，mixed_photo 标签被清走，
  // 但 category 列停在 mixed_photo，图继续在多人混合照视图出现）。tags 是真源——只要当前主分类是人数维度，
  // 就把它跟到收口后实际胜出（非 low）的那个人数标签上。普通（非人数）标签不动主分类。
  let newCategory: CategoryKey = r.category
  let categoryChanged = false
  if ((PERSON_DIMS as string[]).includes(r.category)) {
    const dominant = PERSON_DIMS.find((d) => tags[d] && tags[d]!.level !== 'low')
    if (dominant && dominant !== r.category) {
      newCategory = dominant
      categoryChanged = true
    }
  }
  // 标签变了就重算档位（D4）；人工改档不覆盖
  const tier = scoreTier(tags, getSettings())
  if (categoryChanged) {
    db.prepare(
      `UPDATE images SET tags = ?, category = ?, category_by = 'user', cat_changed_at = ?,
         tier = CASE WHEN tier_by = 'user' THEN tier ELSE ? END,
         tier_by = CASE WHEN tier_by = 'user' THEN tier_by ELSE ? END
       WHERE id = ?`
    ).run(JSON.stringify(tags), newCategory, Date.now(), tier, tier ? 'ai' : null, id)
  } else {
    db.prepare(
      `UPDATE images SET tags = ?,
         tier = CASE WHEN tier_by = 'user' THEN tier ELSE ? END,
         tier_by = CASE WHEN tier_by = 'user' THEN tier_by ELSE ? END
       WHERE id = ?`
    ).run(JSON.stringify(tags), tier, tier ? 'ai' : null, id)
  }
}

/**
 * 一次性修补历史脏数据：老版本（或旧引擎残留）的库里可能有一张图带着多个人数标签，
 * 也可能主分类正指着那个被淘汰的标签。幂等：无冲突时一行都不写，每次启动都跑得起。
 * 返回被修的张数（调用方仅用于日志）。
 */
export function repairPersonMutex(): number {
  const rows = db.prepare(`SELECT id, category, category_by, tags FROM images WHERE tags LIKE '%person%' OR tags LIKE '%group_photo%' OR tags LIKE '%mixed_photo%'`).all() as Array<{
    id: number
    category: string
    category_by: string | null
    tags: string | null
  }>
  let fixed = 0
  for (const r of rows) {
    let parsed: Record<string, DimResult> | null = null
    try {
      parsed = JSON.parse(r.tags || '{}') as Record<string, DimResult>
    } catch {
      parsed = null
    }
    if (!parsed) continue
    const before = PERSON_DIMS.filter((d) => parsed![d])
    if (before.length < 2) continue
    const kept = enforcePersonMutex(parsed)
    const keptDim = PERSON_DIMS.find((d) => kept[d])
    // 主分类正指着被删掉的互斥标签：指到留下来的那个上（用户手过的图保持 user 口径）。
    // 其余情形（分类是 library/review/坏维度）不碰：重筛或连拍一致化会按完整规则重算。
    if (keptDim && (PERSON_DIMS as string[]).includes(r.category) && r.category !== keptDim) {
      db.prepare('UPDATE images SET tags = ?, category = ?, category_by = ?, cat_changed_at = ? WHERE id = ?').run(
        JSON.stringify(kept),
        keptDim,
        r.category_by === 'user' ? 'user' : 'ai',
        Date.now(),
        r.id
      )
    } else {
      db.prepare('UPDATE images SET tags = ? WHERE id = ?').run(JSON.stringify(kept), r.id)
    }
    fixed += 1
  }
  return fixed
}

/** 清空图库：删除软件内全部图片记录与修正记录（磁盘上的原始照片文件不受影响），用于重新导入/重新开始 */
export function clearLibrary(): number {
  const n = (db.prepare('SELECT COUNT(*) c FROM images').get() as { c: number }).c
  db.prepare('DELETE FROM corrections').run()
  db.prepare('DELETE FROM images').run()
  return n
}

/** 把“无法解码”的记录重置为待处理，供清除缓存时重试（新版 RAW 内嵌预览提取链对其生效） */
export function resetSkipped(): number {
  const info = db.prepare(`UPDATE images SET status = 'pending' WHERE status = 'skip'`).run()
  return Number(info.changes) || 0
}

/** 待生成缩略图的总数（供回填进度条）；okSuffix 含义同 listPendingThumbs */
export function countPendingThumbs(okSuffix?: string): number {
  const cond = okSuffix ? "(thumb = '' OR thumb IS NULL OR thumb NOT LIKE ?) AND status != 'skip'" : "(thumb = '' OR thumb IS NULL) AND status != 'skip'"
  const row = (okSuffix ? db.prepare(`SELECT COUNT(*) c FROM images WHERE ${cond}`).get(`%${okSuffix}`) : db.prepare(`SELECT COUNT(*) c FROM images WHERE ${cond}`).get()) as { c: number }
  return row.c
}

export function deleteImages(ids: number[]): void {
  const stmt = db.prepare('DELETE FROM images WHERE id = ?')
  const tx = db.transaction((list: number[]) => list.forEach((i) => stmt.run(i)))
  tx(ids)
}

/**
 * 批量写分块执行（第二档 A3）：每块（默认 500 条）包一个事务，块间 setImmediate 让出事件循环。
 * 旧实现是 IPC handler 里逐条 auto-commit 的同步 for，几千个 id = 主进程全程阻塞，
 * 窗口缩放/输入全都跟着卡；现在事务化（少几千次 fsync，快一个量级）+ 分块（不冻 UI）。
 * 单条的“读-改-写”在同一块内同步完成不跨 await，两个 handler 交错执行最坏也只是
 * 行级后写覆盖，不会出现半套状态。
 */
export async function processChunked<T>(list: T[], fn: (item: T) => void, chunkSize = 500): Promise<void> {
  for (let i = 0; i < list.length; i += chunkSize) {
    const slice = list.slice(i, i + chunkSize)
    const tx = db.transaction(() => {
      for (const it of slice) fn(it)
    })
    tx()
    if (i + chunkSize < list.length) await new Promise((r) => setImmediate(r))
  }
}

export function pendingImages(): ImageRecord[] {
  return (db.prepare(`SELECT * FROM images WHERE status IN ('pending','error') ORDER BY id`).all() as Array<Record<string, unknown>>).map((r) => rowToImage(r))
}

export function countImages(): { total: number; done: number; pending: number } {
  const total = (db.prepare('SELECT COUNT(*) c FROM images').get() as { c: number }).c
  const done = (db.prepare(`SELECT COUNT(*) c FROM images WHERE status = 'done'`).get() as { c: number }).c
  return { total, done, pending: total - done }
}

/**
 * 重新筛选前的归位：把上一轮 AI 的归属与判定清掉，让左侧分类徽章从 0 重新涨起来。
 *
 * 为什么需要：旧写法只把 status 改成 pending，category / tags 全部保持上一轮的值；
 * 而侧标是照 category 计数的，于是整轮重筛跑完前数字一直停在“上一次的结果”，
 * 看不出新一轮正在重算（用户报告的现象）。
 *
 * 三条不动的边界：
 * - status='skip'：非图片 / 不支持的文件，本来就不参与检测
 * - 人工废弃库（trash 且 category_by='user'）：整轮跳过不再重复耗检测，沿用旧行为
 * - trash-like / category_by='user'：只重测更新标签，归属一律不动
 *   （能进两个桶的图全是用户手工丢弃的，AI 无权把它们“还魂”）
 *
 * 用户手动加的维度标签（method='user'）即使图属于 AI 归属也保留，其余标签清空等重算；
 * dup_group 一并清空：旧连拍分组随新一轮重聚类作废，不留“徽章已归零但分组页还看得到旧组”的不一致。
 * cat_changed_at 故意不动：否则几千张归位的图会一起顶到“最新在前”列表最前面。
 */
export function resetForRescan(): number {
  const rows = db
    .prepare(`SELECT id, category, category_by, tags FROM images WHERE status != 'skip'`)
    .all() as Array<{ id: number; category: string; category_by: string | null; tags: string | null }>
  const setPending = db.prepare(`UPDATE images SET status = 'pending' WHERE id = ?`)
  const resetOne = db.prepare(
    `UPDATE images SET status = 'pending', category = ?, category_by = NULL, tags = ?, dup_group = NULL WHERE id = ?`
  )
  let moved = 0
  const tx = db.transaction(() => {
    for (const r of rows) {
      const trash = isTrashLike(r.category)
      if (trash && r.category_by === 'user') continue
      if (trash || r.category_by === 'user') {
        setPending.run(r.id)
        continue
      }
      let kept: Record<string, unknown> = {}
      try {
        const t = JSON.parse(r.tags || '{}') as Record<string, { method?: string } | null>
        kept = Object.fromEntries(Object.entries(t).filter(([, v]) => v && v.method === 'user'))
      } catch {
        kept = {}
      }
      resetOne.run(CAT_LIBRARY, JSON.stringify(kept), r.id)
      moved += 1
    }
  })
  tx()
  return moved
}

/**
 * D4 一次性 backfill：给存量 status=done 行按已存 tags 补算 tier（不重跑引擎），
 * 让新列上线后旧库立刻有档位分布。幂等；人工改过的行（tier_by='user'）不覆盖。
 */
export function backfillTiers(): number {
  const rows = db.prepare(`SELECT id, tags FROM images WHERE status = 'done'`).all() as Array<{ id: number; tags: string | null }>
  const settings = getSettings()
  const stmt = db.prepare(`UPDATE images SET tier = ?, tier_by = 'ai' WHERE id = ? AND tier_by IS NOT 'user'`)
  let written = 0
  const tx = db.transaction(() => {
    for (const r of rows) {
      let parsed: ImageRecord['tags'] = {}
      try {
        parsed = JSON.parse(r.tags || '{}') as ImageRecord['tags']
      } catch {
        continue
      }
      const tier = scoreTier(parsed, settings)
      stmt.run(tier, r.id)
      written += 1
    }
  })
  tx()
  return written
}

// ---------- 分类计数（侧栏徽章） ----------

export function categoryCounts(): Record<string, number> {
  const rows = db.prepare('SELECT id, category, tags, tier, status FROM images').all() as Array<{ id: number; category: string; tags: string | null; tier: number | null; status: string }>
  const map: Record<string, number> = {}
  // 上段四档互斥可求和（= 全部）：交付库(好片) / 瑕疵片 / 重复多余 / 待确认 / 废片。
  // 优先级：废弃库 > 瑕疵片(flaw high) > 重复多余(带可见 duplicate 标签) > 待确认(review 停泊 ∪ flaw mid) > 交付库(其余无瑕疵图，含干净自定义相册)
  // 重复多余排在待确认前：组内冗余帧不需要用户“复核 AI 拿不准的判定”，它要的是去分组里选留哪张。
  let lib = 0
  let flaws = 0
  let review = 0
  let dupRedundant = 0
  // 交付库内档位（D4）：优质/良好/一般互斥，三数和 ≤ lib（差的是尚未 backfill 的 NULL 行）
  const tierCount: Record<TierKey, number> = { 1: 0, 2: 0, 3: 0 }
  // 下段内容维度（人数 / 瑕疵 / 黑白 / 自定义相册）：标签并集（主分类===dim ∪ 非 low 标签），Set 去重、允许重叠
  const dimSets: Record<string, Set<number>> = {}
  const addDim = (d: string, id: number): void => {
    if (!dimSets[d]) dimSets[d] = new Set()
    dimSets[d].add(id)
  }
  map.all = rows.length
  for (const r of rows) {
    map[r.category] = (map[r.category] || 0) + 1
    const tags = parseRowTags(r)
    const fl = flawLevel(tags)
    if (!isTrashLike(r.category)) {
      if (fl === 'high') flaws += 1
      else if (isDupRedundant(tags)) dupRedundant += 1
      else if (r.category === CAT_REVIEW || fl === 'mid') review += 1
      else if (isDeliverable(r.category, tags)) {
        lib += 1 // 与交付库视图/导出同一函数口径，含旧坏维度孤儿排除
        if (r.tier === 1 || r.tier === 2 || r.tier === 3) tierCount[r.tier] += 1
      }
    }
    if (isTrashLike(r.category)) continue // 废弃库/废弃桶不入任何内容并集视图
    if (isDimCat(r.category)) addDim(r.category, r.id) // 主分类命中
    for (const [d, t] of Object.entries(tags)) {
      if (t && t.level !== 'low' && isDimCat(d)) addDim(d, r.id) // 标签命中
    }
  }
  for (const [d, set] of Object.entries(dimSets)) map[d] = set.size
  map[CAT_LIBRARY] = lib
  map[CAT_FLAWS] = flaws
  map[CAT_REVIEW] = review
  // 侧栏“重复多余”行：只数“单因冗余被拦下、本身没拍坏”的那批（与上档互斥求和同口径）；
  // 点开后进的是整组视图，那里的张数按标签并集算（map['duplicate']），两个数不同义，不并列显示。
  map[DUP_REDUNDANT_KEY] = dupRedundant
  map['tier:1'] = tierCount[1]
  map['tier:2'] = tierCount[2]
  map['tier:3'] = tierCount[3]
  // 失败图计数（status='error'）：顶栏徒章与失败定位弹窗的数据源
  map.error = rows.reduce((n, r) => n + (r.status === 'error' ? 1 : 0), 0)
  return map
}

/** 侧栏计数专用：行 tags JSON 解析（非 done / 空 -> {}），供 flawLevel 与并集命中复用 */
function parseRowTags(r: { tags: string | null; status: string }): Record<string, { level?: string }> {
  if (r.status !== 'done' || !r.tags) return {}
  try {
    return JSON.parse(r.tags) as Record<string, { level?: string }>
  } catch {
    return {}
  }
}

// ---------- 修正记录 ----------

export function addCorrection(c: Omit<CorrectionRecord, 'id'>): void {
  db.prepare(`
    INSERT INTO corrections (image_id, orig_dim, orig_confidence, new_category, action, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(c.imageId, c.origDim, c.origConfidence, c.newCategory, c.action, c.timestamp)
}

export function correctionStats(): Record<string, { falsePositive: number; truePositive: number; total: number }> {
  const rows = db.prepare('SELECT orig_dim, action, COUNT(*) c FROM corrections WHERE orig_dim IS NOT NULL GROUP BY orig_dim, action').all() as Array<{ orig_dim: string; action: string; c: number }>
  const out: Record<string, { falsePositive: number; truePositive: number; total: number }> = {}
  for (const r of rows) {
    const s = (out[r.orig_dim] ||= { falsePositive: 0, truePositive: 0, total: 0 })
    if (r.action === 'wrong') s.falsePositive += r.c
    else s.truePositive += r.c
    s.total += r.c
  }
  return out
}

export function totalCorrections(): number {
  return (db.prepare('SELECT COUNT(*) c FROM corrections').get() as { c: number }).c
}

// ---------- 自定义分类 ----------

export function listCustomCategories(): Array<{ id: number; name: string }> {
  return db.prepare('SELECT id, name FROM custom_categories ORDER BY id').all() as Array<{ id: number; name: string }>
}

export function addCustomCategory(name: string): { id: number; name: string } {
  const info = db.prepare('INSERT INTO custom_categories (name, created_at) VALUES (?, ?)').run(name, Date.now())
  return { id: Number(info.lastInsertRowid), name }
}

export function removeCustomCategory(id: number): void {
  db.prepare('DELETE FROM custom_categories WHERE id = ?').run(id)
  // 该分类中的图片回归交付库
  db.prepare(`UPDATE images SET category = 'library', category_by = NULL WHERE category = ?`).run(`custom:${id}`)
}

// ---------- 设置 ----------

export function getSettings(): AppSettings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>
  const map: Record<string, unknown> = {}
  for (const r of rows) {
    try {
      map[r.key] = JSON.parse(r.value)
    } catch {
      map[r.key] = r.value
    }
  }
  const merged = { ...DEFAULT_SETTINGS, ...(map as Partial<AppSettings>) }
  // 一次性迁移：旧版默认阈值 0.9/0.7 且从未主动选过检测程度 → 升级到新的默认“非常严格”档
  if (map.highThreshold === 0.9 && map.midThreshold === 0.7 && map.strictness === undefined) {
    merged.strictness = 'very'
    merged.highThreshold = 0.8
    merged.midThreshold = 0.55
    saveSettings({ strictness: 'very', highThreshold: 0.8, midThreshold: 0.55 })
  }
  return merged
}

export function saveSettings(s: Partial<AppSettings>): void {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(s)) stmt.run(k, JSON.stringify(v))
  })
  tx()
}

/** 更新一张图的最大坏/中性标签置信度后重新分桶 */
export function getImageIdsByDupGroup(g: string): number[] {
  return (db.prepare('SELECT id FROM images WHERE dup_group = ?').all(g) as Array<{ id: number }>).map((r) => r.id)
}

/**
 * 按 dup_group 批量取整组全部成员（含不在当前分类的“第一张”保留帧）。
 * 重复/连拍分组视图必须看到完整组：聚类时每组第一张留在原分类（交付库），
 * 只按当前分类列表分组会让“2 张的组”只剩 1 张可见，退化成无意义的孤帧。
 * IN 列表按 500 个一组分块，避免撞 SQLite 预处理语句变量数上限。
 */
export function listImagesByDupGroups(gids: string[]): ImageRecord[] {
  const out: ImageRecord[] = []
  const seen = new Set<number>()
  for (let i = 0; i < gids.length; i += 500) {
    const chunk = gids.slice(i, i + 500)
    const params: Record<string, string> = {}
    chunk.forEach((g, j) => {
      params[`g${j}`] = g
    })
    const ph = chunk.map((_, j) => `@g${j}`).join(',')
    const rows = db.prepare(`SELECT * FROM images WHERE dup_group IN (${ph}) ORDER BY id`).all(params) as Array<
      Record<string, unknown>
    >
    for (const r of rows) {
      const rec = rowToImage(r, true)
      if (seen.has(rec.id)) continue
      seen.add(rec.id)
      out.push(rec)
    }
  }
  return out
}

export function _helpers_for_test_only() {
  return {}
}
