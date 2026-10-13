/**
 * 检测准确率审计（只读，不重跑引擎，不进包）
 *
 * 要回答的问题：AI 的检测准不准？误判率高不高？会不会乱打标签？
 *
 * 为什么不需要人工重新标注三千张：你自己就是真值。
 *   库里 corrections 表逐条记着你对 AI 判定的表态：
 *     action='wrong'   + orig_dim 有值 = 你否定过 AI 在这张图上打的某个维度标签 → 乱打标签的铁证（FP）
 *     action='correct'                 = 你明确认可 AI 这条判定                 → 判对（TP）
 *     orig_dim 为空（NULL）            = AI 没报，你手动补了这个问题            → 漏打（FN）
 *   与 analyze-calib.js 同一证据原则：AI 报了但你没动过的图不算证据（没看 不等于 认可）。
 *
 * 已知污染：放行（移到交付库）走 clearBadTags，会把该图所有 AI 坏维度逐个记成 wrong，
 *   一次放行可能连坐产生 3 条 wrong。所以每个维度同时给"事件数"与"去重图数"两个口径。
 *
 * 用法：node scripts/detection-audit.js
 */
const fs = require('fs')
const path = require('path')

const AUDIT_DIMS = ['eyes_closed', 'blur', 'exposure', 'half_head', 'face_ugly', 'duplicate']
const PERSON_DIMS = ['single_person', 'group_photo', 'mixed_photo', 'no_person']
const DIM_CN = {
  eyes_closed: '闭眼',
  blur: '模糊',
  exposure: '曝光',
  half_head: '半截头',
  face_ugly: '表情崩坏',
  duplicate: '重复连拍',
  single_person: '单人照',
  group_photo: '多人合拍照',
  mixed_photo: '混合照',
  no_person: '无人物场景',
  black_white: '黑白',
  library: '交付库',
  trash: '废弃库',
  dup_trash: '重复废弃',
  review: '待确认'
}
const cn = (k) => DIM_CN[k] || k
const isRight = (a) => a === 'correct' || a === 'right'
const isWrong = (a) => a === 'wrong'

// 引擎侧关键改动的提交时刻（git log 实测），用来判断这份成绩单属于哪一版引擎
const ENGINE_MILESTONES = [
  { at: Date.parse('2026-10-10T10:51:48+08:00'), label: '10-10 10:51 f4d1fcf 六维度检测严格化（闭眼只认完全闭合/模糊只认严重/曝光删掉偏暗即欠曝/人数交叉校验）' },
  { at: Date.parse('2026-10-10T18:45:00+08:00'), label: '10-10 18:45 2f2fc4b quality.py +40 行、__init__.py +37 行、person.py +24 行' },
  { at: Date.parse('2026-10-11T18:26:00+08:00'), label: '10-11 18:26 eeb1d84 person.py +117 行（人数三层修法）、__init__.py +89 行' }
]

