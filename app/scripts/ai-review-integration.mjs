/**
 * AI 复审 · 后端真实联调探针（Task12 Step4）
 * 只读、可重复；不带 token 时做"连通性 + 契约结构"校验（打过去应 401，不发 key 不耗额度）。
 * 带会员 token 时走完整链路：领 key(A) → 报用量 delta=0(B) → 拿 key 真连一次千问并解析。
 *
 * token 来源：默认读 %APPDATA%/ai-photo-screener/auth.json 的 token；或环境变量 AI_REVIEW_TEST_TOKEN 覆盖。
 * 真实千问出图验证需提供一张本地图：环境变量 AI_REVIEW_TEST_IMG=<图片路径>（不给则跳过出图，仅验 A/B）。
 *
 *   node ai-review-integration.mjs            # 无 token：只验后端连通+401契约
 *   node ai-review-integration.mjs --full     # 有 token：验 A→B 完整；给图则再验千问解析
 *
 * api_key 绝不打印明文，只显示前后缀与长度。
 */
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import fs from 'fs'
import path from 'path'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const API_BASE = 'https://st.uxuuu.cn/api/client'

function maskKey(k) {
  if (!k || typeof k !== 'string') return '(空)'
  if (k.length <= 10) return `len=${k.length} ****`
  return `${k.slice(0, 6)}…${k.slice(-4)} (len=${k.length})`
}

function readToken() {
  if (process.env.AI_REVIEW_TEST_TOKEN) return process.env.AI_REVIEW_TEST_TOKEN.trim()
  const base = process.env.APPDATA || path.join(process.env.HOME || '', 'Library', 'Application Support')
  // 开发版/安装版 userData 目录名可能不同，逐个候选尝试
  for (const dir of ['screener-master', 'ai-photo-screener']) {
    const f = path.join(base, dir, 'auth.json')
    try { const t = (JSON.parse(fs.readFileSync(f, 'utf8')).token || '').trim(); if (t) return t } catch { /* 试下一个 */ }
  }
  return ''
}

async function post(ep, body, token) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 20000)
  try {
    const resp = await fetch(`${API_BASE}/${ep}`, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal })
    let json
    try { json = await resp.json() } catch { return { http: resp.status, envelope: false, note: `响应非 JSON（HTTP ${resp.status}）` } }
    return { http: resp.status, envelope: typeof json.code === 'number', json }
  } catch (e) {
    return { http: 0, envelope: false, note: '网络失败：' + String(e) }
  } finally { clearTimeout(t) }
}

const pass = (ok) => (ok ? '✅' : '❌')
let failures = 0
function check(label, ok, detail) {
  if (!ok) failures++
  console.log(`${pass(ok)} ${label}${detail ? '  ' + detail : ''}`)
}

