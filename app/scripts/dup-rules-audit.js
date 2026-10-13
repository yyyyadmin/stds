/**
 * 按用户重申的重复连拍口径，检查现状做到几条（只读，不动库）
 *
 * 用户口径（2026-10-13 重申）：
 * 1. 闭眼 / 半截头 的图永远不进交付库。
 * 2. 一个重复组不管多少张，必须有一张直接进交付库，且这张要按权重挑最好的
 *    （无闭眼 > 无半截头 > 无表情不好 > 清晰 > 曝光正常）。
 * 3. 眼睛闭着 vs 睁着 仍算重复，但要留睁眼的那张。
 * 4. 脚/手位置、头朝向不同 → 不算重复（需肢体关键点，本轮不测，先量现有信号能覆盖多少）。
 *
 * 用法：node scripts/dup-rules-audit.js
 */
const fs = require('fs')
const path = require('path')

const HAM_MAX = 9
const TRASH = 'trash'
const DUP_TRASH = 'dup_trash'
const REVIEW = 'review'

// 瑕疵维度按用户的权重排：闭眼最重，其次半截头、表情、模糊、曝光
const PENALTY = { eyes_closed: 1000, half_head: 800, face_ugly: 400, blur: 200, exposure: 100 }
const HARD = ['eyes_closed', 'half_head']

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
  const rows = q("SELECT id, filename, path, tags, details, category, category_by, tier FROM images WHERE status = 'done'")

  const BAD = Object.keys(PENALTY).concat(['duplicate'])
  const levelOf = (tags, dim) => {
    const t = tags[dim]
    if (!t || !t.level || t.level === 'low') return null
    return t.level
  }
  const flawList = (tags) => BAD.filter((d) => levelOf(tags, d))
  const hasHard = (tags) => HARD.some((d) => levelOf(tags, d))
  // 交付判定（与 app 同口径）：不在任何废弃桶/待确认，且没有任何中/高置信瑕疵标签
  const deliverable = (cat, tags) => {
    if (cat === TRASH || cat === DUP_TRASH || cat === REVIEW) return false
    if (BAD.includes(cat)) return false
    return flawList(tags).length === 0
  }
  const badScore = (tags) => {
    let s = 0
    for (const d of Object.keys(PENALTY)) {
      const lv = levelOf(tags, d)
      if (!lv) continue
      s += PENALTY[d] * (lv === 'high' ? 1 : 0.6)
    }
    return s
  }

  const imgs = new Map()
  for (const [id, filename, p, tagsRaw, detailsRaw, cat, catBy, tier] of rows) {
    let tags = {}
    let d = {}
    try {
      tags = JSON.parse(tagsRaw || '{}')
      d = JSON.parse(detailsRaw || '{}')
    } catch {
      /* ignore */
    }
    if (!d.phash) continue
    imgs.set(id, { id, filename, dir: String(p).replace(/[\\/][^\\/]*$/, ''), hash: d.phash, tags, cat, catBy, tier, dup: levelOf(tags, 'duplicate') })
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
  const gm = new Map()
  for (const id of imgs.keys()) {
    const r = find(id)
    const list = gm.get(r) || []
    list.push(id)
    gm.set(r, list)
  }
  const groups = [...gm.values()].filter((g) => g.length > 1).map((g) => g.map((id) => imgs.get(id)))
  console.log('重复组 ' + groups.length + ' 个，共 ' + groups.reduce((s, g) => s + g.length, 0) + ' 张照片')

  // 组内挑最好的一张：先没有闭眼半截头，再看其他瑕疵权重，再看档位，最后看导入先后
  const pick = (items) =>
    [...items].sort((a, b) => {
      const ha = hasHard(a.tags) ? 1 : 0
      const hb = hasHard(b.tags) ? 1 : 0
      if (ha !== hb) return ha - hb
      const sa = badScore(a.tags)
      const sb = badScore(b.tags)
      if (Math.abs(sa - sb) > 1) return sa - sb
      const ta = a.tier == null ? 4 : a.tier
      const tb = b.tier == null ? 4 : b.tier
      if (ta !== tb) return ta - tb
      return a.id - b.id
    })[0]

  // ---- 检查1：有没有哪个组一张都进不了交付（违反"必须有一张进交付"）----
  let noDelivery = 0
  const noDeliveryGroups = []
  for (const g of groups) {
    const inDel = g.filter((it) => deliverable(it.cat, it.tags))
    if (!inDel.length) {
      noDelivery++
      noDeliveryGroups.push(g)
    }
  }
  console.log('\n【检查1】一张都进不了交付库的组：' + noDelivery + ' 个（你的规则要求每组必须有一张直接进库）')
  if (noDeliveryGroups.length) {
    // 这些组是不是靠"换挑法"就能救：组内存在没有闭眼/半截头的成员？
    const rescuable = noDeliveryGroups.filter((g) => g.some((it) => !hasHard(it.tags)))
    const rescuableClean = noDeliveryGroups.filter((g) => g.some((it) => !hasHard(it.tags) && flawList(it.tags).length === 0))
    console.log('  其中组内有"没闭眼也没半截头"的照片：' + rescuable.length + ' 个 → 改挑法就能救')
    console.log('  其中组内有"一个瑕疵都没有"的照片：' + rescuableClean.length + ' 个 → 直接进库最干净')
    console.log('  剩下 ' + (noDeliveryGroups.length - rescuable.length) + ' 个组整组都是闭眼或半截头，按你的规则本来就不该进库')
    for (const g of noDeliveryGroups.slice(0, 6)) {
      console.log('  例：组' + g.length + '张 ' + g.slice(0, 5).map((it) => it.filename.replace(/\.[^.]+$/, '') + '[' + (flawList(it.tags).join('+') || '干净') + ']').join(' '))
    }
  }

  // ---- 检查2：现在留在库里的代表帧，是不是常常是闭眼/半截头那张（而组内有更好的）----
  let wrongPick = 0
  let wrongPickHard = 0
  const examples = []
  for (const g of groups) {
    const current = [...g].sort((a, b) => a.id - b.id)[0] // 现状规则：留最早导入那张
    const best = pick(g)
    if (best.id === current.id) continue
    wrongPick++
    const curHard = hasHard(current.tags)
    const bestHard = hasHard(best.tags)
    if (curHard && !bestHard) {
      wrongPickHard++
      if (examples.length < 10) examples.push({ g, current, best })
    }
  }
  console.log('\n【检查2】现状"留最早导入那张"跟你想要的"留最好那张"不一致的组：' + wrongPick + ' 个')
  console.log('  其中现状留下的那张带闭眼或半截头、而组里另有不闭眼不半截头的：' + wrongPickHard + ' 个（这是最刺眼的错）')
  for (const e of examples) {
    const f = (it) => it.filename.replace(/\.[^.]+$/, '') + '[' + (flawList(it.tags).join('+') || '干净') + (it.tier ? ' 档' + it.tier : '') + ']'
    console.log('  组' + e.g.length + '张：现在留 ' + f(e.current) + ' → 该留 ' + f(e.best))
  }

  // ---- 检查3：你亲手丢进重复废弃桶的 74 张里，新挑法会不会反而把它挑回来 ----
  const dupTrash = [...imgs.values()].filter((it) => it.cat === DUP_TRASH)
  const gOf = new Map()
  for (const g of groups) for (const it of g) gOf.set(it.id, g)
  let wouldRePick = 0
  for (const it of dupTrash) {
    const g = gOf.get(it.id)
    if (!g) continue
    if (pick(g).id === it.id) wouldRePick++
  }
  console.log('\n【检查3】你丢进重复废弃桶的照片共 ' + dupTrash.length + ' 张，其中新挑法会把它当成"组内最好"重新挑进库的：' + wouldRePick + ' 张')
  console.log('  （这些是你明确说"这张冗余不要"的，改动必须给你的人工决定让路）')

  // ---- 检查4：你否定过"不算重复"的 24 张，新挑法会不会又被当成冗余 ----
  const corr = q('SELECT image_id FROM corrections WHERE orig_dim = \'duplicate\' AND action = \'wrong\'')
  const rej = new Set(corr.map((c) => c[0]))
  let stillDup = 0
  let freed = 0
  for (const id of rej) {
    const it = imgs.get(id)
    if (!it) continue
    const g = gOf.get(id)
    if (!g) {
      freed++
      continue
    }
    if (pick(g).id === id) freed++
    else stillDup++
  }
  console.log('\n【检查4】你说"不算重复"的 ' + rej.size + ' 张里，改成"每组只留最好一张"后：不再被当冗余的 ' + freed + ' 张，仍被当冗余的 ' + stillDup + ' 张')
  console.log('  （仍被当冗余是因为它跟组内最好那张太像——这部分只能靠手脚姿态区分，见下一轮）')
})().catch((e) => {
  console.error('FAILED', e)
  process.exit(1)
})
