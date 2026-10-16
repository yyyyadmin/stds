/**
 * 一次性把生产 aiReviewPrompt.ts 的 userText 重新生成为 prompt-variants 里的 V12E（= v11 全文 + 表情物理判据）。
 * 红线：生产提示词字符串必须从单一真源生成、不手抄；这里用 JSON.stringify 注入，跑完自带逐字节断言。
 * 只改 userText 那一行 + 把常量名 USER_TEXT_V11 改成 USER_TEXT_V12E（system 仍是 v11，未动）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { V11, V12E } from './prompt-variants.mts'

const FILE = 'src/main/services/aiReviewPrompt.ts'
const target = V12E.build()
const v11 = V11.build()

// 安全护栏：确认 V12E 相对 V11 只改了表情那一句，半截头/闭眼/count 一字未动
const o = v11.userText.split('\n')
const n = target.userText.split('\n')
if (o.length !== n.length) throw new Error('行数变了，非预期，停')
const diffLines = o.map((l, i) => (l !== n[i] ? i : -1)).filter((i) => i >= 0)
if (diffLines.length !== 1 || !n[diffLines[0]].includes('expression')) {
  throw new Error('V12E 相对 V11 不是"仅表情一句不同"，差异行=' + JSON.stringify(diffLines))
}

let src = readFileSync(FILE, 'utf8')

const declRe = /^const USER_TEXT_V11 = .*$\n/m
if (!declRe.test(src)) throw new Error('没找到 USER_TEXT_V11 声明行')
src = src.replace(declRe, `const USER_TEXT_V12E = ${JSON.stringify(target.userText)}\n`)
src = src.replace('return { system: SYSTEM_V11, userText: USER_TEXT_V11 }', 'return { system: SYSTEM_V11, userText: USER_TEXT_V12E }')

writeFileSync(FILE, src, 'utf8')

// 逐字节回读断言
const re = await import('../src/main/services/aiReviewPrompt.ts')
const prod = re.buildReviewMessages()
console.log('生产 userText === V12E 逐字节:', prod.userText === target.userText)
console.log('生产 system  === V11  system:', prod.system === v11.system)
console.log('半截头仍是v11原句:', prod.userText.includes('   - half_head：只对清晰主要人物判。头部被画面任意一条边裁掉、且裁到影响这张照能用才算 true'))
console.log('表情已是物理判据:', prod.userText.includes('true 必须同时满足两条'))
console.log('闭眼v11判据保留:', prod.userText.includes('跟她在不在笑无关'))
console.log('新长度:', prod.userText.length)
