/**
 * 档位 v2 标定：把 reason 里的原始连续量解析出来看真实分布（开发者离线用，不进包）
 * 现状问题：scoreTier 用「离瑕疵线的安全距离」分档，干净图恒等于最大档 → 优质占 95%，三档形同虚设。
 * 新依据候选：
 *   blur     reason = 清晰度方差 139(full) 高频占比 0.5650
 *   exposure reason = 亮度均值 38.2 std 31.3 高光 0.00 暗部 0.20 -> 过曝
 * 切点必须来自真实分位数，所以先统计“交付库候选”（flawLevel=none）上的分布。
 * 用法：node scripts/tier-v2-distribution.js
 */
const fs = require('fs')
const path = require('path')

const BAD_DIMS = ['eyes_closed', 'face_ugly', 'blur', 'exposure', 'half_head', 'duplicate']
// 与 shared/types.ts 保持一致：事实/结构维度不吃力度平移，档位只看瑕疵维基线
const BASELINE = { eyes_closed: [0.7, 0.95], face_ugly: [0.7, 0.82], blur: [0.6, 0.88], exposure: [0.55, 0.8], half_head: [0.7, 0.9] }
const FACT = ['single_person', 'group_photo', 'mixed_photo', 'no_person', 'black_white', 'duplicate']
const DM = 0.55, DH = 0.8

function thr(dim, mid, high) {
  if (FACT.includes(dim)) return [DM, DH]
  const b = BASELINE[dim]
  if (!b) return [mid, high]
  const d = ((mid - DM) + (high - DH)) / 2
  const h = Math.min(0.99, Math.max(0.5, b[1] + d))
  const m = Math.min(h - 0.05, Math.min(0.95, Math.max(0.3, b[0] + d)))
  return [Number(m.toFixed(3)), Number(h.toFixed(3))]
}
const levelOf = (c, high, mid) => (c >= high ? 'high' : c >= mid ? 'mid' : 'low')

// 中文字面量全部用转义写：这份输出走 PowerShell 管道时会被 GBK 控制台二次解码，
// 正则里裸的“清晰度方差”匹配不上 mojibake 字符串。
const T_VARIANCE = '\u6e05\u6670\u5ea6\u65b9\u5dee' // 清晰度方差
const T_HF = '\u9ad8\u9891\u5360\u6bd4' // 高频占比
const T_MEAN = '\u4eae\u5ea6\u5747\u503c' // 亮度均值
const T_HI = '\u9ad8\u5149' // 高光
const T_DARK = '\u6697\u90e8' // 暗部
const RE_BLUR = new RegExp(T_VARIANCE + '\\s*(-?\\d+(?:\\.\\d+)?)\\((full|face)\\)\\s*' + T_HF + '\\s*(-?\\d+(?:\\.\\d+)?)')
const RE_EXP = new RegExp(T_MEAN + '\\s*(-?\\d+(?:\\.\\d+)?)\\s*std\\s*(-?\\d+(?:\\.\\d+)?)\\s*' + T_HI + '\\s*(-?\\d+(?:\\.\\d+)?)\\s*' + T_DARK + '\\s*(-?\\d+(?:\\.\\d+)?)')

function pct(name, arr) {
  if (!arr.length) { console.log(`  ${name.padEnd(16)} 无样本`); return }
  const a = [...arr].sort((x, y) => x - y)
  const q = (p) => a[Math.min(a.length - 1, Math.floor(a.length * p))]
  console.log(
    `  ${name.padEnd(16)} n=${String(a.length).padEnd(5)} ` +
    `p5=${q(0.05).toFixed(3)} p25=${q(0.25).toFixed(3)} 中位=${q(0.5).toFixed(3)} ` +
    `p75=${q(0.75).toFixed(3)} p90=${q(0.9).toFixed(3)} p95=${q(0.95).toFixed(3)} max=${a[a.length - 1].toFixed(3)}`
  )
}

