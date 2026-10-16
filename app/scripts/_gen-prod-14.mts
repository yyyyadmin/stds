/**
 * 一次性把生产 aiReviewPrompt.ts 的 userText 重新生成为 prompt-variants 里的 V14（= 当前生产 V13 + 半截头补"必须还能看见一部分头/脸"硬前提）。
 * 红线：生产提示词字符串必须从单一真源生成、不手抄；用 JSON.stringify 注入。
 * 只改 userText 那一行 + 常量名 USER_TEXT_V13 → USER_TEXT_V14（system 仍是 v11，未动）。
 * 逐字节回读核验放到之后的全新进程里做（避免 import 链把改前模块缓存进内存造成假阴性）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { V13, V14 } from './prompt-variants.mts'

const FILE = 'src/main/services/aiReviewPrompt.ts'
const target = V14.build()
const base = V13.build()

// 安全护栏：确认 V14 相对生产 V13 只改了半截头那一句，表情/闭眼/count/system 一字未动
if (base.system !== target.system) throw new Error('system 变了，非预期，停')
const o = base.userText.split('\n')
const n = target.userText.split('\n')
if (o.length !== n.length) throw new Error('行数变了，非预期，停')
const diffLines = o.map((l, i) => (l !== n[i] ? i : -1)).filter((i) => i >= 0)
if (diffLines.length !== 1 || !n[diffLines[0]].includes('half_head')) {
  throw new Error('V14 相对 V13 不是"仅半截头一句不同"，差异行=' + JSON.stringify(diffLines))
}

let src = readFileSync(FILE, 'utf8')

const declRe = /^const USER_TEXT_V13 = .*$\n/m
if (!declRe.test(src)) throw new Error('没找到 USER_TEXT_V13 声明行')
src = src.replace(declRe, `const USER_TEXT_V14 = ${JSON.stringify(target.userText)}\n`)
src = src.replace('return { system: SYSTEM_V11, userText: USER_TEXT_V13 }', 'return { system: SYSTEM_V11, userText: USER_TEXT_V14 }')

writeFileSync(FILE, src, 'utf8')
console.log('已注入 V14，长度:', target.userText.length, '（差异行仅半截头，护栏通过）')
