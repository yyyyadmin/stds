/**
 * 版本差异对比工具（测试端，不花钱）：列出两个提示词版本判定不一致的图，供人工逐张看真图裁决。
 * 用法：node --experimental-strip-types scripts/prompt-diff.mts --a v1-current --b v8-tighten-group-count [--raw <ab-xxx.raw.jsonl>] [--out <txt>]
 * 说明：初版人工标签只作参考、不作标准（用户 2026-10-16 明确要求：以真实看图裁决为准）。
 */
import { readFileSync, writeFileSync, readdirSync } from 'fs'
import { join, basename } from 'path'

function arg(name: string, dft = ''): string {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dft
}
const A = arg('a', 'v1-current')
const B = arg('b', 'v8-tighten-group-count')
const CN: Record<string, string> = {
  single_person: '单人',
  group_photo: '合影',
  mixed_photo: '混合',
  no_person: '无人',
  __fail__: '解析失败'
}
const PERSON_ORDER = ['单人', '合影', '混合', '无人']

// 默认取最近一个 raw.jsonl
let rawPath = arg('raw')
if (!rawPath) {
  const dir = 'scripts/out'
  const cands = readdirSync(dir)
    .filter((f) => f.startsWith('ab-') && f.endsWith('.raw.jsonl'))
    .sort()
  rawPath = join(dir, cands[cands.length - 1])
}
console.log('读取明细:', rawPath)

interface Rec {
  path: string
  variant: string
  person: string
}
const calls: Rec[] = []
for (const line of readFileSync(rawPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
  const c = JSON.parse(line) as { path: string; variant: string; verdict?: { person?: string } | null }
  calls.push({ path: c.path, variant: c.variant, person: c.verdict && c.verdict.person ? c.verdict.person : '__fail__' })
}

// 初版人工标签（仅参考）
const truth = new Map<string, string>()
try {
  for (const line of readFileSync('scripts/out/truth-couple1.jsonl', 'utf8').split(/\r?\n/).filter(Boolean)) {
    const t = JSON.parse(line) as { path: string; person: string | null }
    truth.set(t.path, t.person ? CN[t.person] || t.person : '无')
  }
} catch {
  /* 真值表缺也不影响差异对比 */
}

const byPath = new Map<string, Record<string, string>>()
for (const c of calls) (byPath.get(c.path) || byPath.set(c.path, {}).get(c.path)!)[c.variant] = c.person

const diffs: Array<{ file: string; path: string; a: string; b: string; ref: string }> = []
const transition = new Map<string, number>()
for (const [path, m] of byPath) {
  const a = m[A]
  const b = m[B]
  if (a === undefined || b === undefined) continue
  if (a === b) continue
  const cnA = CN[a] || a
  const cnB = CN[b] || b
  transition.set(`${cnA}→${cnB}`, (transition.get(`${cnA}→${cnB}`) || 0) + 1)
  diffs.push({ file: basename(path), path, a: cnA, b: cnB, ref: truth.get(path) || '?' })
}

diffs.sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b) || x.file.localeCompare(y.file))
const lines: string[] = []
lines.push(`对比：${A}（记作 A） vs ${B}（记作 B）`)
lines.push(`共 ${diffs.length} 张判定不一致`)
lines.push('')
lines.push('转移分布（A→B 各多少张）：')
for (const [k, n] of [...transition.entries()].sort((p, q) => q[1] - p[1])) lines.push(`  ${k}：${n} 张`)
lines.push('')
lines.push('逐张清单（初版人工标签仅参考，以真图为准）：')
lines.push('序号 | 文件名 | A判定 | B判定 | 初版人工(仅参考) | 母本路径')
diffs.forEach((d, i) => lines.push(`${i + 1} | ${d.file} | ${d.a} | ${d.b} | ${d.ref} | ${d.path}`))

const text = lines.join('\n')
const outPath = arg('out', 'scripts/out/_diff_AB.txt')
writeFileSync(outPath, text, 'utf8')
console.log(text.split('\n').slice(0, 12).join('\n'))
console.log(`\n完整清单已写入：${outPath}（共 ${diffs.length} 张）`)
