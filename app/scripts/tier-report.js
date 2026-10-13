/**
 * 交付库档位分布核查（开发者离线用，不进包）
 * 问题：瑕疵片 + 待确认 拦下之后，剩下的图落在哪个视图？AI 有没有给它们分优质/良好/一般？
 * 口径：完全照 db.categoryCounts 的优先级（废弃库 > 瑕疵片 > 待确认 > 交付库）
 * 用法：node scripts/tier-report.js
 */
const fs = require('fs')
const path = require('path')

const BAD_DIMS = ['eyes_closed', 'face_ugly', 'blur', 'exposure', 'half_head', 'duplicate']
const TRASH_LIKE = ['trash', 'dup_trash']
// 与 shared/types.ts BASELINE_THRESHOLDS / FACT_DIMENSIONS 保持一致
const BASELINE = { eyes_closed: [0.7, 0.95], face_ugly: [0.7, 0.82], blur: [0.6, 0.88], exposure: [0.55, 0.8], half_head: [0.7, 0.9] }
const FACT = ['single_person', 'group_photo', 'mixed_photo', 'no_person', 'black_white', 'duplicate']
const DM = 0.55, DH = 0.8
// 档位 v2（与 classify.scoreTier 同步）：用 blur 的 reason 原始实测锐度分，不用“离瑕疵线多远”
// 中文字面量走转义：这份输出过 PowerShell 管道会被 GBK 控制台二次解码，裸中文正则会匹配不上
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
/** scoreTier v2 同款：锐度实测分 */
function tierOf(tags) {
  const s = sharpScore(tags)
  if (s === null) return 2
  return s >= TIER_TRUST ? 1 : s >= TIER_OK ? 2 : 3
}

/** 力度平移后的阈值（与 classify.effectiveThresholds 同口径）：人工档位那节算余量用 */
function thr(dim, mid, high) {
  if (FACT.includes(dim)) return [DM, DH]
  const b = BASELINE[dim]
  if (!b) return [mid, high]
  const d = ((mid - DM) + (high - DH)) / 2
  let h = Math.min(0.99, Math.max(0.5, b[1] + d))
  let m = Math.min(h - 0.05, Math.min(0.95, Math.max(0.3, b[0] + d)))
  return [Number(m.toFixed(3)), Number(h.toFixed(3))]
}

