/**
 * AI 复审提示构造 + 模型响应解析（纯函数，不 import electron）
 * 被后台服务（aiReview.ts）与探针脚本共用；逻辑单测由开发版 stub 端到端覆盖（见实施计划 Task12）。
 * 口径单一真源：spec §5。人数四分类 + 内容型三瑕疵（闭眼/半截头/表情崩坏）；画质型不判。
 *
 * 2026-10-16 定稿 v14（flash 实测）：本文件的 system/userText 对应 scripts/prompt-variants.mts 的 V14
 * （= V13 全文，仅把"半截头"一句补上"必须先还能看见一部分头/脸"的硬前提；表情/闭眼/count 与 V13 一字未动），由一次性脚本生成/逐字节自检，
 * 不是手抄——改提示词请先改测试工程、A/B 验证过再重新生成，不要直接编辑这两个字符串。要点：
 *  - group 收紧：必须"专为拍照停下来集体定格"，拿不准选 mixed；
 *  - count 字段 + 闸：模型自报在场人数，count>=2 时 single 一律纠偏为 mixed（防"双人判单人"）；
 *  - 伸进来的手不计入人数（化妆师/助理只露手不算第二人）；
 *  - 闭眼按物理开合度判：眼睛闭合成缝、几乎看不到眼珠/眼白即 true（哪怕笑到挤闭眼），与本地 eyes.py 对齐；
 *    眼睛还睁着能看到眼珠——哪怕笑成弯月/眯细——才 false。
 *  - 表情崩坏按物理判据（v12e 新增）：眼睛用力挤没 + 丑嘴型（大张嘴露牙/龇牙/嘴角横拉/整脸皱）同时成立才 true；
 *    亲吻/感动/大笑但五官舒展一律 false。实测 1016 表情维从 0/4 救到 4/4，代价是个别拥吻照可能被误标（模型偶发，人工库零误伤）。
 * 半截头判据（v13 宽口径 + v14 补硬前提）：看"头被画面边裁掉多少"，不看"脸美不美/五官全不全"；前景任何清楚的人（含花童/小孩）露出的那部分头/脸被边裁、凑不出完整头部轮廓都算 true，
 *   大特写/躺姿/旋转构图里额头连头顶被裁掉一大块也算（不再以"像故意构图"放过）。v14 硬前提：必须先能在画面里看见这个人的【一部分】头或脸才算——若一点头脸都看不见（只有手/胳膊/躯干/婚纱/鞋子/背影/纯景物空镜），一律 false，那叫"没拍头"不叫"半截头"；
 *   此外仅发尖/极窄一条头顶擦边、远处看不清的小人 → false。动机：用户真机反馈 9286/9287（整理袖口、只有手的特写、整只头在画幅外）被 v13 连拍一真一假——v14 把"没露头脸"钉死为 false，两张都判不算；实测 1016 半截头乱喊 18→7、9286/9287 一致转 false，代价是 0848（花童低头半张脸被裁）这张边缘样张改漏（模型无法在不复发 9287 的前提下兼得，属天花板）。
 * 送图分辨率：1536（见 aiReview.ts 的 IMG_MAX_SIDE；1024 会把"笑到闭眼/脸太小"糊掉导致漏判）。
 * 模型侧：qwen3.7-flash（后端 login.php 下发 model 字段决定，客户端不硬编码），
 * 请求体必须带 enable_thinking:false + enable_search:false（见 aiReview.ts，不关思考会集体超时）。
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

// v14 定稿全文（生成注入，勿手改；与测试工程 V14 逐字节一致由 selftest 把关；system 仍是 v11 那句，未动）
const SYSTEM_V11 = "你是严谨的世界顶级婚礼跟拍摄影选片师。你的输出会被程序按 JSON 严格解析——只输出一个 JSON 对象，字段名和取值必须完全照下面的规定，加解释、换写法、用候选列表都会被判为无效。不要 markdown 代码块。"
const USER_TEXT_V14 = "这是一张婚礼/活动跟拍里被本地算法判为「待确认」的边缘照片，请作为独立第二意见，只看画面内容，按以下三部分返回一个 JSON：\n\n1) person：画面人物归属，只能从这四个英文词里选【一个】原样输出（不要加斜杠、不要写候选、不要自造词）：\n   - \"single\"：整幅画面只有 1 个能认出是人的完整个体，且没有第二个可辨别人。数人时，只要看得见一个人体——正面、侧身、低头、背影都算——就是一个人；背景路人、远景小人、边缘误入的人（哪怕背对镜头）都算\"第二个人\"，只要有就不能用 single。不算人的只有：宠物；镜面/照片/海报/屏幕里的人像；只拍到一只手/脚/局部肢体、看不出是完整个体的。 特别注意：别人只是伸进画面的手/手臂（看不到其头和躯干），不算“第二个人”，不要因为看到化妆/助理的手就把 single 改成 mixed。\n   - \"group\"：一群人明显是为了拍这张照而停下来、一起面向镜头定格合影（人人基本都在看镜头、姿态是为拍照摆出来的）。两人并肩都看着镜头静止摆拍也算 group，但只要有一人在互动/侧身/低头就不算。拿不准就往 mixed 靠。\n   - \"mixed\"：现场多人，但大家正在办事（接亲、敬酒、游戏、仪式、走动、各忙各的），哪怕有人碰巧看向镜头、比耶、或站得还算齐，只要不像专门为这张照集体定格，就算 mixed；只有 1 个主体面向镜头、其余是背景路人/误入者，也算 mixed。\n   - group 与 mixed 只认一件事：是不是“大家特意为这张照停下来、一起面向镜头定格”。是→group；只是办事中碰巧看镜头、或只是站得齐→mixed。拿不准时一律选 mixed（合影是少数，宁可保守）。\n   - \"none\"：画面没有任何一个真实存在的人体（纯景物/静物/无人；只有镜面/照片/海报/屏幕里的人像、或只剩一只手/脚/局部肢体这种，也算 none）。\n   一致性硬规则：下面第 3 项 count 是画面里“真实存在的人”的个数；count≥2 时 person 绝不能是 \"single\"（哪怕有人侧脸/低头/背影/被挡），只能选 group 或 mixed；只有 count==1 才允许 single。\n\n2) flaws：只判下面三种「内容型」瑕疵，各给 true 或 false；模糊、曝光、黑白这类画质问题一律不判（本地已判，你不用重复、也不要改口）。三项都只对“清晰、够大的主要人物”判，远景小人、虚化的人、路人/误入者一律不计；拿不准一律给 false（宁可漏标，别误标）：\n   - eyes_closed：只判眼睛闭没闭，跟她在不在笑无关。判据只看眼睛还剩多少开合度——只要眼睛闭合成一条缝、几乎看不到眼珠或眼白（笑到眼睛挤闭、眨眼被抓拍、睡着、故意闭眼、单眼闭死都算）→ true。只有眼睛还睁着、能看到眼珠或眼白——哪怕笑成弯月、眯细——才 → false。正常睁眼只是远看像闭眼，false；戴墨镜、或眼睛被头发/手/物体完全挡住看不清，false；低头/侧脸/仰头时，除非能确认眼皮确实闭上，否则 false。\n   - half_head：判的是\"一个人的头只露出了【一部分】、被画面某条边切掉了另一半\"。硬前提：必须先能在画面里看见这个清楚的人的【一部分】头或脸（哪怕只剩半张脸、只剩额头到鼻子、或只剩下巴嘴），这部分又被某条画面边裁走、凑不出完整头部轮廓，才 true；大特写/怼脸/躺姿/旋转构图里只要还有半张脸在框内、额头连头顶被边裁掉一大块，也算 true，不许以\"像是故意构图\"放过。反之，如果画面里【一点头或脸都看不见】——只有手、胳膊、躯干、婚纱裙摆、鞋子、背影，或纯景物空镜（整理袖口的手部特写、婚纱+鞋、舞台/喜字/车队这类没露出任何头脸的照片）——一律 false，那叫\"没拍头\"不叫\"半截头\"。此外：被裁的只是远处看不清的小人、模糊背景路人 → false；整个头基本都在框内、只有发尖或极窄一条头顶擦边 → false。\n   - expression：只对清晰主要人物判，看的是五官的物理状态，不是\"笑没笑\"。true 必须同时满足两条：①眼睛用力挤成一条缝、几乎闭没（不是自然微眯，也不是亲吻/感动时平和闭上的眼）；②嘴大张露牙、或龇牙、或嘴角用力横拉、或整脸皱起用力。有一条不成立就 false：眼睛还睁着能看到眼珠，false；嘴是闭着、抿着、或笑而不露齿，且五官舒展，false——哪怕她在哈哈大笑。亲吻、感动流泪、认真专注、自然微笑都不算 true。\n\n3) count：画面里“真实存在的人”一共几个，给一个整数（正面/侧脸/低头/背影/只露半身都各算一个；宠物、镜面/照片/海报/屏幕里的人像不计）。关键：只数能看到头或躯干的人体；化妆师/助理只是把手或手臂伸进画面（哪怕同时好几只手在补妆、整理衣服、递东西），只要看不到那个人的头和身体，就不算在场的人、不计入 count。\n4) reason：用一句不超过 40 字的中文说明判断依据，要和上面的 person、flaws、count 对得上。\n\n只返回如下结构的 JSON（person 是单个英文词，不是候选列表）：\n{\"person\":\"group\",\"flaws\":{\"eyes_closed\":false,\"half_head\":false,\"expression\":false},\"count\":4,\"reason\":\"伴娘们举香槟围成一排面向镜头合影\"}"

/**
 * 构造给千问 VL 的固定 system + user 文本（图片由调用方作为 image_url 附在 user 消息里）。
 * 要求严格 JSON、temperature=0。业务口径全部写进提示（定稿 v14，出处见文件头注释）。
 */
