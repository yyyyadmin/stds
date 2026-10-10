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
  ImageRecord
} from '../shared/types'
import {
  BAD_DIMENSIONS,
  NEUTRAL_DIMENSIONS,
  CAT_LIBRARY,
  CAT_REVIEW,
  CAT_TRASH,
  CAT_DUP_TRASH,
  isTrashLike,
  DEFAULT_SETTINGS
} from '../shared/types'

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
  // 一次性迁移：产品决策取消“双人照”类型，2 人并入“多人合照”。老库中归在 two_person 桶的图片迁到 group_photo，
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

function rowToImage(r: Record<string, unknown>): ImageRecord {
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
    details: r.details ? JSON.parse(r.details as string) : null,
    dupGroup: (r.dup_group as string) || null,
    scene: (r.scene as string) || null,
    addedAt: r.added_at as number,
    scannedAt: (r.scanned_at as number) || null,
    categoryBy: (r.category_by as ImageRecord['categoryBy']) || null
  }
}

// ---------- 图片 ----------

export function insertImage(rec: Omit<ImageRecord, 'id' | 'tags' | 'details' | 'categoryBy' | 'dupGroup' | 'scene' | 'scannedAt'> & { tags?: ImageRecord['tags'] }): number {
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
  return (db.prepare(sql).all(params) as Array<Record<string, unknown>>).map(rowToImage)
}

/**
 * 成品库 / 待确认 / 垃圾桶 是"虚拟桶"：
 * 成品库 = category 不在坏维度、不在待确认、不在垃圾桶
 */
function virtualCategorySql(cat: CategoryKey): string {
  if (cat === 'all') return '1=1'
  if (cat === CAT_LIBRARY) {
    const bads = [...BAD_DIMENSIONS, CAT_REVIEW, CAT_TRASH, CAT_DUP_TRASH].map((b) => `'${b}'`).join(',')
    return `category NOT IN (${bads})`
  }
  if (cat === CAT_REVIEW || cat === CAT_TRASH || cat === CAT_DUP_TRASH) {
    return `category = '${cat}'`
  }
  return `category = @cat_${cat.replace(/[^a-z0-9]/gi, '')}`
}

export function categoryParams(cat: CategoryKey, params: Record<string, unknown>): Record<string, unknown> {
  if (cat === CAT_LIBRARY || cat === CAT_REVIEW || cat === CAT_TRASH) return params
  params[`cat_${cat.replace(/[^a-z0-9]/gi, '')}`] = cat
  return params
}

export function listByCategory(cat: CategoryKey): ImageRecord[] {
  const where = virtualCategorySql(cat)
  const params: Record<string, unknown> = {}
  if (cat !== 'all' && cat !== CAT_LIBRARY && cat !== CAT_REVIEW && cat !== CAT_TRASH && cat !== CAT_DUP_TRASH) {
    params[`cat_${cat.replace(/[^a-z0-9]/gi, '')}`] = cat
  }
  const tagLike = '%"' + cat + '":{%'
  const rows = db.prepare(`SELECT * FROM images WHERE (${where}) OR (status = 'done' AND tags LIKE @tagLike) ORDER BY COALESCE(sort_order, id), id`).all({ ...params, tagLike }) as Array<Record<string, unknown>>
  const out = rows.map(rowToImage)
  // 坏/中性维度分类是"标签并集视图"：一张图同时模糊+斜眼时两个分类都该看到它，
  // 但仅当该标签达到高/中置信度（未被过滤）才展示，且垃圾桶内的图不在其它视图出现
  if (isDimCat(cat)) {
    return out.filter((r) => r.category === cat || (!isTrashLike(r.category) && r.tags[cat as DimensionKey] && r.tags[cat as DimensionKey]!.level !== 'low'))
  }
  return out.filter((r) => !isTrashLike(r.category) || cat === CAT_TRASH || cat === CAT_DUP_TRASH || cat === 'all')
}

