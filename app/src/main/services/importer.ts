/**
 * 导入模块（第九章 9.1）：文件夹 / 拖入图片，支持 JPG/PNG/TIFF/BMP/WebP/HEIC 及主流 RAW
 * - 递归遍历目录，去重（同路径不重复导入）
 * - 同名过滤（用户 10-16）：文件名+后缀完全一样且文件大小相同 → 判定为同一张照片从多个文件夹重复导入，跳过并计数；
 *   同名但大小不同 → 相机重号（两场婚礼可能都有 7G1A0001.JPG），是不同的照片，照常导入并在提示里单独报数，绝不误吞
 * - sharp 读取尺寸 + 生成缩略图缓存；无法解码的文件标记 skip
 */
import { readdirSync, statSync, unlinkSync, existsSync } from 'fs'
import { basename, extname, join } from 'path'
import sharp from 'sharp'
import { insertImage, imageExists, thumbDir, setImageMeta, setImageStatus, listPendingThumbs, countPendingThumbs, getDb } from '../db'
import { SUPPORTED_EXTS, THUMB_MAX, THUMB_QUALITY, THUMB_SUFFIX, THUMB_SMALL_MAX, THUMB_SMALL_QUALITY, smallThumbPath } from '../../shared/types'
import { orientedSharp } from './rawPreview'

/**
 * 缩略图双档：大档长边 960px + 质量 82（历史档位 256 → 640 → 960），小档 320px（见 shared/types 注释）。
 * 为什么逐次提档：网格卡片是正方形且能用 Ctrl+滚轮放到 610 CSS px（GRID_MAX），<img> 是
 * object-cover，真正决定清晰度的是**短边**像素——3:2 横片在 640 档下短边只有 427px，
 * 放到一行三张时 100% 系统缩放就有 1.43 倍拉伸，能看出发软。960 档短边 640px：
 * 610 格子在 100% 缩放回到约 1:1，125% 缩放也只差 1.2 倍；默认 160 格子更是大幅过足。
 * 但“过足”在普通格子上就是浪费：解码开销随像素面积走，3000 张全用 960 解码是低配机
 * 滚动卡顿大头，所以另生一层小档给网格/列表用，渲染层按 格子×DPR 自动选档。
 * 小档那 320 定的是**短边**（sharp fit:'outside'），不是长边：方形格子 + object-cover 铺满
 * 正方形靠的就是短边。按长边 320 出档时 2:3 竖片只有 213x320，而默认 160 CSS px 格子在
 * 200% 系统缩放下要 323 物理 px，短边不够就被放大 1.5 倍——小屏笔记本上网格发糊正是这里。
 * 小档不入库，所以改几何只能靠换文件名后缀（THUMB_SMALL_SUFFIX 里的 sq 就是这次的版本号）：
 * 不换名的话 backfillSmallThumbs 见文件已存在就跳过，老库会一半短边 213 一半短边 320 混着用。
 * 文件名里的大档后缀（THUMB_SUFFIX）就是版本号：改常量后旧档自动判“待重建”，
 * 后台无感重刷，刷完 pruneUnreferencedThumbs 自动回收老档（小档按大档名派生，一并放行）；
 * 设置里的「清除缓存」是推倒重来（连已重建的新档也删掉全量重建），一般用不着。
 */

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
): Promise<{ added: number; skipped: number; existed: number; filtered: number; dupSkipped: number; nameKept: number }> {
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
  // 库里已有的“文件名(忽略大小写) → 一组文件大小”：同名同大小判重复，同名不同大小判重号（不丢片）
  const nameSizes = new Map<string, Set<number>>()
  for (const r of getDb().prepare('SELECT filename, file_size FROM images').all() as Array<{ filename: string; file_size: number }>) {
    const k = r.filename.toLowerCase()
    let s = nameSizes.get(k)
    if (!s) nameSizes.set(k, (s = new Set()))
    s.add(r.file_size)
  }
  let added = 0
  let existed = 0
  let dupSkipped = 0
  let nameKept = 0
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
    const key = basename(f).toLowerCase()
    const known = nameSizes.get(key)
    if (known && known.has(size)) {
      dupSkipped++ // 同名同大小：同一张照片已经从另一个文件夹导过了，不再重复入库
      continue
    }
    if (known) nameKept++ // 同名不同大小：相机重号，是不同的照片，照常导入但计入提示
    if (known) known.add(size)
    else nameSizes.set(key, new Set([size]))
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
  return { added, skipped: 0, existed, filtered: stats.filtered, dupSkipped, nameKept }
}

