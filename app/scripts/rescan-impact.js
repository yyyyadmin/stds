/**
 * 重筛影响预演（开发者离线用，只读，不进包）
 * 问题：档位换成"锐度实测"后，有 543 张干净图压根没有模糊标签（放行时被删掉了），
 *       它们现在一律兜底成"良好"。要拿到实测只能重跑引擎——那会付出什么代价？
 * 口径：完全照 db.categoryCounts 的优先级（废弃库 > 瑕疵片 > 待确认 > 交付库）
 *       与 db.resetForRescan 的三条边界（user 废弃库跳过 / user 归属只重测不动归属）
 * 用法：node scripts/rescan-impact.js
 */
const fs = require('fs')
const path = require('path')

const BAD_DIMS = ['eyes_closed', 'face_ugly', 'blur', 'exposure', 'half_head', 'duplicate']
const TRASH_LIKE = ['trash', 'dup_trash']
// 与 classify.ts 同口径的中文正则走转义，裸中文过 PowerShell 会失配
const RE_SHARP = new RegExp('\u6e05\u6670\u5ea6\u65b9\u5dee' + '\\s*(-?\\d+(?:\\.\\d+)?)\\((full|face)\\)\\s*' + '\u9ad8\u9891\u5360\u6bd4' + '\\s*(-?\\d+(?:\\.\\d+)?)')
const SHARP_ANCHORS = {
  face: { varLo: 27, varHi: 1073, hfLo: 0.49, hfHi: 0.71 },
  full: { varLo: 34, varHi: 634, hfLo: 0.467, hfHi: 0.683 }
}
const SHARP_VAR_WEIGHT = 0.65
const TIER_TRUST = 0.7, TIER_OK = 0.43
const clamp01 = (x) => Math.min(1, Math.max(0, x))

function sharpScore(tags) {
  const m = (tags.blur?.reason || '').match(RE_SHARP)
  if (!m) return null
  const a = SHARP_ANCHORS[m[2]] || SHARP_ANCHORS.face
  const v = Math.max(1, Number(m[1]))
  const lv = (Math.log10(v) - Math.log10(a.varLo)) / (Math.log10(a.varHi) - Math.log10(a.varLo))
  const lh = (Number(m[3]) - a.hfLo) / (a.hfHi - a.hfLo)
  return SHARP_VAR_WEIGHT * clamp01(lv) + (1 - SHARP_VAR_WEIGHT) * clamp01(lh)
}
const tierOf = (tags) => { const s = sharpScore(tags); return s === null ? null : s >= TIER_TRUST ? 1 : s >= TIER_OK ? 2 : 3 }
const TIER_NAME = { 1: 'youzhi', 2: 'lianghao', 3: 'yiban' }