function isDimCat(cat: CategoryKey): boolean {
  return (BAD_DIMENSIONS as string[]).includes(cat) || (NEUTRAL_DIMENSIONS as string[]).includes(cat)
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
  db.prepare(`
    UPDATE images SET tags = ?, details = ?, dup_group = ?, category = ?, category_by = ?, status = ?, scanned_at = ?
    WHERE id = ?
  `).run(JSON.stringify(tags), JSON.stringify(details), dupGroup, category, categoryBy, status, Date.now(), id)
}

export function setCategory(id: number, category: CategoryKey, categoryBy: 'ai' | 'user' | null): void {
  db.prepare('UPDATE images SET category = ?, category_by = ? WHERE id = ?').run(category, categoryBy, id)
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

/** 后台回填：待生成缩略图的记录（含 done 但缩略图丢失的；skip 项由 resetSkipped 转 pending 后一并重试） */
export function listPendingThumbs(limit: number): Array<{ id: number; path: string }> {
  return db
    .prepare(`SELECT id, path FROM images WHERE (thumb = '' OR thumb IS NULL) AND status != 'skip' ORDER BY id LIMIT ?`)
    .all(limit) as Array<{ id: number; path: string }>
}

export function setDimTag(id: number, dim: DimensionKey, tag: DimResult | null): void {
  const r = getImage(id)
  if (!r) return
  const tags = { ...r.tags }
  if (tag) tags[dim] = tag
  else delete tags[dim]
  db.prepare('UPDATE images SET tags = ? WHERE id = ?').run(JSON.stringify(tags), id)
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

/** 待生成缩略图的总数（供回填进度条） */
export function countPendingThumbs(): number {
  return (db.prepare(`SELECT COUNT(*) c FROM images WHERE (thumb = '' OR thumb IS NULL) AND status != 'skip'`).get() as { c: number }).c
}

export function deleteImages(ids: number[]): void {
  const stmt = db.prepare('DELETE FROM images WHERE id = ?')
  const tx = db.transaction((list: number[]) => list.forEach((i) => stmt.run(i)))
  tx(ids)
}

export function pendingImages(): ImageRecord[] {
  return (db.prepare(`SELECT * FROM images WHERE status IN ('pending','error') ORDER BY id`).all() as Array<Record<string, unknown>>).map(rowToImage)
}

export function countImages(): { total: number; done: number; pending: number } {
  const total = (db.prepare('SELECT COUNT(*) c FROM images').get() as { c: number }).c
  const done = (db.prepare(`SELECT COUNT(*) c FROM images WHERE status = 'done'`).get() as { c: number }).c
  return { total, done, pending: total - done }
}

// ---------- 分类计数（侧栏徽章） ----------

export function categoryCounts(): Record<string, number> {
  const rows = db.prepare('SELECT category, tags, status FROM images').all() as Array<{ category: string; tags: string | null; status: string }>
  const map: Record<string, number> = {}
  let library = 0
  const dimCount: Record<string, number> = {}
  map.all = rows.length
  for (const r of rows) {
    map[r.category] = (map[r.category] || 0) + 1
    const isBad = (BAD_DIMENSIONS as string[]).includes(r.category)
    if (!isBad && r.category !== CAT_LIBRARY && r.category !== CAT_REVIEW && !isTrashLike(r.category)) {
      // 中性/自定义分类同样属于成品库（垃圾桶与重复废弃桶除外）
      library += 1
    }
    // 维度分类徒章 = 标签并集计数（与 listByCategory 视图一致，垃圾桶/废弃桶除外）
    if (r.status === 'done' && r.tags && !isTrashLike(r.category)) {
      try {
        const tags = JSON.parse(r.tags) as Record<string, { level?: string }>
        for (const [d, t] of Object.entries(tags)) {
          if (t && t.level !== 'low' && isDimCat(d)) dimCount[d] = (dimCount[d] || 0) + 1
        }
      } catch {
        /* ignore */
      }
    }
  }
  for (const [d, n] of Object.entries(dimCount)) map[d] = Math.max(map[d] || 0, n)
  map[CAT_LIBRARY] = (map[CAT_LIBRARY] || 0) + library
  return map
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
  // 该分类中的图片回归成品库
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

export function _helpers_for_test_only() {
  return {}
}
