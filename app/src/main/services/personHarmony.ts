/**
 * 连拍组「人数一致化」修补（纯主进程，不依赖引擎，毫秒级，幂等）
 *
 * 为什么要做：3185 张真实婚礼库取证显示——
 *  - 538 个多帧连拍组里 109 组（20.3%）对同一个瞬间给出不同的人数分类；
 *  - 被判「单人照」的帧里 22.2%（185/832）所在的组内，另一帧明确拍到 ≥2 张脸。
 * 同一瞬间不可能既单人又多人，这些是确凿误判（正是"多人合拍照被标成单人照""无人物里其实有人"）。
 *
 * 为什么取「组内人脸数上界」而不是多数派投票：
 *  YuNet 极少凭空多检脸，人体框却常因遮挡/背身漏检——漏检远多于误检，所以"这一瞬间最多看到几张脸"
 *  就是现场人数的可靠下界。实测多数派投票会把 72 张「多人」按帧数改判成「单人」，方向与诉求相反。
 *
 * 两条硬约束：
 *  1) 只上调不下调（少判人 → 多判人）。把本来正确的单人照推成多人是新增误判，反向才是修错。
 *  2) 归属只在"该图因人维度才待在该分类"时重算；交付库兜底帧、坏维度、垃圾桶、用户手动放置
 *     一律不动分类（标签照样修正，避免同一组里两张卡说法不一致）。
 *
 * v2（用户拍板 2026-10-11 新口径）：合照升级门槛从"组内最多脸数"改为"组内最多正面主体数"
 * （frontalCount，引擎 v2.0.65 起输出）——同一瞬间若只有一帧拍到 2 张正脸，其余帧的侧脸/后脑
 * 不该被拉成多人合照；老库 details 无 frontalCount 时回退 faceCount，行为与 v1 一致。
 *
 * v3（用户拍板 2026-10-11 四分类）：≥2 正面主体不再一律算合拍照，要再分合拍照 / 混合照。
 * 处理原则：**人数只上调，结构跟证据帧走**——同一组连拍里只要有一帧拿到「多人合拍照」标签
 * （五道几何闸全过，是强结论），整组都按合拍照；一帧都没有才按混合照。理由：沙发全家福的
 * 连拍里夹杂着被前排虚焦人头闯进画面的帧，那些帧会被判混合照，但「这一刻是在拍合影」是确定的。
 * 两者同属交付库且互斥，误判不丢片，所以宁可保护合拍照的干净度也不拿多数票。
 */
import { getDb, getSettings, saveSettings, updateDetectResult, repairPersonMutex } from '../db'
import { computeCategory, gradeDims } from '../classify'
import type { DimensionKey, ImageRecord } from '../../shared/types'
import { PERSON_DIMS } from '../../shared/types'

/** 人数由少到多的排序：只允许往"更多人"方向改判。合拍照与混合照同为 ≥2 人，**同秩**，
 *  两者之间不互相"上调"（否则会把干净的合拍照组拖成混合照），结构差异另走下面的证据帧规则 */
const RANK: Record<string, number> = { no_person: 0, single_person: 1, mixed_photo: 2, group_photo: 2 }
/** 修补版本：改判规则升级时 +1，老库会在下次启动自动重跑（v3 = 合影/混合四分类口径） */
const HARMONY_VERSION = 3

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

/** 该图当前的人数维度标签（四选一，引擎每图只写一个） */
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
    const parsed = arr.map((r) => {
      const det = parseJson<{ faceCount?: number; frontalCount?: number | null }>(r.details, {})
      return {
        row: r,
        tags: parseJson<Record<string, { confidence: number; level?: string; reason?: string; method?: string }>>(r.tags, {}),
        // 新口径计数单位：正面主体数；旧版引擎结果无此字段时回退总脸数（与 v1 行为一致）
        faceCount: det.frontalCount ?? det.faceCount ?? 0
      }
    })
    const maxFc = Math.max(0, ...parsed.map((p) => p.faceCount))
    // ≥2 人时再分结构：组内任一帧被引擎判为「多人合拍照」（五道几何闸全过的强结论）即整组按合拍照；
    // 只跑过旧引擎的库只有 group_photo 标签，some() 仍为真 → 保持 v2 行为，不把没吃过新口径的图凭空降级
    const multiTarget: DimensionKey = parsed.some((p) => p.faceCount >= 2 && p.tags.group_photo) ? 'group_photo' : 'mixed_photo'
    const target: DimensionKey | null = maxFc >= 2 ? multiTarget : maxFc === 1 ? 'single_person' : null
    if (!target) continue
    // 证据置信度：取"看到最多脸那一帧"的同类标签置信度，拿不到就按 0.9（连拍同伴的实证比单帧推断更硬）
    const evidence = parsed.filter((p) => p.faceCount === maxFc && p.tags[target]?.confidence)
    const conf = evidence.length ? Math.max(...evidence.map((p) => p.tags[target].confidence)) : 0.9

    for (const p of parsed) {
      const cur = personDimOf(p.tags)
      if (!cur || cur === target) continue
      const rankT = RANK[target] ?? 0
      const rankC = RANK[cur] ?? 0
      // 人数只上调，不下调；同为 ≥2 人时额外放行「混合照 → 合拍照」这一个结构方向
      // （反向不降级：已经判成合拍照的帧不因同伴帧而拖回混合照）
      const allowed = rankT > rankC || (rankT === rankC && cur === 'mixed_photo' && target === 'group_photo')
      if (!allowed) continue

      const reason =
        target === 'mixed_photo'
          ? `同组连拍另一帧拍到 ${maxFc} 个正面主体且均非摆拍构图，现场至少 ${maxFc} 人（连拍一致化）`
          : `同组连拍另一帧拍到 ${maxFc} 个正面主体，现场至少 ${maxFc} 人（连拍一致化）`
      const { tags: graded } = gradeDims({ [target]: { confidence: conf, reason, method: 'burst-consensus' } }, settings)
      const newTag = graded[target]
      if (!newTag) continue

      const nextTags = { ...p.tags }
      // 用户手动标过的人数标签不参与一致化：那是人工真值，不能拿同组其它帧把它顶掉
      // （否则用户标得越多，反而被连拍修补改得越多）
      if (cur && p.tags[cur]?.method === 'user') continue
      delete nextTags[cur]
      nextTags[target] = newTag

      // 归属重算：仅限"因人维度才待在该分类"的图；交付库兜底帧与坏维度/垃圾桶保持不动
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
  // 互斥脏数据修补放在版本门控之前，而且每次都跑：它幂等（无冲突时一行都不写），
  // 而 personHarmony 只在版本上升时执行一次，护不住后续写入产生的冲突。
  const mutexFixed = repairPersonMutex()
  if (mutexFixed) console.log(`[person-harmony] 人数标签互斥修补：清理 ${mutexFixed} 张同时挂着多个人数标签的图`)
  const s = getSettings()
  if ((s.personHarmony ?? 0) >= HARMONY_VERSION) return []
  const changed = harmonizePersonCount()
  saveSettings({ personHarmony: HARMONY_VERSION })
  console.log(`[person-harmony] 连拍人数一致化：修正 ${changed.length} 张（规则 v${HARMONY_VERSION}）`)
  return changed
}
