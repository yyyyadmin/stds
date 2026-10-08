/**
 * 导入模块（第九章 9.1）：文件夹 / 拖入图片，支持 JPG/PNG/TIFF/BMP/WebP/HEIC 及主流 RAW
 * - 递归遍历目录，去重（同路径不重复导入）
 * - sharp 读取尺寸 + 生成缩略图缓存；无法解码的文件标记 skip
 */
import { readdirSync, statSync } from 'fs'
import { basename, extname, join } from 'path'
import sharp from 'sharp'
import { insertImage, imageExists, thumbDir, setImageMeta, setImageStatus, listPendingThumbs, getDb } from '../db'
import { SUPPORTED_EXTS } from '../../shared/types'

function walk(dir: string, out: string[], depth = 0): void {
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
      if (e.isDirectory()) walk(p, out, depth + 1)
      else if (e.isFile() && SUPPORTED_EXTS.includes(extname(e.name).toLowerCase())) out.push(p)
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
): Promise<{ added: number; skipped: number; existed: number }> {
  const files: string[] = []
  for (const p of paths) {
    try {
      const st = statSync(p)
      if (st.isDirectory()) walk(p, files)
      else if (st.isFile() && SUPPORTED_EXTS.includes(extname(p).toLowerCase())) files.push(p)
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
  return { added, skipped: 0, existed }
}

/** 单张图片：读尺寸 + 生成 256px 缩略图；失败标记 skip */
async function makeThumb(id: number, path: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = await (sharp(path, { failOn: 'none' } as any).rotate()).metadata()
    const thumbPath = join(thumbDir(), `${Buffer.from(path).toString('base64url').replace(/[+/=]/g, '_')}.jpg`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sharp(path, { failOn: 'none' } as any) as ReturnType<typeof sharp>)
      .rotate()
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
 * 后台缩略图回填：导入后低优先级逐批生成缩略图，每批完成回调 onBatch(count) 供渲染层刷新。
 * 并发受限，避免抢占扫描/渲染资源；可重复调用（幂等，已在跑则直接返回）。
 */
export async function backfillThumbnails(onBatch: (count: number) => void): Promise<void> {
  if (backfilling) return
  backfilling = true
  try {
    while (true) {
      const rows = listPendingThumbs(24)
      if (!rows.length) break
      const CONCURRENCY = 3
      for (let i = 0; i < rows.length; i += CONCURRENCY) {
        const slice = rows.slice(i, i + CONCURRENCY)
        await Promise.all(slice.map((r) => makeThumb(r.id, r.path)))
        await new Promise((res) => setImmediate(res))
      }
      onBatch(rows.length)
    }
  } finally {
    backfilling = false
  }
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
