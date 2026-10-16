/**
 * 提示词版本登记表（测试端）
 *
 * 为什么放这里而不是直接改生产文件：新提示词必须先在同批真图 + 真值集上跑出"改对几张、改坏几张"，
 * 只有确认比现在好，才允许搬进 src/main/services/aiReviewPrompt.ts（只进步不回归红线）。
 *
 * 每个版本必须自备 build() 和 parse()：输出结构一变（比如 v2 要先数人数），解析函数就得跟着变，
 * 不允许两个版本共用一个解析器——那会让新字段悄悄被丢掉，分数看起来"没变差"其实是没读到。
 */
import { buildReviewMessages as v1Build, parseModelVerdict as v1Parse } from '../src/main/services/aiReviewPrompt.ts'

export interface Variant {
  id: string
  desc: string
  build(): { system: string; userText: string }
  parse(text: string): Verdict | null
}

export interface Verdict {
  person: string
  eyes_closed: boolean
  half_head: boolean
  expression: boolean
  reason: string
  /** v2 才有：模型自报看见几个人；v1 为 null */
  person_count: number | null
  /** v2 才有：逐脸交代里是否出现过 closed（用来查 eyes_closed 汇总是否与自己的分脸记录打架） */
  face_closed_in_faces?: boolean
  /** v2 才有：person 与自报 count 是否自洽（count>=2 却选了 single 即为 false） */
  self_consistent?: boolean
}

const PERSON_ALIAS: Record<string, string> = {
  single: 'single_person',
  single_person: 'single_person',
  group: 'group_photo',
  group_photo: 'group_photo',
  mixed: 'mixed_photo',
  mixed_photo: 'mixed_photo',
  none: 'no_person',
  no_person: 'no_person'
}

function toBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (v === 1 || v === '1' || v === 'true' || v === 'yes') return true
  if (v === 0 || v === '0' || v === 'false' || v === 'no') return false
  return undefined
}

/** v1 = 生产现行提示词，逐字沿用；解析也直接用生产函数，保证基线就是线上行为 */
export const V1: Variant = {
  id: 'v1-current',
  desc: '生产现行提示词（500 字那版）',
  build: (): { system: string; userText: string } => v1Build(),
  parse: (text: string): Verdict | null => {
    const v = v1Parse(text)
    if (!v) return null
    return {
      person: v.person,
      eyes_closed: v.flaws.eyes_closed,
      half_head: v.flaws.half_head,
      expression: v.flaws.expression,
      reason: v.reason,
      person_count: null
    }
  }
}

/**
 * v2 草案（本轮只建台子，文案待与用户逐条确认后再填实）
 * 三条结构性改动，对应 7G1A8242 那张暴露的三个洞：
 *   ① 先数再判：必须先给 person_count，person 只能由 count 推，堵死"判词说两人、分类填单人"
 *   ② 硬规则：看得见 2 个及以上的人（含半身/背影/脸被挡）一律不算 single
 *   ③ 逐脸交代：每张脸单独写眼睛开闭，再汇总 eyes_closed
 */
export const V2: Variant = {
  id: 'v2-count-first',
  desc: '先数人数再归类 + 逐脸交代眼睛（草案，未启用）',
  build: (): { system: string; userText: string } => {
    const system = '你是严谨的摄影选片助手。只输出一个 JSON 对象，不要解释、不要 markdown 代码块、不要多余文字。'
    const userText = [
      '这是一张婚礼/活动跟拍照片。请按下面几个步骤依次做完，并严格返回 JSON：',
      '',
      '第 1 步 count：数画面里有几个"人"。',
      '  - 头部、躯干、背影、只露半身或局部（手、腿、侧脸）都各算一个人；宠物不算。',
      '  - 被遮挡但能确定还有一个人（比如只露出半个头、肩膀后面还有一人）也要计入。',
      '  - 拿不准是 2 个还是 3 个时，如实给你看到的数字，不要猜成 1。',
      '',
      '第 2 步 faces：为第 1 步数到的每一个人，逐条交代眼睛状态（顺序与画面从左到右一致）：',
      '  - open：眼睛明显睁开；closed：闭眼、眯眼、半睁；down：低头/侧脸/背身看不到眼球但没闭合。',
      '  - 每个都必须亲眼看过再写，不要一律写 open 交差。',
      '',
      '第 3 步 person：只能由 count 和画面状态推出，不能凭感觉改：',
      '  - count 为 0 → "none"。',
      '  - count 为 1 → "single"。',
      '  - count 大于等于 2 时绝不可能是 "single"：多人面向镜头规整摆拍（站位齐整、都看镜头）→ "group"；',
      '    其余情况（新人两个人互动、接亲、敬酒、仪式、路人走动等抓拍）→ "mixed"。',
      '    特别注意：新郎新娘两个人在一起的画面属于 "mixed"，不属于 "single"。',
      '',
      '第 4 步 flaws：三项内容瑕疵，各给 true/false（模糊/曝光/黑白一律不判）：',
      '  - eyes_closed：第 2 步里出现过 closed 即为 true；全是 open 或 down 则 false。',
      '  - half_head：主要人物头部被画面边缘裁掉一部分。远景小人物头部不完整不算 true。',
      '  - expression：表情崩坏（露牙怪笑、仰头狰狞、翻白眼扭曲）。正常大笑/微笑不算 true。',
      '',
      '第 5 步 reason：一句中文（不超过 40 字）说明依据，必须与你写的 count、faces 不矛盾。',
      '',
      '只返回如下结构的 JSON：',
      '{"count":2,"faces":[{"eyes":"open"},{"eyes":"closed"}],"person":"mixed","flaws":{"eyes_closed":true,"half_head":false,"expression":false},"reason":"新郎新娘两人互动，新娘闭眼"}'
    ].join('\n')
    return { system, userText }
  },
  parse: (text: string): Verdict | null => {
    if (!text) return null
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return null
    let o: Record<string, unknown>
    try {
      o = JSON.parse(m[0]) as Record<string, unknown>
    } catch {
      return null
    }
    const raw = typeof o.person === 'string' ? o.person.trim().toLowerCase() : ''
    const person = PERSON_ALIAS[raw]
    if (!person) return null
    const f = o.flaws as Record<string, unknown> | undefined
    if (!f || typeof f !== 'object') return null
    const eyes = toBool(f.eyes_closed)
    const half = toBool(f.half_head)
    const expr = toBool(f.expression)
    if (eyes === undefined || half === undefined || expr === undefined) return null
    const count = typeof o.count === 'number' ? o.count : null
    // 自洽校验（只记录不否决）：count 与 person 打架说明模型没按规则走，打分时要能看见
    const faces = Array.isArray(o.faces) ? (o.faces as Array<Record<string, unknown>>) : []
    const faceClosed = faces.some((x) => String(x.eyes || '').toLowerCase() === 'closed')
    const selfOk =
      count === null
        ? true
        : count === 0
          ? person === 'no_person'
          : count === 1
            ? person === 'single_person'
            : person === 'group_photo' || person === 'mixed_photo'
    return {
      person,
      eyes_closed: eyes,
      half_head: half,
      expression: expr,
      reason: typeof o.reason === 'string' ? o.reason.trim() : '',
      person_count: count,
      face_closed_in_faces: faceClosed,
      self_consistent: selfOk
    }
  }
}

