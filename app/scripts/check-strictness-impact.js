/**
 * 力度档影响面核查（开发者离线用，不进包）
 * 问题：切"宽松 / 标准 / 严格"会不会动到检测本身？会不会动到人数分类、黑白、重复这些事实结论？
 * 做法：拿真实库里已存的 confidence，逐维度算三个档位下的 level，看谁会变。
 * 用法：node scripts/check-strictness-impact.js
 */
const fs = require('fs')
const path = require('path')

const BAD_DIMS = ['eyes_closed', 'face_ugly', 'blur', 'exposure', 'half_head', 'duplicate']
const PERSON_DIMS = ['single_person', 'group_photo', 'mixed_photo', 'no_person']
// 与 src/shared/types.ts FACT_DIMENSIONS / BASELINE_THRESHOLDS 保持一致
const FACT = [...PERSON_DIMS, 'black_white', 'duplicate']
const BASELINE = { eyes_closed: [0.7, 0.95], face_ugly: [0.7, 0.82], blur: [0.6, 0.88], exposure: [0.55, 0.8], half_head: [0.7, 0.9] }
const DM = 0.55, DH = 0.8
const PRESETS = { '宽松': [0.8, 0.93], '标准': [0.7, 0.9], '严格(默认)': [0.55, 0.8] }
/** 滑条极限（SettingsDialog 里 range 的真实上下界） */
const SLIDER = { 'high 拉到最低 0.50': [0.3, 0.5], 'high 拉到最高 0.99': [0.95, 0.99] }

/** 复刻 classify.effectiveThresholds（含 v2：事实/结构维度不吃平移、不吃自学习） */
function thr(dim, mid, high) {
  if (FACT.includes(dim)) return [DM, DH]
  const anchor = BASELINE[dim]
  if (!anchor) return [mid, high]
  const d = ((mid - DM) + (high - DH)) / 2
  let m = anchor[0] + d
  let h = anchor[1] + d
  h = Math.min(0.99, Math.max(0.5, h))
  m = Math.min(h - 0.05, Math.min(0.95, Math.max(0.3, m)))
  return [Number(m.toFixed(3)), Number(h.toFixed(3))]
}
const level = (c, [m, h]) => (c > h ? 'high' : c >= m ? 'mid' : 'low')

;(async () => {
  const dbPath = path.join(process.env.APPDATA || '', 'screener-master', 'data', 'screener.db')
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs()
  const db = new SQL.Database(fs.readFileSync(dbPath))
  const stRows = db.exec('SELECT key, value FROM settings')
  const st = Object.fromEntries(stRows[0] ? stRows[0].values : [])
  if (st.highThreshold !== undefined || st.midThreshold !== undefined) {
    const m = Number(st.midThreshold), h = Number(st.highThreshold)
    console.log(`当前库里设置：scene=${st.scene} mid=${m} high=${h}（档位=${Object.entries(PRESETS).find(([, v]) => v[0] === m && v[1] === h)?.[0] ?? '自定义'}）`)
    console.log(`tunedThresholds（自学习覆盖）：${st.tunedThresholds ?? '无'}\n`)
  }
  const res = db.exec("SELECT tags FROM images WHERE status = 'done'")
  const rows = res[0] ? res[0].values.map((v) => { try { return JSON.parse(v[0] || '{}') } catch { return {} } }) : []
  console.log(`库内 status=done ${rows.length} 张\n`)

  const ALL = [...BAD_DIMS, ...PERSON_DIMS, 'black_white']
  console.log('=== 逐维度：换档会让多少张图的判定级别变（基线=严格档；事实/结构维度应永远为 0）===')
  console.log('维度             有信号  宽松变化  标准变化  |  滑条0.50  滑条0.99  | 分数区间')
  for (const dim of ALL) {
    const confs = []
    for (const t of rows) {
      const v = t[dim]
      if (v && typeof v.confidence === 'number' && v.confidence > 0) confs.push({ c: v.confidence, user: v.method === 'user' })
    }
    if (!confs.length) {
      console.log(`${dim.padEnd(15)} ${String(0).padStart(6)}  ——引擎从未给出分数`)
      continue
    }
    const base = confs.map((x) => level(x.c, thr(dim, DM, DH)))
    const countDiff = (mid, high) => {
      const t = thr(dim, mid, high)
      return confs.reduce((s, x, i) => s + (level(x.c, t) !== base[i] ? 1 : 0), 0)
    }
    const min = Math.min(...confs.map((x) => x.c))
    const max = Math.max(...confs.map((x) => x.c))
    const tag = BAD_DIMS.includes(dim) ? (BASELINE[dim] ? '瑕疵·有基线' : '瑕疵·常量') : PERSON_DIMS.includes(dim) ? '人数·结构' : '事实·常量'
    console.log(
      `${dim.padEnd(15)} ${String(confs.length).padStart(6)}  ${String(countDiff(...PRESETS['宽松'])).padStart(8)}  ${String(countDiff(...PRESETS['标准'])).padStart(8)}  | ${String(countDiff(...SLIDER['high 拉到最低 0.50'])).padStart(8)}  ${String(countDiff(...SLIDER['high 拉到最高 0.99'])).padStart(8)}  | ${min.toFixed(3)}~${max.toFixed(3)}  ${tag}`
    )
  }

  console.log('\n=== 方向性检查：被 AI 拦下（任一瑕疵维度 high 或 mid）的图数 ===')
  for (const [name, [mid, high]] of Object.entries(PRESETS)) {
    let held = 0
    for (const t of rows) {
      let stop = false
      for (const dim of BAD_DIMS) {
        const v = t[dim]
        if (!v || !(v.confidence > 0)) continue
        if (v.method === 'user') { if (v.level === 'high' || v.level === 'mid') stop = true; continue }
        const [m, h] = thr(dim, mid, high)
        if (v.confidence > h || v.confidence >= m) { stop = true; break }
      }
      if (stop) held++
    }
    console.log(`  ${name.padEnd(12)} AI 拦下 ${held} 张 / ${rows.length} 张`)
  }
  db.close()
})()
