/**
 * 乙方案（只拦极紧子集）的精度网格（只读，用试点已有的 phash + EXIF 时间）
 *
 * 规则形状：同目录 且 phash 汉明≤Th 且 拍摄时间差≤Tt → 才打 duplicate 标签拦交付。
 * 在试点的 95 个有标注配对上算召回/误伤，找有没有一个格子值得上线。
 *
 * 用法：node scripts/dup-tight-grid.js
 */
const fs = require('fs')
const path = require('path')
const exifr = require('exifr')

const HAM_MAX = 9

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

async function stampOf(file) {
  try {
    const ex = await exifr.parse(file, ['DateTimeOriginal', 'CreateDate', 'SubSecTimeOriginal', 'SubSecTimeDigitized'])
    if (!ex) return null
    const pick = (k) => (ex[k] !== undefined ? ex[k] : ex[k.toLowerCase()])
    const dt = pick('DateTimeOriginal') || pick('CreateDate')
    if (!dt) return null
    const base = dt instanceof Date ? dt.getTime() : Date.parse(String(dt))
    const sub = pick('SubSecTimeOriginal') ?? pick('SubSecTimeDigitized')
    let extra = 0
    if (typeof sub === 'number') extra = sub / 1000
    else if (typeof sub === 'string') {
      const s = parseFloat('0.' + sub.replace(/^0+/, ''))
      if (!isNaN(s)) extra = s
    }
    return base + extra * 1000
  } catch {
    return null
  }
}

;(async () => {
  const list = JSON.parse(fs.readFileSync(path.join(__dirname, '_pilot_list.json'), 'utf8'))
  const pose = JSON.parse(fs.readFileSync(path.join(__dirname, '_pilot_pose.json'), 'utf8'))
  const phashById = new Map(pose.map((p) => [p.id, p.phash]))
  const recs = []
  for (const it of list) {
    const ms = await stampOf(it.path)
    if (ms == null) continue
    recs.push({ id: it.id, filename: it.filename, label: it.label, dir: path.dirname(it.path), ms, phash: phashById.get(it.id) })
  }
  console.log('试点 ' + recs.length + ' 张（拿到 EXIF 时间）')

  const pairs = []
  for (let i = 0; i < recs.length; i++) {
    for (let j = i + 1; j < recs.length; j++) {
      const a = recs[i]
      const b = recs[j]
      if (a.dir !== b.dir) continue
      const h = hamming(a.phash, b.phash)
      if (h > HAM_MAX) continue
      const lab = new Set([a.label, b.label])
      if (lab.has('rej') && (lab.has('ok') || lab.has('add'))) continue
      const tag = lab.has('rej') ? 'NOT_DUP' : lab.has('ok') || lab.has('add') ? 'DUP' : null
      if (!tag) continue
      pairs.push({ tag, h, dt: Math.abs(a.ms - b.ms) / 1000 })
    }
  }
  const dup = pairs.filter((p) => p.tag === 'DUP')
  const notd = pairs.filter((p) => p.tag === 'NOT_DUP')
  console.log('有标注配对：DUP ' + dup.length + ' · NOT_DUP ' + notd.length + '\n')

  console.log('=== 拦得住真重复(召回) vs 误拦你否定的(误伤) 的网格 ===')
  console.log('汉明≤ \\ 时间≤   ' + [0.2, 0.35, 0.5, 1, 2, 999].map((t) => String(t).padStart(9)).join(''))
  const grid = []
  for (const th of [1, 2, 3, 4, 6, 9]) {
    const line = ['        ≤' + th + '   ']
    for (const tt of [0.2, 0.35, 0.5, 1, 2, 999]) {
      const tp = dup.filter((p) => p.h <= th && p.dt <= tt).length
      const fp = notd.filter((p) => p.h <= th && p.dt <= tt).length
      line.push((tp + '对' + fp + '错').padStart(9))
      grid.push({ th, tt, tp, fp })
    }
    console.log(line.join(''))
  }
  console.log('\n（格式：拦住真重复数 对 误拦你否定数 错）')

  const best = grid.filter((g) => g.tp > 0).sort((a, b) => (b.tp - b.fp * 2) - (a.tp - a.fp * 2)).slice(0, 6)
  console.log('\n=== 相对最好的格子（把"误伤"按双倍代价扣分后排序）===')
  for (const g of best) {
    console.log('  汉明≤' + g.th + ' 且 时间≤' + g.tt + 's：拦住真重复 ' + g.tp + '/' + dup.length + '（' + ((g.tp / dup.length) * 100).toFixed(0) + '%），误拦你否定 ' + g.fp + '/' + notd.length + '，净 ' + (g.tp - g.fp >= 0 ? '+' : '') + (g.tp - g.fp))
  }

  const base = { tp: dup.length, fp: notd.length }
  console.log('\n=== 对照：现状（只要求汉明≤9，不看时间）= 拦住 ' + dup.length + '/' + dup.length + ' 真重复，误拦 ' + notd.length + '/' + notd.length + ' 你否定的 ===')
  const timeOnly = notd.filter((p) => p.dt > 2).length
  console.log('若只加"时间差≤2s"这一条：可去掉 ' + timeOnly + '/' + notd.length + ' 的误拦，代价是放走 ' + dup.filter((p) => p.dt > 2).length + '/' + dup.length + ' 真重复')
})().catch((e) => {
  console.error('FAILED', e)
  process.exit(1)
})
