/** 标定探针：输出每张测试图的 Laplacian 方差 / 曝光统计 / 黑白占比 / phash 距离 */
const sharp = require('sharp')
const path = require('path')
const fs = require('fs')

async function loadGray(p) {
  const img = await sharp(p, { failOn: 'none' }).resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true }).greyscale().raw().toBuffer({ resolveWithObject: true })
  return { gray: new Float64Array(img.data), w: img.info.width, h: img.info.height }
}
function laplacianVar(gray, w, h) {
  let sum = 0, sum2 = 0, n = 0
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x
    const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w]
    sum += v; sum2 += v * v; n++
  }
  return sum2 / n - (sum / n) ** 2
}
async function statsRgb(p) {
  const img = await sharp(p, { failOn: 'none' }).resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  return img
}
function exposure(img) {
  const { data, info } = img; const ch = info.channels
  let sum = 0, sum2 = 0, hi = 0, lo = 0, n = 0
  for (let i = 0; i < data.length; i += ch * 8) {
    const l = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) * (100 / 255)
    sum += l; sum2 += l * l; if (l >= 96) hi++; if (l <= 6) lo++; n++
  }
  const mean = sum / n
  return { mean, hiRatio: hi / n, loRatio: lo / n }
}
function bwRatio(img) {
  const { data, info } = img; const ch = info.channels
  let close = 0, n = 0
  for (let i = 0; i < data.length; i += ch * 7) {
    const d = Math.abs(data[i] - data[i + 1]) + Math.abs(data[i + 1] - data[i + 2]) + Math.abs(data[i] - data[i + 2])
    if (d <= 12) close++; n++
  }
  return close / n
}
async function phash(p) {
  const img = await sharp(p, { failOn: 'none' }).resize({ width: 32, height: 32, fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true })
  const src = new Float64Array(img.data)
  const px = new Float64Array(1024)
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    let s = 0, n = 0
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < 32 && xx >= 0 && xx < 32) { s += src[yy * 32 + xx]; n++ } }
    px[y * 32 + x] = s / n
  }
  const cos = Array.from({ length: 8 }, (_, k) => Array.from({ length: 32 }, (_, i) => Math.cos(((2 * i + 1) * k * Math.PI) / 64)))
  const low = []
  for (let v = 0; v < 8; v++) {
    const row = new Float64Array(32)
    for (let i = 0; i < 32; i++) { let t = 0; for (let y = 0; y < 32; y++) t += px[y * 32 + i] * cos[v][y]; row[i] = t }
    for (let u = 0; u < 8; u++) { let t = 0; for (let i = 0; i < 32; i++) t += row[i] * cos[u][i]; low.push(t) }
  }
  const sorted = [...low.slice(1)].sort((a, b) => a - b)
  const med = sorted[Math.floor(sorted.length / 2)]
  let hex = ''
  for (let r = 0; r < 8; r++) { let nib = 0; for (let c = 0; c < 8; c++) nib = (nib << 1) | (low[r * 8 + c] > med ? 1 : 0); hex += nib.toString(16) }
  return hex
}
function ham(a, b) { let d = 0; for (let i = 0; i < a.length; i++) { let x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { d += x & 1; x >>= 1 } } return d }

;(async () => {
  const dir = path.join(__dirname, '..', 'test-photos')
  const files = fs.readdirSync(dir)
  const hashes = {}
  for (const f of files) {
    const p = path.join(dir, f)
    const { gray, w, h } = await loadGray(p)
    const v = laplacianVar(gray, w, h)
    const img = await statsRgb(p)
    const e = exposure(img)
    hashes[f] = await phash(p)
    console.log(`${f.padEnd(18)} lapVar=${v.toFixed(1).padStart(9)} mean=${e.mean.toFixed(1)} hi=${(e.hiRatio * 100).toFixed(1)}% lo=${(e.loRatio * 100).toFixed(1)}% bw=${((bwRatio(img.data ? img : img) || 0) * 100).toFixed? ((bwRatio(img)*100).toFixed(1)+'%') : ''}`)
  }
  console.log('\nphash Hamming 距离（64bit，sim=1-d/64）:')
  for (let i = 0; i < files.length; i++) for (let j = i + 1; j < files.length; j++) {
    const d = ham(hashes[files[i]], hashes[files[j]])
    if (d <= 16) console.log(`  ${files[i]} <-> ${files[j]}: dist=${d} sim=${(1 - d / 64).toFixed(3)}`)
  }
})()
