/**
 * 为 E:\1016测试 造"眼睛判"真值表（144 唯一图，只填本次要验的 half_head / expression 两维）
 *
 * 铁律（用户 2026-10-16 明确）：文件夹名是用户随手起的，不当标签。
 *   本表里 half_head / expression 的取值全部来自"逐张开图用眼睛判"的结论，与图片在哪个文件夹无关。
 *   文件夹只用来定位文件路径。
 *
 * person / eyes_closed 本表一律留 null：不参与本次打分（打分台对 null 维度直接跳过）。
 *
 * 产物：scripts/out/truth-1016-eyes.jsonl（打分台用 AB_TRUTH 指过来即可）
 * 用法：node scripts/_build-truth-1016.mts
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'

const ROOT = 'E:\\1016测试'
const OUT = 'scripts/out/truth-1016-eyes.jsonl'

/**
 * 眼睛判·宽口径（用户 2026-10-16 二次拍板，couple1 人工标签为准）：主要/前景人物的脸看不全就算 true。
 *   不管是被画面边裁、还是被花/物/别人挡住，只要凑不出一张完整的五官→ true。
 *   以下 false：①脸完整只额头/头顶/发丝/头饰贴边；②正常侧脸/低头角度（没裁没挡）；③只远景/背景人头被裁；④根本没脸。
 * 全部结论来自逐张开高清用眼睛判，与图片在哪个文件夹无关（文件夹只用来定位路径）。
 */
const HALF_HEAD_TRUE = new Set([
  '7g1a7427.jpg', // 锚点：侧躺半张脸被切（用户报的 bug）
  '7g1a8214.jpg', // 躺姿特写，另一只眼+半边脸被前景白玫瑰挡住，凑不出完整脸（与人工 true 的 8758 同类）
  '7g1a8215.jpg', // 右缘大特写，大半张脸出框
  '7g1a9837.jpg', // 旋转仰躺，一只眼+额头在框外
  'chen0832.jpg', // 新娘主体，眼睛被顶边裁没
  'chen0833.jpg', // 同场景（黑白）
  'chen0834.jpg', // 同场景（黑白）
  // 以下 3 张：用户 2026-10-16 真机跑完反馈漏判，逐张开高清复核——之前被我判严了（错标 false），现纠正为 true
  '7g1a9786.jpg', // 新娘躺姿大特写，额头/头顶被画面边裁掉，看不到完整头部轮廓
  '7g1a7722.jpg', // 脸贴右边缘，半张脸出了框，凑不出一张完整的脸（非仅头饰贴边）
  'chen0848.jpg' // 粉裙花童头被顶边裁掉，眼睛以上全在框外（前景人物脸看不全）
  // 以下脸完整/无脸，按宽口径仍为 false：7421/7443（只额头出框）；7775/9286/9287（无脸细节照）
])
/** 眼睛判：真正的表情崩坏（眼睛挤没+嘴大张露牙+整脸皱）。其余 normal → false。 */
const EXPRESSION_TRUE = new Set([
  '7g1a7955.jpg',
  '7g1a7958.jpg',
  '7g1a7947.jpg', // 放大复核：戴眼镜男子大笑眼睛挤眯+嘴大张露齿，符合崩坏物理判据（原误标 false，2026-10-16 纠正）
  'chen9581.jpg' // 放大复核：新娘大笑眼睛挤成缝+嘴大张露牙（原误标 false，2026-10-16 纠正）
])

function md5File(p: string): string {
  return createHash('md5').update(readFileSync(p)).digest('hex')
}

function walk(root: string): string[] {
  const out: string[] = []
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
      if (e.isDirectory()) stack.push(p)
      else if (/\.(jpg|jpeg|png|webp)$/i.test(e.name)) out.push(p)
    }
  }
  return out
}

function main(): void {
  if (!existsSync(ROOT)) {
    console.error('找不到 ' + ROOT)
    process.exit(1)
  }
  const files = walk(ROOT)
  // 按 md5 去重：同一张内容只留第一个路径当母本（跨文件夹重复的 77 张自动并成一张）
  const seen = new Map<string, string>()
  const dupNames: string[] = []
  for (const p of files) {
    let h: string
    try {
      h = md5File(p)
    } catch {
      continue
    }
    if (seen.has(h)) {
      dupNames.push(p)
      continue
    }
    seen.set(h, p)
  }
  const uniques = [...seen.values()].sort()
  const rows = uniques.map((p) => {
    const key = (p.split(/[\\/]/).pop() || '').toLowerCase()
    return {
      filename: p.split(/[\\/]/).pop(),
      path: p,
      sizeMB: +(statSync(p).size / 1048576).toFixed(1),
      person: null,
      eyes_closed: null,
      half_head: HALF_HEAD_TRUE.has(key) ? true : false,
      expression: EXPRESSION_TRUE.has(key) ? true : false
    }
  })
  mkdirSync('scripts/out', { recursive: true })
  writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n'), 'utf8')
  const halfTrue = rows.filter((r) => r.half_head).length
  const exprTrue = rows.filter((r) => r.expression).length
  console.log('唯一图张数:', rows.length)
  console.log('跨文件夹重复被并掉的张数:', dupNames.length)
  console.log('半截头 true:', halfTrue, '| false:', rows.length - halfTrue)
  console.log('表情崩坏 true:', exprTrue, '| false:', rows.length - exprTrue)
  console.log('产物:', OUT)
}

main()
