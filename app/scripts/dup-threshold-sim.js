/**
 * 重复/连拍成组阈值离线仿真（只读：不动库、不动标签、不重筛）
 *
 * 背景：clusterDuplicates 用同目录两两 phash 汉明距离，sim>=0.85（即汉明<=9）并查集成组，
 * 组内除最早导入那张外全打 duplicate 瑕疵标签 → 被拦在交付库外。
 * 用户口径：只有动作/背景/场景/姿势/方向/颜色完全一样才算重复；站位变化、头部倾向严重不算。
 *
 * 本脚本回答三件事：
 *   1 把阈值抬高会拆掉多少组、释放多少张（释放=原来带 duplicate 标签、现在没了）
 *   2 那四个 20/27/28/36 张的巨组是靠哪条边串起来的（MST 瓶颈边 = 它在哪个阈值会断）
 *   3 拿用户自己的表态当真值：否定的 24 张能救回几张、手动补的 12 张会漏几张、认可的 9 张会误伤几张
 *
 * 用法：node scripts/dup-threshold-sim.js
 */
const fs = require('fs')
const path = require('path')

const CURRENT_HAM = 9 // sim 0.85 => (64-9)/64 = 0.859 >= 0.85；汉明 10 => 0.844 < 0.85
const SCAN = [9, 8, 7, 6, 5, 4, 3]

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

  // ---------- 载入 ----------
  const rows = q("SELECT id, filename, path, tags, category, category_by FROM images WHERE status = 'done'")
  const imgs = new Map()
  for (const [id, filename, p, tags, category, categoryBy] of rows) {
    let d = null
    let t = {}
    try {
      d = JSON.parse(q('SELECT details FROM images WHERE id = ' + id)[0][0] || '{}')
      t = JSON.parse(tags || '{}')
    } catch {
      /* ignore */
    }
    if (!d.phash) continue
    imgs.set(id, {
      id,
      filename,
      dir: String(p).replace(/[\\/][^\\/]*$/, ''),
      hash: d.phash,
      hasDupTag: !!(t.duplicate && t.duplicate.level !== 'low'),
      dupByUser: !!(t.duplicate && t.duplicate.method === 'user'),
      category,
      categoryBy
    })
  }
  console.log('参与仿真：' + imgs.size + ' 张（有 phash）')

  // ---------- 边表（同目录，汉明<=16） ----------
  const byDir = new Map()
  for (const it of imgs.values()) {
    const l = byDir.get(it.dir) || []
    l.push(it)
    byDir.set(it.dir, l)
  }
  const edges = []
  const dist = new Map()
  for (const [, l] of byDir) {
    for (let i = 0; i < l.length; i++) {
      for (let j = i + 1; j < l.length; j++) {
        const h = hamming(l[i].hash, l[j].hash)
        if (h > 16) continue
        edges.push([h, l[i].id, l[j].id])
        dist.set(l[i].id + ':' + l[j].id, h)
        dist.set(l[j].id + ':' + l[i].id, h)
      }
    }
  }
  edges.sort((a, b) => a[0] - b[0])
  console.log('汉明<=16 的候选配对 ' + edges.length + ' 对（全库两两共 ' + ((imgs.size * (imgs.size - 1)) / 2).toFixed(0) + ' 对）')

  const uf = (limit) => {
    const parent = new Map()
    const find = (x) => {
      while (parent.get(x) !== x) {
        parent.set(x, parent.get(x))
        x = parent.get(x)
      }
      return x
    }
    for (const id of imgs.keys()) parent.set(id, id)
    for (const [h, a, b] of edges) {
      if (h > limit) break
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) parent.set(rb, ra)
    }
    const groups = new Map()
    for (const id of imgs.keys()) {
      const r = find(id)
      const g = groups.get(r) || []
      g.push(id)
      groups.set(r, g)
    }
    return [...groups.values()].filter((g) => g.length > 1)
  }

  // 组内除最早 id（= 先导入）外都该带 duplicate 标签
  const taggedSet = (groups) => {
    const s = new Set()
    for (const g of groups) {
      const sorted = [...g].sort((a, b) => a - b)
      for (let i = 1; i < sorted.length; i++) s.add(sorted[i])
    }
    return s
  }

  const base = taggedSet(uf(CURRENT_HAM))
  const curTagged = [...imgs.values()].filter((i) => i.hasDupTag).map((i) => i.id)
  console.log('\n校验：库里现存 duplicate 标签 ' + curTagged.length + ' 张 · 本仿真复现 ' + base.size + ' 张（同公式应一致）')

  // ---------- 真值表态 ----------
  const rej = new Set(q("SELECT DISTINCT image_id FROM corrections WHERE orig_dim='duplicate' AND action='wrong'").map((v) => v[0]))
  const add = new Set(q("SELECT DISTINCT image_id FROM corrections WHERE orig_dim IS NULL AND new_category='duplicate'").map((v) => v[0]))
  const ok = new Set(q("SELECT DISTINCT image_id FROM corrections WHERE orig_dim='duplicate' AND action='correct'").map((v) => v[0]))
  console.log('你的表态：否定 duplicate ' + rej.size + ' 张 · 手动补 ' + add.size + ' 张 · 认可 ' + ok.size + ' 张')

  // ---------- 阈值扫描 ----------
  console.log('\n=== 表 1：抬高阈值会拆掉什么 ===')
  console.log('相似度阈值  汉明≤  组数  成员数  带标签数  比你现状释放  你否定的被救回  你补打的仍并上  你认可的被误伤')
  for (const lim of SCAN) {
    const groups = uf(lim)
    const tagged = taggedSet(groups)
    const members = groups.reduce((s, g) => s + g.length, 0)
    const freed = [...base].filter((id) => !tagged.has(id)).length
    const savedRej = [...rej].filter((id) => !tagged.has(id)).length
    const keptAdd = [...add].filter((id) => tagged.has(id)).length
    const hurtOk = [...ok].filter((id) => !tagged.has(id)).length
    const sim = ((64 - lim) / 64).toFixed(3)
    console.log(
      String(sim).padEnd(10) +
        String(lim).padStart(4) + '   ' +
        String(groups.length).padStart(5) + '  ' +
        String(members).padStart(6) + '   ' +
        String(tagged.size).padStart(7) + '     ' +
        String(freed).padStart(6) + '        ' +
        savedRej + '/' + rej.size + '            ' +
        keptAdd + '/' + add.size + '           ' +
        hurtOk + '/' + ok.size
    )
  }

  // ---------- 巨组解剖 ----------
  console.log('\n=== 表 2：现状 ≥8 张的组，靠哪条边串起来（MST 瓶颈 = 它在哪个阈值会断）===')
  const big = uf(CURRENT_HAM).filter((g) => g.length >= 8).sort((a, b) => b.length - a.length)
  const mstBottleneck = (g) => {
    const inSet = new Set([g[0]])
    const rest = g.slice(1)
    let bottleneck = 0
    let bridge = null
    while (rest.length) {
      let best = null
      for (const a of inSet) {
        for (let k = 0; k < rest.length; k++) {
          const h = dist.get(a + ':' + rest[k])
          if (h !== undefined && (best === null || h < best.h)) best = { h, k, from: a, to: rest[k] }
        }
      }
      if (!best) return { bottleneck: 99, bridge: null }
      if (best.h > bottleneck) {
        bottleneck = best.h
        bridge = best
      }
      inSet.add(best.to)
      rest.splice(best.k, 1)
    }
    return { bottleneck, bridge }
  }
  for (const g of big) {
    const { bottleneck, bridge } = mstBottleneck(g)
    const names = [...g].sort((a, b) => a - b).map((id) => String(imgs.get(id).filename).replace(/\.[^.]+$/, ''))
    const bstr = bridge ? imgs.get(bridge.from).filename + ' ↔ ' + imgs.get(bridge.to).filename + '（汉明 ' + bridge.h + '）' : '无'
    console.log('\n组 ' + g.length + ' 张 · MST 瓶颈边 汉明 ' + bottleneck + ' → 阈值抬到 ' + Math.max(0, bottleneck - 1) + '（相似度 ' + ((64 - Math.max(0, bottleneck - 1)) / 64).toFixed(3) + '）时这组会断')
    console.log('  关键断点：' + bstr)
    console.log('  成员：' + names.slice(0, 12).join(' ') + (names.length > 12 ? ' …共' + names.length : ''))
    const hitRej = [...g].filter((id) => rej.has(id))
    const hitOk = [...g].filter((id) => ok.has(id))
    if (hitRej.length || hitOk.length) console.log('  其中你否定过 ' + hitRej.length + ' 张、认可过 ' + hitOk.length + ' 张')
  }

  // ---------- 表 3：phash 救不了的（必须靠姿态门） ----------
  const strictest = taggedSet(uf(3))
  const stillChained = [...rej].filter((id) => strictest.has(id))
  console.log('\n=== 表 3：你否定过 duplicate 的 ' + rej.size + ' 张里，阈值怎么调都救不回的（phash 无解，只能靠头部倾向/站位门）===')
  console.log('汉明≤3（相似度 0.953）仍被并进来的：' + stillChained.length + ' 张')
  for (const id of stillChained.slice(0, 14)) {
    const g = uf(CURRENT_HAM).find((x) => x.includes(id)) || []
    const near = g
      .filter((x) => x !== id)
      .map((x) => ({ x, h: dist.get(id + ':' + x) }))
      .filter((o) => o.h !== undefined)
      .sort((a, b) => a.h - b.h)
      .slice(0, 2)
    console.log('  ' + imgs.get(id).filename + '  组内 ' + g.length + ' 张 · 最近邻 ' + near.map((o) => imgs.get(o.x).filename + '(汉明' + o.h + ')').join(' / ') + '  现分类 ' + imgs.get(id).category)
  }
  const saveableByThreshold = [...rej].filter((id) => base.has(id) && !strictest.has(id)).length
  console.log('靠提阈值就能救回的：' + saveableByThreshold + ' 张（否定总数 ' + rej.size + ' − 汉明≤3 仍并进的 ' + stillChained.length + '）')
})().catch((e) => {
  console.error('FAILED', e)
  process.exit(1)
})