/**
 * v3（定向修 7G1A8242 那类"两人被判单人"，输出格式与 v1 完全一致，复用生产解析器）
 * 只比 v1 加三处，刻意避开 v2 翻车的原因：
 *   ① 第 0 步先在心里"数人"（侧脸/低头/背影/半都算在场），把尺子从"正面主体"换成"在场的人"；
 *   ② single 加硬规则：数到 2 个及以上就织不选 single（但不像 v2 那样"≥2 一律 mixed"，
 *      保留"两人看镜头摆拍=group"，不再写"新人两人=mixed"那个把合影带坑的错例子）；
 *   ③ reason 里的人数必须与第 0 步数到的一致，堵死"判词说两人、分类填单人"。
 * 闭眼措辞逐字沿用 v1（v2 的逐脸交代把闭眼回忆拖低了，这里不碰）。
 */
export const V3: Variant = {
  id: 'v3-count-guard',
  desc: '现行提示词 + 先数人/≥2不选single/reason人数对齐（定向修两人判单人）',
  build: (): { system: string; userText: string } => {
    const system = '你是严谨的摄影选片助手。只输出一个 JSON 对象，不要解释、不要 markdown 代码块、不要多余文字。'
    const userText = [
      '这是一张婚礼/活动跟拍里被本地算法判为「待确认」的边缘照片。请严格按下面步骤做，并只返回 JSON：',
      '',
      '第 0 步 先数人：心里数一下画面里有几个“在场的人”。正脸、侧脸、低头、背影、只露半身或局部的，只要是真实存在的人统统算一个（宠物不算，镜子/照片里的人像不算）。记住这个人数，后面每一步都不许和它矛盾。',
      '',
      '1) person：画面人物归属，取值只能是以下四个英文词之一：',
      '   - "single"：第 0 步只数到 1 个人时才能选。硬规则：只要数到 2 个及以上在场的人（哪怕此人不看镜头、侧身、低头、被挡住、只露半身），就绝不能选 single，必须往下选 group 或 mixed。',
      '   - "group"：多人且面向镜头规整摆拍合影（站位齐整、都看镜头）；两个人并肩都看镜头的摆拍也算 group。',
      '   - "mixed"：现场多人但非规整摆拍（接亲、游戏、仪式、路人走动，或新人/两人正在互动、各看各的、有人侧身低头的抓拍情节）。多人但凑不出规整主群时用这个。',
      '   - "none"：第 0 步数到 0 个人（纯景物/静物/无人）。',
      '',
      '2) flaws：以下三种「内容型」瑕疵是否存在，各给 true/false（只判这三项，模糊/曝光/黑白一律不判）：',
      '   - eyes_closed：有人闭眼。眯眼、半睁也算 true；但低头/侧脸/远看像闭眼而眼睛实际睁着的算 false。',
      '   - half_head：主要人物头部被画面边缘裁掉一部分（半截头）。远景小人物头部不完整不算 true。',
      '   - expression：表情崩坏（露牙怪笑、仰头狰狞、翻白眼扭曲等难看的表情）。正常大笑/微笑不算 true。',
      '',
      '3) reason：用一句中文说明判断依据（不超过 40 字），里面提到的人数必须与第 0 步数到的一致（若第 0 步数到 2 人，reason 不得写“仅一人”且 person 不得选 single）。',
      '',
      '只返回如下结构的 JSON，person 用上面四个英文词之一：',
      '{"person":"mixed","flaws":{"eyes_closed":false,"half_head":false,"expression":false},"reason":"新郎新娘两人在互动、新娘侧身，非摆拍合影"}'
    ].join('\n')
    return { system, userText }
  },
  // 输出 schema 与 v1 一致（person/flaws/reason），直接复用生产解析器，保证对比同口径、不引入新解析失败
  parse: (text: string): Verdict | null => {
    const v = v1Parse(text)
    if (!v) return null
    return {
      person: v.person,
      eyes_closed: v.flaws.eyes_closed,
      half_head: v.flaws.half_head,
      expression: v.flaws.expression,
      reason: v.reason,
      person_count: null
    }
  }
}

/**
 * v4（只改 v1 里那一害句，最小扰动）
 * v2/v3 都因"先数人"的全局指令导致模型过度找人→单人/合影/闭眼全面回归。
 * v4 不数人、不改 group/eyes，只把 single 定义里"侧脸/背影不算完整主体"这句
 * 反向改成"只要还能看到第二个人（哪怕侧脸/低头/背影）就不许 single"，
 * 直接针对 7G1A8242 那类"正面一个+侧身一个→被判单人"。
 */
const V4_OLD_SINGLE = '"single"：恰好一个完整的人（宠物不计入人数；只拍到手/背影等无完整人物主体不算 single）。'
const V4_NEW_SINGLE =
  '"single"：画面里从头到尾只有一个人（宠物不计入人数）。硬规则：只要除了主角还能看到第二个人——哪怕他侧脸、低头、背影、只露一只手或半身——就不算 single，要选 group 或 mixed。'
export const V4: Variant = {
  id: 'v4-single-guard',
  desc: 'v1 全文，仅把 single 定义里的"侧脸背影不算主体"改为"有第二人就不许single"',
  build: (): { system: string; userText: string } => {
    const base = v1Build()
    if (!base.userText.includes(V4_OLD_SINGLE)) {
      throw new Error('v1 的 single 定义行被改过，v4 的字符串替换失效，需同步更新 V4_OLD_SINGLE')
    }
    return { system: base.system, userText: base.userText.replace(V4_OLD_SINGLE, V4_NEW_SINGLE) }
  },
  parse: (text: string): Verdict | null => {
    const v = v1Parse(text)
    if (!v) return null
    return {
      person: v.person,
      eyes_closed: v.flaws.eyes_closed,
      half_head: v.flaws.half_head,
      expression: v.flaws.expression,
      reason: v.reason,
      person_count: null
    }
  }
}

/**
 * v5（v1 逐字不动，只额外要求一个 count 数字，并在解析时强制"count≥2 就不是 single"）
 * v2/v3/v4 都靠改 person 定义来堵，结果一加强"多人"力度就把合影/单人数误伤。
 * v5 不碰任何 person/eyes 措辞（合影、闭眼定义与 v1 一字相同），只：
 *   ① 输出多一个整数字段 count（在场人数，侧脸/低头/背影都算）；
 *   ② 一致性硬规则：count≥2 时 person 不能是 single；
 *   ③ 解析时自纠偏：若模型仍交 single 但 count≥2 → 按 count 改判 mixed（把"看见两人却填单人"坐实为多人）。
 * 这样只修"自相矛盾"那一类，不靠改措辞去赌模型认知，合影/闭眼不受文字扰动。
 */
