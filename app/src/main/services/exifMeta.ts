/**
 * 原图拍摄参数（EXIF）读取 —— 大图右栏「照片参数信息」区
 * 两条路：
 * ① exifr：JPEG / TIFF 型 RAW（CR2/NEF/ARW/DNG…）全量解析；
 * ② exifr 不认识的容器（CR3、部分 HEIC）退回自研 TIFF-IFD 字节解析：扫文件头 8MB 内所有
 *    II·49·2A 或 MM·4D·2A 签名的 TIFF 头（CR3 的参数在 CMT1 盒内，与 rawPreview.ts 的方向解析同源），
 *    逐个解 IFD0 + ExifIFD 子目录，再把全部候选合并成一份。
 * 两条路的产出最后都过 curate()：只保留 KEEP 白名单里的项，列名一律中文（用户要求：
 * 不要一堆看不懂的英文键名，也不要几十条没用的参数），非相机直出的图返回 null。
 * 结果按路径缓存最近 40 张（来回翻图不重复读文件）。
 */
import { closeSync, fstatSync, openSync, readSync } from 'fs'
import exifr from 'exifr'
import type { MetaItem } from '../../shared/ipc'

// ---------- 展示白名单（顺序即展示顺序） ----------
/**
 * 这一列的规范名提成常量：KEEP 与两条解析路径共用同一个引用，避免三处拼写漂移。
 * 写成两个字符相加是不得已——编辑器批量落盘时这个词曾被转坏过一次。
 */
const L_SHUTTER = '快' + '门'
const KEEP = [
  '相机', '镜头', '拍摄时间', L_SHUTTER, '光圈', 'ISO', '焦距', '等效焦距',
  '曝光补偿', '测光模式', '白平衡', '闪光灯', '机身序列号', '镜头序列号', '拍摄位置'
]

/**
 * 收口成客户看得懂的那几行：
 * - 只留 KEEP 里的列（有值才留），顺序固定；
 * - 制造商 + 相机型号合成一行「相机」，型号已带厂牌名时不重复；
 * - 曝光补偿为 0 时不显示（等于没补偿，占一行没用）。
 */
function curate(items: MetaItem[]): MetaItem[] {
  const by = new Map<string, string>()
  for (const it of items) if (it.v && !by.has(it.k)) by.set(it.k, it.v)
  const mk = by.get('制造商') ?? ''
  let md = by.get('相机型号') ?? ''
  if (mk && md.toLowerCase().startsWith(mk.toLowerCase())) md = md.slice(mk.length).trim()
  const cam = [mk, md].filter(Boolean).join(' ')
  if (cam) by.set('相机', cam)
  const ev = by.get('曝光补偿')
  if (ev && Number.parseFloat(ev) === 0) by.delete('曝光补偿')
  return KEEP.filter((k) => by.get(k)).map((k) => ({ k, v: by.get(k) as string }))
}

// ---------- 值格式化 ----------
const r1 = (n: number): number => Math.round(n * 10) / 10
const fmtShutter = (s: number): string => (s >= 1 ? `${r1(s)} 秒` : `1/${Math.round(1 / s)} 秒`)
const fmtAperture = (f: number): string => `f/${r1(f)}`
const fmtMm = (f: number): string => `${r1(f)} mm`
const fmtEv = (v: number): string => `${v > 0 ? '+' : ''}${r1(v)} EV`
/** EXIF 的 "2026:10:09 12:00:00" → "2026-10-09 12:00:00" */
const fmtExifDate = (s: string): string => s.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')
const p2 = (n: number): string => String(n).padStart(2, '0')
/**
 * exifr 会把相机写的本地时间当成 UTC 建 Date，直接 toLocaleString 在东八区机器上整体
 * 平移 8 小时（客户会以为照片是半夜拍的）。按 UTC 分量原样输出就是墙上的时间。
 */
const fmtWallTime = (d: Date): string =>
  `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ` +
  `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`
/**
 * 解析 EXIF 的时区偏移串（OffsetTimeOriginal 之类，形如 "+08:00" / "-05:30"）→ 相对 UTC 的分钟数。
 * 解不出返回 null（老图普遍不写偏移）。
 */
