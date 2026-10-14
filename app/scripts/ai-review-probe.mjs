/**
 * AI 复审探针（只读 sql.js，仿 inspect-db.js）—— 端到端验证的"证据机器"。
 * 全程只读打开数据库，绝不写库。三个子命令：
 *
 *   node ai-review-probe.mjs snapshot <out.json>
 *     把全库 images 的判定关键字段（+ corrections 计数）导出为 JSON 快照，供后续比对。
 *
 *   node ai-review-probe.mjs verify <before.json>
 *     非破坏性断言（Task12 Step2 / 铁律 e7a2a92d）：重读当前库，与快照逐字段比对，
 *     断言一次纯复审只可能改动 ai_review；tags/category/engine_sig/status/tier 等任何
 *     判定字段一旦漂移即判 FAIL（复审"只给只读建议"红线被破）。
 *
 *   node ai-review-probe.mjs diff <a.json> <b.json>
 *     采纳等价性基准（Task12 Step3）：A 组走 adoptAiReview、B 组在 ReviewPanel 手选同结果
 *     提交后各存一份终态快照，逐字段比对必须完全一致；任何差异 = 采纳通道与手动通道不等价。
 *
 * DB 路径：默认 %APPDATA%/ai-photo-screener/data/screener.db，可用环境变量 AI_REVIEW_DB 覆盖。
 */
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'

const require = createRequire(import.meta.url)

// ---------- 库路径 ----------
function dbPath() {
  if (process.env.AI_REVIEW_DB) return process.env.AI_REVIEW_DB
  const base = process.env.APPDATA || path.join(process.env.HOME || '', 'Library', 'Application Support')
  return path.join(base, 'ai-photo-screener', 'data', 'screener.db')
}

// ---------- 关键字段（判定相关，复审/采纳前后应受控）----------
// 这些字段构成一张图"是什么判定"的全部；复审阶段一个都不许动，采纳阶段只由手动通道改。
const JUDGMENT_COLS = [
  'id', 'path', 'filename', 'category', 'status', 'tags',
  'engine_sig', 'tier', 'tier_by', 'dup_group', 'category_by', 'scene'
]
// ai_review 是复审唯一"允许被写"的列；从判定比对里单列出来。
const REVIEW_COL = 'ai_review'

async function readAll() {
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs()
  const p = dbPath()
  if (!fs.existsSync(p)) {
    console.error('DB 不存在：' + p + '（可设 AI_REVIEW_DB 指向测试库）')
    process.exit(2)
  }
  const db = new SQL.Database(fs.readFileSync(p))
  // 自适应列：迁移在 app 启动时才跑，旧库可能尚无 engine_sig/ai_review 列。
  // 用 PRAGMA 探测实际存在的列，只选有的——旧库缺判定列时如实报告缺哪些，而非崩。
  const info = db.exec('PRAGMA table_info(images)')
  const have = new Set(info[0] ? info[0].values.map((v) => v[1]) : [])
  const presentJudgment = JUDGMENT_COLS.filter((c) => have.has(c))
  const missing = JUDGMENT_COLS.filter((c) => !have.has(c))
  const reviewPresent = have.has(REVIEW_COL)
  const cols = [...presentJudgment, ...(reviewPresent ? [REVIEW_COL] : [])].join(',')
  if (!cols) { console.error('images 表无可比对列'); process.exit(2) }
  const res = db.exec(`SELECT ${cols} FROM images ORDER BY id`)
  const map = new Map()
  if (res[0]) {
    const names = res[0].columns
    for (const row of res[0].values) {
      const o = {}
      names.forEach((n, i) => { o[n] = row[i] })
      // tags 归一化只在读原始行时做一次，下游（快照/比对）一律用已归一值，避免双重归一假差异
      if ('tags' in o) o.tags = normTags(o.tags)
      map.set(o.id, o)
    }
  }
  let corrections = 0
  try { corrections = db.exec('SELECT COUNT(*) FROM corrections')[0].values[0][0] } catch { /* 无表 */ }
  db.close()
  return { images: map, corrections, missing, reviewPresent }
}

function normTags(raw) {
  // tags JSON 稳定化：键排序后序列化，避免键顺序造成假差异
  try {
    const t = JSON.parse(raw || '{}')
    const keys = Object.keys(t).sort()
    const out = {}
    for (const k of keys) {
      const v = t[k] || {}
      out[k] = `${v.level || ''}|${v.confidence ?? ''}`
    }
    return JSON.stringify(out)
  } catch {
    return String(raw)
  }
}

function snapshotRow(o) {
  const rec = {}
  for (const c of JUDGMENT_COLS) rec[c] = o[c] ?? null
  rec[REVIEW_COL] = o[REVIEW_COL] ?? null
  return rec
}

// ---------- 子命令：snapshot ----------
async function cmdSnapshot(outFile) {
  if (!outFile) { console.error('用法: snapshot <out.json>'); process.exit(2) }
  const { images, corrections } = await readAll()
  const snap = {
    meta: { at: Date.now(), db: dbPath(), count: images.size, corrections },
    images: [...images.values()].map(snapshotRow)
  }
  fs.writeFileSync(outFile, JSON.stringify(snap, null, 2))
  const withReview = snap.images.filter((r) => r[REVIEW_COL]).length
  console.log(`快照已写入 ${outFile}`)
  console.log(`  图片 ${snap.meta.count} 张，其中已有 AI 建议 ${withReview} 张，corrections ${corrections} 条`)
}