export const V5: Variant = {
  id: 'v5-count-consistency',
  desc: 'v1 逐字 + count 字段 + 解析时强制 count≥2 不得为 single（自纠偏）',
  build: (): { system: string; userText: string } => {
    const base = v1Build()
    const OLD_NONE = '   - "none"：画面没有人物主体（纯景物/静物/无人）。'
    const OLD_REASON = '3) reason：用一句中文说明你的判断依据（不超过 40 字）。'
    const OLD_EXAMPLE =
      '{"person":"group","flaws":{"eyes_closed":false,"half_head":false,"expression":false},"reason":"四人并排均面向镜头，站位齐整"}'
    for (const need of [OLD_NONE, OLD_REASON, OLD_EXAMPLE]) {
      if (!base.userText.includes(need)) {
        throw new Error('v1 正文被改过，v5 的三处字符串定位失效，需同步更新 V5')
      }
    }
    let text = base.userText
    text = text.replace(
      OLD_NONE,
      OLD_NONE +
        '\n   一致性硬规则：下面第 3 项 count 是画面里“在场的人”的个数；count≥2 时 person 绝不能是 "single"（哪怕有人侧脸/低头/被挡），只能选 group 或 mixed；只有 count==1 才允许 single。'
    )
    text = text.replace(
      OLD_REASON,
      '3) count：画面里“在场的人”一共几个，给一个整数（正脸/侧脸/低头/背影/只露半身都各算一个，宠物不计）。\n4) reason：用一句中文说明你的判断依据（不超过 40 字）。'
    )
    text = text.replace(
      OLD_EXAMPLE,
      '{"person":"group","flaws":{"eyes_closed":false,"half_head":false,"expression":false},"count":4,"reason":"四人并排均面向镜头，站位齐整"}'
    )
    return { system: base.system, userText: text }
  },
  // 复用 v1 解析拿 person/flaws/reason（person 定义未变），另读 count 做一致性纠偏
  parse: (text: string): Verdict | null => {
    const v = v1Parse(text)
    if (!v) return null
    let count: number | null = null
    const m = text.match(/\{[\s\S]*\}/)
    if (m) {
      try {
        const c = (JSON.parse(m[0]) as Record<string, unknown>).count
        if (typeof c === 'number' && Number.isFinite(c)) count = Math.trunc(c)
        else if (typeof c === 'string' && /^\d+$/.test(c.trim())) count = Number(c.trim())
      } catch {
        count = null
      }
    }
    let person = v.person
    // 一致性纠偏：count 明确≥2 却判了 single → 按 count 改为 mixed（不猜，仅在有明确 count≥2 证据时）
    if (count !== null && count >= 2 && person === 'single_person') person = 'mixed_photo'
    return {
      person,
      eyes_closed: v.flaws.eyes_closed,
      half_head: v.flaws.half_head,
      expression: v.flaws.expression,
      reason: v.reason,
      person_count: count,
      self_consistent: count === null ? undefined : !(count >= 2 && v.person === 'single_person')
    }
  }
}

/**
 * v6（用户 2026-10-16 亲手改写的新一版，已按用户裁定修好两处自相矛盾）
 * 用户裁定：背身/低头的路人都算人（计入人数，只不拿来判瑕疵）；海报/镜面/照片/屏幕里的人像不算人。
 * 相比原稿只改了两处：① single 里把"背影"从"不算人"移到"算人"；② none 里去掉"背影"（一个背对镜头的人不是无人）。
 * 其余 group/mixed/眼眉措辞逐字保留用户原稿。输出结构与 v1 一致→可复用生产解析器、不改任何代码。
 */
const V6_SYSTEM =
  '你是严谨的世界顶级婚礼跟拍摄影选片师。你的输出会被程序按 JSON 严格解析——只输出一个 JSON 对象，字段名和取值必须完全照下面的规定，加解释、换写法、用候选列表都会被判为无效。不要 markdown 代码块。'
const V6_NONE_LINE =
  '   - "none"：画面没有任何一个真实存在的人体（纯景物/静物/无人；只有镜面/照片/海报/屏幕里的人像、或只剩一只手/脚/局部肢体这种，也算 none）。'
const V6_REASON_LINE = '3) reason：用一句不超过 40 字的中文说明判断依据，要和上面的 person、flaws 对得上。'
const V6_EXAMPLE_LINE =
  '{"person":"group","flaws":{"eyes_closed":false,"half_head":false,"expression":false},"reason":"伴娘们举香槟围成一排面向镜头合影"}'
const V6_USER_LINES: string[] = [
  '这是一张婚礼/活动跟拍里被本地算法判为「待确认」的边缘照片，请作为独立第二意见，只看画面内容，按以下三部分返回一个 JSON：',
  '',
  '1) person：画面人物归属，只能从这四个英文词里选【一个】原样输出（不要加斜杠、不要写候选、不要自造词）：',
  '   - "single"：整幅画面只有 1 个能认出是人的完整个体，且没有第二个可辨别人。数人时，只要看得见一个人体——正面、侧身、低头、背影都算——就是一个人；背景路人、远景小人、边缘误入的人（哪怕背对镜头）都算"第二个人"，只要有就不能用 single。不算人的只有：宠物；镜面/照片/海报/屏幕里的人像；只拍到一只手/脚/局部肢体、看不出是完整个体的。',
  '   - "group"：多人合影，满足以下任一条即为 group：①一群人专门为拍这张照、共同面向镜头摆好姿势（哪怕站位乱、高矮错落、前后层叠、半躺、比耶、搞怪都算）；②一群人站位/排列规整（哪怕个别人没完全看镜头）。哪怕只有 2 人一起摆拍看镜头也算 group。',
  '   - "mixed"：现场多人，但既不是“大家共同为拍照摆拍”、站位也不规整——正处在接亲、敬酒、游戏、仪式、走动等事件动作里，大家在对现场做反应（哪怕有人碰巧看向镜头、比耶，也算 mixed）；或只有 1 个主体看向镜头、其余是背景路人/误入者。',
  '   - 判 group 还是 mixed，看“是不是大家专门为这张照停下来摆拍”，不看“是什么场景”：接亲/敬酒场景里大家停下动作凑一起为镜头摆一张 → group；同一场景里各忙各的、只是碰巧看镜头 → mixed。',
  V6_NONE_LINE,
  '',
  '2) flaws：只判下面三种「内容型」瑕疵，各给 true 或 false；模糊、曝光、黑白这类画质问题一律不判（本地已判，你不用重复、也不要改口）。三项都只对“清晰、够大的主要人物”判，远景小人、虚化的人、路人/误入者一律不计；拿不准一律给 false（宁可漏标，别误标）：',
  '   - eyes_closed：只认眼睛基本闭死、眯成一条缝才算 true（眨眼被抓拍、睡着、故意闭眼、单眼闭死都算）。因为笑容把眼睛眯起来、但明显是在笑的状态，不算闭眼（false）；正常睁眼只是远看像闭眼，false；戴墨镜、或眼睛被头发/手/物体完全挡住看不清，false；低头/侧脸/仰头时，除非能确认眼皮确实闭上，否则 false。',
  '   - half_head：只对清晰主要人物判。头部被画面任意一条边裁掉、且裁到影响这张照能用才算 true——比如脸上五官（眼/鼻/嘴）被切、或头顶/下巴被裁掉一大块。只是发尖或一点点头顶刚出框、属于正常构图的，false。远景小人、模糊的人、路人/误入者头不完整，false。',
  '   - expression：只对清晰主要人物判。出现明显崩坏难看的表情才 true（露牙怪笑、仰头狰狞、翻白眼、五官扭曲、失控怪相）。自然微笑、正常大笑、感动流泪、认真专注都不算 true。',
  '',
  V6_REASON_LINE,
  '',
  '只返回如下结构的 JSON（person 是单个英文词，不是候选列表）：',
  V6_EXAMPLE_LINE
]
export const V6: Variant = {
  id: 'v6-user-rewrite',
  desc: '用户 10-16 改写版（修好背身/海报两处矛盾），输出结构同 v1',
  build: (): { system: string; userText: string } => ({ system: V6_SYSTEM, userText: V6_USER_LINES.join('\n') }),
  parse: (text: string): Verdict | null => {
    const v = v1Parse(text)
    if (!v) return null
    return {
      person: v.person,
      eyes_closed: v.flaws.eyes_closed,
      half_head: v.flaws.half_head,
      expression: v.flaws.expression,
      reason: v.reason,
      person_count: null
    }
  }
}

