/**
 * 四模型 AI 复审对拍（一次性探针，跑完可删）
 *
 * 目的：同一批真图分别喂给 qwen3-vl-plus / qwen3.5-flash / qwen3.7-flash / qwen3.8-flash，
 * 记录 token 用量、耗时、金额、判定结果，并与本地引擎已给出的分类做一致性对照。
 *
 * 严格复刻软件真实送图流程（app/src/main/services/aiReview.ts callDashScope）：
 *   sharp(path,{failOn:'none'}).rotate()  → resize 最长边 1024 fit:inside → jpeg quality 82 → base64
 *   temperature: 0、enable_search: false、同一份 buildReviewMessages()、同一个 parseModelVerdict()、
 *   解析失败重试一次。
 * 提示词与解析直接 import 生产代码，不复制粘贴，避免两份口径漂移。
 *
 * 用法（key 只走环境变量，绝不写进文件/日志）：
 *   $env:DASHSCOPE_API_KEY='sk-xxx'
 *   node --experimental-strip-types scripts/model-shootout.mts --limit 2   # 先小样冒烟
 *   node --experimental-strip-types scripts/model-shootout.mts             # 全量
 */
import { readdirSync, statSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { createHash } from 'crypto'
import { join, extname, basename } from 'path'
import sharp from 'sharp'
import { buildReviewMessages, parseModelVerdict } from '../src/main/services/aiReviewPrompt.ts'
import type { AiReviewVerdict } from '../src/main/services/aiReviewPrompt.ts'

const ROOT = 'E:\\1016测试'
const ENDPOINT = process.env.SHOOTOUT_ENDPOINT || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const API_KEY = process.env.DASHSCOPE_API_KEY || ''
// 与生产常量对齐（aiReview.ts:20-22）
const IMG_MAX_SIDE = 1024
const IMG_QUALITY = 82
// 测试用超时放宽到 60s（生产是 15s 硬超时）：目的是量出每张图真实耗时，
// 而不是让慢模型被提前掉掉拿不到数据。报告里会拿这个数去对生产的 15s 门槛。
const FETCH_TIMEOUT_MS = argTimeout()
function argTimeout(): number {
  const i = process.argv.indexOf('--timeout')
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : 60000
}
// 官方原价（元/百万 token，华北2 北京，2026-10-16 核自百炼控制台与帮助站）
// thinking: 'omit' = 不发 enable_thinking（VL 系列无思考模式，发了可能报 400）
//           'off'  = 显式关思考，否则主线模型先输出一大段思维链，又慢又贵
const MODELS: Array<{ id: string; inPrice: number; outPrice: number; note: string; thinking: 'omit' | 'off' }> = [
  { id: 'qwen3-vl-plus', inPrice: 1, outPrice: 10, note: '软件当前默认', thinking: 'omit' },
  { id: 'qwen3.5-flash', inPrice: 0.2, outPrice: 2, note: '', thinking: 'off' },
  { id: 'qwen3.7-flash', inPrice: 0.2, outPrice: 0.8, note: '', thinking: 'off' },
  { id: 'qwen3.8-flash', inPrice: 0.8, outPrice: 2.7, note: '', thinking: 'off' }
]
// 本地引擎文件夹名 → 对模型输出的期望断言。画质型（模糊/黑白）软件口径是「不判」，故不入断言。
const ASSERTS: Record<string, (v: AiReviewVerdict) => boolean> = {
  单人照: (v) => v.person === 'single_person',
  多人合拍照: (v) => v.person === 'group_photo',
  多人混合照: (v) => v.person === 'mixed_photo',
  无人物场景: (v) => v.person === 'no_person',
  闭眼: (v) => v.flaws.eyes_closed === true,
  半截头: (v) => v.flaws.half_head === true,
  表情崩坏: (v) => v.flaws.expression === true
}
const IGNORED_DIRS = new Set(['画面模糊', '黑白照'])

function argNum(name: string, dft: number): number {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dft
}
const LIMIT = argNum('limit', 0)
const CONCURRENCY = argNum('concurrency', 5)

interface Sample {
  key: string
  path: string
  folders: string[]
  asserts: Array<{ folder: string; ok: (v: AiReviewVerdict) => boolean }>
  contradictory: boolean
}

/** 递归按 MD5 去重；同图多文件夹合并成一个样本，person 类断言互斥则标 contradictory */
function collect(): { samples: Sample[]; totalFiles: number; dupFiles: number; skippedFiles: number } {
  const byHash = new Map<string, { path: string; folders: Set<string> }>()
  let totalFiles = 0
  let skippedFiles = 0
  const walk = (dir: string, folder: string): void => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      const st = statSync(p)
      if (st.isDirectory()) {
        walk(p, folder ? folder + '/' + e : e)
        continue
      }
      const ext = extname(e).toLowerCase()
      if (ext !== '.jpg' && ext !== '.jpeg' && ext !== '.png' && ext !== '.webp') {
        skippedFiles++
        continue
      }
      totalFiles++
      const top = (folder.split('/')[0] || '').trim()
      if (IGNORED_DIRS.has(top)) {
        // 仍计入总文件数，但不建断言（软件不让模型判画质）
      }
      const hash = createHash('md5').update(readFileSync(p)).digest('hex')
      const cur = byHash.get(hash)
      if (cur) cur.folders.add(top)
      else byHash.set(hash, { path: p, folders: new Set([top]) })
    }
  }
  walk(ROOT, '')
  const samples: Sample[] = []
  for (const [key, v] of byHash) {
    const folders = [...v.folders].filter(Boolean)
    const asserts = folders.filter((f) => ASSERTS[f]).map((f) => ({ folder: f, ok: ASSERTS[f] }))
    // person 四断言互斥：同图同时落在两个人数类文件夹 = 本地引擎自相矛盾，一致性统计剔除
    const personFolders = folders.filter((f) => ['单人照', '多人合拍照', '多人混合照', '无人物场景'].includes(f))
    samples.push({ key, path: v.path, folders, asserts, contradictory: personFolders.length > 1 })
  }
  samples.sort((a, b) => a.path.localeCompare(b.path))
  return {
    samples: LIMIT > 0 ? samples.slice(0, LIMIT) : samples,
    totalFiles,
    dupFiles: totalFiles - byHash.size,
    skippedFiles
  }
}

