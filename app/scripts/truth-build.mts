/**
 * 真值集清洗（测试端基础设施，不是探针，后续 A/B 打分都吃它的产物）
 *
 * 数据源：归档/2026-10-12-couple1-v2.0.64/
 *   - images_ground_truth.jsonl：3190 张的最终快照（category + category_by + tags）
 *   - corrections.csv：4626 行人工改判动作（orig_dim / new_category / action / timestamp）
 *   - MANIFEST.md：这位用户自己写的清洗规则，本脚本严格照做：
 *       ① 算维度准确率时排除 category=trash/dup_trash 的图（其标签为 AI 未验证）
 *       ② 纯 duplicate 连拍帧不作为内容维度真值样本
 *       ③ corrections 里 orig_dim 为空的是漏检样本，按 new_category 归维度
 *
 * 人工动作怎么翻成真值：
 *   action=correct + orig_dim=X   → 人认可引擎说的 X → X 这一维 = 真
 *   action=wrong   + orig_dim=X   → 人说引擎说的 X 是错的 → X 这一维 = 假
 *   action=wrong   + new_category=Y（Y 是维度/人数类）→ 这张应归 Y
 *   同一张多次改判：按 timestamp 先后叠加，后说的覆盖先说的。
 *
 * 用法：node --experimental-strip-types scripts/truth-build.mts
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join } from 'path'

const ARCHIVE = existsSync('归档/2026-10-12-couple1-v2.0.64')
  ? '归档/2026-10-12-couple1-v2.0.64'
  : '../归档/2026-10-12-couple1-v2.0.64'
const IMG_ROOTS = ['E:\\9.27', 'E:\\测试', 'E:\\1016测试']
const OUT = 'scripts/out/truth-couple1.jsonl'

const PERSON = ['single_person', 'group_photo', 'mixed_photo', 'no_person']
/** 云端复审只判这三项内容瑕疵（画质型不判，见 aiReviewPrompt.ts） */
const FLAW_KEYS = ['eyes_closed', 'half_head', 'face_ugly']
/** 已下线的斜眼不当闭眼真值用（口径不同：斜眼是瞳孔偏位，不是眼睑闭合） */
const DROP_DIMS = ['eyes_side', 'blur', 'exposure', 'black_white', 'duplicate', 'custom:4']
/** 状态类归属：人把图搬去这些栏，说的是"这张能不能交"，不是内容维度 */
const STATUS_CATS = ['library', 'review', 'trash', 'dup_trash', 'duplicate']

interface Corr {
  image_id: string
  orig_dim: string
  new_category: string
  action: string
  timestamp: number
}

function loadCorrections(): Corr[] {
  const lines = readFileSync(join(ARCHIVE, 'corrections.csv'), 'utf8').split(/\r?\n/).filter(Boolean)
  const head = lines[0].split(',')
  return lines.slice(1).map((l) => {
    const c = l.split(',')
    const o: Record<string, string> = {}
    head.forEach((h, i) => (o[h] = c[i] ?? ''))
    return {
      image_id: o.id === undefined ? '' : o.image_id,
      orig_dim: (o.orig_dim || '').trim(),
      new_category: (o.new_category || '').trim(),
      action: (o.action || '').trim(),
      timestamp: Number(o.timestamp || 0)
    }
  })
}

interface Snap {
  id: number
  filename: string
  category: string
  category_by: string
  tags: Record<string, { confidence: number; level: string; method: string }>
}

function loadSnapshot(): Snap[] {
  return readFileSync(join(ARCHIVE, 'images_ground_truth.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const o = JSON.parse(l) as Record<string, unknown>
      const tags = typeof o.tags === 'string' ? (JSON.parse(o.tags) as Snap['tags']) : ((o.tags || {}) as Snap['tags'])
      return {
        id: Number(o.id),
        filename: String(o.filename),
        category: String(o.category),
        category_by: String(o.category_by || ''),
        tags
      }
    })
}