/**
 * v7 = v6 正文 + count 字段 + 解析时强制"count≥2 不得为 single"自纠偏（唯一实测有效的招叠在用户新版上）
 */
export const V7: Variant = {
  id: 'v7-user-rewrite-plus-count',
  desc: 'v6 全文 + count 字段 + count≥2 就不得为 single（自纠偏）',
  build: (): { system: string; userText: string } => {
    let text = V6_USER_LINES.join('\n')
    if (!text.includes(V6_NONE_LINE) || !text.includes(V6_REASON_LINE) || !text.includes(V6_EXAMPLE_LINE)) {
      throw new Error('v6 正文被改过，v7 的三处字符串定位失效，需同步更新 V7')
    }
    text = text.replace(
      V6_NONE_LINE,
      V6_NONE_LINE +
        '\n   一致性硬规则：下面第 3 项 count 是画面里“真实存在的人”的个数；count≥2 时 person 绝不能是 "single"（哪怕有人侧脸/低头/背影/被挡），只能选 group 或 mixed；只有 count==1 才允许 single。'
    )
    text = text.replace(
      V6_REASON_LINE,
      '3) count：画面里“真实存在的人”一共几个，给一个整数（正面/侧脸/低头/背影/只露半身都各算一个；宠物、镜面/照片/海报/屏幕里的人像不计）。\n4) reason：用一句不超过 40 字的中文说明判断依据，要和上面的 person、flaws、count 对得上。'
    )
    text = text.replace(
      V6_EXAMPLE_LINE,
      '{"person":"group","flaws":{"eyes_closed":false,"half_head":false,"expression":false},"count":4,"reason":"伴娘们举香槟围成一排面向镜头合影"}'
    )
    return { system: V6_SYSTEM, userText: text }
  },
  parse: (text: string): Verdict | null => {
    const v = v1Parse(text)
    if (!v) return null
    let count: number | null = null
    const m = text.match(/\{[\s\S]*\}/)
    if (m) {
      try {
        const c = (JSON.parse(m[0]) as Record<string, unknown>).count
        if (typeof c === 'number' && Number.isFinite(c)) count = Math.trunc(c)
        else if (typeof c === 'string' && /^\d+$/.test(c.trim())) count = Number(c.trim())
      } catch {
        count = null
      }
    }
    let person = v.person
    if (count !== null && count >= 2 && person === 'single_person') person = 'mixed_photo'
    return {
      person,
      eyes_closed: v.flaws.eyes_closed,
      half_head: v.flaws.half_head,
      expression: v.flaws.expression,
      reason: v.reason,
      person_count: count,
      self_consistent: count === null ? undefined : !(count >= 2 && v.person === 'single_person')
    }
  }
}

/**
 * v8 = v6 正文但把 group 收紧（修掉 v6 吞 144 张混合照的坑）+ 保留 count 闸 + 保留闭眼收紧
 * v6 实测：合影从 13 救到 27（好），但 group 太能抢→把 144 张接亲/走动抓拍当合影（坏）。
 * v8 只改 group/mixed 三句：合影必须“大家专为这张照停下来、一起面向镜头定格”；
 *   只要还在办事/有人侧身互动就不是合影；拿不准一律 mixed（合影是少数，宁可保守）。
 */
const G_OLD1 =
  '   - "group"：多人合影，满足以下任一条即为 group：①一群人专门为拍这张照、共同面向镜头摆好姿势（哪怕站位乱、高矮错落、前后层叠、半躺、比耶、搞怪都算）；②一群人站位/排列规整（哪怕个别人没完全看镜头）。哪怕只有 2 人一起摆拍看镜头也算 group。'
const G_NEW1 =
  '   - "group"：一群人明显是为了拍这张照而停下来、一起面向镜头定格合影（人人基本都在看镜头、姿态是为拍照摆出来的）。两人并肩都看着镜头静止摆拍也算 group，但只要有一人在互动/侧身/低头就不算。拿不准就往 mixed 靠。'
const G_OLD2 =
  '   - "mixed"：现场多人，但既不是“大家共同为拍照摆拍”、站位也不规整——正处在接亲、敬酒、游戏、仪式、走动等事件动作里，大家在对现场做反应（哪怕有人碰巧看向镜头、比耶，也算 mixed）；或只有 1 个主体看向镜头、其余是背景路人/误入者。'
const G_NEW2 =
  '   - "mixed"：现场多人，但大家正在办事（接亲、敬酒、游戏、仪式、走动、各忙各的），哪怕有人碰巧看向镜头、比耶、或站得还算齐，只要不像专门为这张照集体定格，就算 mixed；只有 1 个主体面向镜头、其余是背景路人/误入者，也算 mixed。'
const G_OLD3 =
  '   - 判 group 还是 mixed，看“是不是大家专门为这张照停下来摆拍”，不看“是什么场景”：接亲/敬酒场景里大家停下动作凑一起为镜头摆一张 → group；同一场景里各忙各的、只是碰巧看镜头 → mixed。'
const G_NEW3 =
  '   - group 与 mixed 只认一件事：是不是“大家特意为这张照停下来、一起面向镜头定格”。是→group；只是办事中碰巧看镜头、或只是站得齐→mixed。拿不准时一律选 mixed（合影是少数，宁可保守）。'
