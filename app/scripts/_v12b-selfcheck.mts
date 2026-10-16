import { writeFileSync } from 'node:fs'
import { V12, V12B } from './prompt-variants.mts'

const a = V12.build()
const b = V12B.build()
const lines: string[] = []
lines.push(`system same: ${a.system === b.system}`)
lines.push(`expr identical (v12 kept): ${b.userText.includes('true 必须同时满足两条')}`)
lines.push(`guard1 in: ${b.userText.includes('不要把"头饰贴边"当成裁头')}`)
lines.push(`guard2 in: ${b.userText.includes('只有配角/花童/路人的头被边裁')}`)
lines.push(`len grew vs v12: ${b.userText.length > a.userText.length}`)
lines.push(`userText len: v12=${a.userText.length} v12b=${b.userText.length}`)
writeFileSync('scripts/out/_v12b-selfcheck.txt', lines.join('\n'), 'utf8')
console.log('OK')
