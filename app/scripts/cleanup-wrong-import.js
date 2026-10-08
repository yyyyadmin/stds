/** 一次性清理：删除误导入的 E:\下载 图片记录、其悬挂修正记录与缩略图缓存 */
const initSqlJs = require('sql.js')
const fs = require('fs')
const path = require('path')
const DATA = path.join(process.env.APPDATA, 'ai-photo-screener/data')
const DBF = path.join(DATA, 'screener.db')

initSqlJs().then((SQL) => {
  // 先做安全备份（已存在则不覆盖，保留最早快照）
  if (!fs.existsSync(DBF + '.pre-cleanup.bak')) fs.copyFileSync(DBF, DBF + '.pre-cleanup.bak')
  const db = new SQL.Database(fs.readFileSync(DBF))
  // 先列出目录分布，只删 E:\下载 前缀
  const r1 = db.exec('SELECT DISTINCT dir FROM images')
  const dirs = r1.length ? r1[0].values.map((v) => v[0]) : []
  const target = dirs.filter((d) => /^[Ee]:[\\/]+下载/.test(d))
  if (!target.length) return console.log('未找到 E:\\下载 记录，当前目录：', dirs.join(' | '))
  const r2 = db.exec(`SELECT thumb FROM images WHERE dir LIKE 'E:\\\\%' AND thumb IS NOT NULL AND thumb != ''`)
  const thumbs = r2.length ? r2[0].values.map((v) => v[0]) : []
  db.run(`DELETE FROM corrections WHERE image_id NOT IN (SELECT id FROM images)`)
  db.run(`DELETE FROM images WHERE dir LIKE 'E:\\\\%'`)
  const r3 = db.exec('SELECT COUNT(*) FROM images')
  const left = r3.length ? r3[0].values[0][0] : '?'
  fs.writeFileSync(DBF, Buffer.from(db.export()))
  // 删除这批记录的缩略图缓存
  let tn = 0
  for (const t of thumbs) {
    try { if (t && t.startsWith(DATA) && fs.existsSync(t)) { fs.unlinkSync(t); tn++ } } catch { /* ignore */ }
  }
  console.log('已删除目录:', target.join(', '))
  console.log('库内剩余图片记录:', left, '· 清理缩略图缓存:', tn, '个')
  process.exit(0)
})