export const V8: Variant = {
  id: 'v8-tighten-group-count',
  desc: 'v6 但 group 收紧（必须集体定格否则 mixed、拿不准选mixed）+ count 闸 + 闭眼收紧',
  build: (): { system: string; userText: string } => {
    let text = V6.build().userText
    for (const need of [G_OLD1, G_OLD2, G_OLD3, V6_NONE_LINE, V6_REASON_LINE, V6_EXAMPLE_LINE]) {
      if (!text.includes(need)) {
        throw new Error('v6 正文被改过，v8 的字符串定位失效，需同步更新 V8')
      }
    }
    text = text.replace(G_OLD1, G_NEW1).replace(G_OLD2, G_NEW2).replace(G_OLD3, G_NEW3)
    // 以下与 v7 相同：注入 count 字段 + 一致性硬规则 + 修正例 JSON
    text = text.replace(
      V6_NONE_LINE,
      V6_NONE_LINE +
        '\n   一致性硬规则：下面第 3 项 count 是画面里“真实存在的人”的个数；count≥2 时 person 绝不能是 "single"（哪怕有人侧脸/低头/背影/被挡），只能选 group 或 mixed；只有 count==1 才允许 single。'
    )
    text = text.replace(
      V6_REASON_LINE,
      '3) count：画面里“真实存在的人”一共几个，给一个整数（正面/侧脸/低头/背影/只露半身都各算一个；宠物、镜面/照片/海报/屏幕里的人像不计）。\n4) reason：用一句不超过 40 字的中文说明判断依据，要和上面的 person、flaws、count 对得上。'
    )
    text = text.replace(
      V6_EXAMPLE_LINE,
      '{"person":"group","flaws":{"eyes_closed":false,"half_head":false,"expression":false},"count":4,"reason":"伴娘们举香槟围成一排面向镜头合影"}'
    )
    return { system: V6_SYSTEM, userText: text }
  },
  parse: (text: string): Verdict | null => {
    const v = v1Parse(text)
    if (!v) return null
    let count: number | null = null
    const m = text.match(/\{[\s\S]*\}/)
    if (m) {
      try {
        const c = (JSON.parse(m[0]) as Record<string, unknown>).count
        if (typeof c === 'number' && Number.isFinite(c)) count = Math.trunc(c)
        else if (typeof c === 'string' && /^\d+$/.test(c.trim())) count = Number(c.trim())
      } catch {
        count = null
      }
    }
    let person = v.person
    if (count !== null && count >= 2 && person === 'single_person') person = 'mixed_photo'
    return {
      person,
      eyes_closed: v.flaws.eyes_closed,
      half_head: v.flaws.half_head,
      expression: v.flaws.expression,
      reason: v.reason,
      person_count: count,
      self_consistent: count === null ? undefined : !(count >= 2 && v.person === 'single_person')
    }
  }
}

/**
 * v9 = v8 只改一处：把"数人"规则钉死——只有能看到头或躯干的人体才算一个人；
 *   化妆/助理只是把手或手臂伸进画面（哪怕好几只在补妆、整理衣服）不计入 count。
 * 动机（真图目检 2026-10-16）：v8 的 count 闸救回了真双人（8501 举灯助理、9000 摆拍母女），
 *   但把"只有化妆师的手"（7677/7679/7680）也数成第二个人，误把单人顶成混合。
 *   v9 目标是保住 rescue、砍掉这个误伤。一次只改这一个变量，便于逐张目检归因。
 */
const V9_COUNT_OLD =
  '3) count：画面里“真实存在的人”一共几个，给一个整数（正面/侧脸/低头/背影/只露半身都各算一个；宠物、镜面/照片/海报/屏幕里的人像不计）。'
const V9_COUNT_NEW =
  '3) count：画面里“真实存在的人”一共几个，给一个整数（正面/侧脸/低头/背影/只露半身都各算一个；宠物、镜面/照片/海报/屏幕里的人像不计）。关键：只数能看到头或躯干的人体；化妆师/助理只是把手或手臂伸进画面（哪怕同时好几只手在补妆、整理衣服、递东西），只要看不到那个人的头和身体，就不算在场的人、不计入 count。'
const V9_SINGLE_OLD = V6_USER_LINES[3]
const V9_SINGLE_NEW =
  V6_USER_LINES[3] +
  ' 特别注意：别人只是伸进画面的手/手臂（看不到其头和躯干），不算“第二个人”，不要因为看到化妆/助理的手就把 single 改成 mixed。'
export const V9: Variant = {
  id: 'v9-hands-not-counted',
  desc: 'v8 但把"伸进来的手不计入人数"钉死（修 v8 把手误判成第二人）+ 保留 count 闸/group 收紧/闭眼收紧',
  build: (): { system: string; userText: string } => {
    let text = V8.build().userText
    for (const need of [V9_COUNT_OLD, V9_SINGLE_OLD]) {
      if (!text.includes(need)) {
        throw new Error('v8 正文被改过，v9 的两处字符串定位失效，需同步更新 V9')
      }
    }
    text = text.replace(V9_COUNT_OLD, V9_COUNT_NEW).replace(V9_SINGLE_OLD, V9_SINGLE_NEW)
    return { system: V6_SYSTEM, userText: text }
  },
  parse: (text: string): Verdict | null => V8.parse(text)
}

/**
 * v10 = v9 的逐字克隆（提示词与解析完全相同），只为一个目的：测 AI 同输入跑两遍的波动。
 * 缓存键含版本 id，换个 id 就会重新真调 API（不命中 v9 的旧缓存）；
 * 于是 v9（第一遍） vs v10（第二遍）的判定差异 = 纯模型跑动噪声，与提示词无关。
 */
export const V10: Variant = {
  id: 'v10-repeat-v9',
  desc: 'v9 逐字克隆（同提示词同模型再跑一遍），专测 AI 跑两遍的吻合率',
  build: (): { system: string; userText: string } => V9.build(),
  parse: (text: string): Verdict | null => V9.parse(text)
}

/**
 * v11 = v9 只改一处：把闭眼判据从"看她在不在笑"改回"看眼睛还剩多少开合度"（与本地 eyes.py 对齐）。
 * 动机（真图目检 2026-10-16，7G1A7958）：v9 那句"因为笑容把眼睛眯起来…不算闭眼"是对本地口径的
 *   过度简化转述——本地 eyes.py 判的是 EAR/blink 物理开合度（EAR≤0.06 眯成一条线=满分闭眼，
 *   EAR 0.20+ 只是眯细但还看得见眼=0 分），根本不看"笑没笑"。v9 把"看开合度"错写成"看笑没笑"，
 *   导致笑到眼睛挤闭、看不到眼珠的图被放过。v11 用"还能不能看到眼珠/眼白"这一物理判据替换，
 *   既救回 7958，又保留当初防"正常笑眯眼误标"的目的（眼睛还睁着→仍 false）。一次只改这一个变量。
 */
const V11_EYES_OLD =
  '   - eyes_closed：只认眼睛基本闭死、眯成一条缝才算 true（眨眼被抓拍、睡着、故意闭眼、单眼闭死都算）。因为笑容把眼睛眯起来、但明显是在笑的状态，不算闭眼（false）；正常睁眼只是远看像闭眼，false；戴墨镜、或眼睛被头发/手/物体完全挡住看不清，false；低头/侧脸/仰头时，除非能确认眼皮确实闭上，否则 false。'
const V11_EYES_NEW =
  '   - eyes_closed：只判眼睛闭没闭，跟她在不在笑无关。判据只看眼睛还剩多少开合度——只要眼睛闭合成一条缝、几乎看不到眼珠或眼白（笑到眼睛挤闭、眨眼被抓拍、睡着、故意闭眼、单眼闭死都算）→ true。只有眼睛还睁着、能看到眼珠或眼白——哪怕笑成弯月、眯细——才 → false。正常睁眼只是远看像闭眼，false；戴墨镜、或眼睛被头发/手/物体完全挡住看不清，false；低头/侧脸/仰头时，除非能确认眼皮确实闭上，否则 false。'
export const V11: Variant = {
  id: 'v11-eyes-by-opening',
  desc: 'v9 但闭眼改回物理判据：看不到眼珠/眼白即算闭眼（哪怕在笑），对齐本地 eyes.py',
  build: (): { system: string; userText: string } => {
    const base = V9.build()
    if (!base.userText.includes(V11_EYES_OLD)) {
      throw new Error('v9 正文被改过，v11 的闭眼定位失效，需同步更新 V11')
    }
    return { system: base.system, userText: base.userText.replace(V11_EYES_OLD, V11_EYES_NEW) }
  },
  parse: (text: string): Verdict | null => V9.parse(text)
}