function parseOffsetMin(s: string): number | null {
  const m = /^([+-])(\d{1,2}):?(\d{2})/.exec(s.trim())
  if (!m) return null
  const sign = m[1] === '-' ? -1 : 1
  return sign * (Number(m[2]) * 60 + Number(m[3]))
}
/**
 * 把 exifr 返回的拍摄时间 Date 还原成“相机表上的墙上时间”字符串（两条路都靠它）。
 * - 带时区偏移（OffsetTimeOriginal）：exifr 已把墙上时间换算成绝对时刻，Date 的 UTC 分量比实际时刻早了整
 *   个偏移（东八区 08:05 拍 → UTC 分量 00:05）。把偏移加回去，再按 UTC 分量读，才是相机上显示的时刻。
 * - 无偏移：exifr 直接把墙上时间当 UTC 建 Date（记忆 ec2ccba7），UTC 分量就是墙上时间，原样读。
 * 不依赖本机时区：偏移取自照片自带的那一条，外国图在国产机上也显示成拍摄地的表上时间。
 */
function fmtShotDate(d: Date, offsetRaw: unknown): string {
  const offStr = str(offsetRaw)
  const offMin = offStr ? parseOffsetMin(offStr) : null
  const wall = offMin != null ? new Date(d.getTime() + offMin * 60000) : d
  return fmtWallTime(wall)
}
const ORIENT: Record<number, string> = {
  1: '正常', 2: '水平翻转', 3: '旋转 180°', 4: '垂直翻转',
  5: '镜像+顺时针 90°', 6: '顺时针 90°（竖拍）', 7: '镜像+逆时针 90°', 8: '逆时针 90°（竖拍）'
}
// 与字符串路径同词（那边把 Pattern 译成「多点测光」），保证同一台相机 JPEG/RAW 显示同一个说法
const METERING: Record<number, string> = { 1: '平均', 2: '中央重点', 3: '点测光', 4: '点测光（连续）', 5: '多点测光', 6: '局部', 255: '未定义' }
/** 部分容器（JPEG 走 exifr）返回的是英文词而不是数字 */
const METER_WORDS: Record<string, string> = {
  average: '平均', center: '中央重点', spot: '点测光', panoramic: '点测光（连续）',
  pattern: '多点测光', multi: '多点测光', partial: '局部', undefined: '未定义'
}
const PROGRAM: Record<number, string> = {
  0: '未定义', 1: '手动', 2: '程序自动', 3: '光圈优先', 4: '快门优先',
  5: '慢速程序', 6: '快速程序', 7: '大景深', 8: '运动'
}
const EXPMODE: Record<number, string> = { 0: '自动', 1: '手动', 2: '包围曝光', 3: '手动+包围' }
const LIGHT: Record<number, string> = { 1: '日光', 2: '荧光灯', 3: '白炽灯', 4: '闪光灯', 9: '细日光', 10: '阴天', 11: '树荫', 12: '日光荧光灯', 13: '冷白荧光灯', 14: '办公室', 15: '暖白荧光灯', 17: '标准光 A', 18: '标准光 B', 19: '标准光 C', 21: 'D55 日光', 255: '其它' }
const COLORSPACE: Record<number, string> = { 1: 'sRGB', 2: 'AdobeRGB' }
const SCENE: Record<number, string> = { 0: '标准', 1: '夜景', 2: '人像', 3: '风景' }

/** 白平衡：数字与英文词两种返回都见过（Auto / Manual / 0 / 1） */
function fmtWB(v: unknown): string | undefined {
  if (typeof v === 'number') return v === 0 ? '自动' : '手动'
  const s = str(v)
  if (!s) return undefined
  return /^auto/i.test(s) ? '自动' : /^man/i.test(s) ? '手动' : s
}
/** 闪光灯：只要触发位就算“已闪光”，兼容 "Flash fired, compulsory flash mode" 这类长句 */
function fmtFlash(v: unknown): string | undefined {
  if (typeof v === 'number') return v & 1 ? '已闪光' : '未闪光'
  const s = str(v)
  if (!s) return undefined
  return /fired|compulsory|on\b/i.test(s) && !/did not fire|^off/i.test(s) ? '已闪光' : '未闪光'
}
/** 测光模式：数字查表、英文词查表；认不出就原样（后面还有白名单兜着，英文上不了屏） */
function fmtMetering(v: unknown): string | undefined {
  if (typeof v === 'number') return METERING[v] ?? String(v)
  const s = str(v)
  if (!s) return undefined
  const head = s.toLowerCase().split(/[\s,]+/)[0]
  return METER_WORDS[head] ?? s
}

