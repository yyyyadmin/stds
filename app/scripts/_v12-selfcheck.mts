import { writeFileSync } from 'node:fs'
import { V11, V12 } from './prompt-variants.mts'

const a = V11.build()
const b = V12.build()
const lines: string[] = []
lines.push(`system same: ${a.system === b.system}`)
lines.push(`halfHead old gone: ${!b.userText.includes('且裁到影响这张照能用才算')}`)
lines.push(`halfHead new in: ${b.userText.includes('看不到完整的头部轮廓')}`)
lines.push(`expr old gone: ${!b.userText.includes('出现明显崩坏难看的表情才 true')}`)
lines.push(`expr new in: ${b.userText.includes('true 必须同时满足两条')}`)
lines.push(`eyes v11 kept: ${b.userText.includes('跟她在不在笑无关')}`)
lines.push(`hands rule kept: ${b.userText.includes('就不算在场的人、不计入 count')}`)
lines.push(`userText len: v11=${a.userText.length} v12=${b.userText.length}`)
writeFileSync('scripts/out/_v12-selfcheck.txt', lines.join('\n'), 'utf8')
console.log('OK')
