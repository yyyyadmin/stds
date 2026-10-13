/**
 * 重复/连拍成组判据对比仿真（只读：不动库、不动标签、不重筛）
 *
 * 前提结论（dup-threshold-sim.js 已证）：单纯抬阈值净账为负，问题有一半出在"单链接串组"。
 * 本脚本只换结构判据，不动阈值语义，对比四种成组策略，用你自己的表态打分：
 *
 *   S 单链接（现状）      A-B 达标就 union，链条会把 50 张串成一组
 *   C 完全图（clique）    组内两两都必须达标，按导入序 seed & expand
 *   D 修剪链条            先单链接成组，再把"与组内某张超标"的末端成员踢出去
 *   E 锚点约束            只要求与组内最早那张（锚）达标，允许组内互相不像
 *
 * 打分口径（真值 = 你的 corrections 表态）：
 *   救回 = 你否定过 duplicate 的 24 张里，新判据不再给它们打标签
 *   漏   = 你认可过 duplicate 的 9 张里，被放走的（这些是真重复，放走 = 错）
 *   保住 = 你手动补打 duplicate 的 12 张里，新判据能自动并上来的
 *
 * 用法：node scripts/dup-cluster-strategy.js
 */
const fs = require('fs')
const path = require('path')

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

  const rows = q("SELECT id, filename, path, details FROM images WHERE status = 'done'")
  const imgs = new Map()
  for (const [id, filename, p, details] of rows) {
    let d = null
    try {
      d = JSON.parse(details || '{}')
    } catch {
      /* ignore */
    }
    if (!d.phash) continue
    imgs.set(id, { id, filename, dir: String(p).replace(/[\\/][^\\/]*$/, ''), hash: d.phash })
  }

  // 邻接表：同目录、汉明<=16
  const byDir = new Map()
  for (const it of imgs.values()) {
    const l = byDir.get(it.dir) || []
    l.push(it)
    byDir.set(it.dir, l)
  }
  const adj = new Map() // id -> Map(otherId -> ham)
  const edges = []
  for (const id of imgs.keys()) adj.set(id, new Map())
  for (const [, l] of byDir) {
    for (let i = 0; i < l.length; i++) {
      for (let j = i + 1; j < l.length; j++) {
        const h = hamming(l[i].hash, l[j].hash)
        if (h > 16) continue
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
  console.log('参与 ' + imgs.size + ' 张 · 候选边 ' + edges.length + ' 对（汉明≤16）')

  const rej = new Set(q("SELECT DISTINCT image_id FROM corrections WHERE orig_dim='duplicate' AND action='wrong'").map((v) => v[0]))
  const add = new Set(q("SELECT DISTINCT image_id FROM corrections WHERE orig_dim IS NULL AND new_category='duplicate'").map((v) => v[0]))
  const okSet = new Set(q("SELECT DISTINCT image_id FROM corrections WHERE orig_dim='duplicate' AND action='correct'").map((v) => v[0]))
  console.log('真值：否定 ' + rej.size + ' · 手动补 ' + add.size + ' · 认可 ' + okSet.size)

  // ---------- 四种判据 ----------
  const linkGroups = (x) => {
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
      if (h > x) break
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

  // C 完全图：按导入序（id 升序）逐个开新组，后续成员必须与组内全部达标
  const cliqueGroups = (x) => {
    const left = new Set(imgs.keys())
    const order = [...imgs.keys()].sort((a, b) => a - b)
    const out = []
    for (const seed of order) {
      if (!left.has(seed)) continue
      left.delete(seed)
      const g = [seed]
      for (const cand of order) {
        if (!left.has(cand)) continue
        if (g.every((m) => dOf(m, cand) <= x)) {
          g.push(cand)
          left.delete(cand)
        }
      }
      if (g.length > 1) out.push(g)
    }
    return out
  }

  // D 修剪：先单链接成组，再反复踢掉"与组内任一张超标"的最差成员
  const prunedGroups = (x) => {
    const out = []
    for (const g0 of linkGroups(x)) {
      let g = [...g0]
      for (;;) {
        let worst = null
        let worstD = -1
        for (const a of g) {
          for (const b of g) {
            if (a >= b) continue
            const h = dOf(a, b)
            if (h > x && h > worstD) {
              worstD = h
              worst = a
            }
            if (h > x && worst === null) worst = b
          }
        }
        if (worst === null || worstD < 0) break
        g = g.filter((id) => id !== worst)
      }
      if (g.length > 1) out.push(g)
    }
    return out
  }

  // E 锚点：与最早那张（锚）达标即可入组，不管组内互相
  const anchorGroups = (x) => {
    const out = []
    const used = new Set()
    for (const id of [...imgs.keys()].sort((a, b) => a - b)) {
      if (used.has(id)) continue
      const nb = [...(adj.get(id) || new Map()).entries()].filter(([o, h]) => h <= x && !used.has(o)).sort((a, b) => a[0] - b[0])
      if (!nb.length) continue
      const g = [id, ...nb.map((v) => v[0])]
      g.forEach((v) => used.add(v))
      out.push(g)
    }
    return out
  }

  const STRATS = { S: linkGroups, C: cliqueGroups, D: prunedGroups, E: anchorGroups }

  const score = (name, groups) => {
    const tagged = new Set()
    for (const g of groups) {
      const sorted = [...g].sort((a, b) => a - b)
      for (let i = 1; i < sorted.length; i++) tagged.add(sorted[i])
    }
    const members = groups.reduce((s, g) => s + g.length, 0)
    const biggest = groups.reduce((s, g) => Math.max(s, g.length), 0)
    const saved = [...rej].filter((id) => !tagged.has(id)).length
    const hurt = [...okSet].filter((id) => !tagged.has(id)).length
    const kept = [...add].filter((id) => tagged.has(id)).length
    console.log(
      name.padStart(2) + ' 汉明≤' + String('x').padEnd(2) +
        ' 组数 ' + String(groups.length).padStart(4) +
        ' 成员 ' + String(members).padStart(5) +
        ' 最大组 ' + String(biggest).padStart(3) +
        ' 打标签 ' + String(tagged.size).padStart(5) +
        ' | 救回 ' + saved + '/' + rej.size +
        ' 放走真重复 ' + hurt + '/' + okSet.size +
        ' 保住补打 ' + kept + '/' + add.size +
        ' | 净 ' + (saved - hurt - (add.size - kept))
    )
    return { groups, tagged, biggest, saved, hurt, kept }
  }

  console.log('\n净 = 救回(你否定且被放开的) − 放走(你认可却被放开) − 漏掉(你补打却没自动并上来)')
  for (const [k, fn] of Object.entries(STRATS)) {
    for (const x of [9, 8, 7, 6]) {
      const r = fn(x)
      const line = score(k + '(x=' + x + ')', r)
      void line
    }
    console.log('')
  }

  // 巨组对比：现状 vs 各判据在 x=8/7 下还剩下多少 ≥10 张的组
  console.log('=== 巨组（≥10 张）残留对比 ===')
  const cases = [['S 现状 x=9', linkGroups(9)], ['C clique x=9', cliqueGroups(9)], ['C clique x=8', cliqueGroups(8)], ['D 修剪 x=9', prunedGroups(9)], ['D 修剪 x=8', prunedGroups(8)], ['E 锚点 x=9', anchorGroups(9)]]
  for (const [label, gs] of cases) {
    const big = gs.filter((g) => g.length >= 10)
    const sizes = big.map((g) => g.length).sort((a, b) => b - a)
    console.log(label.padEnd(14) + ' ≥10 张组 ' + String(big.length).padStart(3) + ' 个 · 尺寸 ' + (sizes.slice(0, 12).join(',') || '无'))
  }

  // 细节：C(x=9) 相比 S(x=9) 从巨组里放开了多少"你否定过"的图
  const s9 = linkGroups(9)
  const c9 = cliqueGroups(9)
  const tS = new Set()
  const tC = new Set()
  for (const g of s9) {
    const o = [...g].sort((a, b) => a - b)
    for (let i = 1; i < o.length; i++) tS.add(o[i])
  }
  for (const g of c9) {
    const o = [...g].sort((a, b) => a - b)
    for (let i = 1; i < o.length; i++) tC.add(o[i])
  }
  const freed = [...tS].filter((id) => !tC.has(id))
  console.log('\n同阈值 x=9 下，仅把判据换成 clique 就少打标签 ' + freed.length + ' 张，其中你否定过 ' + freed.filter((id) => rej.has(id)).length + ' 张、你认可过 ' + freed.filter((id) => okSet.has(id)).length + ' 张')
  const stillRej = [...rej].filter((id) => tC.has(id))
  console.log('clique x=9 之后仍被你否定却还在组里的 ' + stillRej.length + ' 张（这些要靠姿态门，phash 无法区分）：')
  for (const id of stillRej.slice(0, 12)) {
    const g = c9.find((x) => x.includes(id)) || []
    const near = g.filter((x) => x !== id).map((x) => x + '(汉明' + dOf(id, x) + ')')
    console.log('  ' + imgs.get(id).filename + ' 组 ' + g.length + ' 张 · 同组 ' + near.slice(0, 3).join(' '))
  }
})().catch((e) => {
  console.error('FAILED', e)
  process.exit(1)
})
