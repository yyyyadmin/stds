/**
 * qwen3-vl-plus 效果 + 单价实测（用临时 key 直连 DashScope，验真实模型输出与成本）
 * key 只从环境变量 AI_REVIEW_TEST_DASHKEY 读，绝不写文件/打印明文。
 *
 *   $env:AI_REVIEW_TEST_DASHKEY="sk-..." ; node qwen-vl-cost-test.mjs [图1 图2 ...]
 *
 * 定价（用户贴的官方价，输入<=32k）：输入 ¥1/百万 token、输出 ¥10/百万 token。
 * 每张：缩略→base64→与生产完全一致的请求体（temperature=0, system+user+image_url）→
 *   读 usage token → 算钱 → 用生产同一套 parseModelVerdict 解析，打印判定与是否可解析。
 * 跑两种模式对比：A) 原样（不加额外参数，等同现客户端）；B) enable_thinking:false（关思考，若模型支持）。
 */
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import fs from 'fs'
import path from 'path'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const KEY = (process.env.AI_REVIEW_TEST_DASHKEY || '').trim()
const ENDPOINT = process.env.AI_REVIEW_TEST_DASH_ENDPOINT || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const MODEL = process.env.AI_REVIEW_TEST_DASH_MODEL || 'qwen3-vl-plus'
const PRICE_IN_PER_M = 1
const PRICE_OUT_PER_M = 10
const IMG_MAX_SIDE = 1024
const IMG_QUALITY = 82

if (!KEY) { console.error('未设环境变量 AI_REVIEW_TEST_DASHKEY'); process.exit(2) }
console.log(`模型：${MODEL} @ ${ENDPOINT}`)
console.log(`key（脱敏）：${KEY.slice(0, 6)}…${KEY.slice(-4)} (len=${KEY.length})`)

function loadPromptModule() {
  const esbuild = require('esbuild')
  const tsPath = path.join(__dirname, '..', 'src', 'main', 'services', 'aiReviewPrompt.ts')
  const src = fs.readFileSync(tsPath, 'utf8')
  const out = esbuild.transformSync(src, { loader: 'ts', format: 'cjs' }).code
  const m = { exports: {} }
  new Function('module', 'exports', 'require', '__dirname', out)(m, m.exports, require, path.dirname(tsPath))
  return m.exports
}
const { buildReviewMessages, parseModelVerdict } = loadPromptModule()
const { system, userText } = buildReviewMessages()

const sharp = require('sharp')
async function toB64(p) {
  const buf = await sharp(p).resize({ width: IMG_MAX_SIDE, height: IMG_MAX_SIDE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: IMG_QUALITY }).toBuffer()
  return buf.toString('base64')
}

async function callOnce(b64, extra) {
  const body = { model: MODEL, temperature: 0, messages: [
    { role: 'system', content: system },
    { role: 'user', content: [{ type: 'text', text: userText }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }] }
  ] }
  if (extra) Object.assign(body, extra)
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 60000)
  try {
    const resp = await fetch(`${ENDPOINT}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body), signal: ctrl.signal
    })
    const json = await resp.json().catch(() => ({}))
    if (!resp.ok) return { err: `HTTP ${resp.status} ${JSON.stringify(json).slice(0, 200)}` }
    const u = json.usage || {}
    const content = json?.choices?.[0]?.message?.content || ''
    const reasoning = json?.choices?.[0]?.message?.reasoning_content || ''
    const cost = (u.prompt_tokens || 0) / 1e6 * PRICE_IN_PER_M + (u.completion_tokens || 0) / 1e6 * PRICE_OUT_PER_M
    return { content, reasoning, usage: u, cost }
  } finally { clearTimeout(t) }
}

async function bench(label, images, extra) {
  console.log(`\n===== 模式 ${label} =====`)
  let sumCost = 0, n = 0, parsedOk = 0
  for (const p of images) {
    const name = path.basename(p)
    let b64
    try { b64 = await toB64(p) } catch (e) { console.log(`  ${name}: 读图失败 ${e}`); continue }
    const r = await callOnce(b64, extra)
    if (r.err) { console.log(`  ${name}: ❌ ${r.err}`); continue }
    const v = parseModelVerdict(r.content)
    if (v) parsedOk++
    const u = r.usage
    sumCost += r.cost; n++
    const tok = `入${u.prompt_tokens || '?'}(图${u.prompt_tokens_details?.image_tokens || '-'} 文${u.prompt_tokens_details?.text_tokens || '-'}) 出${u.completion_tokens || '?'}`
    console.log(`  ${name.padEnd(16)} ${tok} 费¥${r.cost.toFixed(5)} ${v ? '✅可解析' : '⚠️解析失败'}`)
    console.log(`      原始正文：${r.content.replace(/\s+/g, ' ').slice(0, 140)}${r.reasoning ? `  [含思考 ${r.reasoning.length}字]` : ''}`)
    if (v) console.log(`      判定：${v.person} | 闭眼${v.flaws.eyes_closed} 半头${v.flaws.half_head} 表情${v.flaws.expression} | ${v.reason}`)
  }
  console.log(`  —— 成功 ${n} 张、可解析 ${parsedOk}/${images.length}、平均 ¥${n ? (sumCost / n).toFixed(5) : '-'} /张（1000张≈¥${n ? (sumCost / n * 1000).toFixed(2) : '-'}）`)
  return { n, parsedOk, avg: n ? sumCost / n : 0 }
}

const images = process.argv.slice(2).filter((a) => fs.existsSync(a))
const set = images.length ? images : [
  path.resolve(__dirname, '..', '..', 'ai-engine', 'tests', 'fixtures', 'face_closed.jpg'),
  path.resolve(__dirname, '..', '..', 'ai-engine', 'tests', 'fixtures', 'face_open.jpg'),
  path.resolve(__dirname, '..', '..', 'ai-engine', 'tests', 'fixtures', 'no_person.jpg'),
  path.resolve(__dirname, '..', '..', 'ai-engine', 'tests', 'fixtures', 'person_multi.jpg')
].filter(fs.existsSync)
console.log(`测试图 ${set.length} 张：\n${set.map((p) => '  ' + path.basename(p)).join('\n')}`)

;(async () => {
  // 模式 B 先跑（关思考，最可能是生产该用的）；再跑 A 原样对比
  await bench('B：enable_thinking:false（关思考）', set, { enable_thinking: false })
  await bench('A：原样（现客户端请求体，不加额外参数）', set, null)
})().catch((e) => { console.error('异常', e); process.exitCode = 1 })
