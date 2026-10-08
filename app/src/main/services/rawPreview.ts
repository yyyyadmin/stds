/**
 * RAW 兜底解码（问题一：CR3 / ARW 等 LibRaw 支持不佳的机型显示"无法解码"）
 * 相机 RAW 文件内嵌 1~N 个完整 JPEG 预览（相机已按显示方向渲染），
 * sharp/LibRaw 失败时直接从文件里提取最大内嵌 JPEG，纯 JS 无原生依赖，全平台可用。
 */
import { readFileSync, existsSync } from 'fs'
import { extname } from 'path'
import sharp from 'sharp'

const RAW_EXTS = new Set(['.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.dng'])

/** 浏览器 <img> 无法直接显示、必须走缩略图/预览的格式 */
export const BROWSER_UNDISPLAYABLE_EXTS = new Set([
  ...RAW_EXTS,
  '.heic',
  '.heif'
])

export function isRawPath(p: string): boolean {
  return RAW_EXTS.has(extname(p).toLowerCase())
}

/** 扫描文件中的 JPEG 段（FFD8FF...FFD9），返回最大的完整内嵌 JPEG */
export function extractEmbeddedJpeg(file: string): Buffer | null {
  let buf: Buffer
  try {
    buf = readFileSync(file)
  } catch {
    return null
  }
  const candidates: Buffer[] = []
  let off = 0
  const soi = Buffer.from([0xff, 0xd8, 0xff])
  const eoi = Buffer.from([0xff, 0xd9])
  while (off < buf.length - 4) {
    const start = buf.indexOf(soi, off)
    if (start < 0) break
    const end = buf.indexOf(eoi, start + 3)
    if (end < 0) break
    const cand = buf.subarray(start, end + 2)
    if (cand.length > 1024) candidates.push(Buffer.from(cand))
    off = end + 2
    if (candidates.length > 24) break // 防御异常文件里的海量小图
  }
  if (!candidates.length) return null
  candidates.sort((a, b) => b.length - a.length)
  return candidates[0]
}

/** sharp 能否直接解码该文件（用于决定走原生 RAW 还是内嵌预览） */
async function sharpCanDecode(src: string): Promise<boolean> {
  try {
    const m = await sharp(src, { failOn: 'none' }).metadata()
    return !!m.width && !!m.height
  } catch {
    return false
  }
}

// 单进程内同一张图会被模糊/曝光/哈希多次加载，缓存最近一次提取结果避免重复读大文件
let cache: { path: string; buf: Buffer } | null = null

/**
 * 返回可交给 sharp() 的输入：普通格式原路返回；
 * RAW 且 sharp 直解失败时返回内嵌 JPEG Buffer；提取失败仍返回原路径（由调用方 catch 兜底）。
 */
export async function sharpInput(path: string): Promise<string | Buffer> {
  if (!isRawPath(path)) return path
  if (await sharpCanDecode(path)) return path
  if (cache && cache.path === path) return cache.buf
  const jpeg = extractEmbeddedJpeg(path)
  if (!jpeg) return path
  cache = { path, buf: jpeg }
  return jpeg
}

/** 供导入器使用：生成缩略图数据源（含 RAW 兜底链） */
export async function decodeSource(path: string): Promise<{ input: string | Buffer; viaEmbedded: boolean }> {
  const input = await sharpInput(path)
  return { input, viaEmbedded: Buffer.isBuffer(input) }
}

export function hasFile(p: string): boolean {
  return existsSync(p)
}
