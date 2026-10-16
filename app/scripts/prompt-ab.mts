/**
 * 提示词 A/B 打分台（测试端）
 *
 * 拿 truth-build.mts 洗出来的真值集，让同一批真图分别过不同版本的提示词，
 * 只报大白话数字：判对几张、判错几张、漏了几张、多挑了几张。
 *
 * 严格复刻生产送图：EXIF 转正 → 最长边 1024 → JPEG 质量 82 → temperature 0 →
 * enable_search false → enable_thinking false → 解析失败重试一次。
 *
 * 两层缓存都在 scripts/out/ab-cache/，重跑不重复花钱也不重复解码：
 *   img/<md5>.jpg          压缩后的送图字节（母本 2400 万像素，sharp 一次上百毫秒）
 *   <variant>.<model>.<md5>.json   那一版提示词那次调用的完整响应
 *
 * 用法（key 只走环境变量）：
 *   $env:DASHSCOPE_API_KEY='sk-xxx'
 *   node --experimental-strip-types scripts/prompt-ab.mts --variant all --limit 4      # 冒烟
 *   node --experimental-strip-types scripts/prompt-ab.mts --variant all                 # 全量对拍
 *
 * --limit 取样不是截前 N 张：前 N 张是同一场景的连拍，会把分数骗人。
 * 这里按「人数类别 × 闭眼真假」分桶轮转取样，几张也能覆盖到各个格子。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import { join, basename } from 'path'
import sharp from 'sharp'
import { VARIANTS, type Variant } from './prompt-variants.mts'

const TRUTH = process.env.AB_TRUTH || 'scripts/out/truth-couple1.jsonl'
const CACHE = 'scripts/out/ab-cache'
const ENDPOINT = process.env.SHOOTOUT_ENDPOINT || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const MODEL = process.env.SHOOTOUT_MODEL || 'qwen3-vl-plus'
/** 官方原价（元/百万 token，华北2 北京）。跑哪个模型就按哪个的价算，写死成 vl-plus 会把 flash 的金额算错 */
const PRICES: Record<string, [number, number]> = {
  'qwen3-vl-plus': [1, 10],
  'qwen3.5-flash': [0.2, 2],
  'qwen3.7-flash': [0.2, 0.8],
  'qwen3.8-flash': [0.8, 2.7]
}
const [PRICE_IN, PRICE_OUT] = PRICES[MODEL] || [1, 10]
// 送图分辨率/质量：默认与生产一致（1024 / 82）；可用环境变量临时拉高，验证"图清楚点是否判得更准"。
// 改了这两个值，缓存键也会随之分开（见下方 hash 拼接），不会误命中旧分辨率的缓存。
const IMG_MAX_SIDE = Number(process.env.AB_IMG_SIDE || 1024)
const IMG_QUALITY = Number(process.env.AB_IMG_Q || 82)

function arg(name: string, dft: string): string {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dft
}
const LIMIT = Number(arg('limit', '0'))
const CONCURRENCY = Number(arg('concurrency', '6'))
const WHICH = arg('variant', 'all')
const TIMEOUT = Number(arg('timeout', '30000'))
const API_KEY = process.env.DASHSCOPE_API_KEY || ''

interface TruthRow {
  filename: string
  path: string
  sizeMB: number
  person: string | null
  eyes_closed: boolean | null
  half_head: boolean | null
  expression: boolean | null
}

interface Call {
  file: string
  path: string
  variant: string
  ok: boolean
  http: number
  ms: number
  pt: number
  ct: number
  cost: number
  raw: string
  verdict: ReturnType<Variant['parse']>
  err: string
}

function md5File(p: string): string {
  return createHash('md5').update(readFileSync(p)).digest('hex')
}

/** 压缩结果落盘复用：同一张母本无论跑几版提示词、跑几轮，sharp 只做一次 */
async function toBase64(hash: string, p: string): Promise<string> {
  const jp = join(CACHE, 'img', `${hash}.jpg`)
  if (existsSync(jp)) return readFileSync(jp).toString('base64')
  const buf = await sharp(p, { failOn: 'none' })
    .rotate()
    .resize({ width: IMG_MAX_SIDE, height: IMG_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: IMG_QUALITY })
    .toBuffer()
  mkdirSync(join(CACHE, 'img'), { recursive: true })
  writeFileSync(jp, buf)
  return buf.toString('base64')
}

/** 一版一次调用的响应缓存：同一张图 + 同一版提示词 = 同一份 raw，重跑不再花钱 */
function cacheKey(hash: string, variantId: string): string {
  return join(CACHE, `${variantId}.${MODEL}.${hash}.json`)
}