;(async () => {
  const dbPath = path.join(process.env.APPDATA || '', 'screener-master', 'data', 'screener.db')
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs()
  const db = new SQL.Database(fs.readFileSync(dbPath))

  const imgRes = db.exec('SELECT id, filename, category, category_by, tags, status, scanned_at FROM images')
  const imgs = new Map()
  for (const v of imgRes[0]?.values || []) {
    let tags = {}
    try { tags = JSON.parse(v[4] || '{}') } catch { tags = {} }
    imgs.set(v[0], { id: v[0], file: v[1], cat: v[2], by: v[3], tags, status: v[5], scanned: v[6] })
  }
  const corrRes = db.exec('SELECT image_id, orig_dim, orig_confidence, new_category, action, timestamp FROM corrections')
  const corr = (corrRes[0]?.values || []).map((v) => ({ imgId: v[0], dim: v[1], conf: v[2], toCat: v[3], action: v[4], ts: v[5] }))

  /* ---------- 0. 这份成绩单是哪一版引擎考出来的 ---------- */
  const scanned = [...imgs.values()].map((r) => r.scanned).filter((x) => x > 0)
  const lo = Math.min(...scanned)
  const hi = Math.max(...scanned)
  console.log(`库内 ${imgs.size} 行 · 检测时刻（本地）${new Date(lo).toLocaleString()} ~ ${new Date(hi).toLocaleString()}`)
  for (const m of ENGINE_MILESTONES) console.log(`  ${hi < m.at ? '未生效 ✗' : '已生效 ✓'}  ${m.label}`)
  const stale = hi < ENGINE_MILESTONES[2].at
  console.log(`  → 结论：这批标签${stale ? '出自 10-11 那次人数三层修法（person.py +117 行）之前的引擎，那部分改动从没在你这批图上跑过' : '已包含目前全部引擎改动'}\n`)

  console.log(`corrections 共 ${corr.length} 条，涉及 ${new Set(corr.map((c) => c.imgId)).size} 张图 · 表态分布：`)
  const byAction = {}
  for (const c of corr) byAction[c.action] = (byAction[c.action] || 0) + 1
  for (const [k, n] of Object.entries(byAction)) console.log(`  ${k} = ${n} 条`)

  /* ---------- 1. 逐维度误判率：你表过态的 AI 判定里，对/错各多少 ---------- */
  console.log('\n=== 瑕疵维度：误判率（只统计你亲手表过态的判定，没动过的图不算认可）===')
  console.log('维度             表态事件   判对   判错   错判率   判错图数   判错时的置信度档  <0.7 / 0.7~0.9 / >=0.9')
  const wrongHard = []
  for (const dim of AUDIT_DIMS) {
    const ev = corr.filter((c) => c.dim === dim)
    if (!ev.length) { console.log(`${(cn(dim) + ' ' + dim).padEnd(15)} 无表态记录`); continue }
    const right = ev.filter((c) => isRight(c.action))
    const wrong = ev.filter((c) => isWrong(c.action))
    const rate = (wrong.length / ev.length) * 100
    const b1 = wrong.filter((c) => c.conf < 0.7).length
    const b2 = wrong.filter((c) => c.conf >= 0.7 && c.conf < 0.9).length
    const b3 = wrong.filter((c) => c.conf >= 0.9).length
    console.log(
      `${(cn(dim) + ' ' + dim).padEnd(15)} ${String(ev.length).padStart(6)} ${String(right.length).padStart(6)} ${String(wrong.length).padStart(6)} ${rate.toFixed(1).padStart(7)}% ${String(new Set(wrong.map((c) => c.imgId)).size).padStart(8)} ${String(b1).padStart(15)} / ${b2} / ${b3}`
    )
    for (const c of wrong) if (c.conf >= 0.9) wrongHard.push({ ...c, dim })
  }

  /* ---------- 2. 漏打：你手动补标、AI 没报的 ---------- */
  const missed = corr.filter((c) => !c.dim)
  console.log(`\n=== 漏打（orig_dim 为空 = 你手动补了 AI 没报的问题）共 ${missed.length} 条 ===`)
  const missByCat = {}
  for (const c of missed) missByCat[c.toCat] = (missByCat[c.toCat] || 0) + 1
  for (const [k, n] of Object.entries(missByCat).sort((a, b) => b[1] - a[1])) console.log(`  你把它归为 ${cn(k).padEnd(8)} ${String(n).padStart(5)} 条`)
  const manualTags = {}
  for (const r of imgs.values()) {
    for (const [d, t] of Object.entries(r.tags)) if (t && t.method === 'user') manualTags[d] = (manualTags[d] || 0) + 1
  }
  console.log('  库里现存你手动加的标签（按维度）：')
  for (const [d, n] of Object.entries(manualTags).sort((a, b) => b[1] - a[1])) console.log(`    ${cn(d).padEnd(10)} ${String(n).padStart(4)} 张`)

  /* ---------- 3. 抽查清单：高置信还被你否定的那批（最像"乱打标签"） ---------- */
  wrongHard.sort((a, b) => b.conf - a.conf)
  console.log(`\n=== 抽查：AI 置信度 >=0.9 却被你判不成立，共 ${wrongHard.length} 条（列前 15，可直接搜文件名核对）===`)
  const seen = new Set()
  for (const c of wrongHard) {
    if (seen.size >= 15) break
    const key = `${c.imgId}:${c.dim}`
    if (seen.has(key)) continue // 同一张同一维度被反复表态过，只列一次
    seen.add(key)
    const r = imgs.get(c.imgId)
    if (!r) continue
    const now = r.tags[c.dim]
    const nowText = now ? `${now.level}/${(now.confidence ?? 0).toFixed(2)}/${now.method}` : '标签已删除'
    console.log(`  ${String(r.file).padEnd(24)} ${cn(c.dim).padEnd(5)} 当时置信 ${(c.conf ?? 0).toFixed(3)} → 你归为 ${cn(c.toCat).padEnd(5)}｜现在库里 ${nowText}`)
  }

  /* ---------- 4. 人数分类的表态 ---------- */
  const pev = corr.filter((c) => c.dim && PERSON_DIMS.includes(c.dim))
  console.log(`\n=== 人数分类表态：${pev.length} 条 ===`)
  for (const d of PERSON_DIMS) {
    const e = pev.filter((c) => c.dim === d)
    if (!e.length) continue
    const w = e.filter((c) => isWrong(c.action)).length
    const where = [...new Set(e.map((c) => cn(c.toCat)))].join('、')
    console.log(`  ${cn(d).padEnd(6)} ${String(e.length).padStart(4)} 条表态，其中你判错 ${String(w).padStart(4)} 条 → 事后归到：${where}`)
  }

  db.close()
  console.log('\n以上是【库里现有 AI 标签】这张答卷的成绩。重筛 = 让当前引擎在同一批真值上再考一次，跑完重跑本脚本就有前后对比。')
})()
