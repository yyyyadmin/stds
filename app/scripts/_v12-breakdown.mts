/**
 * 拆 V11 vs V12 逐张分歧（对 truth-1016-eyes.jsonl 的眼睛判真值）
 * 输出 scripts/out/_v12-breakdown.txt（UTF-8，避开管道乱码），分类列出要开真图复核的图。
 */
import { readFileSync, writeFileSync, readdirSync } from 'fs'
import { join, basename } from 'path'

const OUTDIR = 'scripts/out'
// 取最新的 raw.jsonl
const raws = readdirSync(OUTDIR)
  .filter((f) => /^ab-.*\.raw\.jsonl$/.test(f))
  .map((f) => ({ f, t: new Date(readFileSync(join(OUTDIR, f), 'utf8')) }))
  .sort((a, b) => (b.f > a.f ? 1 : -1))
const rawFile = join(OUTDIR, readdirSync(OUTDIR).filter((f) => /^ab-.*\.raw\.jsonl$/.test(f)).sort().pop()!)

const truth = new Map<string, any>()
for (const l of readFileSync(join(OUTDIR, 'truth-1016-eyes.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean)) {
  const r = JSON.parse(l)
  truth.set(r.path, r)
}

interface Call { file: string; path: string; variant: string; ok: boolean; verdict: any; raw: string }
const calls: Call[] = readFileSync(rawFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))

// 按 path+variant 索引
const byPV = new Map<string, Call>()
for (const c of calls) if (c.verdict) byPV.set(c.path + '|' + c.variant, c)

const V11 = 'v11-eyes-by-opening'
const V12 = 'v12-halfhead-expression'

const lines: string[] = ['=== V11 vs V12 分歧拆解（真值=眼睛判143张）===', '']
lines.push(`（数据源 raw：${basename(rawFile)}）`, '')

function v(p: string, ver: string, key: 'half_head' | 'expression'): boolean | null {
  const c = byPV.get(p + '|' + ver)
  return c && c.verdict ? !!c.verdict[key] : null
}
function reason(p: string, ver: string): string {
  const c = byPV.get(p + '|' + ver)
  return c && c.verdict ? String(c.verdict.reason || '').slice(0, 60) : ''
}

const paths = [...truth.keys()]

for (const dim of ['expression', 'half_head'] as const) {
  const truthTrue = paths.filter((p) => truth.get(p)[dim] === true)
  const truthFalse = paths.filter((p) => truth.get(p)[dim] === false)
  const rescued = truthTrue.filter((p) => v(p, V12, dim) === true)
  const stillMissed = truthTrue.filter((p) => v(p, V12, dim) !== true)
  const falseAlarm = truthFalse.filter((p) => v(p, V12, dim) === true)
  const v11Hit = truthTrue.filter((p) => v(p, V11, dim) === true).length

  lines.push(`########## ${dim} ##########`)
  lines.push(`真值 true 共 ${truthTrue.length} 张 | V11 认出 ${v11Hit} | V12 认出 ${rescued.length}`)
  lines.push('')
  lines.push(`【V12 救回·需开图确认是真救对】(${rescued.length})`)
  for (const p of rescued) lines.push(`  ${basename(p)} | V11=${v(p, V11, dim)} V12=${v(p, V12, dim)} | V12理由: ${reason(p, V12)}`)
  lines.push('')
  lines.push(`【V12 仍漏的真值】(${stillMissed.length})`)
  for (const p of stillMissed) lines.push(`  ${basename(p)} | V12=${v(p, V12, dim)} | V12理由: ${reason(p, V12)}`)
  lines.push('')
  lines.push(`【V12 乱标·真值false却喊true·必须开图裁决】(${falseAlarm.length})`)
  for (const p of falseAlarm) lines.push(`  ${basename(p)} | V11=${v(p, V11, dim)} V12=${v(p, V12, dim)} | V12理由: ${reason(p, V12)}`)
  lines.push('')
}

// V11/V12 在半截头+表情上所有判定翻转的图（V11≠V12），供全面目检
lines.push('########## V11→V12 任意一维翻转的全部图 ##########')
for (const p of paths) {
  const flips: string[] = []
  for (const dim of ['expression', 'half_head'] as const) {
    const a = v(p, V11, dim), b = v(p, V12, dim)
    if (a !== b) flips.push(`${dim}:${a}→${b}`)
  }
  if (flips.length) lines.push(`  ${basename(p)} [真值 h=${truth.get(p).half_head} e=${truth.get(p).expression}] ${flips.join(' ')}`)
}

writeFileSync(join(OUTDIR, '_v12-breakdown.txt'), lines.join('\n'), 'utf8')
console.log('written:', rawFile)
