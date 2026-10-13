/**
 * v2.0.67 新逻辑离线复算（只读，不动库）
 * 完全照抄 app/src/main/services/scanner.ts::reclusterDuplicates + types.ts::dupKeepWeight
 * 在真实库上跑一遍，回答四件事：
 *   1) 有多少组的“该留哪张”换了人
 *   2) 换人后还有多少组把闭眼/半截头留在交付库里（应为 0）
 *   3) 有多少组原来一张都进不了交付库、现在能进了（这就是修好的量）
 *   4) 交付库总张数会不会翻倍（不能翻倍，甲方案的 +98.7% 是灾难）
 * 用法：node scripts/dup-v4-verify.js
 */
const fs = require('fs')
const path = require('path')

const TRASH = ['trash', 'dup_trash']
const REVIEW = 'review'
// 瑕疵维度（v4 口径：duplicate 不在这里）
const BAD = ['eyes_closed', 'half_head', 'face_ugly', 'blur', 'exposure']
const CAT_DUP = 'duplicate'

const lv = (tags, d) => {
  const t = tags && tags[d]
  if (!t || !t.level || t.level === 'low') return null
  return t.level
}
/** 照抄 types.ts flawLevel：只看 BAD 五维，high > mid > none */
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
/** 照抄 types.ts isDupRedundant */
const isDupRedundant = (tags) => !!lv(tags, 'duplicate')
/** 照抄 types.ts isDeliverable（v4 双闸门） */
function isDeliverable(cat, tags) {
  if (TRASH.includes(cat) || cat === REVIEW || cat === 'flaws') return false
  if (BAD.includes(cat)) return false
  if (cat === CAT_DUP) return false
  if (isDupRedundant(tags)) return false
  return flawLevel(tags) === 'none'
}
/** 照抄 types.ts dupKeepWeight（数字越小越该留） */
function dupKeepWeight(tags, tier) {
  const hit = (d) => {
    const l = lv(tags, d)
    if (!l) return 0
    return l === 'high' ? 2 : 0.8
  }
  const fatal = hit('eyes_closed') + hit('half_head')
  const face = hit('face_ugly')
  const soft = hit('blur') + hit('exposure')
  const tierPenalty = tier === 1 || tier === 2 || tier === 3 ? tier - 1 : 1
  return fatal * 100000 + face * 10000 + soft * 1000 + tierPenalty * 10
}
/** 给人看的瑕疵清单（只报文件名 + 哪几个维度被标了） */
const DIM_CN = { eyes_closed: '闭眼', half_head: '半截头', face_ugly: '表情', blur: '模糊', exposure: '曝光', duplicate: '重复' }
function flawListStr(tags) {
  return BAD.filter((d) => lv(tags, d))
    .map((d) => DIM_CN[d])
    .join('+')
}

function hammingSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dist = 0
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (x) {
      dist += x & 1
      x >>= 1
    }
  }
  return 1 - dist / (a.length * 4)
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
  const rows = q("SELECT id, filename, path, tags, details, category, category_by, tier, dup_group FROM images WHERE status = 'done'")

  const imgs = new Map()
  for (const [id, filename, p, tagsRaw, detailsRaw, cat, catBy, tier, dupGroup] of rows) {
    let tags = {}
    let d = {}
    try {
      tags = JSON.parse(tagsRaw || '{}')
      d = JSON.parse(detailsRaw || '{}')
    } catch {
      /* ignore */
    }
    imgs.set(id, {
      id,
      filename,
      dir: String(p).replace(/[\\/][^\\/]*$/, ''),
      hash: d.phash || null,
      tags,
      cat,
      catBy,
      tier,
      dupGroup
    })
  }

  // ---------- 成组（并查集，与主程序同：同目录 + 相似度 >= 0.85）----------
  const parent = new Map()
  const find = (x) => {
    while (parent.get(x) !== x) x = parent.get(x)
    return x
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(rb, ra)
  }
  const byDir = new Map()
  for (const it of imgs.values()) {
    if (!it.hash) continue
    parent.set(it.id, it.id)
    const l = byDir.get(it.dir) || []
    l.push(it)
    byDir.set(it.dir, l)
  }
  for (const [, list] of byDir) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (hammingSim(list[i].hash, list[j].hash) >= 0.85) union(list[i].id, list[j].id)
      }
    }
  }
  const groupsMap = new Map()
  for (const it of imgs.values()) {
    if (!it.hash || !parent.has(it.id)) continue
    const g = groupsMap.get(find(it.id)) || []
    g.push(it.id)
    groupsMap.set(find(it.id), g)
  }

  // ---------- 逐组：旧代表帧（min id）vs 新代表帧（权重）----------
  let groups = 0
  let swapped = 0
  const swapSamples = []
  const perImageNewState = new Map() // id -> { keep: bool, redundant: bool }
  let noKeepable = 0
  for (const [, ids] of groupsMap) {
    if (ids.length < 2) continue
    groups++
    ids.sort((a, b) => a - b)
    const recs = ids.map((i) => imgs.get(i))
    const oldRep = recs[0]
    const willing = recs.filter((r) => !(isDupRedundant(r.tags) && r.tags.duplicate && r.tags.duplicate.method === 'user'))
    const keepable = willing.filter((r) => !TRASH.includes(r.cat))
    if (!keepable.length) {
      noKeepable++
      for (const r of recs) perImageNewState.set(r.id, { keep: false, redundant: isDupRedundant(r.tags) })
      continue
    }
    const human = keepable.filter((r) => r.catBy === 'user')
    // 与主程序同：先只在“本身干净、没被人工搁在待确认”的那几张里挑代表
    const cleanPool = keepable.filter((r) => flawLevel(r.tags) === 'none' && r.cat !== REVIEW)
    const poolClean = cleanPool.filter((r) => r.catBy === 'user')
    const pool = poolClean.length ? poolClean : cleanPool.length ? cleanPool : human.length ? human : keepable
    const keep = pool.reduce((a, b) => (dupKeepWeight(a.tags, a.tier) <= dupKeepWeight(b.tags, b.tier) ? a : b))
    for (const r of recs) perImageNewState.set(r.id, { keep: r.id === keep.id, redundant: r.id !== keep.id && r.catBy !== 'user' && !TRASH.includes(r.cat) })
    if (keep.id !== oldRep.id) {
      swapped++
      if (swapSamples.length < 12) swapSamples.push({ old: oldRep, keep, size: ids.length })
    }
  }

  // ---------- 收尾（与主程序同）：不在任何 ≥ 2 张组的孤帧，身上的 AI 冗余标签会被摘掉 ----------
  for (const it of imgs.values()) {
    if (perImageNewState.has(it.id)) continue
    const t = it.tags.duplicate
    if (t && t.level !== 'low' && t.method !== 'user') perImageNewState.set(it.id, { keep: true, redundant: false })
  }

  // ---------- 交付库张数：现状 vs 新逻辑 ----------
  const deliverableOld = []
  const deliverableNew = []
  for (const it of imgs.values()) {
    if (TRASH.includes(it.cat)) continue
    if (isDeliverable(it.cat, it.tags)) deliverableOld.push(it)
    const st = perImageNewState.get(it.id) || { keep: false, redundant: false }
    // 新逻辑：代表帧把身上的冗余标签摘掉，其余按标签走
    const tags2 = st.keep ? { ...it.tags, duplicate: undefined } : it.tags
    if (isDeliverable(it.cat, tags2) && !st.redundant) deliverableNew.push(it)
  }

  // ---------- 组内是否还有“闭眼/半截头当代表帧” ----------
  const repHasFatal = (rep) => !!lv(rep.tags, 'eyes_closed') || !!lv(rep.tags, 'half_head')
  let oldRepFatal = 0
  let newRepFatal = 0
  let newRepFatalFixable = 0 // 代表帧还烂着、但组里其实有更干净的可挑（应为 0）
  let oldGroupEmpty = 0 // 一张都进不了库的组
  let newGroupEmpty = 0
  const byRootRep = new Map()
  for (const [, ids] of groupsMap) {
    if (ids.length < 2) continue
    ids.sort((a, b) => a - b)
    const recs = ids.map((i) => imgs.get(i))
    const oldRep = recs[0]
    const newRep = recs.find((r) => (perImageNewState.get(r.id) || {}).keep)
    if (repHasFatal(oldRep)) oldRepFatal++
    if (newRep && repHasFatal(newRep)) {
      newRepFatal++
      const hadClean = recs.some((r) => flawLevel(r.tags) === 'none' && !TRASH.includes(r.cat) && r.cat !== REVIEW)
      if (hadClean) newRepFatalFixable++
    }
    const oldIn = recs.filter((r) => !TRASH.includes(r.cat) && isDeliverable(r.cat, r.tags)).length
    const newIn = recs.filter((r) => {
      const st = perImageNewState.get(r.id) || { keep: false, redundant: false }
      const tags2 = st.keep ? { ...r.tags, duplicate: undefined } : r.tags
      return isDeliverable(r.cat, tags2) && !st.redundant
    }).length
    if (!oldIn) oldGroupEmpty++
    if (!newIn) newGroupEmpty++
    byRootRep.set(ids[0], { oldRep, newRep })
  }

  // ---------- 用户丢进重复废弃桶的图，新逻辑会不会又把它挑回库 ----------
  const dupTrash = [...imgs.values()].filter((r) => r.cat === 'dup_trash')
  const dupTrashPicked = dupTrash.filter((r) => {
    const st = perImageNewState.get(r.id)
    return st && st.keep
  })

  const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) : '0.0')
  console.log('====== v2.0.67 新逻辑离线复算（只读）======')
  console.log(`库里已完成筛选 ${imgs.size} 张，成组 ${groups} 组`)
  console.log('')
  console.log('【1】每组该留哪张，换了多少组的人')
  console.log(`  换了代表帧：${swapped} 组 / ${groups} 组（${pct(swapped, groups)}%）`)
  for (const s of swapSamples) {
    const of = flawListStr(s.old.tags)
    const nf = flawListStr(s.keep.tags)
    console.log(`  ${s.size}张组：${s.old.filename}[${of || '无瑕疵'}] → 改留 ${s.keep.filename}[${nf || '无瑕疵'}]`)
  }
  console.log('')
  console.log('【2】“AI 自动留下的那张”是闭眼/半截头的组，还剩多少')
  console.log(`  改之前：${oldRepFatal} 组    改之后还烂着：${newRepFatal} 组`)
  console.log(`  其中“整组都找不出干净的一张”（没得挑，本来就不该交）：${newRepFatal - newRepFatalFixable} 组`)
  console.log(`  其中“组里其实有干净的却没挑到”（bug，应为 0）：${newRepFatalFixable} 组`)
  console.log('')
  console.log('【3】有多少组一张都进不了交付库')
  console.log(`  改之前：${oldGroupEmpty} 组    改之后：${newGroupEmpty} 组（修好 ${oldGroupEmpty - newGroupEmpty} 组；其中 ${noKeepable} 组是整组都被你手动丢进桶/否掉，本来就不该进）`)
  console.log('')
  console.log('【4】交付库总张数')
  console.log(`  改之前：${deliverableOld.length} 张    改之后：${deliverableNew.length} 张    变化 ${deliverableNew.length - deliverableOld.length > 0 ? '+' : ''}${deliverableNew.length - deliverableOld.length} 张（${pct(Math.abs(deliverableNew.length - deliverableOld.length), deliverableOld.length)}%）`)
  console.log('')
  console.log('【5】你亲手丢进重复废弃桶的图，新逻辑会不会又捞回来')
  console.log(`  废弃桶 ${dupTrash.length} 张，其中被重新挑成代表帧的：${dupTrashPicked.length} 张`)
  for (const r of dupTrashPicked.slice(0, 8)) console.log(`    ${r.filename}`)
  console.log('')
  console.log('【6】新逻辑下各状态张数（侧栏上段互斥求和口径）')
  let lib = 0
  let flaws = 0
  let dupRedundant = 0
  let review = 0
  for (const it of imgs.values()) {
    if (TRASH.includes(it.cat)) continue
    const st = perImageNewState.get(it.id) || { keep: false, redundant: false }
    const tags2 = st.keep ? { ...it.tags, duplicate: undefined } : it.tags
    const fl = flawLevel(tags2)
    if (fl === 'high') flaws++
    else if (st.redundant || (isDupRedundant(tags2) && !st.keep)) dupRedundant++
    else if (it.cat === REVIEW || fl === 'mid') review++
    else if (isDeliverable(it.cat, tags2)) lib++
  }
  console.log(`  交付库 ${lib} / 瑕疵片 ${flaws} / 重复多余 ${dupRedundant} / 待确认 ${review}   合计 ${lib + flaws + dupRedundant + review}`)
  console.log(`  非废弃桶总张数 ${[...imgs.values()].filter((r) => !TRASH.includes(r.cat)).length}`)
})().catch((e) => {
  console.error('FAILED', e)
  process.exit(1)
})