/** 与生产同构的送图管线 */
async function toBase64(path: string): Promise<string> {
  const buf = await sharp(path, { failOn: 'none' })
    .rotate()
    .resize({ width: IMG_MAX_SIDE, height: IMG_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: IMG_QUALITY })
    .toBuffer()
  return buf.toString('base64')
}

interface CallResult {
  model: string
  ok: boolean
  parseOk: boolean
  retried: boolean
  httpStatus: number
  ms: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cost: number
  verdict: AiReviewVerdict | null
  raw: string
  error: string
  sampleKey?: string
  file?: string
  folders?: string[]
  assertsOk?: boolean[]
}

async function callOne(modelId: string, inPrice: number, outPrice: number, thinking: 'omit' | 'off', b64: string, retry = true): Promise<CallResult> {
  const { system, userText } = buildReviewMessages()
  const t0 = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  let httpStatus = 0
  let raw = ''
  let pt = 0
  let ct = 0
  let tt = 0
  let err = ''
  try {
    const resp = await fetch(`${ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: modelId,
        temperature: 0,
        enable_search: false,
        ...(thinking === 'off' ? { enable_thinking: false } : {}),
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: [
              { type: 'text', text: userText },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }
            ]
          }
        ]
      }),
      signal: ctrl.signal
    })
    clearTimeout(timer)
    httpStatus = resp.status
    if (!resp.ok) {
      err = (await resp.text()).slice(0, 300)
      return { model: modelId, ok: false, parseOk: false, retried: false, httpStatus, ms: Date.now() - t0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, verdict: null, raw: '', error: err }
    }
    const json = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    }
    raw = json.choices?.[0]?.message?.content ?? ''
    pt = Number(json.usage?.prompt_tokens || 0)
    ct = Number(json.usage?.completion_tokens || 0)
    tt = Number(json.usage?.total_tokens || pt + ct)
  } catch (e) {
    clearTimeout(timer)
    err = String(e).slice(0, 300)
    const r: CallResult = { model: modelId, ok: false, parseOk: false, retried: false, httpStatus, ms: Date.now() - t0, promptTokens: pt, completionTokens: ct, totalTokens: tt, cost: 0, verdict: null, raw, error: err }
    if (retry && err.includes('AbortError')) return r // 超时不重跑，如实记失败
    return r
  }
  const ms = Date.now() - t0
  const v = parseModelVerdict(raw)
  let retried = false
  let verdict = v
  if (!v && retry) {
    // 复刻生产：解析失败重试一次
    const again = await callOne(modelId, inPrice, outPrice, thinking, b64, false)
    retried = true
    pt += again.promptTokens
    ct += again.completionTokens
    tt += again.totalTokens
    if (again.verdict) verdict = again.verdict
    raw += '\n===RETRY===\n' + again.raw
  }
  return {
    model: modelId,
    ok: true,
    parseOk: !!verdict,
    retried,
    httpStatus,
    ms,
    promptTokens: pt,
    completionTokens: ct,
    totalTokens: tt,
    cost: (pt * inPrice + ct * outPrice) / 1e6,
    verdict: verdict ?? null,
    raw,
    error: ''
  }
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('缺少 DASHSCOPE_API_KEY 环境变量')
    process.exit(1)
  }
  const c = collect()
  console.log(`总文件 ${c.totalFiles}，去重后 ${c.samples.length} 张参与对拍（重复 ${c.dupFiles} 个文件被合并，跳过非图 ${c.skippedFiles}）`)
  console.log(`模型：${MODELS.map((m) => m.id).join(' / ')}　并发 ${CONCURRENCY}`)

  // 预压图：每张只解一次，四模型共用同一份 base64，保证像素完全一致
  const imgs: Array<{ s: Sample; b64: string }> = []
  for (const s of c.samples) {
    try {
      imgs.push({ s, b64: await toBase64(s.path) })
    } catch (e) {
      console.log(`解码失败，跳过：${basename(s.path)} -> ${String(e).slice(0, 80)}`)
    }
  }
  console.log(`送图预处理完成 ${imgs.length} 张`)

  const jobs: Array<() => Promise<void>> = []
  const results: CallResult[] = []
  const t0 = Date.now()
  let done = 0
  for (const { s, b64 } of imgs) {
    for (const m of MODELS) {
      jobs.push(async () => {
        const r = await callOne(m.id, m.inPrice, m.outPrice, m.thinking, b64)
        r.sampleKey = s.key
        r.file = basename(s.path)
        r.folders = s.folders
        r.assertsOk = s.asserts.map((a) => (r.verdict ? a.ok(r.verdict) : false))
        results.push(r)
        if (++done % 40 === 0) console.log(`  ... ${done}/${jobs.length} 次调用，已用 ${((Date.now() - t0) / 1000).toFixed(0)}s`)
      })
    }
  }
  // 简单并发池
  const pool: Promise<void>[] = []
  for (const j of jobs) {
    const p = j().then(() => {
      pool.splice(pool.indexOf(p), 1)
    })
    pool.push(p)
    if (pool.length >= CONCURRENCY) await Promise.race(pool)
  }
  await Promise.all(pool)
  const wallMs = Date.now() - t0

  // 汇总
  const byModel: Record<string, unknown> = {}
  const sampleAsserts = new Map<string, Sample>()
  for (const s of c.samples) sampleAsserts.set(s.key, s)
  for (const m of MODELS) {
    const rs = results.filter((r) => r.model === m.id)
    const ok = rs.filter((r) => r.ok)
    const parsed = ok.filter((r) => r.parseOk)
    const judged = rs.filter((r) => {
      if (!r.parseOk || !r.sampleKey) return false
      const s = sampleAsserts.get(r.sampleKey)
      return !!s && !s.contradictory && s.asserts.length > 0
    })
    let assertTotal = 0
    let assertHit = 0
    const perFolder: Record<string, { total: number; hit: number }> = {}
    for (const r of judged) {
      const s = sampleAsserts.get(r.sampleKey as string)!
      s.asserts.forEach((a, i) => {
        assertTotal++
        const hit = !!r.assertsOk?.[i]
        if (hit) assertHit++
        const g = (perFolder[a.folder] ||= { total: 0, hit: 0 })
        g.total++
        if (hit) g.hit++
      })
    }
    const msList = ok.map((r) => r.ms).sort((a, b) => a - b)
    byModel[m.id] = {
      单价_元每百万token: { 输入: m.inPrice, 输出: m.outPrice },
      备注: m.note,
      调用次数: rs.length,
      HTTP失败: rs.length - ok.length,
      解析失败_含重试后仍失败: ok.length - parsed.length,
      触发重试次数: rs.filter((r) => r.retried).length,
      输入token合计: ok.reduce((a, r) => a + r.promptTokens, 0),
      输出token合计: ok.reduce((a, r) => a + r.completionTokens, 0),
      总token合计: ok.reduce((a, r) => a + r.totalTokens, 0),
      平均输入token每张: parsed.length ? +(ok.reduce((a, r) => a + r.promptTokens, 0) / Math.max(1, ok.length)).toFixed(0) : 0,
      平均输出token每张: parsed.length ? +(ok.reduce((a, r) => a + r.completionTokens, 0) / Math.max(1, ok.length)).toFixed(0) : 0,
      本次金额元: +ok.reduce((a, r) => a + r.cost, 0).toFixed(4),
      单张平均耗时ms: ok.length ? Math.round(ok.reduce((a, r) => a + r.ms, 0) / ok.length) : 0,
      耗时中位数ms: msList.length ? msList[Math.floor(msList.length / 2)] : 0,
      耗时最慢ms: msList.length ? msList[msList.length - 1] : 0,
      与本地分类一致率: assertTotal ? +((assertHit / assertTotal) * 100).toFixed(1) + '%' : 'N/A',
      一致断言数: `${assertHit}/${assertTotal}`,
      分文件夹一致率: perFolder
    }
  }
  const outDir = join('scripts', 'out')
  mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  writeFileSync(join(outDir, `shootout-${stamp}.jsonl`), results.map((r) => JSON.stringify(r)).join('\n'), 'utf8')
  const summary = {
    生成时间: new Date().toISOString(),
    图片根目录: ROOT,
    总文件数: c.totalFiles,
    参与对拍张数: imgs.length,
    模型数: MODELS.length,
    总调用次数: results.length,
    墙钟耗时秒: +(wallMs / 1000).toFixed(1),
    送图口径: `EXIF转正 + 最长边${IMG_MAX_SIDE} + JPEG质量${IMG_QUALITY} + temperature 0 + enable_search false（与生产 aiReview.ts 同构）`,
    测试超时门槛ms: FETCH_TIMEOUT_MS,
    生产超时门槛ms: '15000（超过即计为复审失败）',
    各模型: byModel,
    合计金额元: +results.reduce((a, r) => a + r.cost, 0).toFixed(4)
  }
  writeFileSync(join(outDir, `shootout-${stamp}.summary.json`), JSON.stringify(summary, null, 2), 'utf8')
  console.log('\n===== 汇总 =====')
  console.log(JSON.stringify(summary, null, 2))
  console.log(`\n明细：${join(outDir, `shootout-${stamp}.jsonl`)}`)
}

void main()