;(async () => {
  const dbPath = path.join(process.env.APPDATA || '', 'screener-master', 'data', 'screener.db')
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs()
  const db = new SQL.Database(fs.readFileSync(dbPath))
  const st = Object.fromEntries((db.exec('SELECT key, value FROM settings')[0]?.values || []))
  const mid = Number(st.midThreshold ?? DM), high = Number(st.highThreshold ?? DH)
  const res = db.exec("SELECT filename, tags FROM images WHERE status = 'done'")
  const rows = (res[0]?.values || []).map((v) => ({ file: v[0], tags: (() => { try { return JSON.parse(v[1] || '{}') } catch { return {} } })() }))

  // 交付库候选：AI 侧没有任何中/高瑕疵
  const cand = rows.filter((r) => {
    return !BAD_DIMS.some((d) => {
      const t = r.tags[d]
      if (!t || t.method === 'user') return false
      const [m2, h2] = thr(d, mid, high)
      return levelOf(t.confidence, h2, m2) !== 'low'
    })
  })
  console.log(`库内 done ${rows.length} 张 · 交付库候选（无任何瑕疵标签）${cand.length} 张\n`)

  const groups = { varFace: [], varFull: [], hp: [], hpFace: [], hpFull: [], mean: [], std: [], hi: [], lo: [], darkRatio: [] }
  let noBlur = 0, noExp = 0
  for (const r of cand) {
    const b = (r.tags.blur?.reason || '').match(RE_BLUR)
    if (b) {
      const v = Number(b[1]), hpr = Number(b[3])
      if (b[2] === 'face') { groups.varFace.push(v); groups.hpFace.push(hpr) }
      else { groups.varFull.push(v); groups.hpFull.push(hpr) }
      groups.hp.push(hpr)
    } else noBlur++
    const e = (r.tags.exposure?.reason || '').match(RE_EXP)
    if (e) {
      const mean = Number(e[1]), std = Number(e[2]), hi = Number(e[3]), lo = Number(e[4])
      groups.mean.push(mean); groups.std.push(std); groups.hi.push(hi); groups.lo.push(lo)
      groups.darkRatio.push(hi + lo)
    } else noExp++
  }
  console.log(`blur reason 解析失败 ${noBlur} 张 / exposure reason 解析失败 ${noExp} 张`)
  // 解析失败到底是“根本没这个标签”还是“格式不同”——决定新档位能覆盖多少图
  const failBlur = cand.filter((r) => !RE_BLUR.test(r.tags.blur?.reason || '')).slice(0, 3)
  for (const r of failBlur) console.log(`   [blur \u5931\u8d25\u6837\u672c] ${r.file} tag=${r.tags.blur ? 'conf=' + r.tags.blur.confidence + ' reason=' + r.tags.blur.reason : '\u65e0\u6807\u7b7e'}`)
  const failExp = cand.filter((r) => !RE_EXP.test(r.tags.exposure?.reason || '')).slice(0, 3)
  for (const r of failExp) console.log(`   [exposure \u5931\u8d25\u6837\u672c] ${r.file} tag=${r.tags.exposure ? 'conf=' + r.tags.exposure.confidence + ' reason=' + r.tags.exposure.reason : '\u65e0\u6807\u7b7e'}`)
  console.log('\n=== 清晰度（拉普拉斯方差：越大越锐）===')
  pct('方差 face', groups.varFace)
  pct('方差 full', groups.varFull)
  console.log('\n=== 高频占比（0~1）===')
  pct('占比 face', groups.hpFace)
  pct('占比 full', groups.hpFull)
  console.log('\n=== 曝光 ===')
  pct('亮度均值', groups.mean)
  pct('std', groups.std)
  pct('高光溢出', groups.hi)
  pct('暗部死黑', groups.lo)
  pct('高光+暗部', groups.darkRatio)

  // 关键校验：这些量和「引擎给的模糊置信度」到底有没有相关性——没相关性就不能拿来分档
  console.log('\n=== 与置信度的相关性（Spearman 简化版：按方差十分位的平均 conf）===')
  const withV = cand.map((r) => {
    const b = (r.tags.blur?.reason || '').match(RE_BLUR)
    return b ? { v: Number(b[1]), conf: r.tags.blur?.confidence ?? 0 } : null
  }).filter(Boolean)
  const sorted = [...withV].sort((a, b) => a.v - b.v)
  const N = 10
  for (let i = 0; i < N; i++) {
    const slice = sorted.slice(Math.floor((i * sorted.length) / N), Math.floor(((i + 1) * sorted.length) / N))
    if (!slice.length) continue
    const avgV = slice.reduce((s, x) => s + x.v, 0) / slice.length
    const avgC = slice.reduce((s, x) => s + x.conf, 0) / slice.length
    console.log(`  第${i + 1}档 方差均值=${avgV.toFixed(1).padStart(7)} → blur 置信度均值=${avgC.toFixed(3)}`)
  }
  const withE = cand.map((r) => {
    const e = (r.tags.exposure?.reason || '').match(RE_EXP)
    return e ? { dark: Number(e[3]) + Number(e[4]), conf: r.tags.exposure?.confidence ?? 0 } : null
  }).filter(Boolean)
  const se = [...withE].sort((a, b) => a.dark - b.dark)
  console.log('\n  曝光侧同样十分位：')
  for (let i = 0; i < N; i += 2) {
    const slice = se.slice(Math.floor((i * se.length) / N), Math.floor(((i + 2) * se.length) / N))
    if (!slice.length) continue
    const avgD = slice.reduce((s, x) => s + x.dark, 0) / slice.length
    const avgC = slice.reduce((s, x) => s + x.conf, 0) / slice.length
    console.log(`  第${i + 1}-${i + 2}档 高光+暗部均值=${avgD.toFixed(3)} → exposure 置信度均值=${avgC.toFixed(3)}`)
  }

  // ===== 新档位公式模拟 =====
  // 锐度分 = 0.65 x 方差（对数归一，因为方差跨 200 倍）+ 0.35 x 高频占比（线性归一）
  // 锚点取上面实测的 p5 / p90，face 与 full 两套口径分开归一（同值不同义，不能混用）
  const ANCHOR = {
    face: { vLo: 27, vHi: 1073, hLo: 0.49, hHi: 0.71 },
    full: { vLo: 34, vHi: 634, hLo: 0.467, hHi: 0.683 }
  }
  const clamp01 = (x) => Math.min(1, Math.max(0, x))
  function sharpOf(tags) {
    const m = (tags.blur?.reason || '').match(RE_BLUR)
    if (!m) return null
    const a = ANCHOR[m[2]] || ANCHOR.face
    const v = Math.max(1, Number(m[1]))
    const lv = (Math.log10(v) - Math.log10(a.vLo)) / (Math.log10(a.vHi) - Math.log10(a.vLo))
    const lh = (Number(m[3]) - a.hLo) / (a.hHi - a.hLo)
    return clamp01(0.65 * clamp01(lv) + 0.35 * clamp01(lh))
  }
  const scored = cand.map((r) => ({ file: r.file, s: sharpOf(r.tags) })).filter((x) => x.s !== null)
  const noMeasure = cand.length - scored.length
  const sv = scored.map((x) => x.s).sort((a, b) => a - b)
  const q = (p) => sv[Math.min(sv.length - 1, Math.floor(sv.length * p))]
  console.log(`\n=== 锐度分 S 分布（有实测 ${scored.length} 张 / 无实测 ${noMeasure} 张）===`)
  console.log(`  p10=${q(0.1).toFixed(3)} p25=${q(0.25).toFixed(3)} p35=${q(0.35).toFixed(3)} p50=${q(0.5).toFixed(3)} p65=${q(0.65).toFixed(3)} p70=${q(0.7).toFixed(3)} p80=${q(0.8).toFixed(3)} p90=${q(0.9).toFixed(3)}`)
  for (const [hi, lo] of [[0.7, 0.35], [0.65, 0.3], [q(0.7), q(0.35)], [q(0.8), q(0.4)]]) {
    const t1 = scored.filter((x) => x.s >= hi).length + 0
    const t2 = scored.filter((x) => x.s >= lo && x.s < hi).length
    const t3 = scored.filter((x) => x.s < lo).length
    console.log(`  切点 优质≥${hi.toFixed(3)} 良好≥${lo.toFixed(3)} → 优质 ${t1} / 良好 ${t2} / 一般 ${t3} + 无实测归良好 ${noMeasure}`)
  }
  console.log('\n=== 你手动降过档那 3 张在新公式下的锐度分 ===')
  for (const name of ['7G1A7319.JPG', 'CHEN9904.JPG', 'CHEN9910.JPG']) {
    const r = rows.find((x) => x.file === name)
    if (!r) { console.log(`  ${name} 不在库`); continue }
    const s = sharpOf(r.tags)
    console.log(`  ${name.padEnd(20)} S=${s === null ? '无实测' : s.toFixed(3)} 全部标签= ${JSON.stringify(r.tags).slice(0, 220)}`)
  }

  // 无实测那批到底是什么：全部没标签 / 有曝光没模糊 / reason 格式不对——影响新档位的兜底策略
  const unmeasured = cand.filter((r) => sharpOf(r.tags) === null)
  const noTagAtAll = unmeasured.filter((r) => !Object.keys(r.tags).length).length
  const hasExpNoBlur = unmeasured.filter((r) => r.tags.exposure && !r.tags.blur).length
  const hasBlurNoParse = unmeasured.filter((r) => r.tags.blur && r.tags.blur.method !== 'user' && !RE_BLUR.test(r.tags.blur.reason || '')).length
  const userOnly = unmeasured.filter((r) => r.tags.blur?.method === 'user' || r.tags.half_head?.method === 'user' || r.tags.eyes_closed?.method === 'user').length
  console.log(`\n=== 无实测 ${unmeasured.length} 张拆开看 ===`)
  console.log(`  标签完全为空 ${noTagAtAll} 张 / 有曝光无模糊 ${hasExpNoBlur} 张 / 有模糊标签但 reason 解析不出 ${hasBlurNoParse} 张 / 带人工标签 ${userOnly} 张`)
  for (const r of unmeasured.slice(0, 6)) console.log(`  样本 ${String(r.file).padEnd(20)} tags=${JSON.stringify(r.tags).slice(0, 150)}`)
  db.close()
})()
