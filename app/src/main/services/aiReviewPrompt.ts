/**
 * AI 复审提示构造 + 模型响应解析（纯函数，不 import electron）
 * 被后台服务（aiReview.ts）与探针脚本共用；逻辑单测由开发版 stub 端到端覆盖（见实施计划 Task12）。
 * 口径单一真源：spec §5。人数四分类 + 内容型三瑕疵（闭眼/半截头/表情崩坏）；画质型不判。
 */
import type { AiReviewSuggestion } from '../../shared/types'

/** 解析函数只管内容；sig/model/at 由调用方注入后组装成完整 AiReviewSuggestion */
export type AiReviewVerdict = Pick<AiReviewSuggestion, 'person' | 'flaws' | 'reason'>

const PERSON_ENUM = ['single_person', 'group_photo', 'mixed_photo', 'no_person'] as const
type PersonVal = (typeof PERSON_ENUM)[number]

/** 模型可能回简写（group/single/mixed/none，见 spec §5 期望输出）或全名；都归一到 PERSON_DIMS 值 */
const PERSON_ALIAS: Record<string, PersonVal> = {
  single: 'single_person',
  single_person: 'single_person',
  group: 'group_photo',
  group_photo: 'group_photo',
  mixed: 'mixed_photo',
  mixed_photo: 'mixed_photo',
  none: 'no_person',
  no_person: 'no_person'
}

/**
 * 构造给千问 VL 的固定 system + user 文本（图片由调用方作为 image_url 附在 user 消息里）。
 * 要求严格 JSON、temperature=0。业务口径写进提示，避免模型自由发挥：
 *  - 眯眼/半睁算闭眼，但低头/远看像闭眼而实际睁着的不算；
 *  - 半截头仅算主要人物头部被裁，远景小头不算；
 *  - 宠物不计入人数；接亲/游戏/仪式等在场多人但非摆拍归混合。
 */
export function buildReviewMessages(): { system: string; userText: string } {
  const system = '你是严谨的摄影选片助手。只输出一个 JSON 对象，不要解释、不要 markdown 代码块、不要多余文字。'
  const userText = [
    '这是一张婚礼/活动跟拍里被本地算法判为「待确认」的边缘照片。请只做两件事并严格返回 JSON：',
    '',
    '1) person：画面人物归属，取值只能是以下四个英文词之一：',
    '   - "single"：恰好一个完整的人（宠物不计入人数；只拍到手/背影等无完整人物主体不算 single）。',
    '   - "group"：多人且面向镜头规整摆拍合影（站位齐整、看镜头）。',
    '   - "mixed"：现场多人但非规整摆拍（接亲、游戏、仪式、路人走动等抓拍情节）。多人凑不出规整主群时用这个。',
    '   - "none"：画面没有人物主体（纯景物/静物/无人）。',
    '',
    '2) flaws：以下三种「内容型」瑕疵是否存在，各给 true/false（只判这三项，模糊/曝光/黑白一律不判）：',
    '   - eyes_closed：有人闭眼。眯眼、半睁也算 true；但低头/侧脸/远看像闭眼而眼睛实际睁着的算 false。',
    '   - half_head：主要人物头部被画面边缘裁掉一部分（半截头）。远景小人物头部不完整不算 true。',
    '   - expression：表情崩坏（露牙怪笑、仰头狰狞、翻白眼扭曲等难看的表情）。正常大笑/微笑不算 true。',
    '',
    '3) reason：用一句中文说明你的判断依据（不超过 40 字）。',
    '',
    '只返回如下结构的 JSON，person 用上面四个英文词之一：',
    '{"person":"group","flaws":{"eyes_closed":false,"half_head":false,"expression":false},"reason":"四人并排均面向镜头，站位齐整"}'
  ].join('\n')
  return { system, userText }
}

/** 抽布尔：容忍 "true"/1/yes 等不规范回值；无法确定为布尔则返回 undefined */
function toBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (v === 1 || v === '1' || v === 'true' || v === 'yes') return true
  if (v === 0 || v === '0' || v === 'false' || v === 'no') return false
  return undefined
}

/**
 * 解析模型返回文本 → 结构化判定；解析失败/越界一律返回 null（调用方记「复审失败」，绝不猜测写入）。
 * 健壮性：容忍 ```json 包裹、前后废话——抽取第一个 `{...}`（贪婪到最后一个 }，覆盖嵌套 flaws 对象）。
 */
export function parseModelVerdict(text: string): AiReviewVerdict | null {
  if (!text || typeof text !== 'string') return null
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(m[0]) as Record<string, unknown>
  } catch {
    return null
  }
  // person：归一别名并校验落在四枚举内
  const rawPerson = typeof obj.person === 'string' ? obj.person.trim().toLowerCase() : ''
  const person = PERSON_ALIAS[rawPerson]
  if (!person) return null
  // flaws：三键必须都能确定为布尔，否则视为非法（不猜）
  const f = obj.flaws as Record<string, unknown> | undefined
  if (!f || typeof f !== 'object') return null
  const eyes = toBool(f.eyes_closed)
  const half = toBool(f.half_head)
  const expr = toBool(f.expression)
  if (eyes === undefined || half === undefined || expr === undefined) return null
  const reason = typeof obj.reason === 'string' ? obj.reason.trim() : ''
  return { person, flaws: { eyes_closed: eyes, half_head: half, expression: expr }, reason }
}