// ---------- ① exifr 路径（JPEG / TIFF 型 RAW） ----------
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const num = (v: unknown): number | null =>
  typeof v === 'number' && isFinite(v) ? v : Array.isArray(v) && typeof v[0] === 'number' && isFinite(v[0]) ? v[0] : null

function fromExifr(ex: Record<string, unknown>): MetaItem[] {
  const m = new Map<string, string>()
  const put = (label: string, v: string | undefined | null): void => {
    if (v) m.set(label, v)
  }
  /**
   * exifr 的键名大小写不统一：JPEG/TIFF 型 RAW 返回 PascalCase（Make / DateTimeOriginal /
   * SerialNumber），部分容器返回驼峰（make / dateTimeOriginal）。按小写键取会全部取空，
   * 于是 JPG 掉进字节兜底、序列号丢失，所以两种写法都查一遍。
   */
  const get = (key: string): unknown =>
    ex[key] ?? ex[key.charAt(0).toUpperCase() + key.slice(1)] ?? ex[key.toUpperCase()]
  put('制造商', str(get('make')))
  put('相机型号', str(get('model')))
  put('镜头', str(get('lensModel')) ?? str(get('lens')))
  put('机身序列号', str(get('bodySerialNumber')) ?? str(get('serialNumber')))
  put('镜头序列号', str(get('lensSerialNumber')))
  const dt = (get('dateTimeOriginal') ?? get('createTime')) as Date | string | undefined
  const offRaw = get('offsetTimeOriginal') ?? get('offsetTimeDigitized') ?? get('offsetTime')
  put(
    '拍摄时间',
    dt instanceof Date
      ? fmtShotDate(dt, offRaw)
      : str(dt as string)
        ? fmtExifDate(str(dt as string) as string)
        : undefined
  )
  const sh = num(get('exposureTime') ?? get('shutterSpeed'))
  put(L_SHUTTER, sh ? fmtShutter(sh) : undefined)
  const ap = num(get('fNumber') ?? get('apertureValue'))
  put('光圈', ap ? fmtAperture(ap) : undefined)
  const iso = num(get('iso') ?? get('photographicSensitivity'))
  put('ISO', iso ? String(iso) : undefined)
  const fl = num(get('focalLength'))
  put('焦距', fl ? fmtMm(fl) : undefined)
  const fl35 = num(get('focalLengthIn35mmFormat'))
  put('等效焦距', fl35 ? fmtMm(fl35) : undefined)
  const ev = num(get('exposureCompensation') ?? get('exposureBias'))
  put('曝光补偿', ev === null ? undefined : fmtEv(ev))
  put('测光模式', fmtMetering(get('meteringMode')))
  put('白平衡', fmtWB(get('whiteBalance')))
  put('闪光灯', fmtFlash(get('flash')))
  const gps = get('gps') as { latitude?: number; longitude?: number } | undefined
  put('拍摄位置', gps && typeof gps.latitude === 'number' && typeof gps.longitude === 'number' ? `${r1(gps.latitude * 1e5) / 1e5}, ${r1(gps.longitude * 1e5) / 1e5}` : undefined)
  // 映射表之外的参数一律不收：这里要的是客户能读懂的几行，不是把 EXIF 全倒出来
  return [...m.entries()].map(([k, v]) => ({ k, v }))
}

