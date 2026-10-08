/** 数据库状态摘要 */
const initSqlJs = require('sql.js')
const fs = require('fs')
const path = require('path')
initSqlJs().then((SQL) => {
  const f = path.join(process.env.APPDATA, 'ai-photo-screener/data/screener.db')
  if (!fs.existsSync(f)) return console.log('no db')
  const db = new SQL.Database(fs.readFileSync(f))
  const q = (sql) => { const r = db.exec(sql); return r[0] ? r[0].values : [] }
  console.log('by status:', JSON.stringify(q('SELECT status, COUNT(*) FROM images GROUP BY status')))
  console.log('by category(top):', JSON.stringify(q('SELECT category, COUNT(*) FROM images GROUP BY category ORDER BY 2 DESC LIMIT 15')))
  console.log('corrections:', JSON.stringify(q('SELECT COUNT(*) FROM corrections')))
  console.log('dirs:', JSON.stringify(q('SELECT dir, COUNT(*) FROM images GROUP BY dir ORDER BY 2 DESC LIMIT 5')))
})
