/**
 * 分歧图放大核对表：把 V11/V12 与眼睛真值不一致的关键图拼成一张高清 grid，逐张目检裁决。
 * 产物：scripts/out/sheets/_v12verify.jpg
 * 用法：node scripts/_v12-verify-sheet.mts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, basename } from 'path'
import sharp from 'sharp'

// 从真值表按文件名解析路径
const truth = readFileSync('scripts/out/truth-1016-eyes.jsonl', 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l))
const byName = new Map<string, string>()
for (const r of truth) byName.set(String(r.filename).toLowerCase(), r.path)

// 要复核的分歧图（basename : 复核问题）
const LIST: Array<[string, string]> = [
  ['7G1A7955.JPG', 'EXPR recover? eyes squeezed + mouth wide?'],
  ['7G1A7958.JPG', 'EXPR recover? eyes squeezed + mouth wide?'],
  ['7G1A7947.JPG', 'EXPR false-alarm? eyes open or squeezed?'],
  ['CHEN9581.JPG', 'EXPR false-alarm? eyes open or squeezed?'],
  ['7G1A7427.JPG', 'HALF recover(main target)? forehead/top cut?'],
  ['7G1A8214.JPG', 'HALF recover? crown cut?'],
  ['7G1A9837.JPG', 'HALF recover? side/top cut?'],
  ['CHEN9286.JPG', 'HALF recover? head cut, only torso/hands?'],
  ['7G1A7421.JPG', 'HALF NEW-MISS V12 lost it. really cut?'],
  ['7G1A7623.JPG', 'HALF NEW-FALSEALARM V12. really cut?'],
  ['CHEN0849.JPG', 'HALF NEW-FALSEALARM V12. girl crown cut?'],
  ['7G1A7775.JPG', 'HALF both-say-true. really cut?'],
  ['7G1A8007.JPG', 'HALF both-say-true. really cut?'],
  ['7G1A7722.JPG', 'HALF both-say-true. really cut?']
]

const TILE = 760
const PAD = 8
const LABEL = 40
const COLS = 2

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function makeTile(name: string, note: string): Promise<Buffer> {
  const p = byName.get(name.toLowerCase())
  if (!p) throw new Error('path not found: ' + name)
  const img = await sharp(p, { failOn: 'none' })
    .rotate()
    .resize({ width: TILE, height: TILE - LABEL, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer()
  const meta = await sharp(img).metadata()
  const w = meta.width || TILE
  const h = meta.height || (TILE - LABEL)
  // 画布：标签条 + 图
  const canvas = sharp({
    create: { width: TILE, height: TILE, channels: 3, background: { r: 16, g: 16, b: 16 } }
  })
  const svg = `<svg width="${TILE}" height="${LABEL}"><text x="6" y="18" font-family="monospace" font-size="15" fill="#ffd000">${esc(name)}</text><text x="6" y="34" font-family="monospace" font-size="12" fill="#66ff99">${esc(note)}</text></svg>`
  return canvas
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }, { input: img, left: Math.floor((TILE - w) / 2), top: LABEL }])
    .jpeg({ quality: 90 })
    .toBuffer()
}

async function main(): Promise<void> {
  const tiles: Buffer[] = []
  for (const [n, note] of LIST) tiles.push(await makeTile(n, note))
  const rows = Math.ceil(tiles.length / COLS)
  const CW = COLS * TILE + (COLS + 1) * PAD
  const CH = rows * TILE + (rows + 1) * PAD
  const comps: Array<{ input: Buffer; left: number; top: number }> = []
  tiles.forEach((t, i) => {
    const c = i % COLS
    const r = Math.floor(i / COLS)
    comps.push({ input: t, left: PAD + c * (TILE + PAD), top: PAD + r * (TILE + PAD) })
  })
  mkdirSync('scripts/out/sheets', { recursive: true })
  // 整体一张（概览）
  const out = await sharp({ create: { width: CW, height: CH, channels: 3, background: { r: 40, g: 40, b: 40 } } })
    .composite(comps)
    .jpeg({ quality: 88 })
    .toBuffer()
  writeFileSync('scripts/out/sheets/_v12verify.jpg', out)
  // 逐行高清（每行 2 张，读图不被压缩丢细节）
  for (let r = 0; r < rows; r++) {
    const rowComps = comps.filter((_, i) => Math.floor(i / COLS) === r).map((c) => ({ input: c.input, left: c.left, top: c.top - r * (TILE + PAD) }))
    const ro = await sharp({ create: { width: CW, height: TILE + 2 * PAD, channels: 3, background: { r: 40, g: 40, b: 40 } } })
      .composite(rowComps)
      .jpeg({ quality: 92 })
      .toBuffer()
    writeFileSync(`scripts/out/sheets/_v12verify_r${r + 1}.jpg`, ro)
  }
  console.log('tiles:', tiles.length, 'rows:', rows, 'full:', CW, 'x', CH)
}

main().catch((e) => {
  console.error(String(e))
  process.exit(1)
})
