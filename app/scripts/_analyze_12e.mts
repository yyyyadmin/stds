/**
 * 一次性解析 V11 vs V12E 对拍：确认表情纯赢 + 半截头逐张=V11（没偷偷动半截头）。
 * 只读文件不改任何生产/真值，跑完可留档。
 */
import fs from 'node:fs'

const base = (p) => String(p).split(/[\\/]/).pop().toLowerCase()

function loadTruth(f) {
  const t = {}
  for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const r = JSON.parse(l)
    t[base(r.filename)] = { hh: r.half_head, ex: r.expression }
  }
  return t
}

function loadRaw(f) {
  // fn -> variant -> {hh, ex}
  const rows = {}
  for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const c = JSON.parse(l)
    if (!c.verdict) continue
    const fn = base(c.file)
    rows[fn] = rows[fn] || {}
    rows[fn][c.variant] = { hh: c.verdict.half_head, ex: c.verdict.expression }
  }
  return rows
}

function scoreDim(truth, rows, variant, key, trueKey) {
  let hit = 0, wrong = 0, miss = 0, totTrue = 0
  const hits = [], wrongs = [], misses = []
  for (const fn of Object.keys(truth)) {
    const tv = truth[fn][trueKey]
    if (tv === null || tv === undefined) continue
    const rv = rows[fn] && rows[fn][variant] && rows[fn][variant][key]
    if (rv === undefined) continue
    if (tv === true) {
      totTrue++
      if (rv === true) { hit++; hits.push(fn) } else { miss++; misses.push(fn) }
    } else {
      if (rv === true) { wrong++; wrongs.push(fn) }
    }
  }
  return { hit, totTrue, wrong, miss, hits, wrongs, misses }
}

function hhConsistency(truth, rows) {
  // 半截头维：V11 与 V12E 判得不一致的张（正文那句一字不差，理论上应全一致，只差模型跑动噪声）
  const diff = []
  for (const fn of Object.keys(truth)) {
    const a = rows[fn] && rows[fn]['v11-eyes-by-opening'] && rows[fn]['v11-eyes-by-opening'].hh
    const b = rows[fn] && rows[fn]['v12e-expression-only'] && rows[fn]['v12e-expression-only'].hh
    if (a !== undefined && b !== undefined && a !== b) diff.push(fn + ' V11:' + a + ' V12E:' + b)
  }
  return diff
}

const VV11 = 'v11-eyes-by-opening', VV12E = 'v12e-expression-only'
for (const [label, rawF, truthF] of [
  ['1016', 'scripts/out/ab-2026-10-16T07-57-13.raw.jsonl', 'scripts/out/truth-1016-eyes.jsonl'],
  ['couple1', 'scripts/out/ab-2026-10-16T07-58-15.raw.jsonl', 'scripts/out/truth-couple1-hhexpr.jsonl'],
]) {
  const truth = loadTruth(truthF)
  const rows = loadRaw(rawF)
  console.log('\n======== ' + label + ' ========')
  for (const v of [VV11, VV12E]) {
    const ex = scoreDim(truth, rows, v, 'ex', 'ex')
    const hh = scoreDim(truth, rows, v, 'hh', 'hh')
    console.log(v, '| 表情 认出' + ex.hit + '/' + ex.totTrue + ' 乱标' + ex.wrong + ' 漏' + ex.miss,
      '| 半截头 认出' + hh.hit + '/' + hh.totTrue + ' 乱标' + hh.wrong + ' 漏' + hh.miss)
  }
  const ex = scoreDim(truth, rows, VV12E, 'ex', 'ex')
  console.log('  V12E 表情命中:', ex.hits.join(',') || '(无)')
  console.log('  V12E 表情乱标:', ex.wrongs.join(',') || '(无)')
  console.log('  V12E 表情漏:', ex.misses.join(',') || '(无)')
  const diff = hhConsistency(truth, rows)
  console.log('  半截头 V11 vs V12E 判定不一致(应≈0，仅跑动噪声):', diff.length ? diff.join(' | ') : '完全一致')
}