/** 母本目录扫描：文件名（小写）→ 绝对路径；先扫到的赢（IMG_ROOTS 已按"最像母本"排序） */
function indexImages(): Map<string, string> {
  const map = new Map<string, string>()
  for (const root of IMG_ROOTS) {
    if (!existsSync(root)) continue
    const stack = [root]
    while (stack.length) {
      const d = stack.pop() as string
      let es
      try {
        es = readdirSync(d, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of es) {
        const p = join(d, e.name)
        if (e.isDirectory()) {
          if (stack.length < 5000) stack.push(p)
          continue
        }
        const k = e.name.toLowerCase()
        if (!map.has(k) && /\.(jpg|jpeg|png|webp)$/i.test(e.name)) map.set(k, p)
      }
    }
  }
  return map
}

function main(): void {
  const snaps = loadSnapshot()
  const corrs = loadCorrections()
  const paths = indexImages()
  const byFile = new Map<string, Corr[]>()
  for (const c of corrs) {
    const s = snaps.find((x) => String(x.id) === c.image_id)
    if (!s) continue
    const k = s.filename.toLowerCase()
    const arr = byFile.get(k) || []
    arr.push(c)
    byFile.set(k, arr)
  }

  const rows: Array<Record<string, unknown>> = []
  const stat = {
    快照总张数: snaps.length,
    有人工动作的张数: 0,
    人数真值张数: 0,
    闭眼真值张数: 0,
    半截头真值张数: 0,
    表情崩坏真值张数: 0,
    母本找不到的张数: 0,
    按清洗规则剔除的张数: 0
  }
  const personDist: Record<string, number> = {}
  const eyesDist = { 真: 0, 假: 0 }
  const halfDist = { 真: 0, 假: 0 }

  for (const s of snaps) {
    const k = s.filename.toLowerCase()
    // 清洗规则①：trash/dup_trash 的标签是 AI 未验证，整张剔除
    if (s.category === 'trash' || s.category === 'dup_trash') {
      stat.按清洗规则剔除的张数++
      continue
    }
    const cs = (byFile.get(k) || []).slice().sort((a, b) => a.timestamp - b.timestamp)
    if (cs.length) stat.有人工动作的张数++

    // --- 人数真值：人工动作优先，其次"人亲手把这张归到某个四类"（category_by=user）
    let person: string | null = null
    const personSrc: string[] = []
    for (const c of cs) {
      if (c.action === 'correct' && PERSON.includes(c.orig_dim)) {
        person = c.orig_dim
        personSrc.push('认可:' + c.orig_dim)
      } else if (c.action === 'wrong' && PERSON.includes(c.orig_dim)) {
        if (PERSON.includes(c.new_category)) {
          person = c.new_category
          personSrc.push('纠正:' + c.orig_dim + '→' + c.new_category)
        } else if (STATUS_CATS.includes(c.new_category)) {
          person = null // 人只是把它搬去状态栏，人数没表态：不拿引擎值冒充真值
          personSrc.push('撤销人数:' + c.orig_dim)
        }
      } else if (c.action === 'wrong' && !c.orig_dim && PERSON.includes(c.new_category)) {
        // 清洗规则③：orig_dim 为空 = 漏检样本，按 new_category 归维度
        person = c.new_category
        personSrc.push('补漏:' + c.new_category)
      }
    }
    if (!person && s.category_by === 'user' && PERSON.includes(s.category)) {
      person = s.category
      personSrc.push('快照人工归类:' + s.category)
    }
    if (person) {
      stat.人数真值张数++
      personDist[person] = (personDist[person] || 0) + 1
    }

    // --- 瑕疵真值（闭眼 / 半截头 / 表情崩坏）：只认人工动作，引擎标签一律不算真值
    // 清洗规则②：纯 duplicate 连拍帧不作为内容维度真值（母本里同一瞬间多张，标注会互相污染）
    const dupOnly = cs.length === 0 && s.category === 'duplicate'
    const flaw: Record<string, boolean | null> = { eyes_closed: null, half_head: null, face_ugly: null }
    const flawSrc: string[] = []
    if (!dupOnly) {
      for (const c of cs) {
        if (c.action === 'correct' && FLAW_KEYS.includes(c.orig_dim)) {
          flaw[c.orig_dim] = true
          flawSrc.push('认可:' + c.orig_dim)
        } else if (c.action === 'wrong' && FLAW_KEYS.includes(c.orig_dim)) {
          flaw[c.orig_dim] = false
          flawSrc.push('否掉:' + c.orig_dim)
        } else if (c.action === 'wrong' && !c.orig_dim && FLAW_KEYS.includes(c.new_category)) {
          flaw[c.new_category] = true
          flawSrc.push('补漏:' + c.new_category)
        } else if (c.action === 'wrong' && FLAW_KEYS.includes(c.orig_dim) === false && STATUS_CATS.includes(c.new_category)) {
          // 把瑕疵图搬去交付库/待确认 = 人认为这张没那个瑕疵，已在上面"否掉"分支覆盖，这里不重复处理
        }
      }
    }
    if (flaw.eyes_closed !== null) {
      stat.闭眼真值张数++
      if (flaw.eyes_closed) eyesDist.真++
      else eyesDist.假++
    }
    if (flaw.half_head !== null) {
      stat.半截头真值张数++
      if (flaw.half_head) halfDist.真++
      else halfDist.假++
    }
    if (flaw.face_ugly !== null) stat.表情崩坏真值张数++

    const p = paths.get(k)
    if (!p) {
      stat.母本找不到的张数++
      continue
    }
    if (!person && flaw.eyes_closed === null && flaw.half_head === null && flaw.face_ugly === null) continue

    rows.push({
      filename: s.filename,
      path: p,
      sizeMB: +(statSync(p).size / 1048576).toFixed(1),
      person,
      personSrc,
      eyes_closed: flaw.eyes_closed,
      half_head: flaw.half_head,
      expression: flaw.face_ugly,
      flawSrc,
      snapCategory: s.category,
      snapCategoryBy: s.category_by,
      engineTags: Object.fromEntries(
        Object.entries(s.tags).filter(([dim]) => !DROP_DIMS.includes(dim)).map(([dim, t]) => [dim, t.level + '/' + t.method])
      )
    })
  }

  writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n'), 'utf8')
  console.log('=== 清洗统计 ===')
  console.log(JSON.stringify(stat, null, 2))
  console.log('人数真值分布:', JSON.stringify(personDist))
  console.log('闭眼真值 有/无:', JSON.stringify(eyesDist))
  console.log('半截头真值 有/无:', JSON.stringify(halfDist))
  console.log('可打分行数(有任一真值且母本在盘上):', rows.length)
  console.log('产物:', OUT)
  const both = rows.filter((r) => r.person && r.eyes_closed !== null).length
  console.log('同时有人数+闭眼真值的张数:', both)
}

main()