async function callVariant(v: Variant, hash: string, b64: string, retry = true): Promise<Call> {
  const ck = cacheKey(hash, v.id)
  if (existsSync(ck)) {
    const c = JSON.parse(readFileSync(ck, 'utf8')) as Call
    return c
  }
  const { system, userText } = v.build()
  const t0 = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT)
  const base: Call = { file: '', path: '', variant: v.id, ok: false, http: 0, ms: 0, pt: 0, ct: 0, cost: 0, raw: '', verdict: null, err: '' }
  try {
    const resp = await fetch(`${ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        enable_search: false,
        enable_thinking: false,
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
    base.http = resp.status
    if (!resp.ok) {
      base.err = (await resp.text()).slice(0, 300)
      base.ms = Date.now() - t0
      return base
    }
    const j = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    base.raw = j.choices?.[0]?.message?.content ?? ''
    base.pt = Number(j.usage?.prompt_tokens || 0)
    base.ct = Number(j.usage?.completion_tokens || 0)
    base.ms = Date.now() - t0
    base.ok = true
    base.verdict = v.parse(base.raw)
    if (!base.verdict && retry) {
      const again = await callVariantFresh(v, b64, false)
      base.pt += again.pt
      base.ct += again.ct
      base.ms += again.ms
      base.raw += '\n===RETRY===\n' + again.raw
      if (again.verdict) base.verdict = again.verdict
    }
    base.cost = (base.pt * PRICE_IN + base.ct * PRICE_OUT) / 1e6
    mkdirSync(CACHE, { recursive: true })
    writeFileSync(ck, JSON.stringify(base), 'utf8')
    return base
  } catch (e) {
    clearTimeout(timer)
    base.err = String(e).slice(0, 300)
    base.ms = Date.now() - t0
    return base
  }
}

/** 重试那次不走缓存（同一张图同一版可能刚好缓存了个坏响应） */
async function callVariantFresh(v: Variant, b64: string, retry: boolean): Promise<Call> {
  const { system, userText } = v.build()
  const t0 = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT)
  const base: Call = { file: '', path: '', variant: v.id, ok: false, http: 0, ms: 0, pt: 0, ct: 0, cost: 0, raw: '', verdict: null, err: '' }
  try {
    const resp = await fetch(`${ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        enable_search: false,
        enable_thinking: false,
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
    if (!resp.ok) return { ...base, http: resp.status, err: (await resp.text()).slice(0, 200), ms: Date.now() - t0 }
    const j = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const raw = j.choices?.[0]?.message?.content ?? ''
    return {
      ...base,
      ok: true,
      http: resp.status,
      raw,
      pt: Number(j.usage?.prompt_tokens || 0),
      ct: Number(j.usage?.completion_tokens || 0),
      ms: Date.now() - t0,
      verdict: v.parse(raw)
    }
  } catch (e) {
    clearTimeout(timer)
    return { ...base, err: String(e).slice(0, 200), ms: Date.now() - t0 }
  }
}

const PERSON_CN: Record<string, string> = {
  single_person: '单人照',
  group_photo: '多人合拍照',
  mixed_photo: '多人混合照',
  no_person: '无人物场景'
}

function score(v: Variant, calls: Call[], truth: Map<string, TruthRow>): Record<string, unknown> {
  const good = calls.filter((c) => c.ok && c.verdict)
  const bad = calls.filter((c) => !c.ok || !c.verdict)
  let pTotal = 0
  let pHit = 0
  const perClass: Record<string, { 真值张数: number; 判对: number }> = {}
  const confusions: Record<string, number> = {}
  let eyesHit = 0
  let eyesTruthTotal = 0
  let eyesFalseAlarm = 0
  let eyesNoTruthButSaid = 0
  let halfHit = 0
  let halfTruthTotal = 0
  let halfFalseAlarm = 0
  let exprHit = 0
  let exprTruthTotal = 0
  let exprFalseAlarm = 0
  let selfOkCnt = 0
  let selfBadCnt = 0
  const selfBadFiles: string[] = []
  for (const c of good) {
    const t = truth.get(c.file)
    const vd = c.verdict!
    if (t?.person) {
      pTotal++
      const g = (perClass[t.person] ||= { 真值张数: 0, 判对: 0 })
      g.真值张数++
      if (vd.person === t.person) {
        pHit++
        g.判对++
      } else {
        const k = `${PERSON_CN[t.person] || t.person} → 判成 ${PERSON_CN[vd.person] || vd.person}`
        confusions[k] = (confusions[k] || 0) + 1
      }
    }
    const eyesTruth = t ? t.eyes_closed : undefined
    if (t && eyesTruth !== null && eyesTruth !== undefined) {
      eyesTruthTotal++
      if (eyesTruth && vd.eyes_closed) eyesHit++
      if (!eyesTruth && vd.eyes_closed) eyesFalseAlarm++
    }
    if ((eyesTruth === null || eyesTruth === undefined) && vd.eyes_closed) eyesNoTruthButSaid++
    if (t && t.half_head !== null && t.half_head !== undefined) {
      halfTruthTotal++
      if (t.half_head && vd.half_head) halfHit++
      if (!t.half_head && vd.half_head) halfFalseAlarm++
    }
    if (t && t.expression !== null && t.expression !== undefined) {
      exprTruthTotal++
      if (t.expression && vd.expression) exprHit++
      if (!t.expression && vd.expression) exprFalseAlarm++
    }
    if (vd.self_consistent === false) {
      selfBadCnt++
      if (selfBadFiles.length < 12) selfBadFiles.push(basename(c.path) + ' 自报' + vd.person_count + '人却写' + vd.person)
    } else if (vd.self_consistent === true) selfOkCnt++
  }
  const topConfuse = Object.entries(confusions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, n]) => `${k}：${n} 张`)
  return {
    版本: v.id,
    说明: v.desc,
    调用: { 成功: good.length, 失败或解析不出: bad.length, 失败样例: bad.slice(0, 3).map((b) => basename(b.path) + ' ' + (b.err || '').slice(0, 90)) },
    输入token合计: good.reduce((a, c) => a + c.pt, 0),
    输出token合计: good.reduce((a, c) => a + c.ct, 0),
    本次金额元: +good.reduce((a, c) => a + c.cost, 0).toFixed(4),
    平均单张耗时ms: good.length ? Math.round(good.reduce((a, c) => a + c.ms, 0) / good.length) : 0,
    人数: {
      有真值张数: pTotal,
      判对: pHit,
      判对率: pTotal ? +((pHit / pTotal) * 100).toFixed(1) + '%' : 'N/A',
      分类别: Object.fromEntries(
        Object.entries(perClass).map(([k, g2]) => [PERSON_CN[k] || k, `${g2.判对}/${g2.真值张数}`])
      ),
      最常犯的错: topConfuse
    },
    闭眼: {
      有真值张数: eyesTruthTotal,
      真闭眼认出: eyesHit,
      真闭眼总数_漏了几张: `${[...truth.values()].filter((t) => t.eyes_closed === true).length} 张，漏 ${[...truth.values()].filter((t) => t.eyes_closed === true).length - eyesHit} 张`,
      没闭眼却乱喊: eyesFalseAlarm,
      没真值但喊了闭眼: eyesNoTruthButSaid
    },
    表情: {
      有真值张数: exprTruthTotal,
      真崩坏认出: exprHit,
      没崩坏却乱喊: exprFalseAlarm,
      备注: '真值里人工明确表过态的表情维度只有这一张，数字没有统计意义，只能用来发现乱喊'
    },
    半截头: {
      有真值张数: halfTruthTotal,
      真半截头认出: halfHit,
      没裁却乱喊: halfFalseAlarm,
      备注: '真值里"确实半截头"只有 9 张，这一维数字只能当参考，不足以定优劣'
    },
    自洽: v.id === 'v1-current' ? '本版没有自报人数，无从校验' : { count与分类自洽: selfOkCnt, 自相矛盾: selfBadCnt, 矛盾样例: selfBadFiles }
  }
}

