/**
 * 重启后现状核对（只读，不动库）
 * 用 app/src/shared/types.ts 同一套口径，把库里真实数据按侧栏上段四档互斥分类，
 * 并检查交付库里是否还残留"高置信闭眼/半截头"的张。
 * 用法：node scripts/dup-v4-live.js
 */
const fs = require('fs')
const path = require('path')

const TRASH = ['trash', 'dup_trash']
const REVIEW = 'review'
const BAD = ['eyes_closed', 'half_head', 'face_ugly', 'blur', 'exposure']

const lv = (tags, d) => {
  const t = tags && tags[d]
  if (!t || !t.level || t.level === 'low') return null
  return t.level
}
const flawLevel = (tags) => {
  let high = false
  let mid = false
  for (const d of BAD) {
    const l = lv(tags, d)
    if (!l) continue
    if (l === 'high') high = true
    else if (l === 'mid') mid = true
  }
  return high ? 'high' : mid ? 'mid' : 'none'
}
const isDupRedundant = (tags) => !!lv(tags, 'duplicate')

;(async () => {
  const dbPath = path.join(process.env.APPDATA || '', 'screener-master', 'data', 'screener.db')
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs()
  const db = new SQL.Database(fs.readFileSync(dbPath))
  const r = db.exec("SELECT filename, tags, category FROM images WHERE status != 'skip'")
  const rows = r.length ? r[0].values : []
  let library = 0
  let flaws = 0
  let redundant = 0
  let review = 0
  let trash = 0
  let libFatal = 0
  let fatalTotal = 0
  let fatalInFlaws = 0
  const libFatalList = []
  for (const [filename, tagsRaw, cat] of rows) {
    let tags = {}
    try {
      tags = JSON.parse(tagsRaw || '{}')
    } catch {
      /* ignore */
    }
    if (TRASH.includes(cat)) {
      trash++
      continue
    }
    const fl = flawLevel(tags)
    const fatal = lv(tags, 'eyes_closed') === 'high' || lv(tags, 'half_head') === 'high'
    if (fatal) fatalTotal++
    if (fl === 'high') {
      flaws++
      if (fatal) fatalInFlaws++
    } else if (isDupRedundant(tags)) redundant++
    else if (cat === REVIEW || fl === 'mid') review++
    else library++
    // 交付库（= 会被导出的那些）里不该有一张高置信闭眼/半截头，有就是漏拦
    if (fl === 'none' && !isDupRedundant(tags) && cat !== REVIEW && !TRASH.includes(cat) && fatal) {
      libFatal++
      if (libFatalList.length < 10) libFatalList.push(filename)
    }
  }
  const sum = library + flaws + redundant + review
  console.log('====== 库里现状（重启后实测）======')
  console.log(`总张数（不含 skip）：${rows.length}`)
  console.log(`废弃桶 ${trash} / 交付库 ${library} / 瑕疵片 ${flaws} / 重复多余 ${redundant} / 待确认 ${review}`)
  console.log(`上段四档求和：${sum}    非废弃桶总数：${rows.length - trash}    ${sum === rows.length - trash ? '对齐 √' : '不对齐 ×'}`)
  console.log(`高置信闭眼/半截头共 ${fatalTotal} 张，其中被拦在瑕疵片 ${fatalInFlaws} 张，漏进交付库 ${libFatal} 张`, libFatalList.join(', '))
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