export function buildReviewMessages(): { system: string; userText: string } {
  return { system: SYSTEM_V11, userText: USER_TEXT_V14 }
}

/** 抽布尔：容忍 "true"/1/yes 等不规范回值；无法确定为布尔则返回 undefined */
function toBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (v === 1 || v === '1' || v === 'true' || v === 'yes') return true
  if (v === 0 || v === '0' || v === 'false' || v === 'no') return false
  return undefined
}

/** 抽 count 整数：容忍数字或纯数字字符串；无法确定为数字则返回 null（null 只表示"没读到 count"，不否掉合法判定） */
function toCount(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim())
  return null
}

/**
 * 解析模型返回文本 → 结构化判定；解析失败/越界一律返回 null（调用方记「复审失败」，绝不猜测写入）。
 * 健壮性：容忍 ```json 包裹、前后废话——取第一个左花括号到最后一个右花括号（贪婪匹配，覆盖嵌套 flaws 对象）。
 * count 闸（v9 实测唯一有效防"双人判单人"的机制，语义与测试工程 V8/V9.parse 完全一致）：
 * count>=2 且 person=single —— 模型自相矛盾，以它自己数出来的 count 为准，纠偏为 mixed。
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
  const count = toCount(obj.count)
  const finalPerson = count !== null && count >= 2 && person === 'single_person' ? 'mixed_photo' : person
  return { person: finalPerson, flaws: { eyes_closed: eyes, half_head: half, expression: expr }, reason }
}