;(async () => {
  const dbPath = path.join(process.env.APPDATA || '', 'screener-master', 'data', 'screener.db')
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs()
  const db = new SQL.Database(fs.readFileSync(dbPath))
  const st = Object.fromEntries((db.exec('SELECT key, value FROM settings')[0]?.values || []))
  const mid = Number(st.midThreshold ?? 0.55), high = Number(st.highThreshold ?? 0.8)
  const res = db.exec("SELECT filename, category, category_by, tier, tier_by, tags, status FROM images")
  const rows = (res[0]?.values || []).map((v) => ({ file: v[0], cat: v[1], catBy: v[2], tier: v[3], tierBy: v[4], tags: (() => { try { return JSON.parse(v[5] || '{}') } catch { return {} } })(), status: v[6] }))
  console.log(`当前设置 mid=${mid} high=${high} · 库内共 ${rows.length} 行（含未检测完的）`)
  if (fs.existsSync(dbPath + '-wal')) console.log('⚠ 应用正在运行，WAL 里的最新改动可能还没进主文件，数字与侧栏徽章可能有小差异。')

  const buckets = { 废片: 0, 瑕疵片: 0, 待确认: 0, 交付库: 0, 未检测完: 0 }
  const libTier = { 1: 0, 2: 0, 3: 0, 空: 0 }
  const libTierBy = { ai: 0, user: 0, 无: 0 }
  const catBreak = {}
  for (const r of rows) {
    if (r.status !== 'done') { buckets['未检测完']++; continue }
    catBreak[r.cat] = (catBreak[r.cat] || 0) + 1
    const levels = BAD_DIMS.map((d) => r.tags[d]?.level).filter(Boolean)
    const fl = levels.includes('high') ? 'high' : levels.includes('mid') ? 'mid' : 'none'
    if (TRASH_LIKE.includes(r.cat)) buckets['废片']++
    else if (fl === 'high') buckets['瑕疵片']++
    else if (r.cat === 'review' || fl === 'mid') buckets['待确认']++
    else {
      buckets['交付库']++
      if (r.tier === 1 || r.tier === 2 || r.tier === 3) libTier[r.tier]++
      else libTier['空']++
      libTierBy[r.tierBy === 'user' ? 'user' : r.tierBy === 'ai' ? 'ai' : '无']++
    }
  }
  console.log('\n=== 侧栏四档实际归属（优先级 废片 > 瑕疵片 > 待确认 > 交付库）===')
  for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(6)} ${v} 张`)
  console.log('\n=== 落在交付库那些图的 AI 档位（v2：锐度实测）===')
  console.log(`  1 优质（锐度分 ≥${TIER_TRUST}）  ${libTier[1]} 张`)
  console.log(`  2 良好（≥${TIER_OK}，含无实测）    ${libTier[2]} 张`)
  console.log(`  3 一般（偏软 <${TIER_OK}）          ${libTier[3]} 张`)
  console.log(`  tier 为空（还没算过）                     ${libTier['空']} 张`)
  console.log(`  档位来源：AI ${libTierBy.ai} 张 / 人工改过 ${libTierBy.user} 张 / 无标记 ${libTierBy['无']} 张`)
  console.log('\n=== 按现在该按新阈值重算的话，档位应是多少（对照 scoreTier）===')
  const simTier = { 1: 0, 2: 0, 3: 0 }
  for (const r of rows) {
    if (r.status !== 'done') continue
    const levels = BAD_DIMS.map((d) => r.tags[d]?.level).filter(Boolean)
    const fl = levels.includes('high') ? 'high' : levels.includes('mid') ? 'mid' : 'none'
    if (TRASH_LIKE.includes(r.cat) || fl !== 'none' || r.cat === 'review') continue
    simTier[tierOf(r.tags)]++
  }
  console.log(`  优质 ${simTier[1]} / 良好 ${simTier[2]} / 一般 ${simTier[3]}（合计 ${simTier[1] + simTier[2] + simTier[3]} 张）`)

  // 再拆一层：瑕疵片里有多少其实只是“重复/连拍冗余”，多少是真的画质问题
  let dupOnly = 0, qualityHi = 0, bothHi = 0
  let dupMid = 0, qualityMid = 0
  for (const r of rows) {
    if (r.status !== 'done' || TRASH_LIKE.includes(r.cat)) continue
    const highs = BAD_DIMS.filter((d) => r.tags[d]?.level === 'high')
    const mids = BAD_DIMS.filter((d) => r.tags[d]?.level === 'mid')
    if (highs.length) {
      const hasDup = highs.includes('duplicate')
      const hasQuality = highs.some((d) => d !== 'duplicate')
      if (hasDup && hasQuality) bothHi++
      else if (hasDup) dupOnly++
      else qualityHi++
    } else if (mids.length) {
      if (mids.includes('duplicate')) dupMid++
      else qualityMid++
    }
  }
  console.log('\n=== 瑕疵片（AI 判 high）到底是什么问题 ===')
  console.log(`  只有重复/连拍冗余    ${dupOnly} 张`)
  console.log(`  重复 + 画质都有        ${bothHi} 张`)
  console.log(`  真的画质问题（闭眼/模糊/曝光/半截头/表情） ${qualityHi} 张`)
  console.log('=== 待确认（只有 mid）===')
  console.log(`  重复可疑 ${dupMid} 张 / 画质可疑 ${qualityMid} 张`)

  // 人工定档的那几行到底是谁：界面里没有“人工”标记，只能从库里查
  const manual = rows.filter((r) => r.tierBy === 'user')
  console.log(`\n=== 人工改过档位的图（共 ${manual.length} 张，重筛/重算都不会覆盖）===`)
  const TIER_NAME = { 1: '优质', 2: '良好', 3: '一般', null: '未定档' }
  for (const r of manual) {
    let nearest = '—', margin = Infinity
    for (const dim of BAD_DIMS) {
      const [bdMid] = thr(dim, mid, high)
      const mg = bdMid - (r.tags[dim]?.confidence ?? 0)
      if (mg < margin) { margin = mg; nearest = dim }
    }
    console.log(`  ${String(r.file).padEnd(34)} 档位=${TIER_NAME[r.tier] ?? r.tier} 主分类=${r.cat}(by=${r.catBy ?? '-'}) 离瑕疵线最近维度=${nearest} 余量=${margin.toFixed(3)}`)
  }

  // 人工复审痕迹：这决定“重新筛选一遍”会保住什么、会拿 AI 判定盖掉什么
  let byUser = 0, byUserNonTrash = 0, byAi = 0, userTagTotal = 0
  let flawFromUser = 0, flawFromAi = 0, libByUser = 0
  for (const r of rows) {
    if (r.status !== 'done') continue
    if (r.catBy === 'user') { byUser++; if (!TRASH_LIKE.includes(r.cat)) byUserNonTrash++ } else byAi++
    const lv = BAD_DIMS.map((d) => r.tags[d]).filter(Boolean)
    if (lv.some((t) => t.method === 'user')) userTagTotal++
    const fl = lv.map((t) => t.level).includes('high') ? 'high' : lv.map((t) => t.level).includes('mid') ? 'mid' : 'none'
    if (!TRASH_LIKE.includes(r.cat)) {
      if (fl === 'high') {
        const userHigh = BAD_DIMS.filter((d) => r.tags[d]?.level === 'high')
        if (userHigh.some((d) => r.tags[d].method === 'user')) flawFromUser++
        else flawFromAi++
      }
      if (fl === 'none' && r.cat !== 'review' && r.catBy === 'user') libByUser++
    }
  }
  const corr = db.exec('SELECT COUNT(*) FROM corrections')[0]?.values[0][0] ?? 0
  console.log('\n=== 人工复审痕迹（“重新筛选”会不会盖掉）===')
  console.log(`  主分类归属由人工放置 category_by='user'：${byUser} 张（其中废弃库内 ${byUser - byUserNonTrash} 张、非废弃库 ${byUserNonTrash} 张）`)
  console.log(`  主分类归属仍由 AI 持有：${byAi} 张`)
  console.log(`  带人工标签（method='user'）的图：${userTagTotal} 张`)
  console.log(`  瑕疵片的 high 标签来源：人工判的 ${flawFromUser} 张 / 纯 AI 判的 ${flawFromAi} 张`)
  console.log(`  交付库里是你手动放进去的：${libByUser} 张`)
  console.log(`  corrections（学习样本）：${corr} 条`)
  db.close()
})()
