/**
 * 检测代次核查（开发者离线用，不进包）· 纯 ASCII 源码版
 * 为什么纯 ASCII：PowerShell 5.1 的控制台会把 node 的 UTF-8 输出按 GBK 解码，
 * 里头的中文字面量与正则一旦落进源码就会花屏，正则还会直接匹配不上。
 *
 * 疑点：交付库候选里有一批图完全没有 blur 标签，而现版引擎（engine/__init__.py 94 行）
 *       是无条件输出 blur/exposure/black_white/half_head 的。查清这批图是谁、哪一轮扫的，
 *       决定“重筛能不能补上这个测量”。
 * 用法：node scripts/scan-vintage.js
 */
const fs = require('fs')
const path = require('path')

const L = {
  hasBlur: '\u6709 blur \u6807\u7b7e',
  noBlur: '\u7f3a blur \u6807\u7b7e',
  noExp: '\u7f3a exposure \u6807\u7b7e',
  noHalf: '\u7f3a half_head \u6807\u7b7e',
  noEyes: '\u7f3a eyes_closed \u6807\u7b7e',
  engine: '\u5f15\u64ce',
  ext: '\u6269\u5c55\u540d',
  dims: '\u6807\u7b7e\u4e2a\u6570\u5206\u5e03',
  total: '\u5171',
  hourHead: '=== \u6309\u68c0\u6d4b\u5c0f\u65f6\uff08UTC\uff09\u4ea4\u53c9\uff1a\u7f3a blur vs \u6709 blur ===',
  dirHead: '=== \u6309\u76ee\u5f55 ===',
  dayHead: '\u68c0\u6d4b\u65e5\u671f\u603b\u4f53\u5206\u5e03\uff1a'
}

;(async () => {
  const dbPath = path.join(process.env.APPDATA || '', 'screener-master', 'data', 'screener.db')
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs()
  const db = new SQL.Database(fs.readFileSync(dbPath))
  const res = db.exec("SELECT filename, path, tags, details, scanned_at FROM images WHERE status = 'done'")
  const rows = (res[0]?.values || []).map((v) => ({
    file: v[0],
    path: v[1],
    tags: (() => { try { return JSON.parse(v[2] || '{}') } catch { return {} } })(),
    det: (() => { try { return JSON.parse(v[3] || '{}') } catch { return {} } })(),
    ts: Number(v[4])
  }))
  const fmt = (ts, len) => (ts ? new Date(ts > 1e11 ? ts : ts * 1000).toISOString().slice(0, len || 10) : 'null')
  const f = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k}:${c}`).join('  ')

  console.log(`done \u56fe ${rows.length} \u5f20`)
  for (const key of ['blur', 'exposure', 'half_head', 'eyes_closed', 'face_ugly']) {
    const has = rows.filter((r) => r.tags[key])
    const missing = rows.filter((r) => !r.tags[key])
    const byDay = (arr) => {
      const m = {}
      for (const r of arr) m[fmt(r.ts)] = (m[fmt(r.ts)] || 0) + 1
      return f(m)
    }
    console.log(`[${key.padEnd(11)}] \u6709 ${has.length} / \u65e0 ${missing.length} | \u65e0\u7684\u68c0\u6d4b\u65e5\uff1a${byDay(missing)}`)
  }

  console.log(`\n${L.dayHead}`)
  const all = {}
  for (const r of rows) all[fmt(r.ts)] = (all[fmt(r.ts)] || 0) + 1
  console.log('  ' + f(all))

  const tab = (label, pred) => {
    const hit = rows.filter(pred)
    const byEngine = {}, byExt = {}, dimCount = {}
    for (const r of hit) {
      byEngine[r.det?.engine || 'null'] = (byEngine[r.det?.engine || 'null'] || 0) + 1
      const ext = String(r.file).split('.').pop().toLowerCase()
      byExt[ext] = (byExt[ext] || 0) + 1
      const n = Object.keys(r.tags).length
      dimCount[n] = (dimCount[n] || 0) + 1
    }
    console.log(`\n${label} ${L.total} ${hit.length}`)
    console.log(`  ${L.engine}\uff1a${f(byEngine)}`)
    console.log(`  ${L.ext}\uff1a${f(byExt)}`)
    console.log(`  ${L.dims}\uff1a${f(dimCount)}`)
  }
  tab(L.noBlur, (r) => !r.tags.blur)
  tab(L.hasBlur, (r) => !!r.tags.blur)
  tab(L.noExp, (r) => !r.tags.exposure)
  tab(L.noHalf, (r) => !r.tags.half_head)
  tab(L.noEyes, (r) => !r.tags.eyes_closed)

  // 按检测小时交叉：若缺 blur 的图集中在某个时间段，说明那一轮跑的是旧引擎二进制（重筛能补上）
  console.log(`\n${L.hourHead}`)
  const hourTab = (pred) => {
    const m = {}
    for (const r of rows.filter(pred)) m[fmt(r.ts, 13)] = (m[fmt(r.ts, 13)] || 0) + 1
    return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0])).map(([k, c]) => `${k.slice(11)}\u65f6:${c}`).join('  ')
  }
  console.log(`  \u7f3a blur\uff1a${hourTab((r) => !r.tags.blur)}`)
  console.log(`  \u6709 blur\uff1a${hourTab((r) => !!r.tags.blur)}`)

  console.log(`\n${L.dirHead}`)
  const dirTab = (pred) => {
    const m = {}
    for (const r of rows.filter(pred)) {
      const d = String(r.path).replace(/[\\/][^\\/]*$/, '')
      m[d] = (m[d] || 0) + 1
    }
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, c]) => `${k}(${c})`).join(' | ')
  }
  console.log(`  \u7f3a blur\uff1a${dirTab((r) => !r.tags.blur)}`)
  console.log(`  \u6709 blur\uff1a${dirTab((r) => !!r.tags.blur)}`)

  // 标签个数最少（≤2）的图到底长什么样：如果它们连 blur 都没有，
  // 而引擎是无条件输出 blur 的，那只能是“这批走的不是同一条入库路径”
  const poor = rows.filter((r) => Object.keys(r.tags).length <= 2).slice(0, 6)
  console.log('\n=== \u6807\u7b7e\u6781\u5c11\u7684\u6837\u672c\uff08\u22642 \u4e2a\uff09===')
  for (const r of poor) {
    console.log(`  ${String(r.file).padEnd(22)} tags=${JSON.stringify(r.tags)}`)
    console.log(`    details=${JSON.stringify(r.det).slice(0, 200)}`)
  }
  // 按“标签个数”总体分布，看尾部有多大
  const hist = {}
  for (const r of rows) { const n = Object.keys(r.tags).length; hist[n] = (hist[n] || 0) + 1 }
  console.log(`\n=== \u5168\u5e93\u6807\u7b7e\u4e2a\u6570\u5206\u5e03 ===\n  ${Object.entries(hist).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, c]) => `${k}\u4e2a:${c}`).join('  ')}`)
  db.close()
})()