// ---------- 子命令：verify（非破坏性：仅 ai_review 可变）----------
async function cmdVerify(beforeFile) {
  if (!beforeFile) { console.error('用法: verify <before.json>'); process.exit(2) }
  const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'))
  const bmap = new Map(before.images.map((r) => [r.id, r]))
  const { images: cur } = await readAll()

  const drift = []
  let reviewWritten = 0
  for (const [id, rec] of cur) {
    const b = bmap.get(id)
    if (!b) { drift.push({ id, field: '(新增行)', before: null, after: '新图出现，复审期间不应新增' }); continue }
    for (const c of JUDGMENT_COLS) {
      const bv = b[c]
      const av = rec[c]
      if (String(bv ?? '') !== String(av ?? '')) {
        drift.push({ id, path: rec.path, field: c, before: bv, after: av })
      }
    }
    if ((b[REVIEW_COL] ?? null) !== (rec[REVIEW_COL] ?? null)) reviewWritten++
  }
  for (const id of bmap.keys()) if (!cur.has(id)) drift.push({ id, field: '(行消失)', before: '复审期间不应删除', after: null })

  console.log(`比对基准：${beforeFile}（快照时 ${before.meta.count} 张）`);
  console.log(`复审期间被写入 ai_review 的张数：${reviewWritten}`)
  if (drift.length) {
    console.error(`\n❌ 非破坏性断言 FAIL：${drift.length} 处判定字段被改动（复审只应写 ai_review，红线 e7a2a92d）`)
    for (const d of drift.slice(0, 40)) {
      console.error(`  id=${d.id} ${d.path || ''} 字段[${d.field}] 前=${JSON.stringify(d.before)} 后=${JSON.stringify(d.after)}`)
    }
    process.exit(1)
  }
  console.log(`\n✅ 非破坏性断言 PASS：判定字段（tags/category/engine_sig/status/tier/...）逐张逐字段零漂移，仅 ai_review 被写。`)
}

// ---------- 子命令：diff（采纳等价性：两份终态须逐字段一致）----------
async function cmdDiff(aFile, bFile) {
  if (!aFile || !bFile) { console.error('用法: diff <a.json> <b.json>'); process.exit(2) }
  const A = JSON.parse(fs.readFileSync(aFile, 'utf8'))
  const B = JSON.parse(fs.readFileSync(bFile, 'utf8'))
  const amap = new Map(A.images.map((r) => [r.id, r]))
  const bmap = new Map(B.images.map((r) => [r.id, r]))
  const ids = new Set([...amap.keys(), ...bmap.keys()])
  const diffs = []
  for (const id of [...ids].sort((x, y) => x - y)) {
    const a = amap.get(id), b = bmap.get(id)
    if (!a || !b) { diffs.push({ id, field: '(集合不同)', a: !!a, b: !!b }); continue }
    for (const c of [...JUDGMENT_COLS, REVIEW_COL]) {
      const av = a[c] ?? null, bv = b[c] ?? null
      if (String(av) !== String(bv)) diffs.push({ id, path: a.path || b.path, field: c, a: av, b: bv })
    }
  }
  console.log(`A=${aFile}(${A.meta.count}) vs B=${bFile}(${B.meta.count})`)
  if (diffs.length) {
    console.error(`\n❌ 采纳等价性 FAIL：${diffs.length} 处不一致——adoptAiReview 与 ReviewPanel 手选不同结果（铁律 e7a2a92d）`)
    for (const d of diffs.slice(0, 40)) {
      console.error(`  id=${d.id} ${d.path || ''} 字段[${d.field}] A=${JSON.stringify(d.a)} B=${JSON.stringify(d.b)}`)
    }
    process.exit(1)
  }
  console.log(`\n✅ 采纳等价性 PASS：两条通道终态逐字段完全一致（含 ai_review 清空行为）。`)
}

// ---------- 子命令：status（快速看当前复审落库情况）----------
async function cmdStatus() {
  const { images, corrections } = await readAll()
  let has = 0, byModel = {}
  for (const rec of images.values()) {
    if (rec[REVIEW_COL]) {
      has++
      try { const m = JSON.parse(rec[REVIEW_COL]).model || '?'; byModel[m] = (byModel[m] || 0) + 1 } catch { }
    }
  }
  console.log(`全库 ${images.size} 张，带 AI 建议 ${has} 张`, byModel)
  console.log('corrections:', corrections)
}

// ---------- 入口 ----------
const [cmd, ...args] = process.argv.slice(2)
switch (cmd) {
  case 'snapshot': void cmdSnapshot(args[0]); break
  case 'verify': void cmdVerify(args[0]); break
  case 'diff': void cmdDiff(args[0], args[1]); break
  case 'status': void cmdStatus(); break
  default:
    console.log('AI 复审探针（只读）子命令：')
    console.log('  snapshot <out.json>        导出判定字段快照')
    console.log('  verify   <before.json>     非破坏性断言：仅 ai_review 可变')
    console.log('  diff     <a.json> <b.json> 采纳等价性：两份终态逐字段一致')
    console.log('  status                     查看当前复审落库概况')
}
