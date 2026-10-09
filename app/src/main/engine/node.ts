/**
 * Node 内置降级引擎：Python 不可用时的保底检测
 * 基于 sharp 像素级计算：画面模糊（Laplacian）、曝光异常（Lab 直方图规则）、黑白照（通道差）
 * 人脸类维度（闭眼/斜眼/狰狞/半截头/人数）无法在纯 Node 高精度完成 -> 不输出对应标签，
 * 这些图片按规则进入成品库并可按置信度排序抽查。
 */
import sharp from 'sharp'
import { EventEmitter } from 'events'
import type { EngineCapabilities } from './python'
import { orientedSharp } from '../services/rawPreview'

interface RawImage {
  data: Buffer
  info: { width: number; height: number; channels: number }
}

async function loadGray(path: string, maxSide = 800): Promise<{ gray: Float64Array; w: number; h: number; rgb: RawImage | null }> {
  const img = await (await orientedSharp(path))
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { data, info } = img
  return { gray: new Float64Array(data), w: info.width, h: info.height, rgb: null }
}

function laplacianVar(gray: Float64Array, w: number, h: number): number {
  // 4 邻域拉普拉斯
  let sum = 0
  let sum2 = 0
  let n = 0
  for (let y = 1; y < h - 1; y++) {
    const row = y * w
    for (let x = 1; x < w - 1; x++) {
      const i = row + x
      const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w]
      sum += v
      sum2 += v * v
      n++
    }
  }
  if (!n) return 9999
  const mean = sum / n
  return sum2 / n - mean * mean
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z))
}

/** 模糊：Laplacian 方差映射置信度（与 Python 引擎同一标定） */
function blurConf(variance: number): number {
  return Math.min(0.99, Math.max(0, sigmoid((60 - variance) / 22)))
}

async function statsRgb(path: string): Promise<{ rgb: RawImage }> {
  const img = await (await orientedSharp(path))
    .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { rgb: img as unknown as RawImage }
}

/** 曝光：RGB -> 亮度统计（近似 Lab L），高光/暗部占比 */
function exposureConf(rgb: RawImage): { conf: number; reason: string } {
  const { data, info } = rgb
  const ch = info.channels
  let sum = 0
  let sum2 = 0
  let hi = 0
  let lo = 0
  let n = 0
  for (let i = 0; i < data.length; i += ch * 8) {
    const r = data[i]
    const g = ch >= 2 ? data[i + 1] : r
    const b = ch >= 3 ? data[i + 2] : r
    const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) * (100 / 255)
    sum += l
    sum2 += l * l
    if (l >= 96) hi++
    if (l <= 6) lo++
    n++
  }
  if (!n) return { conf: 0, reason: 'no pixels' }
  const mean = sum / n
  const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean))
  const hiRatio = hi / n
  const loRatio = lo / n
  const over = sigmoid((hiRatio - 0.14) / 0.05) * sigmoid((mean - 74) / 8)
  const under = sigmoid((loRatio - 0.22) / 0.07) * sigmoid((32 - mean) / 8)
  const conf = Math.min(0.99, Math.max(over, under))
  const dir = over >= under ? '过曝' : '欠曝'
  return { conf, reason: `亮度均值 ${mean.toFixed(1)} 高光 ${(hiRatio * 100).toFixed(1)}% 暗部 ${(loRatio * 100).toFixed(1)}% -> ${dir}` }
}

/** 黑白照：|R-G|、|G-B|、|R-B| 通道差极小像素占比 */
function blackWhiteConf(rgb: RawImage): { conf: number; reason: string } {
  const { data, info } = rgb
  const ch = info.channels
  if (ch < 3) return { conf: 0.99, reason: '单通道图像' }
  let close = 0
  let diffSum = 0
  let n = 0
  for (let i = 0; i < data.length; i += ch * 7) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const d = Math.abs(r - g) + Math.abs(g - b) + Math.abs(r - b)
    diffSum += d
    if (d <= 12) close++
    n++
  }
  if (!n) return { conf: 0, reason: 'no pixels' }
  const ratio = close / n
  const meanDiff = diffSum / n / 3
  const conf = ratio > 0.8 ? Math.min(0.995, sigmoid((ratio - 0.90) / 0.02) * sigmoid((8 - meanDiff) / 3)) : Math.min(0.4, ratio * 0.4)
  return { conf, reason: `通道差极小像素占比 ${(ratio * 100).toFixed(1)}%` }
}

/** 感知哈希：与 Python 引擎同构的 64bit DCT phash（16 位十六进制），跨引擎自洽 */
async function phash(path: string): Promise<string> {
  const img = await (await orientedSharp(path))
    .resize({ width: 32, height: 32, fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const px = new Float64Array(1024)
  // 3x3 盒式模糊模拟 INTER_AREA 平滑
  const src = new Float64Array(img.data)
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      let s = 0
      let n = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy
          const xx = x + dx
          if (yy >= 0 && yy < 32 && xx >= 0 && xx < 32) {
            s += src[yy * 32 + xx]
            n++
          }
        }
      px[y * 32 + x] = s / n
    }
  // 可分离 DCT-II，取左下 8x8 低频
  const cosCache: number[][] = Array.from({ length: 8 }, (_, k) => Array.from({ length: 32 }, (_, i) => Math.cos(((2 * i + 1) * k * Math.PI) / 64)))
  const low: number[] = []
  for (let v = 0; v < 8; v++) {
    const row = new Float64Array(32)
    for (let i = 0; i < 32; i++) {
      let t = 0
      for (let y = 0; y < 32; y++) t += px[y * 32 + i] * cosCache[v][y]
      row[i] = t
    }
    for (let u = 0; u < 8; u++) {
      let t = 0
      for (let i = 0; i < 32; i++) t += row[i] * cosCache[u][i]
      low.push(t)
    }
  }
  // 中位数（去直流项）作比较基准
  const sorted = [...low.slice(1)].sort((a, b) => a - b)
  const med = sorted[Math.floor(sorted.length / 2)]
  let hex = ''
  for (let r = 0; r < 8; r++) {
    let nib = 0
    for (let c = 0; c < 8; c++) nib = (nib << 1) | (low[r * 8 + c] > med ? 1 : 0)
    hex += nib.toString(16)
  }
  return hex
}

export class NodeEngine {
  readonly events = new EventEmitter()
  capabilities: EngineCapabilities = { faceBackend: 'none', eyes: 'none', nodeFallback: true }
  started = true

  async start(): Promise<EngineCapabilities> {
    return this.capabilities
  }

  async detect(path: string, imageId: number): Promise<Record<string, unknown>> {
    try {
      const { gray, w, h } = await loadGray(path)
      const variance = laplacianVar(gray, w, h)
      const { rgb } = await statsRgb(path)
      const exp = exposureConf(rgb)
      const bw = blackWhiteConf(rgb)
      const hash = await phash(path)
      const dims: Record<string, { confidence: number; reason: string; method: string }> = {
        blur: { confidence: blurConf(variance), reason: `清晰度方差 ${variance.toFixed(0)}（背景虚化需人工复核）`, method: 'laplacian-node' },
        exposure: { confidence: exp.conf, reason: exp.reason, method: 'histogram-node' },
        black_white: { confidence: bw.conf, reason: bw.reason, method: 'channels-node' }
      }
      return { imageId, dims, faces: [], faceCount: -1, phash: hash, nodeEngine: true }
    } catch (e) {
      return { imageId, dims: {}, faces: [], faceCount: -1, error: String(e) }
    }
  }

  stop(): void {
    /* noop */
  }
}
