/**
 * 甲方案影响面（只读）：把 duplicate 从"瑕疵维度"里摘出去之后，交付库会多几张、谁多出来
 *
 * 现状：duplicate 属于 BAD_DIMENSIONS，命中即算瑕疵 → 组内除最早那张外全被拦在交付之外。
 * 甲：duplicate 只作分组组织，不再拦交付。冗余帧由你在重复分组视图里手动清（你实际只丢了 74 张）。
 *
 * 用法：node scripts/dup-unblock-impact.js
 */
const fs = require('fs')
const path = require('path')

const BAD_WITH = ['eyes_closed', 'half_head', 'face_ugly', 'blur', 'exposure', 'duplicate']
const BAD_WITHOUT = BAD_WITH.filter((d) => d !== 'duplicate')
const CAT_TRASH = 'trash'
const CAT_DUP_TRASH = 'dup_trash'
const CAT_REVIEW = 'review'
const CAT_FLAWS = 'flaws'

;(async () => {
  const dbPath = path.join(process.env.APPDATA || '', 'screener-master', 'data', 'screener.db')
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs()
  const db = new SQL.Database(fs.readFileSync(dbPath))
  const q = (s) => {
    const r = db.exec(s)
    return r.length ? r[0].values : []
  }
  const rows = q("SELECT id, filename, category, category_by, tags, details FROM images WHERE status = 'done'")

  const levelOf = (tags, list) => {
    let high = false
    let mid = false
    for (const d of list) {
      const t = tags[d]
      if (!t || t.level === 'low') continue
      if (t.level === 'high') high = true
      else mid = true
    }
    return high ? 'high' : mid ? 'mid' : 'none'
  }
  const deliverable = (cat, tags, list) => {
    if (cat === CAT_TRASH || cat === CAT_DUP_TRASH || cat === CAT_REVIEW) return false
    if (list.includes(cat)) return false
    return levelOf(tags, list) === 'none'
  }

  const corr = q("SELECT orig_dim, action, new_category, image_id FROM corrections")
  const rejIds = new Set(corr.filter((r) => r[0] === 'duplicate' && r[1] === 'wrong').map((r) => r[3]))

  let now = 0
  let after = 0
  const gained = []
  for (const [id, filename, cat, catBy, tagsRaw, detailsRaw] of rows) {
    let tags = {}
    try {
      tags = JSON.parse(tagsRaw || '{}')
    } catch {
      /* ignore */
    }
    const a = deliverable(cat, tags, BAD_WITH)
    const b = deliverable(cat, tags, BAD_WITHOUT)
    if (a) now++
    if (b) after++
    if (!a && b) {
      const dupTag = tags.duplicate || {}
      gained.push({
        id,
        filename,
        cat,
        catBy,
        lvl: dupTag.level || '-',
        conf: dupTag.confidence == null ? null : dupTag.confidence,
        rejected: rejIds.has(id)
      })
    }
  }
  console.log('当前交付库（含 duplicate 拦）：' + now + ' 张')
  console.log('摘掉 duplicate 拦之后      ：' + after + ' 张')
  const pct = ((gained.length / Math.max(1, now)) * 100).toFixed(1)
  console.log('净多出来                   ：' + gained.length + ' 张（+' + pct + '%）')
  console.log('  其中你明确否定过 AI 重复判定的：' + gained.filter((g) => g.rejected).length + ' 张（这些本该放回去）')
  console.log('  其中你人工动过归属的        ：' + gained.filter((g) => g.catBy === 'user').length + ' 张')
  console.log('  高置信 duplicate 拦住的      ：' + gained.filter((g) => g.lvl === 'high').length + ' 张')
  console.log('  中置信 duplicate 拦住的      ：' + gained.filter((g) => g.lvl === 'mid').length + ' 张')
  const byCat = {}
  for (const g of gained) byCat[g.cat] = (byCat[g.cat] || 0) + 1
  console.log('  放回前它们落在：' + JSON.stringify(byCat))
  console.log('\n前 10 个例子：')
  for (const g of gained.slice(0, 10)) console.log('  ' + g.filename + ' [' + g.cat + (g.catBy === 'user' ? '/人工' : '') + '] duplicate=' + g.lvl + ' conf=' + (g.conf == null ? '-' : g.conf) + (g.rejected ? ' ←你否定过' : ''))
})().catch((e) => {
  console.error('FAILED', e)
  process.exit(1)
})