/**
 * v12 = v11 只改两处：半截头判据 + 表情崩坏判据（真图目检 2026-10-16，144 张唯一图逐张开图核过）。
 * 动机：
 *   ① half_head 收得过紧——7427/7421/7443/8214/8215/9837 等大特写/横躺旋转图，额头头顶被边裁掉
 *      一大块、只剩五官在框里，v11 以"未遮挡五官/像故意构图"放过。v12 明确：看不到完整头部轮廓就算，
 *      不因"像故意构图"豁免；同时给无脸图（景物/只有手/背影）钉死 false，防乱标。
 *   ② expression 在 144 张上全填 false（整维失灵）——"正常大笑不算"+"拿不准一律false"叠加导致模型
 *      永远保守。v12 改成与本地 expression.py 同款的物理判据：眼睛挤没 + 丑嘴型（大张嘴露牙/龇牙/
 *      横拉/整脸皱）同时成立才 true；眼睛还睁着或五官舒展（哪怕大笑、亲吻）一律 false，
 *      守住 7601（大笑但眼睛睁着）、8666（亲吻）两条误伤红线。
 * 一次只改这两个变量，其余全部继承 v11（含闭眼物理判据、count 闸、 hands 规则）。
 */
const V12_HALF_OLD =
  '   - half_head：只对清晰主要人物判。头部被画面任意一条边裁掉、且裁到影响这张照能用才算 true——比如脸上五官（眼/鼻/嘴）被切、或头顶/下巴被裁掉一大块。只是发尖或一点点头顶刚出框、属于正常构图的，false。远景小人、模糊的人、路人/误入者头不完整，false。'
const V12_HALF_NEW =
  '   - half_head：只对清晰主要人物判。头部被画面任意一条边裁掉一大块就算 true，两种情形都算：①脸上五官（眼/鼻/嘴）被切；②哪怕五官都在画面里，只要额头/头顶/下巴被边裁掉一大块、看不到完整的头部轮廓（超大脸部特写、横躺或旋转构图的特写都算，不要以"像是故意构图"为理由放过）。只是发尖或一点点头顶刚出框、属于正常构图的，false。远景小人、模糊的人、路人/误入者头不完整，false。画面里根本没有脸（纯景物、只有手或局部肢体、背影），false。'
const V12_EXPR_OLD =
  '   - expression：只对清晰主要人物判。出现明显崩坏难看的表情才 true（露牙怪笑、仰头狰狞、翻白眼、五官扭曲、失控怪相）。自然微笑、正常大笑、感动流泪、认真专注都不算 true。'
const V12_EXPR_NEW =
  '   - expression：只对清晰主要人物判，看的是五官的物理状态，不是"笑没笑"。true 必须同时满足两条：①眼睛用力挤成一条缝、几乎闭没（不是自然微眯，也不是亲吻/感动时平和闭上的眼）；②嘴大张露牙、或龇牙、或嘴角用力横拉、或整脸皱起用力。有一条不成立就 false：眼睛还睁着能看到眼珠，false；嘴是闭着、抿着、或笑而不露齿，且五官舒展，false——哪怕她在哈哈大笑。亲吻、感动流泪、认真专注、自然微笑都不算 true。'
export const V12: Variant = {
  id: 'v12-halfhead-expression',
  desc: 'v11 但补两处判据：半截头不再放过裁掉额头/头顶的特写；表情崩坏改物理判据（眼睛挤没+丑嘴型同时成立）',
  build: (): { system: string; userText: string } => {
    const base = V11.build()
    for (const need of [V12_HALF_OLD, V12_EXPR_OLD]) {
      if (!base.userText.includes(need)) {
        throw new Error('v11 正文被改过，v12 的半截头/表情崩坏定位失效，需同步更新 V12')
      }
    }
    const userText = base.userText.replace(V12_HALF_OLD, V12_HALF_NEW).replace(V12_EXPR_OLD, V12_EXPR_NEW)
    return { system: base.system, userText }
  },
  parse: (text: string): Verdict | null => V11.parse(text)
}

/**
 * v12b = v12 只给半截头加两道护栏（表情那句沿用 v12）。动机（真图目检 2026-10-16 对拍）：
 *   v12 半截头认出从 8→11/12（修好用户报的 7427），但放宽过头冒出 2 个真乱标：
 *     7623 新娘五官完整、只是金冠头饰贴上边被当成裁头；0849 多人仪式抓拍里数了配角花童的头。
 *   护栏①：五官都在、只有头饰/纱/发丝贴边、头部轮廓本身还完整 → false（正常特写构图，压 7623/7722）。
 *   护栏②：多人动作/互动抓拍、主体不是单个清晰人时，配角/花童/路人头被边裁 → false（压 0849）。
 *   要求不得误伤 7427（半张脸被切）/8214/9837（头顶真被裁，非仅头饰）。
 */
const V12B_HALF_OLD = V12_HALF_NEW
const V12B_HALF_NEW =
  V12_HALF_NEW.replace(
    '画面里根本没有脸（纯景物、只有手或局部肢体、背影），false。',
    '两条护栏（命中就 false）：①如果眼/鼻/嘴五官都清楚在画面里、只有头饰/纱/发丝贴到画面边或微被裁、本人头部轮廓本身还基本完整，这属于正常特写构图，false，不要把"头饰贴边"当成裁头。②多人动作/互动抓拍（仪式、堵门、敬酒等，主体不是单独某一个人）里，只有配角/花童/路人的头被边裁，false。画面里根本没有脸（纯景物、只有手或局部肢体、背影），false。'
  )
export const V12B: Variant = {
  id: 'v12b-halfhead-guard',
  desc: 'v12 但给半截头补两道护栏：五官完整仅头饰贴边→false；多人动作照配角头被裁→false（压 v12 的 7623/0849 乱标）',
  build: (): { system: string; userText: string } => {
    const base = V12.build()
    if (!base.userText.includes(V12B_HALF_OLD)) {
      throw new Error('v12 半截头正文被改过，v12b 护栏定位失效，需同步更新 V12B')
    }
    return { system: base.system, userText: base.userText.replace(V12B_HALF_OLD, V12B_HALF_NEW) }
  },
  parse: (text: string): Verdict | null => V12.parse(text)
}

/**
 * v12c = v11 基础上：半截头改"宽口径判别式"（用户 2026-10-16 二次拍板，couple1 人工标签为准）+ 表情崩坏沿用 v12 物理判据。
 * 动机：上一版"只认五官被边裁"收得太窄，漏掉你人工标 true 的遮挡类（8758）与多人照前景人头被裁（9488/9533/9582），
 *   8758 甚至比线上 V11 还倒退。v12c 改成"主要/前景人物脸看不全就算"（边裁+遮挡都算），同时用护栏守住
 *   "脸完整只贴边/正常侧脸角度/远景背景小头/根本没脸"四类不乱标。锚点：7427/8214/8215/9837/0832/8758/9488=true，
 *   7421/7443/7775/9286/9287/7623/7415/7441/9865=false。
 */
