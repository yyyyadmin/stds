/** 只读检查应用数据库当前状态 */
const initSqlJs = require('sql.js')
const fs = require('fs')
const path = require('path')
initSqlJs().then((SQL) => {
  const db = new SQL.Database(fs.readFileSync(path.join(process.env.APPDATA, 'ai-photo-screener/data/screener.db')))
  const r = db.exec('SELECT filename,category,status,tags,details FROM images ORDER BY id')
  for (const row of r[0].values) {
    const tags = JSON.parse(row[3] || '{}')
    const det = row[4] ? JSON.parse(row[4]) : {}
    const t = Object.entries(tags).map(([d, v]) => `${d}:${(v.confidence * 100).toFixed(0)}/${v.level}`).join(' ')
    console.log(`${String(row[0]).padEnd(18)} cat=${String(row[1]).padEnd(12)} st=${String(row[2]).padEnd(7)} ${t} | phash=${String(det.phash || '').slice(0, 12)} dup=${det.dupGroup || '-'}`)
  }
  const c = db.exec("SELECT COUNT(*) FROM corrections")
  console.log('corrections:', c[0].values[0][0])
})