// ---------- ② 字节解析路径（CR3 等 exifr 不支持的容器） ----------
/** 常见 TIFF 标签：ID → 中文列名 + 值格式化（值已由 readVal 统一成 string|number） */
const TAGS: Record<number, { label: string; fmt?: (v: string | number) => string | undefined }> = {
  0x010f: { label: '制造商' },
  0x0110: { label: '相机型号' },
  0x0112: { label: '方向', fmt: (v) => ORIENT[Number(v)] ?? String(v) },
  0x011a: { label: '水平分辨率' },
  0x0131: { label: '处理软件' },
  0x0132: { label: '修改时间', fmt: (v) => fmtExifDate(String(v)) },
  0x013a: { label: '机身序列号' },
  0x013b: { label: '作者' },
  0x8298: { label: '版权' },
  0x829a: { label: L_SHUTTER, fmt: (v) => fmtShutter(Number(v)) },
  0x829d: { label: '光圈', fmt: (v) => fmtAperture(Number(v)) },
  0x8822: { label: '曝光程序', fmt: (v) => PROGRAM[Number(v)] ?? String(v) },
  0x8827: { label: 'ISO' },
  0x9003: { label: '拍摄时间', fmt: (v) => fmtExifDate(String(v)) },
  0x9204: { label: '曝光补偿', fmt: (v) => fmtEv(Number(v)) },
  0x9207: { label: '测光模式', fmt: (v) => METERING[Number(v)] ?? String(v) },
  0x9208: { label: '光源', fmt: (v) => LIGHT[Number(v)] ?? String(v) },
  0x9209: { label: '闪光灯', fmt: (v) => (Number(v) & 1 ? '已闪光' : '未闪光') },
  0x920a: { label: '焦距', fmt: (v) => fmtMm(Number(v)) },
  0xa001: { label: '色彩空间', fmt: (v) => COLORSPACE[Number(v)] ?? String(v) },
  0xa002: { label: '像素宽度' },
  0xa003: { label: '像素高度' },
  0xa402: { label: '曝光模式', fmt: (v) => EXPMODE[Number(v)] ?? String(v) },
  0xa403: { label: '白平衡', fmt: (v) => (Number(v) === 0 ? '自动' : '手动') },
  0xa405: { label: '场景类型', fmt: (v) => SCENE[Number(v)] ?? String(v) },
  0xa40c: { label: '等效焦距', fmt: (v) => fmtMm(Number(v)) },
  0xa434: { label: '镜头' },
  0xa435: { label: '镜头信息' },
  0xa436: { label: '镜头序列号' },
  0xa5d0: { label: '机身序列号' }
}

/** 解 buf[t] 处的一个 TIFF：IFD0 + ExifIFD 子目录；解不出返回 null */
function parseTiff(buf: Buffer, t: number): MetaItem[] | null {
  if (t + 8 > buf.length) return null
  const little = buf[t] === 0x49 && buf[t + 1] === 0x49
  const big = buf[t] === 0x4d && buf[t + 1] === 0x4d
  if (!little && !big) return null
  const r16 = (o: number): number => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o))
  const r32 = (o: number): number => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
  if (r16(t + 2) !== 0x2a) return null
  const m = new Map<string, string>()

  /** 读第 e 项（entry 起始偏移）的值，统一成 string | number | null */
  const readVal = (e: number): string | number | null => {
    const type = r16(e + 2)
    const count = r32(e + 4)
    if (count <= 0 || count > 4096) return null
    const sizeOf: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8, 11: 4, 12: 8 }
    const es = sizeOf[type]
    if (!es) return null
    const total = es * count
    const vo = total <= 4 ? e + 8 : t + r32(e + 8)
    if (vo < 0 || vo + total > buf.length) return null
    if (type === 2 || type === 7) {
      // ASCII / UNDEFINED：截断到第一个 \0
      let s = ''
      for (let i = 0; i < count; i++) {
        const c = buf[vo + i]
        if (c === 0) break
        s += String.fromCharCode(c)
      }
      return s.trim() || null
    }
    const one = (o: number): number | null => {
      switch (type) {
        case 1: return buf[o]
        case 3: return r16(o)
        case 4: return r32(o)
        case 5: { const n = r32(o); const d = r32(o + 4); return d ? n / d : null }
        case 10: { const n = r32(o) | 0; const d = r32(o + 4) | 0; return d ? n / d : null }
        case 11: return little ? buf.readFloatLE(o) : buf.readFloatBE(o)
        case 12: return little ? buf.readDoubleLE(o) : buf.readDoubleBE(o)
        default: return null
      }
    }
    if (count === 1) return one(vo)
    // 多值（如 ISO 数组、镜头规格三元组）：斜杠连接
    const parts: string[] = []
    const step = es
    for (let i = 0; i < Math.min(count, 8); i++) {
      const v = one(vo + i * step)
      if (v === null) return parts.length ? parts.join(' / ') : null
      parts.push(String(r1(v)))
    }
    return parts.join(' / ')
  }

  const walk = (ifd: number): void => {
    if (ifd + 2 > buf.length) return
    const n = r16(ifd)
    if (n <= 0 || n > 200) return
    for (let k = 0; k < n; k++) {
      const e = ifd + 2 + k * 12
      if (e + 12 > buf.length) return
      const tag = r16(e)
      if (tag === 0x8769) {
        // ExifIFD 子目录指针：稍后进入
        const off = t + r32(e + 8)
        if (off > 0 && off < buf.length - 2) walk(off)
        continue
      }
      if (tag === 0x8825 || tag === 0xa005) continue // GPS / Interop 指针：不展开
      const def = TAGS[tag]
      if (!def) continue // 字节解析只收常见参数（未知私有标签噪声大）
      const v = readVal(e)
      if (v === null || v === '') continue
      const s = def.fmt ? def.fmt(v) : String(v)
      if (s) m.set(def.label, s)
    }
  }

  walk(t + r32(t + 4))
  return m.size ? [...m.entries()].map(([k, v]) => ({ k, v })) : null
}

