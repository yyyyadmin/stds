/**
 * 一致性修剪的安全阀扫描（只读）：只摘"最有把握不是重复"的那部分，看分档效果
 *
 * 每个被踢出组的成员，记一个"踢出强度" kick = 它到幸存组成员的最小汉明距离
 *   kick 只比阈值 X 大一点点（10/11）→ 处于灰区，不确定，保留标签不动归属
 *   kick 很大（14+）→ 确信它跟这组不是一回事，摘标签放开
 * 扫 kick 门限 Y：Y 越高放开的越少越准。同时算"真的会改归属"的张数与你的表态命中。
 *
 * 用法：node scripts/dup-prune-safeguard.js
 */
const fs = require('fs')
const path = require('path')

const BAD = ['eyes_closed', 'half_head', 'face_ugly', 'blur', 'exposure', 'duplicate']
const X = 9 // 阈值保持现状 0.85 不变，只改结构判据

function hamming(a, b) {
  let n = 0
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (x) {
      n += x & 1
      x >>= 1
    }
  }
  return n
}

;(async () => {
  const dbPath = path.join(process.env.APPDATA || '', 'screener-master', 'data', 'screener.db')
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs()
  const db = new SQL.Database(fs.readFileSync(dbPath))
  const q = (s) => {
    const r = db.exec(s)
    return r.length ? r[0].values : []
  }
  const rows = q("SELECT id, filename, path, tags, details, category, category_by FROM images WHERE status = 'done'")
  const imgs = new Map()
  for (const [id, filename, p, tags, details, category, categoryBy] of rows) {
    let t = {}
    let d = {}
    try {
      t = JSON.parse(tags || '{}')
      d = JSON.parse(details || '{}')
    } catch {
      /* ignore */
    }
    if (!d.phash) continue
    imgs.set(id, { id, filename, dir: String(p).replace(/[\\/][^\\/]*$/, ''), hash: d.phash, tags: t, category, categoryBy })
  }
  const adj = new Map()
  const edges = []
  const byDir = new Map()
  for (const it of imgs.values()) {
    const l = byDir.get(it.dir) || []
    l.push(it)
    byDir.set(it.dir, l)
  }
  for (const id of imgs.keys()) adj.set(id, new Map())
  for (const [, l] of byDir) {
    for (let i = 0; i < l.length; i++) {
      for (let j = i + 1; j < l.length; j++) {
        const h = hamming(l[i].hash, l[j].hash)
        if (h > 20) continue
        edges.push([h, l[i].id, l[j].id])
        adj.get(l[i].id).set(l[j].id, h)
        adj.get(l[j].id).set(l[i].id, h)
      }
    }
  }
  edges.sort((a, b) => a[0] - b[0])
  const dOf = (a, b) => {
    const m = adj.get(a)
    return m && m.has(b) ? m.get(b) : 99
  }
  const linkGroups = () => {
    const parent = new Map()
    const find = (a) => {
      while (parent.get(a) !== a) {
        parent.set(a, parent.get(a))
        a = parent.get(a)
      }
      return a
    }
    for (const id of imgs.keys()) parent.set(id, id)
    for (const [h, a, b] of edges) {
      if (h > X) break
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) parent.set(rb, ra)
    }
    const g = new Map()
    for (const id of imgs.keys()) {
      const r = find(id)
      const list = g.get(r) || []
      list.push(id)
      g.set(r, list)
    }
    return [...g.values()].filter((v) => v.length > 1)
  }
  // 修剪并记录每个被踢成员的 kick
  const kicked = new Map() // id -> kick（到幸存组的最小距离）
  const keptGroups = []
  for (const g0 of linkGroups()) {
    let g = [...g0]
    const out = []
    for (;;) {
      let worst = null
      let worstD = -1
      for (const a of g) {
        for (const b of g) {
          if (a >= b) continue
          const h = dOf(a, b)
          if (h > X && h > worstD) {
            worstD = h
            worst = a
          }
        }
      }
      if (worst === null) break
      g = g.filter((id) => id !== worst)
      out.push(worst)
    }
    if (g.length > 1) keptGroups.push(g)
    for (const w of out) {
      let kick = 99
      for (const m of g) kick = Math.min(kick, dOf(w, m))
      kicked.set(w, kick)
    }
  }
  const taggedS = new Set()
  for (const g of linkGroups()) {
    const o = [...g].sort((a, b) => a - b)
    for (let i = 1; i < o.length; i++) taggedS.add(o[i])
  }
  const taggedD = new Set()
  for (const g of keptGroups) {
    const o = [...g].sort((a, b) => a - b)
    for (let i = 1; i < o.length; i++) taggedD.add(o[i])
  }
  const dropped = [...taggedS].filter((id) => !taggedD.has(id))
  console.log('阈值不动（相似度 0.859 / 汉明≤9），只把单链接换成一致性修剪：')
  console.log('  被踢出组的成员 ' + kicked.size + ' 张，其中原本带 duplicate 标签的 ' + dropped.length + ' 张')
  const kickHist = new Map()
  for (const k of kicked.values()) kickHist.set(k, (kickHist.get(k) || 0) + 1)
  console.log('  踢出强度分布（kick = 到幸存组的最小汉明距离）：' + [...kickHist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => k + ':' + v).join(' '))

  const rej = new Set(q("SELECT DISTINCT image_id FROM corrections WHERE orig_dim='duplicate' AND action='wrong'").map((v) => v[0]))
  const okSet = new Set(q("SELECT DISTINCT image_id FROM corrections WHERE orig_dim='duplicate' AND action='correct'").map((v) => v[0]))
  const add = new Set(q("SELECT DISTINCT image_id FROM corrections WHERE orig_dim IS NULL AND new_category='duplicate'").map((v) => v[0]))
  const otherFlaw = (it) => BAD.some((dim) => dim !== 'duplicate' && it.tags[dim] && it.tags[dim].level && it.tags[dim].level !== 'low')

  console.log('\n=== 按 kick 门限 Y 分档：只摘"确信不一致"的，灰区保留标签不动 ===')
  console.log('Y(踢出强度≥) 摘标签张数  真改归属  你否定被放开  你认可被放开  你补打仍能并上')
  for (const Y of [10, 11, 12, 13, 14, 16, 20]) {
    const freed = new Set(dropped.filter((id) => (kicked.get(id) || 0) >= Y))
    // 放开集 = 修剪后不带标签的（tD 保留）再扣掉"灰区仍保留"
    const finalTagged = new Set([...taggedD, ...dropped.filter((id) => !freed.has(id))])
    let realMove = 0
    for (const id of freed) {
      const it = imgs.get(id)
      if (!it || it.categoryBy === 'user') continue
      if (otherFlaw(it)) continue
      if (it.category === 'trash' || it.category === 'dup_trash') continue
      realMove++
    }
    const savedRej = [...rej].filter((id) => !finalTagged.has(id)).length
    const hurtOk = [...okSet].filter((id) => !finalTagged.has(id)).length
    const keptAdd = [...add].filter((id) => finalTagged.has(id)).length
    console.log(String(Y).padStart(6) + '        ' + String(freed.size).padStart(6) + '    ' + String(realMove).padStart(6) + '       ' + savedRej + '/' + rej.size + '        ' + hurtOk + '/' + okSet.size + '        ' + keptAdd + '/' + add.size)
  }

  // 推荐档的明细
  console.log('\n=== kick≥12 这一档的放开清单（前 25 条，你抽查用）===')
  const mid = dropped.filter((id) => (kicked.get(id) || 0) >= 12)
  for (const id of mid.slice(0, 25)) {
    const it = imgs.get(id)
    console.log('  ' + String(it.filename).padEnd(16) + ' kick ' + String(kicked.get(id)).padStart(2) + '  现分类 ' + String(it.category).padEnd(14) + ' 归属来源 ' + it.categoryBy + (rej.has(id) ? '  ←你否定过' : ''))
  }
  console.log('  …合计 ' + mid.length + ' 张')
})().catch((e) => {
  console.error('FAILED', e)
  process.exit(1)
})