async function main() {
  const full = process.argv.includes('--full')
  const token = readToken()
  console.log(`后端 Base：${API_BASE}`)
  console.log(`登录 token：${token ? '已取到（len=' + token.length + '）' : '无（仅做连通+401契约校验）'}\n`)

  // —— 接口 A ——
  console.log('【接口 A】ai_review_key.php')
  const a = await post('ai_review_key.php', { scope: 'review', client_version: 'probe' }, token || null)
  if (a.note) { check('接口 A 可达', false, a.note); }
  else {
    check('接口 A 可达且返回 {code,message,data} 信封', a.envelope, `HTTP=${a.http} code=${a.json.code}`)
    if (!token) {
      // 无 token：期望被拒（401 / unauthorized），且不得下发真 key
      const rejected = a.json.code === 401 || a.json.data?.reason === 'unauthorized'
      check('未登录被正确拒绝（401/unauthorized）', rejected, `code=${a.json.code} reason=${a.json.data?.reason || '-'}`)
      check('未登录未下发 api_key', !a.json.data?.api_key, `api_key=${a.json.data?.api_key ? '⚠️竟然有' : '无'}`)
    } else if (a.json.code !== 200) {
      // 有 token 但未 200：区分真实错误与后端正常裁决
      const dr = a.json.data?.reason || ''
      if (dr === 'service_disabled' || dr === 'key_not_configured' || a.json.code === 503) {
        console.log(`ℹ️ 接口 A 返回保护分支 code=${a.json.code} reason=${dr || '-'}（后台尚未配千问 key / 总开关关闭，属预期，非缺陷）`)
      } else if (dr === 'not_member' || a.json.code === 403) {
        // 服务端会员闸门拦下非会员（防线止常）——但正向链路需会员账号才能验
        check('服务端会员闸门拦截非会员（未发 key）', !a.json.data?.api_key, `code=${a.json.code} reason=${dr || '-'}→需会员账号才能测领到 key 的正向链路`)
      } else {
        check('会员领 key 返回 200', false, `code=${a.json.code} reason=${dr || '-'}（token 非会员/额度尽/限频？或后端异常）`)
      }
    }
  }

  // —— 接口 B ——
  console.log('\n【接口 B】ai_review_usage.php')
  const b = await post('ai_review_usage.php', { scope: 'review', session_id: 'probe-no-session', seq: 1, delta: 0 }, token || null)
  if (b.note) { check('接口 B 可达', false, b.note) }
  else {
    check('接口 B 可达且返回信封', b.envelope, `HTTP=${b.http} code=${b.json.code}`)
    if (!token) {
      const rejected = b.json.code === 401 || b.json.data?.reason === 'unauthorized' || b.json.data?.reason === 'bad_session'
      check('未登录/非法 session 被拒（401/unauthorized/bad_session）', rejected, `code=${b.json.code} reason=${b.json.data?.reason || '-'}`)
    }
  }

  // —— 完整链路（需会员 token）——
  if (full && token && a.json?.code === 200 && a.json.data?.api_key) {
    console.log('\n【完整链路】会员领 key 成功')
    const d = a.json.data
    check('下发 session_id', !!d.session_id, `session_id=${d.session_id}`)
    check('下发 endpoint/model', !!d.endpoint && !!d.model, `model=${d.model} endpoint=${d.endpoint}`)
    check('额度字段齐全', d.daily_limit != null && d.used_today != null, `daily_limit=${d.daily_limit} used_today=${d.used_today} remaining=${d.remaining}`)
    console.log(`  api_key（脱敏）：${maskKey(d.api_key)}`)
    // B 上报 delta=0（幂等、不产生成本）
    const b2 = await post('ai_review_usage.php', { scope: 'review', session_id: d.session_id, seq: 1, delta: 0 }, token)
    check('报用量接口 B（合法 session, delta=0）返回 200', b2.json?.code === 200, `code=${b2.json?.code}`)

    // 真连一次千问并解析（需本地测试图）
    const img = process.env.AI_REVIEW_TEST_IMG
    if (img && fs.existsSync(img) && d.api_key) {
      console.log('\n【千问真实出图 + 解析】')
      try {
        const initSqlJsUnused = null
        const sharp = require('sharp')
        const buf = await sharp(img).resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer()
        const b64 = buf.toString('base64')
        const { buildReviewMessages, parseModelVerdict } = loadPromptModule()
        const { system, userText } = buildReviewMessages()
        const resp = await fetch(`${d.endpoint}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d.api_key}` },
          body: JSON.stringify({ model: d.model, temperature: 0, messages: [
            { role: 'system', content: system },
            { role: 'user', content: [{ type: 'text', text: userText }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }] }
          ] })
        })
        const j = await resp.json()
        const text = j?.choices?.[0]?.message?.content || ''
        check('千问返回非空文本', !!text, text ? `原文：${text.replace(/\s+/g, ' ').slice(0, 120)}` : '(空)')
        const verdict = parseModelVerdict(text)
        check('模型输出可被 parseModelVerdict 解析', !!verdict, verdict ? JSON.stringify(verdict) : '解析为 null（模型没吐合法 JSON）')
      } catch (e) {
        check('千问出图链路', false, String(e))
      }
    } else {
      console.log('\n（跳过千问出图：未设 AI_REVIEW_TEST_IMG 指向本地图）')
    }
  } else if (full && !(a.json?.code === 200 && a.json.data?.api_key)) {
    console.log('\n（--full 但未拿到真 key：token 非会员或接口 A 未 200，跳过完整链路）')
  }

  console.log(`\n结论：${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项未过`}`)
  // 用 exitCode 而非 process.exit，让 fetch socket 自然排空，避开 Windows libuv 拆除断言
  process.exitCode = failures === 0 ? 0 : 1
}

// 用 esbuild 现场转译 aiReviewPrompt.ts，保证解析逻辑与主进程单一真源，零重复
function loadPromptModule() {
  const esbuild = require('esbuild')
  const tsPath = path.join(__dirname, '..', 'src', 'main', 'services', 'aiReviewPrompt.ts')
  const src = fs.readFileSync(tsPath, 'utf8')
  const out = esbuild.transformSync(src, { loader: 'ts', format: 'cjs' }).code
  const m = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', '__dirname', out)(m, m.exports, require, path.dirname(tsPath))
  return m.exports
}

main().catch((e) => { console.error('探针异常：', e); process.exit(1) })
