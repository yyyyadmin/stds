/**
 * 连拍组「人数一致化」修补（纯主进程，不依赖引擎，毫秒级，幂等）
 *
 * 为什么要做：3185 张真实婚礼库取证显示——
 *  - 538 个多帧连拍组里 109 组（20.3%）对同一个瞬间给出不同的人数分类；
 *  - 被判「单人照」的帧里 22.2%（185/832）所在的组内，另一帧明确拍到 ≥2 张脸。
 * 同一瞬间不可能既单人又多人，这些是确凿误判（正是"多人合照被标成单人照""无人物里其实有人"）。
 *
 * 为什么取「组内人脸数上界」而不是多数派投票：
 *  YuNet 极少凭空多检脸，人体框却常因遮挡/背身漏检——漏检远多于误检，所以"这一瞬间最多看到几张脸"
 *  就是现场人数的可靠下界。实测多数派投票会把 72 张「多人」按帧数改判成「单人」，方向与诉求相反。
 *
 * 两条硬约束：
 *  1) 只上调不下调（少判人 → 多判人）。把本来正确的单人照推成多人是新增误判，反向才是修错。
 *  2) 归属只在"该图因人维度才待在该分类"时重算；成品库兜底帧、坏维度、垃圾桶、用户手动放置
 *     一律不动分类（标签照样修正，避免同一组里两张卡说法不一致）。
 */
import { getDb, getSettings, saveSettings, updateDetectResult } from '../db'
import { computeCategory, gradeDims } from '../classify'
import type { DimensionKey, ImageRecord } from '../../shared/types'

/** 人数由少到多的排序：只允许往"更多人"方向改判 */
const RANK: Record<string, number> = { no_person: 0, single_person: 1, group_photo: 2 }
const PERSON_DIMS: DimensionKey[] = ['group_photo', 'single_person', 'no_person']
/** 修补版本：改判规则升级时 +1，老库会在下次启动自动重跑 */
const HARMONY_VERSION = 1

interface Row {
  id: number
  dup_group: string
  category: string
  category_by: string | null
  tags: string | null
  details: string | null
}

function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

/** 该图当前的人数维度标签（三选一，引擎每图只写一个） */
function personDimOf(tags: Partial<Record<DimensionKey, unknown>>): DimensionKey | null {
  for (const d of PERSON_DIMS) if (tags[d]) return d
  return null
}

/**
 * 对全库连拍组做人数一致化，返回被修正的图片 id。
 * 每次聚类结束调用一次；老库无需重新检测，启动时按版本号补跑一次即可。
 */
export function harmonizePersonCount(): number[] {
  const settings = getSettings()
  const rows = getDb()
    .prepare(`SELECT id, dup_group, category, category_by, tags, details FROM images WHERE status = 'done' AND dup_group IS NOT NULL`)
    .all() as Row[]

  const groups = new Map<string, Row[]>()
  for (const r of rows) {
    const list = groups.get(r.dup_group) || []
    list.push(r)
    groups.set(r.dup_group, list)
  }

  const changed: number[] = []
  for (const [, arr] of groups) {
    if (arr.length < 2) continue
    const parsed = arr.map((r) => ({
      row: r,
      tags: parseJson<Record<string, { confidence: number; level?: string; reason?: string; method?: string }>>(r.tags, {}),
      faceCount: parseJson<{ faceCount?: number }>(r.details, {}).faceCount ?? 0
    }))
    const maxFc = Math.max(0, ...parsed.map((p) => p.faceCount))
    const target: DimensionKey | null = maxFc >= 2 ? 'group_photo' : maxFc === 1 ? 'single_person' : null
    if (!target) continue
    // 证据置信度：取"看到最多脸那一帧"的同类标签置信度，拿不到就按 0.9（连拍同伴的实证比单帧推断更硬）
    const evidence = parsed.filter((p) => p.faceCount === maxFc && p.tags[target]?.confidence)
    const conf = evidence.length ? Math.max(...evidence.map((p) => p.tags[target].confidence)) : 0.9

    for (const p of parsed) {
      const cur = personDimOf(p.tags)
      if (!cur || cur === target) continue
      if ((RANK[target] ?? 0) <= (RANK[cur] ?? 0)) continue // 只上调，不下调

      const reason = `同组连拍另一帧看到 ${maxFc} 张脸，现场至少 ${maxFc} 人（连拍一致化）`
      const { tags: graded } = gradeDims({ [target]: { confidence: conf, reason, method: 'burst-consensus' } }, settings)
      const newTag = graded[target]
      if (!newTag) continue

      const nextTags = { ...p.tags }
      delete nextTags[cur]
      nextTags[target] = newTag

      // 归属重算：仅限"因人维度才待在该分类"的图；成品库兜底帧与坏维度/垃圾桶保持不动
      let category = p.row.category
      if (p.row.category_by !== 'user' && RANK[p.row.category] !== undefined) {
        category = computeCategory(nextTags as ImageRecord['tags'], settings, {
          category: p.row.category,
          categoryBy: (p.row.category_by as 'ai' | 'user' | null) ?? null
        } as ImageRecord)
      }
      updateDetectResult(
        p.row.id,
        nextTags as ImageRecord['tags'],
        parseJson<ImageRecord['details']>(p.row.details, null),
        p.row.dup_group,
        category,
        (p.row.category_by as 'ai' | 'user' | null) ?? null,
        'done'
      )
      changed.push(p.row.id)
    }
  }
  return changed
}

/** 启动期一次性修补（按版本门控，幂等）：老库不必重跑 AI 就能吃到连拍一致化 */
export function harmonizePersonCountOnce(): number[] {
  const s = getSettings()
  if ((s.personHarmony ?? 0) >= HARMONY_VERSION) return []
  const changed = harmonizePersonCount()
  saveSettings({ personHarmony: HARMONY_VERSION })
  console.log(`[person-harmony] 连拍人数一致化：修正 ${changed.length} 张（规则 v${HARMONY_VERSION}）`)
  return changed
}
