/**
 * "重复/连拍 = 同一次拍摄的冗余帧"假设验证（只读原图 EXIF，不写库）
 *
 * 试点数据否定了姿态门（AUC 全在 0.34~0.53，方向还普遍反着：你判"是重复"的那批
 * 头部偏航/站位/表情差异反而更大）。这提示你的判据不是画面差异，而是拍摄序列：
 * 同一次按下的连拍帧 = 重复；不同时刻摆的不同动作 = 不是重复，哪怕看起来很像。
 *
 * 本脚本回答：EXIF 拍摄时间差、快门序号差、文件名序号差，哪个能分开你这两群。
 * 用法：node scripts/dup-time-probe.js
 */
const fs = require('fs')
const path = require('path')
const exifr = require('exifr')

const HAM_MAX = 9

function ham(a, b) {
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

const serial = (name) => {
  const m = String(name).match(/(\d+)(?=\.\w+$)/)
  return m ? parseInt(m[1], 10) : null
}

/** exifr 的时间 + 亚秒，凑成可比的绝对时间（相机没写时区，同场拍摄用差值就够） */
async function stampOf(file) {
  let ex = null
  try {
    ex = await exifr.parse(file, ['DateTimeOriginal', 'CreateDate', 'SubSecTimeOriginal', 'SubSecTimeDigitized', 'offsetTimeOriginal', 'ShutterSpeedValue'])
  } catch {
    /* 容器不支持时静默 */
  }
  const pick = (o, k) => (o && o[k] !== undefined && o[k] !== null ? o[k] : o ? o[k.toLowerCase()] : undefined)
  const dt = (ex && (pick(ex, 'DateTimeOriginal') || pick(ex, 'CreateDate'))) || null
  if (!dt) return null
  const base = dt instanceof Date ? dt.getTime() : Date.parse(String(dt))
  const sub = pick(ex, 'SubSecTimeOriginal') ?? pick(ex, 'SubSecTimeDigitized')
  let extra = 0
  if (typeof sub === 'number') extra = sub / 1000
  else if (typeof sub === 'string') {
    const s = parseFloat('0.' + sub.replace(/^0+/, ''))
    if (!isNaN(s)) extra = s
  }
  return { ms: base + extra * 1000, hasSub: extra !== 0, raw: ex }
}

;(async () => {
  const list = JSON.parse(fs.readFileSync(path.join(__dirname, '_pilot_list.json'), 'utf8'))
  const poseRaw = JSON.parse(fs.readFileSync(path.join(__dirname, '_pilot_pose.json'), 'utf8'))
  const poseById = new Map(poseRaw.map((p) => [p.id, p]))
  console.log('试点 ' + list.length + ' 张，逐张读 EXIF 时间…')

  const recs = []
  let noExif = 0
  for (const it of list) {
    const s = await stampOf(it.path)
    if (!s) {
      noExif++
      continue
    }
    recs.push({ id: it.id, filename: it.filename, label: it.label, dir: path.dirname(it.path), ms: s.ms, hasSub: s.hasSub, serial: serial(it.filename), phash: poseById.get(it.id)?.phash || it.phash })
  }
  console.log('拿到时间 ' + recs.length + ' 张 · 无 EXIF 时间 ' + noExif + ' 张 · 其中带亚秒精度 ' + recs.filter((r) => r.hasSub).length + ' 张')

  const pairs = []
  for (let i = 0; i < recs.length; i++) {
    for (let j = i + 1; j < recs.length; j++) {
      const a = recs[i]
      const b = recs[j]
      if (a.dir !== b.dir) continue
      const h = ham(a.phash, b.phash)
      if (h > HAM_MAX) continue
      const lab = new Set([a.label, b.label])
      let tag
      if (lab.has('rej') && (lab.has('ok') || lab.has('add'))) tag = 'amb'
      else if (lab.has('rej')) tag = 'NOT_DUP'
      else if (lab.has('ok') || lab.has('add')) tag = 'DUP'
      else tag = 'ctx'
      const dt = Math.abs(a.ms - b.ms) / 1000 // 秒
      const dser = a.serial != null && b.serial != null ? Math.abs(a.serial - b.serial) : null
      pairs.push({ tag, a, b, h, dt, dser })
    }
  }
  const cnt = {}
  for (const p of pairs) cnt[p.tag] = (cnt[p.tag] || 0) + 1
  console.log('可打分配对 ' + pairs.length + '：' + JSON.stringify(cnt))

  const dist = (vals) => {
    const v = vals.filter((x) => x != null && isFinite(x)).sort((x, y) => x - y)
    if (!v.length) return '无数据'
    const f = (x) => (x >= 100 ? x.toFixed(0) : x.toFixed(2))
    const p75 = v[Math.max(0, Math.min(v.length - 1, Math.floor(v.length * 0.75) - 1))]
    return 'n=' + v.length + ' min=' + f(v[0]) + ' 中位=' + f(v[Math.floor(v.length / 2)]) + ' p75=' + f(p75) + ' max=' + f(v[v.length - 1])
  }
  const auc = (dupVals, notVals, biggerIsNotDup) => {
    const d = dupVals.filter((x) => x != null && isFinite(x))
    const n = notVals.filter((x) => x != null && isFinite(x))
    if (!d.length || !n.length) return null
    let win = 0
    let tie = 0
    let tot = 0
    for (const x of n) {
      for (const y of d) {
        tot++
        const ok = biggerIsNotDup ? x > y : x < y
        if (ok) win++
        else if (x === y) tie++
      }
    }
    return (win + 0.5 * tie) / tot
  }

  const dup = pairs.filter((p) => p.tag === 'DUP')
  const notd = pairs.filter((p) => p.tag === 'NOT_DUP')
  console.log('\n=== 表1：时间/序列特征（预期：DUP 的时间差小、NOT_DUP 的时间差大）===')
  for (const [key, cn, bigger] of [['dt', '拍摄时间差(秒)', true], ['dser', '文件名序号差', true], ['h', 'phash 汉明差(参照)', true]]) {
    const dv = dup.map((p) => p[key])
    const nv = notd.map((p) => p[key])
    const a = auc(dv, nv, bigger)
    console.log(cn.padEnd(16) + ' DUP:   ' + String(dist(dv)).padEnd(42))
    console.log(''.padEnd(16) + ' NOT:   ' + String(dist(nv)).padEnd(42) + ' AUC=' + (a == null ? 'n/a' : a.toFixed(2)))
  }

  console.log('\n=== 表2：把"时间差"当闸门的收益（时间差 > T 秒就不算重复）===')
  console.log('T(秒)  救回NOT_DUP  误放DUP  净收益   备注')
  for (const T of [0.1, 0.3, 0.5, 1, 2, 3, 5, 10, 30, 60]) {
    const saved = notd.filter((p) => p.dt > T).length
    const lost = dup.filter((p) => p.dt > T).length
    console.log(String(T).padStart(5) + '   ' + String(saved).padStart(6) + '/' + notd.length + '   ' + String(lost).padStart(4) + '/' + dup.length + '   ' + String(saved - lost).padStart(4) + (saved - lost > 0 ? '  ←正收益' : ''))
  }

  console.log('\n=== 表3：序号闸门（序号差 > N 就不算重复）===')
  for (const N of [1, 2, 3, 5, 10]) {
    const saved = notd.filter((p) => p.dser != null && p.dser > N).length
    const lost = dup.filter((p) => p.dser != null && p.dser > N).length
    console.log('序号差 >' + String(N).padStart(2) + '  救回 ' + saved + '/' + notd.length + ' · 误放 ' + lost + '/' + dup.length + ' · 净 ' + (saved - lost) + (saved - lost > 0 ? '  ←正收益' : ''))
  }

  console.log('\n=== 表4：DUP 群（你认可/补打的重复）逐对的时间差 ===')
  for (const p of dup.slice(0, 22)) console.log('  ' + p.a.filename + ' ↔ ' + p.b.filename + '  ham ' + p.h + '  时间差 ' + p.dt.toFixed(3) + 's  序号差 ' + p.dser)
  console.log('\n=== 表5：NOT_DUP 群（你否定为重复）逐对的时间差 ===')
  for (const p of notd.slice(0, 22)) console.log('  ' + p.a.filename + ' ↔ ' + p.b.filename + '  ham ' + p.h + '  时间差 ' + p.dt.toFixed(3) + 's  序号差 ' + p.dser)
})().catch((e) => {
  console.error('FAILED', e)
  process.exit(1)
})