/** 分桶轮转取样：人数类别 × 闭眼真假，保证冒烟那几张能覆盖到不同格子（连拍帧全挤在一块，截前 N 张会骗人） */
function stratify(rows: TruthRow[], n: number): TruthRow[] {
  const buckets = new Map<string, TruthRow[]>()
  for (const r of rows) {
    const eyes = r.eyes_closed === true ? '闭眼' : r.eyes_closed === false ? '睁眼' : '未标'
    const k = `${r.person || '无人数真值'}/${eyes}`
    ;(buckets.get(k) || buckets.set(k, []).get(k)!).push(r)
  }
  const keys = [...buckets.keys()].sort()
  const picked: TruthRow[] = []
  let cursor = 0
  while (picked.length < n) {
    const b = buckets.get(keys[cursor % keys.length]) as TruthRow[]
    const idx = Math.floor(cursor / keys.length)
    if (idx >= b.length) {
      if (keys.every((k) => (buckets.get(k) as TruthRow[]).length <= Math.floor(cursor / keys.length))) break
    } else picked.push(b[idx])
    cursor++
    if (cursor > n * keys.length + keys.length) break
  }
  return picked
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('缺少 DASHSCOPE_API_KEY')
    process.exit(1)
  }
  if (!existsSync(TRUTH)) {
    console.error(`找不到真值表 ${TRUTH}，先跑 node --experimental-strip-types scripts/truth-build.mts`)
    process.exit(1)
  }
  const rows = readFileSync(TRUTH, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TruthRow)
  const missing = rows.filter((r) => !existsSync(r.path))
  if (missing.length) console.log(`警告：${missing.length} 张母本不在盘上，已跳过`)
  let pick = rows.filter((r) => existsSync(r.path))
  if (LIMIT > 0) pick = stratify(pick, LIMIT)
  // --variant 支持 all / 单个 id / 逗号分隔多个 id（便于只重跑关心的几版，省时间）
  const wantIds = WHICH === 'all' ? null : WHICH.split(',').map((s) => s.trim()).filter(Boolean)
  if (wantIds) {
    const unknown = wantIds.filter((id) => !VARIANTS.some((v) => v.id === id))
    if (unknown.length) {
      console.error('未知版本 id：' + unknown.join(', ') + '；可用：' + VARIANTS.map((v) => v.id).join(', '))
      process.exit(1)
    }
  }
  const variants: Variant[] = wantIds ? VARIANTS.filter((v) => wantIds.includes(v.id)) : VARIANTS
  console.log(`真值图 ${pick.length} 张 × 提示词版本 ${variants.map((v) => v.id).join(' / ')} = ${pick.length * variants.length} 次调用，模型 ${MODEL}，同时在跑 ${CONCURRENCY} 张`)

  const truth = new Map<string, TruthRow>()
  for (const r of pick) truth.set(r.path, r)

  // 一张图一个任务：先问响应缓存，两版都命中就不读原图不跑 sharp；否则压缩一次两版共用
  const jobs: Array<() => Promise<Call[]>> = pick.map((r) => async () => {
    // 把送图口径并进 hash：同一张源图在不同分辨率/质量下视为不同缓存，互不污染
    const hash = md5File(r.path) + `-s${IMG_MAX_SIDE}q${IMG_QUALITY}`
    const todo = variants.filter((v) => !existsSync(cacheKey(hash, v.id)))
    if (todo.length === 0)
      return variants.map((v) => ({ ...(JSON.parse(readFileSync(cacheKey(hash, v.id), 'utf8')) as Call), file: r.path, path: r.path }))
    const b64 = await toBase64(hash, r.path)
    const got: Call[] = []
    for (const v of variants) got.push({ ...(await callVariant(v, hash, b64)), file: r.path, path: r.path })
    return got
  })
  const out: Call[] = []
  const t0 = Date.now()
  let done = 0
  let next = 0
  // 固定几个工人轮流取任务，比“排队列 + 手动控制并发窗口”不容易出错（取到算谁的不会乱）
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++
      if (i >= jobs.length) return
      out.push(...(await jobs[i]()))
      if (++done % 50 === 0) console.log(`  ... ${done}/${jobs.length} 张，已用 ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, () => worker()))

  const byVariant: Record<string, Call[]> = {}
  for (const c of out) (byVariant[c.variant] ||= []).push(c)
  const report = variants.map((v) => score(v, byVariant[v.id] || [], truth))
  const wall = +((Date.now() - t0) / 1000).toFixed(1)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  mkdirSync('scripts/out', { recursive: true })
  const full = { 生成时间: new Date().toISOString(), 模型: MODEL, 真值表: TRUTH, 张数: pick.length, 墙钟秒: wall, 取样: LIMIT > 0 ? `分桶轮转取 ${LIMIT} 张` : '全量', 送图口径: `EXIF转正+最长边${IMG_MAX_SIDE}+质量${IMG_QUALITY}+temperature 0+关联网+关思考`, 各版本: report }
  writeFileSync(join('scripts/out', `ab-${stamp}.json`), JSON.stringify(full, null, 2), 'utf8')
  writeFileSync(join('scripts/out', `ab-${stamp}.raw.jsonl`), out.map((c) => JSON.stringify({ ...c, raw: c.raw.slice(0, 400) })).join('\n'), 'utf8')
  console.log('\n===== 打分 =====')
  console.log(JSON.stringify(full, null, 2))
}

main().catch((e) => {
  console.error('跑挂了：' + String(e))
  process.exit(1)
})