/** 单张图片：读尺寸 + 生成缩略图双档（大档见 THUMB_MAX，小档由大档换后缀派生）；RAW 解码失败时自动提取内嵌 JPEG 预览兜底；仍失败才标记 skip */
async function makeThumb(id: number, path: string): Promise<void> {
  try {
    const meta = await (await orientedSharp(path)).metadata()
    const thumbPath = join(thumbDir(), `${Buffer.from(path).toString('base64url').replace(/[+/=]/g, '_')}${THUMB_SUFFIX}`)
    await (await orientedSharp(path))
      .resize({ width: THUMB_MAX, height: THUMB_MAX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: THUMB_QUALITY })
      .toFile(thumbPath)
    // 小档从已生成大档缩：不必再解一次原图（RAW 尤其贵）。小档失败无害——
    // 渲染层 onError 自动回退大档，不影响正确性，所以不纳入 skip 判定。
    try {
      const sp = smallThumbPath(thumbPath)
      // fit:'outside' = 缩到能把 320x320 这个框整个盖住（仍是等比例，不裁画面）；
      // 小档是从大档缩的，长边不会超过大档，所以这一档永远不比大档大（3:1 宽幅全景图就停在 960x320）。
      if (sp) await sharp(thumbPath).resize({ width: THUMB_SMALL_MAX, height: THUMB_SMALL_MAX, fit: 'outside', withoutEnlargement: true }).jpeg({ quality: THUMB_SMALL_QUALITY }).toFile(sp)
    } catch {
      /* 小档缺失由 backfillSmallThumbs 下次启动补 */
    }
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
    let total = countPendingThumbs(THUMB_SUFFIX)
    onProgress?.({ done, total })
    while (true) {
      const rows = listPendingThumbs(24, THUMB_SUFFIX)
      if (!rows.length) break
      const CONCURRENCY = 3
      for (let i = 0; i < rows.length; i += CONCURRENCY) {
        const slice = rows.slice(i, i + CONCURRENCY)
        await Promise.all(slice.map((r) => makeThumb(r.id, r.path)))
        await new Promise((res) => setImmediate(res))
      }
      done += rows.length
      // 回填期间可能有新导入，总数动态校准
      total = Math.max(total, done + countPendingThumbs(THUMB_SUFFIX))
      onProgress?.({ done, total })
      onBatch(rows.length)
    }
    onProgress?.({ done: total, total })
    // 全部追上新档后，老 256px 文件（以及已删图残留）已无人指向，收掉腾回磁盘
    if (done > 0) pruneUnreferencedThumbs()
  } finally {
    backfilling = false
  }
}

let smallBackfilling = false

/**
 * 小档补齐（老库升级一次性成本）：已有当前大档但小档文件缺失的，直接从大档缩一张。
 * 不报进度、不发 thumbsReady：回填期间渲染层请求小档失败会 onError 自动回退大档，
 * 用户全程有图可看，事后新渲染的卡片自然用上小档，无需任何刷新。
 */
export async function backfillSmallThumbs(): Promise<void> {
  if (smallBackfilling) return
  smallBackfilling = true
  let rebuilt = 0
  try {
    const rows = getDb().prepare(`SELECT thumb FROM images WHERE thumb != '' AND thumb LIKE ?`).all(`%${THUMB_SUFFIX}`) as Array<{ thumb: string }>
    for (let i = 0; i < rows.length; i += 16) {
      const slice = rows.slice(i, i + 16)
      await Promise.all(
        slice.map(async (r) => {
          const sp = smallThumbPath(r.thumb)
          if (!sp || existsSync(sp)) return
          try {
            // 与 makeThumb 里那行保持一致（同一套几何与质量），否则老库补出来的小档跟新导入的不是一个档
            await sharp(r.thumb).resize({ width: THUMB_SMALL_MAX, height: THUMB_SMALL_MAX, fit: 'outside', withoutEnlargement: true }).jpeg({ quality: THUMB_SMALL_QUALITY }).toFile(sp)
            rebuilt++
          } catch {
            /* 单张损坏跳过，下次启动再试 */
          }
        })
      )
      await new Promise((res) => setImmediate(res))
    }
    /*
     * 收旧小档：换过小档后缀（几何改版）后，老 @320.jpg 在 keep 集合里已不再被引用，
     * 而大档没待重建时 backfillThumbnails 里的 prune 分支（done>0）不会跑，这批孤儿文件
     * 会一直占盘（一万张约 150MB）。只在确实重缩过东西时才收一次，且必须确认大档已全部
     * 跟上：两个回填是同时启动的，大档还在迁移时 DB 行可能仍指向旧后缀的大档，
     * 那时广撒网地 prune 会把还有人在用的大档删掉，卡片会白到重刷完成。
     */
    if (rebuilt > 0 && countPendingThumbs(THUMB_SUFFIX) === 0) pruneUnreferencedThumbs()
  } finally {
    smallBackfilling = false
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

/**
 * 删除缩略图目录里已无人指向的文件，返回清理个数。
 * 以库里的 thumb 字段为准：正在用、以及“还没轮到重建”的老档图都还被某行指着，不会被误删；
 * 小档不入库，按大档名派生白名单（否则会被当无主垃圾收掉，网格天天回退大档提速白做）；
 * 只有升级后被彻底抛弃的老档文件（连同已删照片的残留）才会被收掉。
 */
export function pruneUnreferencedThumbs(): number {
  const dir = thumbDir()
  const keep = new Set<string>()
  for (const r of getDb().prepare(`SELECT thumb FROM images WHERE thumb != ''`).all() as Array<{ thumb: string }>) {
    const b = basename(r.thumb)
    keep.add(b)
    const s = smallThumbPath(b)
    if (s) keep.add(s)
  }
  let n = 0
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jpg') || keep.has(f)) continue
      try {
        unlinkSync(join(dir, f))
        n++
      } catch {
        /* 占用中的跳过，下次启动再清 */
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
