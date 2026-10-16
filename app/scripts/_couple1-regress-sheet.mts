import { writeFileSync, mkdirSync } from 'fs'
import sharp from 'sharp'
const ITEMS: Array<[string, string]> = [
  ['E:\\9.27\\jpg\\7G1A7415.JPG', '7G1A7415 couple1 truth half_head=FALSE. really cut?'],
  ['E:\\9.27\\jpg\\7G1A9865.JPG', '7G1A9865 couple1 truth half_head=FALSE. really cut?']
]
const TILE = 900, LABEL = 44, PAD = 8
function esc(s: string) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
async function tile(p: string, note: string) {
  const img = await sharp(p, { failOn: 'none' }).rotate().resize({ width: TILE, height: TILE - LABEL, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer()
  const meta = await sharp(img).metadata()
  const w = meta.width || TILE
  const svg = `<svg width="${TILE}" height="${LABEL}"><text x="6" y="18" font-family="monospace" font-size="16" fill="#ffd000">${esc(note)}</text></svg>`
  return sharp({ create: { width: TILE, height: TILE, channels: 3, background: { r: 16, g: 16, b: 16 } } })
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }, { input: img, left: Math.floor((TILE - w) / 2), top: LABEL }]).jpeg({ quality: 92 }).toBuffer()
}
async function main() {
  const tiles = []
  for (const [p, n] of ITEMS) tiles.push(await tile(p, n))
  const CW = 2 * TILE + 3 * PAD, CH = TILE + 2 * PAD
  const comps = tiles.map((t, i) => ({ input: t, left: PAD + i * (TILE + PAD), top: PAD }))
  const out = await sharp({ create: { width: CW, height: CH, channels: 3, background: { r: 40, g: 40, b: 40 } } }).composite(comps).jpeg({ quality: 92 }).toBuffer()
  mkdirSync('scripts/out/sheets', { recursive: true })
  writeFileSync('scripts/out/sheets/_couple1_regress.jpg', out)
  console.log('ok', CW, 'x', CH)
}
main().catch((e) => { console.error(String(e)); process.exit(1) })