const V12C_HALF_NEW =
  '   - half_head：只对画面里清楚、靠前、算主要人物的人判。核心看"这个人的脸能不能看全"。只要某个主要人物的五官凑不出一张完整的脸——不管是被画面某条边裁掉，还是被花束/物体/别人挡住——就算 true（比如侧躺只剩半张脸、读誓词时眼睛以上被顶边裁没、脸被一大束花遮住一半、多人照里前景的人头被边裁掉）。以下一律 false：①这个人的眼鼻嘴都在，只是额头/头顶/发丝或头饰纱贴到边或微出框（脸是完整的，不要把贴边当裁头）；②只是正常的侧脸、低头、仰头角度，本来就只能看到部分脸，但既没被边裁也没被东西挡住（这是角度不是残缺）；③被裁或被挡的只是远景小人、背景里模糊的路人，不是主要人物；④画面里根本没有脸（纯景物、只有躯干/手/局部肢体、背影这类细节照）。'
export const V12C: Variant = {
  id: 'v12c-halfhead-strict',
  desc: 'v11 但半截头改宽口径判别式（主要/前景人物脸看不全就算：边裁+遮挡都算；贴边/侧脸角度/远景/无脸护栏防乱标）+ 表情崩坏沿用 v12 物理判据',
  build: (): { system: string; userText: string } => {
    const base = V11.build()
    for (const need of [V12_HALF_OLD, V12_EXPR_OLD]) {
      if (!base.userText.includes(need)) {
        throw new Error('v11 正文被改过，v12c 的半截头/表情崩坏定位失效，需同步更新 V12C')
      }
    }
    const userText = base.userText.replace(V12_HALF_OLD, V12C_HALF_NEW).replace(V12_EXPR_OLD, V12_EXPR_NEW)
    return { system: base.system, userText }
  },
  parse: (text: string): Verdict | null => V11.parse(text)
}

/**
 * v12e = v11 基础上只改表情崩坏一句（半截头 half_head 原封不动沿用 v11），用户 2026-10-16 拍板"只上表情、半截头不动"。
 * 动机：宽口径/严格口径两版都试过，模型（qwen3.7-flash）对"脸被花挡住""多人照前景人头被裁"就是抓不稳，
 *   改了半截头反而让 8758 从 V11 的能抓退化成漏（违反只进步不回归红线）。表情崩坏维则是干净的纯赢
 *   （1016 从 0/4 整维失灵救到 4/4，couple1 零乱标，7601 大笑/8666 亲吻两条误伤红线守住），
 *   所以只把 expression 这一句搬生产，half_head 保持线上 v11 一字不改。一次只改这一个变量，
 *   跑对拍时半截头维应逐张 = v11（因正文那句完全相同），以此验证"没有偷偷动半截头"。
 */
export const V12E: Variant = {
  id: 'v12e-expression-only',
  desc: 'v11 但只改表情崩坏判据为物理判据（眼睛挤没+丑嘴型同时成立）；半截头/闭眼/count 全部沿用 v11 一字不动',
  build: (): { system: string; userText: string } => {
    const base = V11.build()
    if (!base.userText.includes(V12_EXPR_OLD)) {
      throw new Error('v11 正文被改过，v12e 的表情崩坏定位失效，需同步更新 V12E')
    }
    return { system: base.system, userText: base.userText.replace(V12_EXPR_OLD, V12_EXPR_NEW) }
  },
  parse: (text: string): Verdict | null => V11.parse(text)
}

/**
 * v13 = 在 v12e（= 当前生产：v11 + 表情物理判据）基础上，只重写半截头一句。
 * 用户 2026-10-16 真机反馈：9786/9837/7722/0848 明明半截头，云端全漏；坚持"问题 100% 在提示词"。
 * 复盘旧写法漏在哪：
 *   ① 旧句"裁到影响这张照能用才算"+"只对清晰主要人物判"→ 大特写（9786 额头头顶裁没但五官还在）被当"故意构图"放过；
 *      前景能看清的花童/小孩（0848）被"主要人物"挡掉。
 *   ② 表情那句沿用 v12e 不动，只此一处变量，对拍时表情维应逐张 = v12e，以此坐实"没偷偷动别的"。
 * 新判据核心：看"头被边裁掉多少"，不看"脸美不美/五官全不全"；前景任何清楚的人头被裁都算；
 *   仅发尖/极窄一条头顶擦边、远处看不清的小人、根本没头 → 才算 false（守住 7443/7421/7623 不乱标）。
 */
const V13_HALF_NEW =
  '   - half_head：看的是"头"被画面边裁掉了多少，不是"脸拍得好不好看、五官全不全"。只要画面里任何一个清楚的人（主角，以及前景里能看清的小孩/伴娘/宾客都算），他/她的头部被画面某条边裁掉一大块——额头以上、头顶、后脑或半张脸出了框，凑不出一个完整的头部轮廓——就算 true。特别针对大特写/怼脸/躺姿/旋转构图：哪怕眼鼻嘴都还在框里、脸拍得很美，只要额头连同头顶被顶边或侧边裁掉一大块，也照样算 true，不许当成"像是故意构图"放过。以下才算 false：①整个头基本都在框内，只有发尖或极窄一条头顶刚擦到边；②被裁的只是远处看不清的小人、模糊背景里的路人；③画面里根本没有头/脸（纯景物、只有手或躯干、背影）。'
export const V13: Variant = {
  id: 'v13-halfhead-rework',
  desc: 'v12e 但重写半截头：看头被边裁多少（不看五官/构图），前景清楚人头被裁也算，专治 9786/9837/7722/0848 漏判',
  build: (): { system: string; userText: string } => {
    const base = V12E.build()
    if (!base.userText.includes(V12_HALF_OLD)) {
      throw new Error('v12e 正文里的半截头句被改过，v13 的半截头定位失效，需同步更新 V13')
    }
    return { system: base.system, userText: base.userText.replace(V12_HALF_OLD, V13_HALF_NEW) }
  },
  parse: (text: string): Verdict | null => V11.parse(text)
}

/**
 * V14：在 V13 基础上给半截头补一条硬前提——必须先还能看见【一部分】头或脸才算。
 * 动机（用户 2026-10-16 拍板"整只头都没了不算半截头"）：V13 那句留了缝，9287（新郎整理袖口、
 * 只有手和身子、头完全在画幅外）被模型读成"头顶被边裁"判了 true，而同场景的 9286 判 false，连拍自相矛盾。
 * 本地几何模型分不清"只剩下巴的新娘(0832真该标)"和"只有手的袖口特写(9286不该标)"，但 AI 看得懂语义，
 * 故把"一点头脸都看不见（只有手/躯干/婚纱/鞋子/背影/纯景物空镜）→ 一律 false"钉成前置条件。
 */
