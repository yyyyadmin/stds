/**
 * 离线标定分析（一次性把阈值做好的工具，开发者用，不进包）
 * 用法：node scripts/analyze-calib.js [calib.jsonl路径]
 *
 * 为什么不用分位数：引擎各维度的置信度不是连续同分布的量纲，而是"码内台阶"
 *   （eyes 1.0/0.82/0.75/0.38、blur 饱和 0.85、half_head 饱和 0.98、bw 0.897 …）。
 *   对台阶数据取 p95 会把阈值正好落在某个台阶上，导致同一档图被随机劈成两半。
 * 正确做法：在"相邻台阶的空隙"里选切点，并看每个切点带来的后果——
 *   标瑕疵量（>high）、待确认量（[mid,high]）、以及被"降级"的台阶上用户的真实态度。
 *
 * 证据口径（只认用户亲手盖章的两类）：
 *   放行到交付库(libUser) = 这张其实是好片 → 该台阶不该标瑕疵
 *   丢进废弃库(trashUser) = 这张确实是废片 → 该台阶该标
 *   AI 判定未动(untouched) ≠ 认可，只是没看，不参与判断。
 */
const fs = require('fs')
const path = require('path')

const CALIB_DEFAULT = path.join(__dirname, '..', '..', '归档', '2026-10-12-couple1-v2.0.64', 'calib-v2.0.64-20261011-182636.jsonl')
const calibPath = process.argv[2] || CALIB_DEFAULT

/** 坏维度：会决定"标瑕疵/进待确认"的那些 */
const BAD_DIMS = ['eyes_closed', 'blur', 'exposure', 'half_head', 'face_ugly', 'duplicate']

