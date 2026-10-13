/**
 * 丙方案验证 v2（只读）：只比对"重复废弃桶"这一个真信号
 *
 * 上一版缺陷：KEEP 用 isDeliverable 定义（要求零瑕疵），DISCARD 混了普通废弃库
 * （那是你因瑕疵丢的，与重复无关）→ "保留者更干净"是定义造出来的，不是证据。
 *
 * 本版口径：
 *   留下的 = 组内 category 不属于任何废弃桶的图（允许带瑕疵，因为你留它可能是因为
 *            它是这组里唯一拍清的 / 表情好的，瑕疵由别的维度管）
 *   丢弃的 = 仅 dup_trash（你从重复分组里主动丢进重复废弃桶的，纯粹是"这张冗余"的判断）
 *   打分只用 tier（引擎按实测锐度分的优质/良好/一般），不引入瑕疵，避免串维度。
 *
 * 用法：node scripts/dup-keep-verify.js
 */
const fs = require('fs')
const path = require('path')

const BAD = ['eyes_closed', 'half_head', 'face_ugly', 'blur', 'exposure', 'duplicate']
const HAM_MAX = 9
const CAT_TRASH = 'trash'
const CAT_DUP_TRASH = 'dup_trash'

function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 99
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
  const rows = q("SELECT id, filename, path, tags, details, category, category_by, tier, tier_by FROM images WHERE status = 'done'")

  const flawLevelOf = (tags) => {
    let high = false
    let mid = false
    for (const d of BAD) {
      const t = tags[d]
      if (!t || t.level === 'low') continue
      if (t.level === 'high') high = true
      else mid = true
    }
    return high ? 'high' : mid ? 'mid' : 'none'
  }

  const imgs = new Map()
  for (const [id, filename, p, tags, details, category, categoryBy, tier, tierBy] of rows) {
    let t = {}
    let d = {}
    try {
      t = JSON.parse(tags || '{}')
      d = JSON.parse(details || '{}')
    } catch {
      /* ignore */
    }
    if (!d.phash) continue
    imgs.set(id, {
      id,
      filename,
      dir: String(p).replace(/[\\/][^\\/]*$/, ''),
      hash: d.phash,
      cat: category,
      catBy: categoryBy,
      tier: tier == null ? null : tier,
      tierBy: tierBy,
      flaw: flawLevelOf(t),
      sharp: null
    })
  }

  const byDir = new Map()
  for (const it of imgs.values()) {
    const l = byDir.get(it.dir) || []
    l.push(it)
    byDir.set(it.dir, l)
  }
  const parent = new Map()
  const find = (a) => {
    while (parent.get(a) !== a) {
      parent.set(a, parent.get(a))
      a = parent.get(a)
    }
    return a
  }
  for (const id of imgs.keys()) parent.set(id, id)
  for (const [, l] of byDir) {
    for (let i = 0; i < l.length; i++) {
      for (let j = i + 1; j < l.length; j++) {
        if (hamming(l[i].hash, l[j].hash) <= HAM_MAX) {
          const ra = find(l[i].id)
          const rb = find(l[j].id)
          if (ra !== rb) parent.set(rb, ra)
        }
      }
    }
  }
  const groupMap = new Map()
  for (const id of imgs.keys()) {
    const r = find(id)
    const list = groupMap.get(r) || []
    list.push(id)
    groupMap.set(r, list)
  }
  const allGroups = [...groupMap.values()].filter((g) => g.length > 1).map((g) => g.map((id) => imgs.get(id)))
  console.log('组数 ' + allGroups.length + ' · 成员 ' + allGroups.reduce((s, g) => s + g.length, 0) + ' 张 · 全库 dup_trash 图 ' + [...imgs.values()].filter((it) => it.cat === CAT_DUP_TRASH).length + ' 张')

  // 只取"组内既有你留下的、又有你丢进重复废弃桶的"组
  const cases = []
  for (const items of allGroups) {
    const keepers = items.filter((it) => it.cat !== CAT_TRASH && it.cat !== CAT_DUP_TRASH)
    const discarded = items.filter((it) => it.cat === CAT_DUP_TRASH)
    if (keepers.length && discarded.length) cases.push({ items, keepers, discarded, size: items.length })
  }
  console.log('可测组（有留下 + 有丢进重复废弃桶）：' + cases.length + ' 个 · 涉及留下 ' + cases.reduce((s, c) => s + c.keepers.length, 0) + ' 张 / 丢弃 ' + cases.reduce((s, c) => s + c.discarded.length, 0) + ' 张')

  // ---- 检验1：只看档位，你留下的那张是不是比丢进重复桶的更好 ----
  const both = []
  for (const c of cases) {
    for (const k of c.keepers) {
      for (const d of c.discarded) {
        if (k.tier != null && d.tier != null) both.push([k.tier, d.tier])
      }
    }
  }
  let win = 0
  let tie = 0
  for (const [kt, dt] of both) {
    if (kt < dt) win++
    else if (kt === dt) tie++
  }
  console.log('\n=== 检验1：档位（1优质/2良好/3一般）能否预测你的取舍（' + both.length + ' 个「留下×丢弃」对）===')
  if (both.length) {
    console.log('  你留下的档位更好：' + win + '（' + ((win / both.length) * 100).toFixed(1) + '%）')
    console.log('  同档：' + tie + '（' + ((tie / both.length) * 100).toFixed(1) + '%）')
    console.log('  你留下的档位更差：' + (both.length - win - tie) + '（' + (((both.length - win - tie) / both.length) * 100).toFixed(1) + '%）')
    console.log('  AUC = ' + ((win + 0.5 * tie) / both.length).toFixed(3) + '（0.5 = 档位对你的取舍毫无预测力）')
  } else {
    console.log('  两边都有档位的对子为 0 —— 说明 dup_trash 里的图大多没有 tier（不在交付库就不算档），无法比对')
  }

  // ---- 检验1b：你丢进重复桶的，有多少本身是干净的（不靠瑕疵也能被 AI 留下）----
  const discClean = [...imgs.values()].filter((it) => it.cat === CAT_DUP_TRASH && it.flaw === 'none')
  const discFlawed = [...imgs.values()].filter((it) => it.cat === CAT_DUP_TRASH && it.flaw !== 'none')
  console.log('\n=== 检验1b：你丢进重复废弃桶的 ' + (discClean.length + discFlawed.length) + ' 张的自身质量 ===')
  console.log('  零瑕疵（纯因冗余被丢）：' + discClean.length + ' 张（' + ((discClean.length / Math.max(1, discClean.length + discFlawed.length)) * 100).toFixed(1) + '%）')
  console.log('  带瑕疵（可能顺手一起丢的）：' + discFlawed.length + ' 张')
  const discTier = {}
  for (const it of discClean) {
    const k = it.tier == null ? '无档' : '档' + it.tier
    discTier[k] = (discTier[k] || 0) + 1
  }
  console.log('  其中档位分布：' + JSON.stringify(discTier))

  // ---- 检验2：组内该保留哪张——「最早导入」vs「最高档」vs「最高档且零瑕疵」----
  let hitOld = 0
  let hitTier = 0
  let hitTierFlaw = 0
  let n = 0
  const diffs = []
  const tierVal = (it) => (it.tier == null ? 4 : it.tier)
  for (const c of cases) {
    n++
    const keepIds = new Set(c.keepers.map((it) => it.id))
    const earliest = [...c.items].sort((a, b) => a.id - b.id)[0]
    const bestTier = [...c.items].sort((a, b) => tierVal(a) - tierVal(b) || (a.flaw === 'none' ? -1 : 1) - (b.flaw === 'none' ? -1 : 1) || a.id - b.id)[0]
    const bestTierFlaw = [...c.items].sort((a, b) => (a.flaw === 'none' ? 0 : 1) - (b.flaw === 'none' ? 0 : 1) || tierVal(a) - tierVal(b) || a.id - b.id)[0]
    if (keepIds.has(earliest.id)) hitOld++
    if (keepIds.has(bestTier.id)) hitTier++
    if (keepIds.has(bestTierFlaw.id)) hitTierFlaw++
    if (bestTier.id !== earliest.id || bestTierFlaw.id !== earliest.id) diffs.push({ c, earliest, bestTier, bestTierFlaw })
  }
  console.log('\n=== 检验2：' + n + ' 个可测组里，三种"组内保留谁"的规则命中你实际留下的比例 ===')
  console.log('  现状「最早导入那张」：' + hitOld + '/' + n + '（' + ((hitOld / n) * 100).toFixed(1) + '%）')
  console.log('  规则B「档位最好优先」：' + hitTier + '/' + n + '（' + ((hitTier / n) * 100).toFixed(1) + '%）')
  console.log('  规则C「先零瑕疵再档位好」：' + hitTierFlaw + '/' + n + '（' + ((hitTierFlaw / n) * 100).toFixed(1) + '%）')
  console.log('  与现状选择不同的组：' + diffs.length + ' 个')

  // ---- 全库影响面：换保留帧会动多少 ----
  let change = 0
  let changeUserTouched = 0
  let affected = 0
  for (const items of allGroups) {
    const earliest = [...items].sort((a, b) => a.id - b.id)[0]
    const best = [...items].sort((a, b) => (a.flaw === 'none' ? 0 : 1) - (b.flaw === 'none' ? 0 : 1) || tierVal(a) - tierVal(b) || a.id - b.id)[0]
    if (best.id !== earliest.id) {
      change++
      affected += 2
      if (items.some((it) => it.catBy === 'user')) changeUserTouched++
    }
  }
  console.log('\n=== 影响面：全库 ' + allGroups.length + ' 组，按规则C 换保留帧的组 ' + change + ' 个（约 ' + affected + ' 张的标签会重挂），其中你人工动过的组 ' + changeUserTouched + ' 个（受保护，改动不会覆盖你的归属）===')

  // ---- 明细 ----
  console.log('\n=== 可测组明细（全部 ' + cases.length + ' 个）===')
  for (const c of cases) {
    const tierStr = (it) => it.filename.replace(/\.[^.]+$/, '') + '(档' + (it.tier == null ? '-' : it.tier) + '/' + it.flaw + (it.cat === CAT_DUP_TRASH ? '/丢' : '/留') + ')'
    console.log('  组 ' + c.size + ' 张｜留下 ' + c.keepers.map(tierStr).join(' ') + '｜丢弃 ' + c.discarded.slice(0, 8).map(tierStr).join(' ') + (c.discarded.length > 8 ? ' …共丢' + c.discarded.length : ''))
  }
})().catch((e) => {
  console.error('FAILED', e)
  process.exit(1)
})
