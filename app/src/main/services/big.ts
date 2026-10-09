/**
 * 大图原图预览缓存：浏览器 <img> 无法直接渲染 RAW/HEIC 原文件，
 * 主进程用 sharp（含 RAW 内嵌预览兜底链）产出长边 2560 的高清 JPEG 缓存供大图视图使用。
 */
import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import sharp from 'sharp'
import { getDb } from '../db'
import { sharpInput } from './rawPreview'

/** 大预览长边上限（兼顾锐利与加载速度） */
const BIG_MAX = 2560

function bigDir(): string {
  const dir = join(app.getPath('userData'), 'data', 'big')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 清理大图预览磁盘缓存（升级方向修正后强制重建用），返回删除文件数 */
export function clearBigCache(): number {
  const dir = bigDir()
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

/**
 * 确保某张图的高清预览存在，返回其磁盘路径（失败回退缩略图路径；无缓存返回 null）。
 * 缓存命中条件：<id>.jpg 存在且不早于源文件修改时间。
 */
export async function ensureBigPreview(id: number): Promise<string | null> {
  const row = getDb()
    .prepare('SELECT path, thumb FROM images WHERE id = ?')
    .get(id) as { path: string; thumb: string } | undefined
  if (!row) return null
  const out = join(bigDir(), `${id}.jpg`)
  try {
    if (existsSync(out) && statSync(out).mtimeMs >= statSync(row.path).mtimeMs) return out
  } catch {
    /* 源文件信息取不到则继续重新生成 */
  }
  try {
    const input = await sharpInput(row.path)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sharp(input as any, { failOn: 'none' }) as ReturnType<typeof sharp>)
      .rotate()
      .resize({ width: BIG_MAX, height: BIG_MAX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toFile(out)
    return out
  } catch {
    return row.thumb || null
  }
}