const V14_HALF_NEW =
  '   - half_head：判的是"一个人的头只露出了【一部分】、被画面某条边切掉了另一半"。硬前提：必须先能在画面里看见这个清楚的人的【一部分】头或脸（哪怕只剩半张脸、只剩额头到鼻子、或只剩下巴嘴），这部分又被某条画面边裁走、凑不出完整头部轮廓，才 true；大特写/怼脸/躺姿/旋转构图里只要还有半张脸在框内、额头连头顶被边裁掉一大块，也算 true，不许以"像是故意构图"放过。反之，如果画面里【一点头或脸都看不见】——只有手、胳膊、躯干、婚纱裙摆、鞋子、背影，或纯景物空镜（整理袖口的手部特写、婚纱+鞋、舞台/喜字/车队这类没露出任何头脸的照片）——一律 false，那叫"没拍头"不叫"半截头"。此外：被裁的只是远处看不清的小人、模糊背景路人 → false；整个头基本都在框内、只有发尖或极窄一条头顶擦边 → false。'
export const V14: Variant = {
  id: 'v14-halfhead-noface',
  desc: 'v13 基础上给半截头加硬前提：必须还能看见一部分头/脸才算；一点头脸都没露（只有手/身子/婚纱/空镜）一律不算——治 9286/9287 连拍一真一假',
  build: (): { system: string; userText: string } => {
    const base = V13.build()
    if (!base.userText.includes(V13_HALF_NEW)) {
      throw new Error('v13 正文里的半截头句被改过，v14 的半截头定位失效，需同步更新 V14')
    }
    return { system: base.system, userText: base.userText.replace(V13_HALF_NEW, V14_HALF_NEW) }
  },
  parse: (text: string): Verdict | null => V11.parse(text)
}

/**
 * V14b：在 V14 基础上补两条硬指令，专治 0848 漏判（V14 把 9286/9287 修好了，却漏了 0848）。
 * 证据（ab-2026-10-16T09-33-23 原始理由）：V13 判 0848 true 时说"花童头顶被画面边缘裁切"，
 * V14 判 false 时只回"多人交接戒指、现场抓拍、非摆拍合影"——模型一看是多人抓拍就走了"非摆拍→false"
 * 的捷径，压根没逐个检查花童的头被没被裁。故补：①判前必须逐个看每个清楚的人的头，不许因"抓拍/互动/非摆拍"跳过；
 * ②低头/弯腰/侧脸的小孩、花童只要露出的那部分脸被边裁走也算 true。保留 V14"一点头脸都看不见→false"治 9286/9287。
 */
const V14B_HALF_NEW =
  '   - half_head：判的是"一个人的头只露出了【一部分】、被画面某条边切掉了另一半"。判之前【必须逐个检查】——对画面里每一个清楚的人（主角、以及前景能看清的小孩/花童/伴郎伴娘/宾客都算）一个一个看一眼他/她的头有没有被边裁，绝不许因为"这是抓拍/多人互动/非摆拍合影"就跳过逐个检查、直接判 false（多人现场抓拍里照样可能有半截头）。硬前提：必须先能在画面里看见这个清楚的人的【一部分】头或脸（哪怕只剩半张脸、只剩额头到鼻子、或只剩下巴嘴），这部分又被某条画面边裁走、凑不出完整头部轮廓，才 true；大特写/怼脸/躺姿/旋转构图里只要还有半张脸在框内、额头连头顶被边裁掉一大块，也算 true，不许以"像是故意构图"放过；低头/弯腰/侧身的小孩或花童也一样——只要他/她露出的那部分脸（哪怕只有下半张脸）被顶边或侧边裁走、凑不出完整头，也算 true。反之，如果画面里【一点头或脸都看不见】——只有手、胳膊、躯干、婚纱裙摆、鞋子、背影，或纯景物空镜（整理袖口的手部特写、婚纱+鞋、舞台/喜字/车队这类没露出任何头脸的照片）——一律 false，那叫"没拍头"不叫"半截头"。此外：被裁的只是远处看不清的小人、模糊背景路人 → false；整个头基本都在框内、只有发尖或极窄一条头顶擦边 → false。'
export const V14B: Variant = {
  id: 'v14b-halfhead-eachperson',
  desc: 'v14 基础上补两条：①判前必须逐个检查每个人的头，不许因"抓拍/多人互动"跳过；②低头/侧脸的小孩花童只露半张脸被边裁也算 true——捞回 0848 同时保住 9286/9287',
  build: (): { system: string; userText: string } => {
    const base = V14.build()
    if (!base.userText.includes(V14_HALF_NEW)) {
      throw new Error('v14 正文里的半截头句被改过，v14b 的半截头定位失效，需同步更新 V14B')
    }
    return { system: base.system, userText: base.userText.replace(V14_HALF_NEW, V14B_HALF_NEW) }
  },
  parse: (text: string): Verdict | null => V11.parse(text)
}

/**
 * V15：在 V14 基础上修 0141 这类漏判——半截头不能只盯新郎新娘主角。
 * 证据（用户 2026-10-16 真机反馈）：CHEN0141 敬茶现场，右侧浅紫裙宾客半张脸被画面右边缘切掉，是真半截头，
 * 但 V14 判 false——因为 flaws 前置句"只对清晰够大的主要人物判"+"拿不准一律 false"让模型把非主角的宾客跳过了。
 * 0141 与 9287 的区别：0141 的宾客脸露了一半在框内只是被边切（该抓），9287 是整张脸都没进画面（不该抓）。
 * 故把 half_head 改成"前景每个看得清脸的人（伴娘/宾客/长辈/小孩）被边裁都算，不许因'不是主角'跳过"，
 * 同时保留"一个人一点头脸都没进画面→false"守住 9286/9287。
 */
const V15_HALF_NEW =
  '   - half_head：判的是"一个人的头只露出了【一部分】、被画面某条边切掉了另一半"。判的时候别只盯新郎新娘主角——画面前景里每一个看得清的人（伴娘、宾客、长辈、小孩、敬茶对象都算），只要他/她露出的那部分头或脸（哪怕只剩半张脸、只剩额头到鼻子、或只剩下巴嘴）被画面某条边裁走、凑不出完整头部轮廓，就算 true，不许因为"这人不是主角"就跳过。大特写/怼脸/躺姿/旋转构图里只要还有半张脸在框内、额头连头顶被边裁掉一大块，也算 true，不许以"像是故意构图"放过。反之，如果一个人【一点头或脸都没进画面】——只有手、胳膊、躯干、婚纱裙摆、鞋子、背影——那叫"没拍头"不叫"半截头"，一律 false；纯景物空镜（舞台/喜字/车队）也 false。此外：被裁的只是远处看不清的小人、模糊背景路人 → false；整个头基本都在框内、只有发尖或极窄一条头顶擦边 → false。'
export const V15: Variant = {
  id: 'v15-halfhead-anyperson',
  desc: 'v14 基础上把半截头从"只判主角"放宽到"前景每个看得清脸的人被边裁都算"——治 0141 宾客半张脸被右边缘切掉却漏判，同时保住 9286/9287 没拍头不算',
  build: (): { system: string; userText: string } => {
    const base = V14.build()
    if (!base.userText.includes(V14_HALF_NEW)) {
      throw new Error('v14 正文里的半截头句被改过，v15 的半截头定位失效，需同步更新 V15')
    }
    return { system: base.system, userText: base.userText.replace(V14_HALF_NEW, V15_HALF_NEW) }
  },
  parse: (text: string): Verdict | null => V11.parse(text)
}

export const VARIANTS: Variant[] = [V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, V11, V12, V12B, V12C, V12E, V13, V14, V14B, V15]