;(async () => {
  if (!fs.existsSync(calibPath)) {
    console.error('找不到校准文件：' + calibPath)
    process.exit(1)
  }
  const lines = fs.readFileSync(calibPath, 'utf8').split('\n').filter(Boolean)
  const meta = JSON.parse(lines[0])
  const rows = lines.slice(1).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  console.log(`=== ${path.basename(calibPath)} | v${meta.ver} 场景 ${meta.scene} 全局 mid=${meta.mid}/high=${meta.high} | ${rows.length} 张 ===`)
  console.log('（scene 预设已覆盖的维度会优先用它自己的阈值，全局值不生效）\n')

  for (const dim of BAD_DIMS) {
    /** 台阶表：conf -> 计数 */
    const lv = {}
    for (const r of rows) {
      const d = (r.d || {})[dim]
      if (!d || !(d[0] > 0)) continue
      const k = Math.round(d[0] * 1000) / 1000
      const c = (lv[k] ||= { n: 0, lib: 0, trash: 0, recl: 0, untouched: 0 })
      c.n++
      if (r.by === 'user') {
        if (r.cat === 'library') c.lib++
        else if (r.cat === 'trash' || r.cat === 'dup_trash') c.trash++
        else c.recl++
      } else c.untouched++
    }
    const levels = Object.keys(lv).map(Number).sort((a, b) => b - a)
    if (!levels.length) { console.log(`### ${dim}: 无信号\n`); continue }
    const total = levels.reduce((s, k) => s + lv[k].n, 0)
    // 台阶合并：把相距 <0.02 的相邻值并成一档（blur 的 0.83~0.85 是一坨连续微差，不是一个台阶）
    const merged = []
    for (const k of levels) {
      const top = merged[merged.length - 1]
      if (top && top.hi - k < 0.02) {
        top.hi = top.hi; top.lo = k
        for (const f of ['n', 'lib', 'trash', 'recl', 'untouched']) top[f] += lv[k][f]
      } else merged.push({ hi: k, lo: k, n: 0, lib: 0, trash: 0, recl: 0, untouched: 0, ...lv[k] })
    }
    console.log(`### ${dim}（有信号 ${total} 张，合并后 ${merged.length} 档）`)
    for (const m of merged) {
      const tag = m.hi === m.lo ? `${m.hi.toFixed(3)}` : `${m.lo.toFixed(3)}~${m.hi.toFixed(3)}`
      const mark = m.lib + m.trash + m.recl === 0 ? '' : `  ← 用户盖章：放行${m.lib} 丢桶${m.trash} 改判${m.recl}`
      console.log(`  档 ${tag.padEnd(12)} n=${String(m.n).padStart(4)} 未动=${String(m.untouched).padStart(4)}${mark}`)
    }
    // 候选切点：每两档之间的空隙，high 取上一个档的下沿、mid 取更高一档的上沿
    console.log('  候选阈值（high=把 ≥该档 直接标瑕疵；mid=把 ≥该档 进待确认）：')
    for (let hi = 0; hi < merged.length; hi++) {
      for (let mi = hi; mi < Math.min(merged.length, hi + 4); mi++) {
        const highCut = merged[hi].lo - 0.005
        const midCut = merged[mi].lo - 0.005
        let toFlaw = 0, toReview = 0, missedLib = 0
        for (let i = 0; i < merged.length; i++) {
          const m = merged[i]
          if (m.lo - 0.005 >= highCut) { toFlaw += m.n; missedLib += m.lib }
          else if (m.lo - 0.005 >= midCut) { toReview += m.n; missedLib += m.lib }
        }
        if (mi === hi) console.log(`    high@${merged[hi].hi.toFixed(3)}档 mid同档 → 标瑕疵${toFlaw} 待确认${toReview}（其中放行过的好片 ${missedLib}）`)
        else console.log(`    high≥${merged[hi].lo.toFixed(3)} mid≥${merged[mi].lo.toFixed(3)} → 标瑕疵${toFlaw} 待确认${toReview}（误伤好片${missedLib}）`)
      }
      if (hi > 3) { console.log('    …（更低优先的切点省略）'); break }
    }
    console.log('')
  }

  // ---------- 2. 新旧配置全库模拟（直接吃同一份真实判定分布，不重跑引擎） ----------
  // 旧：场景 wedding 的绝对覆盖优先，没覆盖的维度（exposure/half_head/face_ugly）落回全局一对数
  const OLD_WEDDING = { eyes_closed: [0.6, 0.85], blur: [0.6, 0.85], duplicate: [0.6, 0.9] }
  // 必须与 src/shared/types.ts 的 BASELINE_THRESHOLDS 保持一致（手改两处最容易漂，改完跑本脚本对账）。
  // duplicate / 人数四维 / 黑白故意不进表：它们给的是常量分数，阈值只能"全开/全关"，平移会把重复图
  // 整段从瑕疵塌进待确认（实测待确认 473→1546），所以沿用全局一对数即可恒高触发。
  const NEW_BASE = { eyes_closed: [0.7, 0.95], face_ugly: [0.7, 0.82], blur: [0.6, 0.88], exposure: [0.55, 0.8], half_head: [0.7, 0.9] }
  const STRICTNESS = { '宽松': [0.8, 0.93], '标准': [0.7, 0.9], '严格(默认)': [0.55, 0.8] }
  const DM = 0.55, DH = 0.8

  /** 按给定阈表算：至少一个坏维度 high 的图（被标瑕疵）/ 无 high 但有 mid 的图（进待确认） */
  function simulate(thrOf) {
    let flaw = 0, review = 0
    for (const r of rows) {
      let anyHigh = false, anyMid = false
      for (const dim of BAD_DIMS) {
        const d = (r.d || {})[dim]
        if (!d || !(d[0] > 0)) continue
        const [mid, high] = thrOf(dim)
        const c = d[0]
        if (c > high) anyHigh = true
        else if (c >= mid) anyMid = true
      }
      if (anyHigh) flaw++
      else if (anyMid) review++
    }
    return { flaw, review }
  }

  console.log('=== 全库模拟（' + rows.length + ' 张，同一批已存判定分数，不重新检测）===')
  for (const [name, [mid, high]] of Object.entries(STRICTNESS)) {
    const s = simulate((dim) => OLD_WEDDING[dim] || [mid, high])
    console.log(`  旧（婚礼覆盖 + 一对全局阈值・${name.padEnd(8)}）→ 被标瑕疵 ${s.flaw} 张，进待确认 ${s.review} 张`)
  }
  console.log('')
  for (const [name, [mid, high]] of Object.entries(STRICTNESS)) {
    const d = ((mid - DM) + (high - DH)) / 2
    const sim = simulate((dim) => {
      const b = NEW_BASE[dim]
      if (!b) return [mid, high]
      const h = Math.min(0.99, Math.max(0.5, b[1] + d))
      const m = Math.min(h - 0.05, Math.min(0.95, Math.max(0.3, b[0] + d)))
      return [m, h]
    })
    console.log(`  新（台阶基线·刚性平移・${name.padEnd(8)}）→ 被标瑕疵 ${sim.flaw} 张，进待确认 ${sim.review} 张`)
  }

  // ---------- 3. 用真实库当前已存分数复算一遍（证明标定不需要"清空重导"） ----------
  // calib jsonl 只是某一次筛选的快照；库里 tags[dim].confidence 一直存着引擎原始分，
  // 阈值只是拿去切这些数，所以想吃"现在的库"直接读 SQLite 即可，不必重跑检测。
  const dbPath = path.join(process.env.APPDATA || '', 'screener-master', 'data', 'screener.db')
  if (fs.existsSync(dbPath)) {
    const initSqlJs = require('sql.js')
    const SQL = await initSqlJs()
    const ldb = new SQL.Database(fs.readFileSync(dbPath))
    const res = ldb.exec("SELECT tags FROM images WHERE status = 'done'")
    const dbRows = res[0] ? res[0].values.map((v) => { try { return JSON.parse(v[0] || '{}') } catch { return {} } }) : []
    console.log('')
    console.log(`=== 真实库当前已存判定复算（${path.basename(dbPath)}，${dbRows.length} 张 status=done）===`)
    if (fs.existsSync(dbPath + '-wal')) {
      console.log('  ⚠ 检测到 WAL 日志（应用正在跑），主文件可能还没包含最新写入，以下数字仅供对账。')
    }
    for (const [name, [mid, high]] of Object.entries(STRICTNESS)) {
      const d = ((mid - DM) + (high - DH)) / 2
      let flaw = 0, review = 0, userKept = 0
      for (const tags of dbRows) {
        let anyHigh = false, anyMid = false
        for (const dim of BAD_DIMS) {
          const t = tags[dim]
          if (!t || !(t.confidence > 0)) continue
          // 与 scanner.regradeAll 同口径：人工标签（method:'user'）不受阈值约束，
          // 按它存下来的 level 原样计入——不是“忽略”，忽略会把人判的废片算成好片。
          if (t.method === 'user') {
            if (t.level === 'high') anyHigh = true
            else if (t.level === 'mid') anyMid = true
            userKept++
            continue
          }
          const b = NEW_BASE[dim]
          const [m, h] = b
            ? [Math.min(Math.min(0.99, Math.max(0.5, b[1] + d)) - 0.05, Math.min(0.95, Math.max(0.3, b[0] + d))), Math.min(0.99, Math.max(0.5, b[1] + d))]
            : [mid, high]
          if (t.confidence > h) anyHigh = true
          else if (t.confidence >= m) anyMid = true
        }
        if (anyHigh) flaw++
        else if (anyMid) review++
      }
      console.log(`  ${name.padEnd(10)} → 被标瑕疵 ${flaw} 张，进待确认 ${review} 张（其中人工标签直接计入的图命中 ${userKept} 次）`)
    }
    ldb.close()
  }
})()
