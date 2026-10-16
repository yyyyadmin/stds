/**
 * 端到端验真（脱离 GUI 能做到的最真实路径）：
 *   - 真 import 生产 aiReviewPrompt.ts 的 buildReviewMessages / parseModelVerdict（不是测试工程的副本）
 *   - 压图逐字复刻生产 orientedSharp 的 JPG 分支：sharp(path,{failOn:'none'}).rotate().resize(1536 inside).jpeg(82)
 *   - 真调 DashScope，参数与 aiReview.ts 完全一致：temperature 0 + enable_search false + enable_thinking false
 *   - 用生产 parseModelVerdict 解析
 * 目的：确认搬上生产的 V12E 真的把崩坏挑出来、且不冤枉亲吻/大笑，半截头行为仍与线上 V11 一致。
 * key 只走环境变量，不落盘。
 */
import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import { buildReviewMessages, parseModelVerdict } from '../src/main/services/aiReviewPrompt.ts'

const KEY = process.env.DASHSCOPE_API_KEY || ''
const ENDPOINT = process.env.SHOOTOUT_ENDPOINT || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const MODEL = process.env.SHOOTOUT_MODEL || 'qwen3.7-flash'
const IMG_MAX_SIDE = 1536
const IMG_QUALITY = 82

// 期望（来自眼睛判真值 + 红线）：fn 前缀 -> {expression, half_head}
const TARGETS: Array<{ key: string; note: string; expExpr: boolean | null; expHalf: boolean | null }> = [
  { key: '7g1a7958', note: '表情崩坏(用户报的bug)，期望挑出', expExpr: true, expHalf: null },
  { key: '7g1a7955', note: '表情崩坏，期望挑出', expExpr: true, expHalf: null },
  { key: 'chen1240', note: '拥吻红线，期望别冤枉', expExpr: false, expHalf: null },
  { key: '7g1a7601', note: '正常大笑红线，期望别冤枉', expExpr: false, expHalf: null },
  { key: '7g1a8666', note: '亲吻红线，期望别冤枉', expExpr: false, expHalf: null },
  { key: '7g1a7427', note: '半截头锚点，期望仍判半截头(=V11行为)', expExpr: null, expHalf: true }
]

// 从真值表取真实 UTF-8 路径，避免手抄乱码
const pathOf: Record<string, string> = {}
for (const l of readFileSync('scripts/out/truth-1016-eyes.jsonl', 'utf8').split(/\r?\n/).filter(Boolean)) {
  const r = JSON.parse(l)
  const f = String(r.filename).toLowerCase()
  for (const t of TARGETS) if (f.startsWith(t.key) && !pathOf[t.key]) pathOf[t.key] = r.path || r.file
}

async function reviewOne(path: string): Promise<{ expr: boolean; half: boolean; eyes: boolean; reason: string } | null> {
  // 逐字复刻生产 orientedSharp 的 JPG 分支
  const buf = await sharp(path, { failOn: 'none' })
    .rotate()
    .resize({ width: IMG_MAX_SIDE, height: IMG_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: IMG_QUALITY })
    .toBuffer()
  const base64 = buf.toString('base64')
  const { system, userText } = buildReviewMessages()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const resp = await fetch(`${ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        enable_search: false,
        enable_thinking: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: [{ type: 'text', text: userText }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }] }
        ]
      }),
      signal: ctrl.signal
    })
    clearTimeout(timer)
    if (!resp.ok) { console.log('  HTTP', resp.status, (await resp.text()).slice(0, 120)); return null }
    const j = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const text = j.choices?.[0]?.message?.content ?? ''
    const v = parseModelVerdict(text)
    if (!v) { console.log('  解析失败，原始：', text.slice(0, 160)); return null }
    return { expr: v.flaws.expression, half: v.flaws.half_head, eyes: v.flaws.eyes_closed, reason: v.reason }
  } catch (e) {
    clearTimeout(timer)
    console.log('  调用异常：', String(e).slice(0, 120))
    return null
  }
}

let pass = 0, fail = 0
for (const t of TARGETS) {
  const p = pathOf[t.key]
  console.log('\n▶', t.key, '|', t.note)
  if (!p) { console.log('  找不到路径，跳过'); continue }
  const r = await reviewOne(p)
  if (!r) { fail++; console.log('  结果：拿不到判定'); continue }
  console.log('  生产判定 → 表情:', r.expr, '半截头:', r.half, '闭眼:', r.eyes, '| 理由:', r.reason)
  let ok = true
  if (t.expExpr !== null && r.expr !== t.expExpr) { ok = false; console.log('  ✗ 表情与期望不符（期望', t.expExpr, '）') }
  if (t.expHalf !== null && r.half !== t.expHalf) { ok = false; console.log('  ✗ 半截头与期望不符（期望', t.expHalf, '）') }
  if (ok) { pass++; console.log('  ✓ 符合期望') } else fail++
}
console.log(`\n===== 端到端验真：符合 ${pass} / 不符 ${fail} =====`)
