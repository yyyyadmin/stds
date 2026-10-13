/**
 * 姿态门试点：挑出必须重测的图（只读库，产出一个 JSON 清单给 Python 引擎跑）
 *
 * 集合 = 你在 duplicate 维度表过态的 45 张（否定 24 / 手动补 12 / 认可 9）
 *        + 它们各自所在重复组的成员（作为对照伙伴）
 * 输出 app/scripts/_pilot_list.json：[{id, filename, path, label}]
 *   label: rej(你否定过) / add(你补打过) / ok(你认可过) / ctx(同组对照，未表态)
 *
 * 用法：node scripts/dup-pilot-list.js
 */
const fs = require('fs')
const path = require('path')

;(async () => {
  const dbPath = path.join(process.env.APPDATA || '', 'screener-master', 'data', 'screener.db')
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs()
  const db = new SQL.Database(fs.readFileSync(dbPath))
  const q = (s) => {
    const r = db.exec(s)
    return r.length ? r[0].values : []
  }

  const labelOf = new Map()
  for (const [id] of q("SELECT DISTINCT image_id FROM corrections WHERE orig_dim='duplicate' AND action='wrong'")) labelOf.set(id, 'rej')
  for (const [id] of q("SELECT DISTINCT image_id FROM corrections WHERE orig_dim IS NULL AND new_category='duplicate'")) if (!labelOf.has(id)) labelOf.set(id, 'add')
  for (const [id] of q("SELECT DISTINCT image_id FROM corrections WHERE orig_dim='duplicate' AND action='correct'")) if (!labelOf.has(id)) labelOf.set(id, 'ok')
  console.log('表态图：rej ' + [...labelOf.values()].filter((v) => v === 'rej').length + ' · add ' + [...labelOf.values()].filter((v) => v === 'add').length + ' · ok ' + [...labelOf.values()].filter((v) => v === 'ok').length)

  const rows = q("SELECT id, filename, path, details FROM images WHERE status = 'done'")
  const info = new Map()
  for (const [id, filename, p, details] of rows) {
    let d = {}
    try {
      d = JSON.parse(details || '{}')
    } catch {
      /* ignore */
    }
    info.set(id, { id, filename, path: p, group: d.dupGroup == null ? null : d.dupGroup, hash: d.phash || null })
  }

  // 同组对照
  const wanted = new Map(labelOf)
  let added = 0
  for (const id of [...labelOf.keys()]) {
    const it = info.get(id)
    if (!it || it.group == null) continue
    for (const [oid, o] of info) {
      if (o.group === it.group && !wanted.has(oid)) {
        wanted.set(oid, 'ctx')
        added++
      }
    }
  }
  console.log('同组对照 +' + added + ' 张 → 试点总数 ' + wanted.size + ' 张')

  const out = []
  const missing = []
  for (const [id, label] of wanted) {
    const it = info.get(id)
    if (!it) {
      missing.push(id)
      continue
    }
    const abs = path.resolve(it.path)
    if (!fs.existsSync(abs)) {
      missing.push(it.filename)
      continue
    }
    out.push({ id, filename: it.filename, path: abs, label, group: it.group, phash: it.hash })
  }
  console.log('可读到文件的 ' + out.length + ' 张 · 文件缺失/路径不通 ' + missing.length + (missing.length ? '（' + missing.slice(0, 6).join(', ') + '）' : ''))

  const byLabel = {}
  for (const o of out) byLabel[o.label] = (byLabel[o.label] || 0) + 1
  console.log('清单构成：' + JSON.stringify(byLabel))
  fs.writeFileSync(path.join(__dirname, '_pilot_list.json'), JSON.stringify(out), 'utf8')
  console.log('写出 app/scripts/_pilot_list.json')
})().catch((e) => {
  console.error('FAILED', e)
  process.exit(1)
})