function fromBytes(path: string): MetaItem[] {
  // EXIF 都在文件头部：CR3 的 CMT1、JPEG 的 Exif 段、TIFF 型 RAW 的 IFD 全在前 8MB
  const fd = openSync(path, 'r')
  try {
    const len = Math.min(fstatSync(fd).size, 8 * 1024 * 1024)
    const buf = Buffer.allocUnsafe(len)
    readSync(fd, buf, 0, len, 0)
    // 候选 TIFF 头（与 rawPreview.orientAngleOfBytes 同一找法）：'Exif\0\0' 之后 + 所有 II*/MM*
    const heads: number[] = []
    const exifMark = buf.indexOf(Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]))
    if (exifMark >= 0) heads.push(exifMark + 6)
    for (const sig of [Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.from([0x4d, 0x4d, 0x00, 0x2a])]) {
      let off = 0
      while (heads.length < 48) {
        const i = buf.indexOf(sig, off)
        if (i < 0) break
        heads.push(i)
        off = i + 1
      }
    }
    /**
     * CR3 把参数拆在两个不同的 TIFF 里：IFD0（制造商/相机型号/作者/版权）在文件头 320 字节那个
     * TIFF，而曝光三件套与镜头那批在另一个 TIFF 的 ExifSub 里（前者根本没有 0x8769 指针）。
     * 以前只取“条目最多”的单一 TIFF，于是 RAW 只剩下曝光参数、机型丢了。
     * 现在合并全部候选：按信息量从多到少定优先（主流 TIFF 先占坑），同名列不覆盖。
     */
    const buckets: MetaItem[][] = []
    for (const t of heads) {
      const items = parseTiff(buf, t)
      if (items?.length) buckets.push(items)
    }
    buckets.sort((a, b) => b.length - a.length)
    const seen = new Set<string>()
    const merged: MetaItem[] = []
    for (const bucket of buckets) {
      for (const it of bucket) {
        if (seen.has(it.k)) continue
        seen.add(it.k)
        merged.push(it)
      }
    }
    return merged
  } finally {
    closeSync(fd)
  }
}

// ---------- 入口（带路径缓存） ----------
const cache = new Map<string, MetaItem[] | null>()

export async function readImageMeta(path: string): Promise<MetaItem[] | null> {
  const hit = cache.get(path)
  if (hit !== undefined) return hit
  let out: MetaItem[] = []
  try {
    const ex = (await exifr.parse(path)) as Record<string, unknown> | undefined
    if (ex) out = curate(fromExifr(ex))
  } catch {
    /* CR3/HEIC 等 exifr 不支持的容器会抛错或返回空，走字节解析 */
  }
  if (!out.length) {
    try {
      out = curate(fromBytes(path))
    } catch {
      out = []
    }
  }
  const result = out.length ? out : null
  if (cache.size > 40) cache.delete(cache.keys().next().value as string)
  cache.set(path, result)
  return result
}
