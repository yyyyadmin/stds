/**
 * 把四模型对拍明细渲染成一张可本地打开的分歧复核页（一次性探针，跑完可删）
 * 用法：node --experimental-strip-types scripts/shootout-report.mts <明细.jsonl>
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const ROOT = 'E:\\1016测试'
const src = process.argv[2]
if (!src) {
  console.error('用法: node shootout-report.mts <明细.jsonl>')
  process.exit(1)
}

interface Row {
  model: string
  ok: boolean
  file: string
  folders: string[]
  verdict: { person: string; flaws: Record<string, boolean>; reason: string } | null
  ms: number
  sampleKey: string
}

const rows = readFileSync(src, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Row)

// 找到每张图在磁盘上的真实路径（用于 <img src=file:///...>）
function findPath(file: string): string {
  const stack = [ROOT]
  while (stack.length) {
    const d = stack.pop() as string
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      const st = statSync(p)
      if (st.isDirectory()) stack.push(p)
      else if (e.toLowerCase() === file.toLowerCase()) return p
    }
  }
  return ''
}

const byKey = new Map<string, { file: string; folders: string[]; models: Record<string, Row> }>()
for (const r of rows) {
  const cur = byKey.get(r.sampleKey) || { file: r.file, folders: r.folders || [], models: {} }
  cur.models[r.model] = r
  byKey.set(r.sampleKey, cur)
}

const MODELS = ['qwen3-vl-plus', 'qwen3.5-flash', 'qwen3.7-flash', 'qwen3.8-flash']
const FLKEYS: Array<[string, string]> = [
  ['eyes_closed', '闭眼'],
  ['half_head', '半截头'],
  ['expression', '表情崩坏']
]

function cell(r: Row | undefined): string {
  if (!r) return '<td class="na">—</td>'
  if (!r.ok) return '<td class="na">HTTP失败</td>'
  const v = r.verdict
  if (!v) return '<td class="na">解析失败</td>'
  const flags = FLKEYS.map(([k, cn]) => `<span class="${v.flaws[k] ? 'on' : 'off'}">${cn}</span>`).join('')
  return `<td><b>${v.person}</b><br>${flags}<br><i>${(v.reason || '').replace(/</g, '&lt;')}</i></td>`
}

const cards: string[] = []
for (const [key, g] of byKey) {
  const vals = MODELS.map((m) => g.models[m]?.verdict?.person || '?')
  const personDiff = new Set(vals).size > 1
  const flawDiff = FLKEYS.some(
    ([k]) => new Set(MODELS.map((m) => String(g.models[m]?.verdict?.flaws?.[k] ?? '?'))).size > 1
  )
  const cls = personDiff && flawDiff ? 'both' : personDiff ? 'p' : flawDiff ? 'f' : 'same'
  if (cls === 'same') continue
  const path = findPath(g.file)
  cards.push(`<div class="card ${cls}">
  <div class="head"><b>${g.file}</b> <span class="eng">引擎标签：${g.folders.join(' / ') || '（无）'}</span></div>
  <div class="body">
    <img loading="lazy" src="file:///${path.replace(/\\/g, '/')}" />
    <table><tr><th>模型</th>${MODELS.map((m) => `<th>${m}</th>`).join('')}</tr>
    <tr><td>判定</td>${MODELS.map((m) => cell(g.models[m])).join('')}</tr></table>
  </div>
</div>`)
}

const html = `<!doctype html><meta charset="utf-8"><title>四模型分歧复核</title>
<style>
body{font:14px/1.5 system-ui;background:#111;color:#ddd;margin:16px}
.card{background:#1b1b1b;border-radius:8px;margin:0 0 14px;padding:10px;border-left:4px solid #444}
.card.p{border-left-color:#e0a}
.card.f{border-left-color:#0a8}
.card.both{border-left-color:#f60}
.head b{font-size:15px}
.eng{color:#8ab;margin-left:10px}
.body{display:flex;gap:14px;align-items:flex-start}
img{max-height:300px;max-width:420px;border-radius:6px;object-fit:contain;background:#000}
table{border-collapse:collapse;table-layout:fixed;width:100%}
th,td{border:1px solid #333;padding:5px 7px;vertical-align:top;width:23%}
th{background:#222;color:#9cf}
td i{color:#999;font-style:normal;font-size:12px}
.on{color:#f66;margin-right:5px}
.off{color:#4a4;margin-right:5px}
.na{color:#f80}
</style>
<h2>四模型分歧复核（共 ${cards.length} 张有分歧 / ${byKey.size} 张）</h2>
<p>左边颜色：<span style="color:#e0a">粉=人数分类有分歧</span> <span style="color:#0a8">绿=瑕疵判定有分歧</span> <span style="color:#f60">橙=两者都有</span>。
「引擎标签」是本地算法给出的既有分类，用来对照模型判断谁更像在理。</p>
${cards.join('\n')}
`
const out = src.replace(/\.jsonl$/, '.分歧复核.html')
writeFileSync(out, html, 'utf8')
console.log(`生成 ${cards.length} 张分歧卡片 -> ${out}`)
