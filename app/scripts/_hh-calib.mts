/**
 * 半截头校准备案表：把"确定 true(7427)"、"人工 false(7421/7415)"两端锚点 + 其余候选拼一张，
 * 按用户严格标准（五官/大半脸被裁才算，脸完整只头顶/头饰贴边不算）重判 1016 候选。
 * 产物：scripts/out/sheets/_hhcalib.jpg
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { basename } from 'path'
import sharp from 'sharp'

// 从两份真值表按文件名解析路径
const paths = new Map<string, string>()
for (const f of ['scripts/out/truth-1016-eyes.jsonl', 'scripts/out/truth-couple1-hhexpr.jsonl']) {
  for (const l of readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const r = JSON.parse(l)
    paths.set(String(r.filename).toLowerCase(), r.path)
  }
}
// 锚点 + 候选（anchor=已知标准，? = 待重判）
const LIST: Array<[string, string]> = [
  ['7G1A7427.JPG', 'ANCHOR TRUE: 半张脸被切(用户报的bug)'],
  ['7G1A7421.JPG', 'ANCHOR FALSE: 脸完整只头顶出框(couple1人工false)'],
  ['7G1A7415.JPG', 'ANCHOR FALSE: 横躺脸完整(couple1人工false)'],
  ['7G1A7443.JPG', '? 重判: 脸完整还是被切?'],
  ['7G1A8214.JPG', '? 重判: 脸完整还是被切?'],
  ['7G1A8215.JPG', '? 重判: 脸完整还是被切?'],
  ['7G1A9837.JPG', '? 重判: 脸完整还是被切?'],
  ['CHEN0832.JPG', '? 重判: 多人里新娘脸?'],
  ['CHEN0833.JPG', '? 重判: 多人里新娘脸?'],
  ['CHEN0834.JPG', '? 重判: 多人里新娘脸?'],
  ['CHEN9286.JPG', '? 重判: 只有躯干手无脸'],
  ['CHEN9287.JPG', '? 重判: 只有躯干手无脸'],
  ['7G1A7623.JPG', '? 重判: 脸完整+金冠贴边(我1016标false)'],
  ['7G1A9865.JPG', '? 重判: 暗模糊侧脸局部(couple1人工false)']
]
const TILE = 720, PAD = 8, LABEL = 42, COLS = 3
function esc(s: string) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
async function tile(name: string, note: string): Promise<Buffer> {
  const p = paths.get(name.toLowerCase())
  if (!p) throw new Error('no path ' + name)
  const img = await sharp(p, { failOn: 'none' }).rotate().resize({ width: TILE, height: TILE - LABEL, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer()
  const meta = await sharp(img).metadata()
  const w = meta.width || TILE
  const svg = `<svg width="${TILE}" height="${LABEL}"><text x="5" y="16" font-family="sans-serif" font-size="14" fill="#ffd000">${esc(name)}</text><text x="5" y="33" font-family="sans-serif" font-size="12" fill="#7CFC99">${esc(note)}</text></svg>`
  return sharp({ create: { width: TILE, height: TILE, channels: 3, background: { r: 16, g: 16, b: 16 } } })
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }, { input: img, left: Math.floor((TILE - w) / 2), top: LABEL }]).jpeg({ quality: 92 }).toBuffer()
}
async function main() {
  const tiles: Buffer[] = []
  for (const [n, note] of LIST) tiles.push(await tile(n, note))
  const rows = Math.ceil(tiles.length / COLS)
  const CW = COLS * TILE + (COLS + 1) * PAD, CH = rows * TILE + (rows + 1) * PAD
  const comps: Array<{ input: Buffer; left: number; top: number }> = []
  tiles.forEach((t, i) => { const c = i % COLS, r = Math.floor(i / COLS); comps.push({ input: t, left: PAD + c * (TILE + PAD), top: PAD + r * (TILE + PAD) }) })
  const out = await sharp({ create: { width: CW, height: CH, channels: 3, background: { r: 40, g: 40, b: 40 } } }).composite(comps).jpeg({ quality: 90 }).toBuffer()
  mkdirSync('scripts/out/sheets', { recursive: true })
  writeFileSync('scripts/out/sheets/_hhcalib.jpg', out)
  // 逐行高清
  for (let r = 0; r < rows; r++) {
    const rc = comps.filter((_, i) => Math.floor(i / COLS) === r).map((c) => ({ input: c.input, left: c.left, top: c.top - r * (TILE + PAD) }))
    const ro = await sharp({ create: { width: CW, height: TILE + 2 * PAD, channels: 3, background: { r: 40, g: 40, b: 40 } } }).composite(rc).jpeg({ quality: 92 }).toBuffer()
    writeFileSync(`scripts/out/sheets/_hhcalib_r${r + 1}.jpg`, ro)
  }
  console.log('tiles', tiles.length, 'rows', rows, CW + 'x' + CH)
}
main().catch((e) => { console.error(String(e)); process.exit(1) })