;(async () => {
  const dbPath = path.join(process.env.APPDATA || '', 'screener-master', 'data', 'screener.db')
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs()
  const db = new SQL.Database(fs.readFileSync(dbPath))
  const res = db.exec('SELECT filename, category, category_by, tier, tags, status FROM images')
  const rows = (res[0]?.values || []).map((v) => ({
    file: v[0], cat: v[1], catBy: v[2], tier: v[3],
    tags: (() => { try { return JSON.parse(v[4] || '{}') } catch { return {} } })(),
    status: v[5]
  }))
  db.close()

  const flawLevel = (tags) => {
    const lv = BAD_DIMS.map((d) => tags[d]?.level).filter(Boolean)
    return lv.includes('high') ? 'high' : lv.includes('mid') ? 'mid' : 'none'
  }
  const inLib = rows.filter((r) => r.status === 'done' && !TRASH_LIKE.includes(r.cat) && flawLevel(r.tags) === 'none' && r.cat !== 'review')

  // 1) 交付库里能不能测出锐度
  const measured = inLib.filter((r) => sharpScore(r.tags) !== null)
  const missing = inLib.filter((r) => sharpScore(r.tags) === null)
  console.log(`交付库（干净图）共 ${inLib.length} 张`)
  console.log(`  有锐度实测 ${measured.length} 张 / 没实测（放行时被删了）${missing.length} 张`)

  // 2) 没实测那批的归属来源：决定重筛会不会动它们
  const byUser = missing.filter((r) => r.catBy === 'user').length
  console.log(`  没实测那批里 category_by='user'（重筛只重测、不改归属）：${byUser} 张`)
  console.log(`  没实测那批里归属仍由 AI 持有（重筛可能把它们判回瑕疵片）：${missing.length - byUser} 张`)

  // 3) 用有实测那批的三档比例，外推没实测那批重筛后会落哪
  const sim = { 1: 0, 2: 0, 3: 0 }
  for (const r of measured) sim[tierOf(r.tags)]++
  console.log('\n=== 有实测这批，新算法的三档（可直接重算拿到）===')
  for (const k of [1, 2, 3]) {
    const pct = measured.length ? ((sim[k] / measured.length) * 100).toFixed(1) : '0'
    console.log(`  ${TIER_NAME[k]}  ${String(sim[k]).padStart(4)} 张  (${pct}%)`)
  }
  console.log(`\n=== 没实测那批，若重筛后与上面同分布，预计落点（外推，仅供参考）===`)
  for (const k of [1, 2, 3]) {
    const share = measured.length ? sim[k] / measured.length : 0
    console.log(`  ${TIER_NAME[k]}  ~${Math.round(missing.length * share)} 张`)
  }

  // 4) 重筛会不会把"干净图"打成瑕疵片：拿全库可测样本的 blur high 命中率外推
  const doneNonTrash = rows.filter((r) => r.status === 'done' && !TRASH_LIKE.includes(r.cat))
  const withBlur = doneNonTrash.filter((r) => r.tags.blur)
  const blurHigh = withBlur.filter((r) => r.tags.blur.level === 'high').length
  const blurMid = withBlur.filter((r) => r.tags.blur.level === 'mid').length
  console.log('\n=== 重筛的代价：模糊维度会不会把交付库的图打回瑕疵片 ===')
  console.log(`  非废弃库且测过模糊的图 ${withBlur.length} 张：high ${blurHigh} (${((blurHigh / (withBlur.length || 1)) * 100).toFixed(1)}%) / mid ${blurMid} (${((blurMid / (withBlur.length || 1)) * 100).toFixed(1)}%)`)
  console.log(`  按这个命中率外推 ${missing.length} 张无实测图：预计约 ${Math.round(missing.length * blurHigh / (withBlur.length || 1))} 张会被重新判为模糊瑕疵、${Math.round(missing.length * blurMid / (withBlur.length || 1))} 张进待确认`)

  // 5) 其他维度顺带复活的数量（这些也是放行时删掉的）
  for (const dim of ['eyes_closed', 'exposure', 'half_head', 'face_ugly']) {
    const n = inLib.filter((r) => !r.tags[dim]).length
    console.log(`  交付库里缺 ${dim} 标签：${n} 张（重筛会一并补回来）`)
  }

  // 6) 现在库里存的旧档 vs 新档，看"改了多少行"
  let changed = 0, keep = 0
  const move = { '1>2': 0, '1>3': 0, '2>1': 0, '3>1': 0, 'x>1': 0, 'x>2': 0, 'x>3': 0 }
  for (const r of inLib) {
    const nt = tierOf(r.tags) ?? 2
    if (nt === r.tier) keep++; else changed++
    if (nt === r.tier) continue
    const key = `${r.tier ?? 'x'}>${nt}`
    if (key in move) move[key]++
  }
  console.log('\n=== 只改算法、不重跑引擎（regrade v3）会动多少 ===')
  console.log(`  保持 ${keep} 张 / 改档 ${changed} 张`)
  console.log(`  优质→良好 ${move['1>2']} 张，优质→一般 ${move['1>3']} 张（这就是原来 95% 挤在优质的那批被摊开）`)
})()
