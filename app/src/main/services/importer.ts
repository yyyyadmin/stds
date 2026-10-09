/**
 * 导入模块（第九章 9.1）：文件夹 / 拖入图片，支持 JPG/PNG/TIFF/BMP/WebP/HEIC 及主流 RAW
 * - 递归遍历目录，去重（同路径不重复导入）
 * - sharp 读取尺寸 + 生成缩略图缓存；无法解码的文件标记 skip
 */
import { readdirSync, statSync, unlinkSync } from 'fs'
import { basename, extname, join } from 'path'
import sharp from 'sharp'
import { insertImage, imageExists, thumbDir, setImageMeta, setImageStatus, listPendingThumbs, countPendingThumbs, getDb } from '../db'
import { SUPPORTED_EXTS } from '../../shared/types'
import { orientedSharp } from './rawPreview'

function walk(dir: string, out: string[], stats: { filtered: number }, depth = 0): void {
  if (depth > 8) return
  let entries: ReturnType<typeof readdirSync> extends never ? never : import('fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as unknown as typeof entries
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    try {
      if (e.isDirectory()) walk(p, out, stats, depth + 1)
      else if (e.isFile()) {
        if (SUPPORTED_EXTS.includes(extname(e.name).toLowerCase())) out.push(p)
        else stats.filtered++ // 非照片格式：不入库，计入“已跳过”反馈
      }
    } catch {
      /* 忽略无权限项 */
    }
  }
}

export interface ImportProgress {
  done: number
  total: number
  current: string
}

export async function importPaths(
  paths: string[],
  onProgress: (p: ImportProgress) => void,
  shouldStop: () => boolean
): Promise<{ added: number; skipped: number; existed: number; filtered: number }> {
  const files: string[] = []
  const stats = { filtered: 0 }
  for (const p of paths) {
    try {
      const st = statSync(p)
      if (st.isDirectory()) walk(p, files, stats)
      else if (st.isFile()) {
        if (SUPPORTED_EXTS.includes(extname(p).toLowerCase())) files.push(p)
        else stats.filtered++ // 直接选/拖入的不支持文件：不入库，计入反馈
      }
    } catch {
      /* ignore */
    }
  }
  let added = 0
  let existed = 0
  let done = 0
  // 快速入库：只 stat + 插入，不解码、不生成缩略图（缩略图交后台回填），本地目录可秒级完成
  for (const f of files) {
    done++
    if (shouldStop()) break
    if (imageExists(f)) {
      existed++
      continue
    }
    let size = 0
    try {
      size = statSync(f).size
    } catch {
      /* ignore */
    }
    insertImage({
      path: f,
      filename: basename(f),
      dir: f.replace(/[\\/][^\\/]*$/, ''),
      width: 0,
      height: 0,
      format: extname(f).slice(1).toLowerCase(),
      fileSize: size,
      thumb: '',
      status: 'pending',
      category: 'library',
      addedAt: Date.now()
    })
    added++
    if (done % 300 === 0) {
      onProgress({ done, total: files.length, current: basename(f) })
      await new Promise((r) => setImmediate(r))
    }
  }
  onProgress({ done: files.length, total: files.length, current: '' })
  return { added, skipped: 0, existed, filtered: stats.filtered }
}

/** 单张图片：读尺寸 + 生成 256px 缩略图；RAW 解码失败时自动提取内嵌 JPEG 预览兜底；仍失败才标记 skip */
async function makeThumb(id: number, path: string): Promise<void> {
  try {
    const meta = await (await orientedSharp(path)).metadata()
    const thumbPath = join(thumbDir(), `${Buffer.from(path).toString('base64url').replace(/[+/=]/g, '_')}.jpg`)
    await (await orientedSharp(path))
      .resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 76 })
      .toFile(thumbPath)
    setImageMeta(id, meta.width || 0, meta.height || 0, thumbPath)
  } catch {
    setImageStatus(id, 'skip')
  }
}

let backfilling = false

/**
 * 后台缩略图回填：导入后低优先级逐批生成缩略图，每批完成回调 onBatch(count) 供渲染层刷新；
 * onProgress 上报 {done,total} 供中部“生成缩略图中”进度条。可重复调用（幂等，已在跑则直接返回）。
 */
export async function backfillThumbnails(
  onBatch: (count: number) => void,
  onProgress?: (p: { done: number; total: number }) => void
): Promise<void> {
  if (backfilling) return
  backfilling = true
  try {
    let done = 0
    let total = countPendingThumbs()
    onProgress?.({ done, total })
    while (true) {
      const rows = listPendingThumbs(24)
      if (!rows.length) break
      const CONCURRENCY = 3
      for (let i = 0; i < rows.length; i += CONCURRENCY) {
        const slice = rows.slice(i, i + CONCURRENCY)
        await Promise.all(slice.map((r) => makeThumb(r.id, r.path)))
        await new Promise((res) => setImmediate(res))
      }
      done += rows.length
      // 回填期间可能有新导入，总数动态校准
      total = Math.max(total, done + countPendingThumbs())
      onProgress?.({ done, total })
      onBatch(rows.length)
    }
    onProgress?.({ done: total, total })
  } finally {
    backfilling = false
  }
}

/** 清理缩略图磁盘缓存（仅应用私有缓存目录），返回删除文件数 */
export function clearThumbCache(): number {
  const dir = thumbDir()
  let n = 0
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jpg')) continue
      try {
        unlinkSync(join(dir, f))
        n++
      } catch {
        /* 占用中的文件跳过 */
      }
    }
  } catch {
    /* ignore */
  }
  return n
}

/** 清理数据库中已不存在于磁盘的文件记录 */
export function pruneMissing(): number {
  const rows = getDb().prepare('SELECT id, path FROM images').all() as Array<{ id: number; path: string }>
  const del = getDb().prepare('DELETE FROM images WHERE id = ?')
  let n = 0
  for (const r of rows) {
    try {
      statSync(r.path)
    } catch {
      del.run(r.id)
      n++
    }
  }
  return n
}
