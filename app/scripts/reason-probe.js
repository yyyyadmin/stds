/**
 * reason 文本探针（开发者离线用，不进包）
 * 目的：档位要改用连续量（模糊面积占比/拉普拉斯方差/高光溢出比/头顶余量），
 *       先确认这些量到底存不存在于已入库的 reason 字符串里——决定要不要重跑全库。
 * 用法：node scripts/reason-probe.js
 */
const fs = require('fs')
const path = require('path')

const BAD = ['eyes_closed', 'blur', 'exposure', 'half_head', 'face_ugly', 'duplicate']
const NAMED = { eyes_closed: '闭眼', blur: '模糊', exposure: '曝光', half_head: '半截头', face_ugly: '表情', duplicate: '重复' }

;(async () => {
  const dbPath = path.join(process.env.APPDATA || '', 'screener-master', 'data', 'screener.db')
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs()
  const db = new SQL.Database(fs.readFileSync(dbPath))
  const res = db.exec("SELECT filename, tags, status FROM images WHERE status = 'done'")
  const rows = (res[0]?.values || []).map((v) => ({ file: v[0], tags: (() => { try { return JSON.parse(v[1] || '{}') } catch { return {} } })() }))
  console.log(`真实库 done 图 ${rows.length} 张 · 逐维度看 reason 里有什么可用连续量\n`)

  for (const dim of BAD) {
    const tagged = rows.map((r) => r.tags[dim]).filter(Boolean)
    const ai = tagged.filter((t) => t.method !== 'user' && (t.reason || '').trim())
    console.log(`【${NAMED[dim]} ${dim}】有标签 ${tagged.length} 张（非人工且带 reason ${ai.length} 张）`)
    // 只看 AI 标签：按置信度取最低 3 条 + 最高 3 条，看清两个端点的真实格式
    const sorted = [...ai].sort((a, b) => a.confidence - b.confidence)
    const pick = sorted.length <= 6 ? sorted : [...sorted.slice(0, 3), ...sorted.slice(-3)]
    for (const t of pick) console.log(`   conf=${String(t.confidence).padEnd(6)} level=${(t.level || '-').padEnd(4)} reason= ${t.reason}`)
    const keys = {}
    for (const t of ai) {
      for (const m of String(t.reason).matchAll(/([A-Za-z_\u4e00-\u9fa5]+)\s*[=:]?\s*(-?\d+(?:\.\d+)?)/g)) {
        keys[m[1]] = (keys[m[1]] || 0) + 1
      }
    }
    const entries = Object.entries(keys).sort((a, b) => b[1] - a[1])
    console.log(`   出现过的数值字段：${entries.slice(0, 12).map(([k, c]) => `${k}(${c})`).join('  ') || '（无）'}\n`)
  }
  db.close()
})()
