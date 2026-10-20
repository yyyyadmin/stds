/**
 * 新手指导（聚光灯带路）
 *
 * 交互（用户 2026-10-17 定）：整屏压暗，只把当前该看的那颗真按钮/那一行真分类亮出来，
 * 一只手指在卡片边上戳着它，第 1 步、第 2 步……一步步走到导出。纯文字翻页卡片被判为“太低级”，
 * 所以这里全部锚到界面真实元素上（锚点是各界面写的 data-tour，见 TopBar / Sidebar / App 的 main）。
 *
 * 不可跳过：没有「跳过全部」，点遮罩不关、按 Esc 不关，只能一页页点到底；右上角留 ×。
 * 但不把人铐住：卡片左下有「停下，我自己试试」——亮层收起、界面交还给用户去点，
 * 屏幕底部留一颗胶囊，点「继续」回到原来那一步（照片数据全程不动）。
 *
 * 首启自动弹一次由 store.bootstrap 判（settings.onboardGuideSeen）；重放入口是侧栏「🎓 新手指导」；
 * 启动时若有版本更新弹窗，本组件先不出现，等它关掉再说（不两层摞着）。
 *
 * 文案红线：口径对齐真实界面（TopBar 按钮名 / Sidebar 行名与悬停说明 / JudgmentBar 三个按钮 /
 * ExportDialog 的选项 / store 的扣费与会员分支）。界面里不存在的东西不写——比如“场景下拉”
 * “筛选力度”已经从界面上撤了，这里就不提。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useStore } from '../store'
import { DEFAULT_TIER_NAMES } from '../../../shared/types'

/** 卡片放在亮框的哪一侧 */
type Side = 'below' | 'above' | 'right' | 'left'

interface Line {
  term: string
  text: ReactNode
}

interface Step {
  /** 锚点：各界面写的 data-tour 值。'thumb' 特指内容区第一张缩略图（空库时回落整块内容区） */
  tour: string
  /** 卡片优先放哪一侧；放不下会依次试另外几侧，全放不下就贴着亮框放空间最大的一侧 */
  prefer: Side
  title: string
  lead?: ReactNode
  lines?: Line[]
  note?: ReactNode
}

interface Box {
  l: number
  t: number
  w: number
  h: number
}

interface Geo {
  /** null = 没找到锚点（整屏均匀压暗，卡片居中，不亮框） */
  ring: Box | null
  card: Box
  finger: { l: number; t: number; rot: number } | null
}

const CARD_W = 440
/** 卡片离窗口边缘的最小留白 */
const MARGIN = 12
/** 亮框比目标四周各宽出这么多，免得边框贴着字 */
const PAD = 5
/** 手指占的那一段（含戳动余量），卡片要让开它 */
const FINGER = 36

/**
 * 找到这一步该亮的真元素。
 * 'thumb' 先找内容区第一张缩略图（有图才指得到，空库退化成整块内容区）；其余按 data-tour 直取。
 */
function findTarget(tour: string): HTMLElement | null {
  if (tour === 'thumb') {
    return document.querySelector<HTMLElement>('main[data-tour="grid"] [data-img-id]') ?? document.querySelector<HTMLElement>('main[data-tour="grid"]')
  }
  return document.querySelector<HTMLElement>(`[data-tour="${tour}"]`)
}

/**
 * 算这一步的亮框、卡片、手指各在哪。
 * 先试这一步指定的那一侧，装不下就换边试；四边都装不下（小屏 + 高卡片）时按剩余空间最大的一边放，
 * 宁可压住一点亮框也不让卡片跑出窗口。
 */
function place(rect: DOMRect, cw: number, ch: number, prefer: Side, vw: number, vh: number): Geo {
  const ring: Box = {
    l: Math.max(2, rect.left - PAD),
    t: Math.max(2, rect.top - PAD),
    w: rect.width + PAD * 2,
    h: rect.height + PAD * 2
  }
  const order: Side[] = [prefer, ...(['below', 'above', 'right', 'left'] as Side[]).filter((s) => s !== prefer)]
  const fits = (s: Side): boolean =>
    s === 'below'
      ? ring.t + ring.h + FINGER + ch + MARGIN <= vh
      : s === 'above'
        ? ring.t - FINGER - ch - MARGIN >= 0
        : s === 'right'
          ? ring.l + ring.w + FINGER + cw + MARGIN <= vw
          : ring.l - FINGER - cw - MARGIN >= 0
  let side = order.find(fits) ?? order[0]
  // 四边都装不下时，选离亮框那一侧边界空间最大的，卡片会被 clamp 回窗口内
  if (!order.some(fits)) {
    const space: Record<Side, number> = {
      below: vh - (ring.t + ring.h),
      above: ring.t,
      right: vw - (ring.l + ring.w),
      left: ring.l
    }
    side = (['below', 'above', 'right', 'left'] as Side[]).reduce((a, b) => (space[a] >= space[b] ? a : b))
  }
  const maxL = Math.max(MARGIN, vw - cw - MARGIN)
  const maxT = Math.max(MARGIN, vh - ch - MARGIN)
  let l = ring.l
  let t = ring.t
  let f = { l: ring.l, t: ring.t, rot: 0 }
  if (side === 'below') {
    l = Math.min(Math.max(ring.l, MARGIN), maxL)
    t = ring.t + ring.h + FINGER
    f = { l: l + 18, t: ring.t + ring.h + 1, rot: 0 }
  } else if (side === 'above') {
    l = Math.min(Math.max(ring.l, MARGIN), maxL)
    t = ring.t - FINGER - ch
    f = { l: l + 18, t: ring.t - FINGER - 1 + 12, rot: 180 }
  } else if (side === 'right') {
    l = ring.l + ring.w + FINGER
    t = Math.min(Math.max(ring.t - 24, MARGIN), maxT)
    f = { l: l - FINGER - 2, t: t + 4, rot: -90 }
  } else {
    l = ring.l - FINGER - cw
    t = Math.min(Math.max(ring.t - 24, MARGIN), maxT)
    f = { l: l + cw + 2, t: t + 4, rot: 90 }
  }
  // 卡片任何情况下都不许跑出窗口（小屏、顶栏换行时 ring.l 可能本身就很靠边）
  l = Math.min(Math.max(l, MARGIN), maxL)
  t = Math.min(Math.max(t, MARGIN), maxT)
  return { ring, card: { l, t, w: cw, h: ch }, finger: f }
}

function Key({ children }: { children: ReactNode }): JSX.Element {
  return <kbd className="inline-block min-w-[22px] rounded border border-line bg-panel2 px-1.5 py-0.5 text-center text-[11px] font-semibold tabular-nums text-fg2">{children}</kbd>
}

/**
 * 精简模式的九步。锚点与标准版完全一致（界面还是同一套元素，只是侧栏少了入口），
 * 文案只讲精简下真实存在的东西——没有三档、重复照片、瑕疵分类、废片、标签管理、采纳弹窗。
 */
function buildSlimSteps(): Step[] {
  return [
    {
      tour: 'account',
      prefer: 'below',
      title: '第 1 步 · 先登录',
      lead: <>右上角这一颗。没登录时它写着「登录 / 注册」，登录以后变成你的会员身份名。</>,
      lines: [
        { term: '新注册送 500 积分', text: '手机号或邮箱都行，收 6 位验证码、自定至少 6 位密码，填完自动登录。' },
        { term: '只有「开始筛选」扣积分', text: '1 张照片 = 1 积分；导入、浏览、手动分类、导出都不收费。' },
        { term: '会员才有的两件事', text: '筛选不扣积分；筛完的 AI 复审也不扣积分，只占每日复审额度。' },
      ],
      note: '想先逛逛也可以：登录框里有「暂不登录，先逛逛」，能先导入和浏览，但开始筛选要先登录。',
    },
    {
      tour: 'import',
      prefer: 'below',
      title: '第 2 步 · 导入照片',
      lead: <>顶栏左上角这颗按钮。把这次要筛的照片先放进软件。</>,
      lines: [
        { term: '点它选文件', text: '单张、多选，或者整个文件夹（勾选后连子文件夹一起收）。' },
        { term: '也可以直接拖', text: '把照片或文件夹拖进窗口，松手就开始导入。' },
        { term: '支持的格式', text: 'JPG、PNG、WEBP、TIFF、BMP、iPhone HEIC，以及佳能 CR2 / CR3、尼康 NEF、索尼 ARW、富士 RAF 等各家 RAW。' },
      ],
      note: '导入只建索引、生成缩略图，磁盘上的原始照片一个字节都不会被改，这一步不收费。',
    },
    {
      tour: 'scan',
      prefer: 'below',
      title: '第 3 步 · 开始筛选',
      lead: <>全流程唯一扣积分的一步，也是 AI 真正干活的一步。</>,
      lines: [
        { term: 'AI 逐张在看', text: '闭眼、画面模糊、曝光过亮过暗、半截头、表情崩坏、画面里有几个人、是不是黑白，另外给清晰度打分。' },
        { term: '跑完会自动过一遍云端复审', text: '精简模式下，「待确认」里的图会被 AI 复审自动处理：判稳的直接归位到交付库或瑕疵片，不用你逐张拍板。' },
        { term: '中途能停', text: '跑起来这颗按钮会变成「停止」；下次再点开始筛选会自己接着跑，筛过的不重跑、不重复扣分。' },
      ],
      note: 'AI 复审是会员功能，第一次要先同意「照片压缩后上传」。没开通会员也不影响筛选，只是待确认会保持原样，需要你自己处理。',
    },
    {
      tour: 'review',
      prefer: 'right',
      title: '第 4 步 · 待确认：基本不用你操心',
      lead: <>左侧栏「待确认」这一行，装的是 AI 拿不准该归哪类的照片。</>,
      lines: [
        { term: '精简模式下它会被自动清空', text: '云端复审核一遍后，判稳的归位；剩下犹豫、且是画面模糊或曝光异常的，直接算瑕疵片。' },
        { term: '想自己拍板也很快', text: '点开这一栏，选中后底部只有两个动作：「✓ 移入交付库」「✗ 移入瑕疵片」。' },
        { term: '没清空是正常的', text: '没开通会员、没同意上传、或者这张缺人数归属时，它会留在这里等你亲手处理——软件不会假装处理过。' },
      ],
    },
    {
      tour: 'library',
      prefer: 'right',
      title: '第 5 步 · 交付库：能交出去的',
      lead: <>这一栏是 AI 认为能用、默认参与导出的照片。精简模式不再分优质 / 良好 / 一般三档。</>,
      lines: [
        { term: '整栏都能导', text: '没有档位要选，点顶栏「导出交付」选「仅交付库」就整栏打包。' },
        { term: '放错了怎么改', text: '选中那张，点底部或大图右栏的「✗ 移入瑕疵片」即可；反过来在瑕疵片里点「✓ 移入交付库」就放行。' },
        { term: '想按人数找图', text: '侧栏下面「人物分类」四行，每行末尾有个「导出」，只导这一栏里能交付的照片。' },
      ],
    },
    {
      tour: 'result',
      prefer: 'right',
      title: '第 6 步 · 这三栏加起来 ≈ 全部照片',
      lead: <>「筛选结果」按交付去向分栏，一张照片只进其中一栏。</>,
      lines: [
        { term: '交付库 / 待确认 / 瑕疵片', text: '三种互不重复的去向，三栏数字相加就是全部照片。瑕疵片默认不导出。' },
        { term: '最上面的「全部文件」', text: '整库总览，点它回到全局视图。' },
        { term: '下面的「人物分类」', text: '按画面人数换个角度再看一遍，同一张图会在两边都出现，所以不能跟上面三栏相加。' },
      ],
      note: '精简模式没有交付库三档、重复照片、黑白照、瑕疵分类、废弃库和自定义分类。要用这些入口，去设置 → 使用模式切回「标准模式」，图库一张都不会动。',
    },
    {
      tour: 'thumb',
      prefer: 'below',
      title: '第 7 步 · 改判要快，靠这几下',
      lead: <>中间这片就是看图、改判的地方（现在亮着的是列表里的第一张）。</>,
      lines: [
        { term: '选片', text: <>精简模式单击就能多选：点一张加一张，再点一下取消，不用按 Ctrl；<Key>Ctrl</Key>+<Key>A</Key> 全选，<Key>Esc</Key> 清空选中。</> },
        { term: '改判', text: '选中后底部只有两个动作；双击打开大图，右栏也是同样两个动作，拍摄参数在下面照旧能看。' },
        { term: '批量', text: '选中一批后，两个动作对整批生效；也能整批拖到左侧「待确认」或某个人物分类行上。' },
        { term: '反悔', text: <>移动过照片后顶栏「↩ 撤回」会变亮，可以连着多退几步。精简模式没有废弃库入口，所以别顺手按 <Key>Delete</Key>。</> },
      ],
      note: <>一行摆几张，用顶栏「一行 N 张」按钮直接选，也能按住 <Key>Ctrl</Key> 滚轮缩放；双击任意小图看大图。</>,
    },
    {
      tour: 'export',
      prefer: 'below',
      title: '第 8 步 · 导出交付',
      lead: <>确认完就出片，导出不收费。</>,
      lines: [
        { term: '选范围', text: '只有两种：「仅交付库」或「全部文件」。面板下方实时显示将导出多少张、大约多大。' },
        { term: '默认原格式', text: 'RAW 还是 RAW，不压缩、不转格式；也可以统一转 JPG / PNG，或保留原文件名、重名自动加序号。' },
        { term: '目录结构', text: '精简模式不按档位建子文件夹，全部平铺到一个文件夹里。' },
      ],
      note: '「待确认」里的照片不会被顺手带走，也不会拦着不让你导出。',
    },
    {
      // 教程中心在侧栏最底部：卡片改放上方，手指朝下戳住它
      tour: 'tutorial',
      prefer: 'above',
      title: '第 9 步 · 忘了就看这里',
      lead: <>侧栏最底下这两枚按钮，一个给文档，一个给带路。</>,
      lines: [
        { term: '📖 教程中心', text: '七章完整文档；它会跟着当前模式讲——精简模式不会讲三档、重复照片这些找不到的入口。' },
        { term: '🎓 新手指导', text: '就是你现在看到的这套手指指着走的带路；关掉之后随时能从这里重放。' },
        { term: '问价、开通、充值', text: '教程中心左下角就是客服二维码，扫码找人。' },
      ],
      note: '点右下角「开始使用」或右上角 × 都能出去，你的照片一张都不会动。',
    },
  ]
}

/**
 * 九步。每步都锚在界面上真实存在的位置，文案只讲“这里是什么、你要做什么”。
 * 档位名从设置里读（用户可以自己改三档叫法），否则会出现引导跟侧栏各说一套。
 */
function buildSteps(tierNames: string[], slim: boolean): Step[] {
  if (slim) return buildSlimSteps()
  const n1 = tierNames[0] || DEFAULT_TIER_NAMES[0]
  const n2 = tierNames[1] || DEFAULT_TIER_NAMES[1]
  const n3 = tierNames[2] || DEFAULT_TIER_NAMES[2]
  return [
    {
      tour: 'account',
      prefer: 'below',
      title: '第 1 步 · 先登录',
      lead: <>右上角这一颗。没登录时它写着「登录 / 注册」，登录以后变成你的会员身份名。</>,
      lines: [
        { term: '新注册送 500 积分', text: '手机号或邮箱都行，收 6 位验证码、自定至少 6 位密码，填完自动登录。' },
        { term: '只有「开始筛选」扣积分', text: '1 张照片 = 1 积分；导入、浏览、手动分类、导出都不收费。' },
        { term: '会员筛选不扣积分', text: '已开通的按会员权益用，剩余额度点这颗按钮进会员中心看。' },
      ],
      note: '想先逛逛也可以：登录框里有「暂不登录，先逛逛」，能先导入和浏览，但开始筛选要先登录。',
    },
    {
      tour: 'import',
      prefer: 'below',
      title: '第 2 步 · 导入照片',
      lead: <>顶栏左上角这颗按钮。把这次要筛的照片先放进软件。</>,
      lines: [
        { term: '点它选文件', text: '单张、多选，或者整个文件夹（勾选后连子文件夹一起收）。' },
        { term: '也可以直接拖', text: '把照片或文件夹拖进窗口，松手就开始导入。' },
        { term: '支持的格式', text: 'JPG、PNG、WEBP、TIFF、BMP、iPhone HEIC，以及佳能 CR2 / CR3、尼康 NEF、索尼 ARW、富士 RAF 等各家 RAW。' },
      ],
      note: '导入只建索引、生成缩略图，磁盘上的原始照片一个字节都不会被改，这一步不收费。',
    },
    {
      tour: 'scan',
      prefer: 'below',
      title: '第 3 步 · 开始筛选',
      lead: <>全流程唯一扣积分的一步，也是 AI 真正干活的一步。</>,
      lines: [
        { term: 'AI 逐张在看', text: '闭眼、画面模糊、曝光过亮过暗、半截头、表情崩坏、画面里有几个人、是不是黑白，另外给清晰度打分。' },
        { term: '跑完自动打开「待确认」', text: '那一栏就是等你拍板的；它空着就直接落在「交付库」，不会给你开白屏。' },
        { term: '中途能停', text: '跑起来这颗按钮会变成「停止」；下次再点开始筛选会自己接着跑，筛过的不重跑、不重复扣分。' },
      ],
      note: '觉得卡的话，设置里「性能模式」保持自动就行，低配机器会自动去掉动画等装饰，功能一项不少。',
    },
    {
      tour: 'review',
      prefer: 'right',
      title: '第 4 步 · AI 拿不准的都堆在这',
      lead: <>左侧栏「待确认」这一行，筛完默认就停在这里。</>,
      lines: [
        { term: '这一栏是欠账', text: '判定存疑、要你拍板的，暂不导出。' },
        { term: '怎么拍板', text: '点开这一栏，双击一张放大，右栏会摆出「✓ 好图 → 交付库」「✕ 不合格 废弃库」「此判定错误（重判）」。' },
        { term: '数字清零就轻松了', text: '说明没有等你拍板的照片，可以直接导出。' },
      ],
    },
    {
      tour: 'library',
      prefer: 'right',
      title: '第 5 步 · 交付库：能交出去的',
      lead: <>这一栏是 AI 认为能用、默认参与导出的照片。</>,
      lines: [
        { term: '下面三档只按清晰度分', text: `${n1}可放大精修，${n2}正常出片够用，${n3}画面偏软、只做备选不建议放大。` },
        { term: '想给某张改档', text: '把它的缩略图拖到某一档那一行上就行；点开这一栏后也能在大图右栏直接选档。' },
        { term: '档名能自己改', text: '设置里改了以后，侧栏和导出的子文件夹名会跟着一起变。' },
      ],
    },
    {
      tour: 'result',
      prefer: 'right',
      title: '第 6 步 · 这五栏加起来 ≈ 全部照片',
      lead: <>「筛选结果」这一区按交付去向分栏，一张照片只进其中一栏。</>,
      lines: [
        { term: '交付库 / 待确认 / 瑕疵片', text: '三种互不重复的去向。瑕疵片默认不导出；确认是误判，删掉那个缺陷标签它自己就回交付库。' },
        { term: '重复照片', text: '同一瞬间连拍的那几张算一组，AI 已把组里干净的自动收进交付库、照常导出。这一行按「组」统计（数字带个组字），不能跟旁边按张数的几栏相加。点进去逐张挑：要留的点「要这张→」选档加进库（一组能同时留好几张），多余的点「丢弃」。' },
        { term: '废弃库', text: '你手动丢弃的，永不导出，磁盘原文件不会被删；可随时还原或重新入档。' },
        { term: '再往下几组', text: <>「类型」「瑕疵」「自定义分类」是按内容看的另一个世界，同一张照片会同时出现在两边，所以数字会重叠、也不能相加。</> },
      ],
      note: '鼠标停在任何一行上，都有一句话解释，不用翻文档。',
    },
    {
      tour: 'thumb',
      prefer: 'below',
      title: '第 7 步 · 拍板要快，靠这几下',
      lead: <>中间这片就是看图、改判的地方（现在亮着的是列表里的第一张）。</>,
      lines: [
        { term: '看片', text: <>单击选中，双击放大；放大后 <Key>←</Key> <Key>→</Key> 翻页，<Key>Esc</Key> 退出放大，<Key>4</Key> 直接从选中的第一张开始看。</> },
        { term: '改判', text: '放大弹窗右栏三颗按钮就是拍板区；想放到别的相册，把缩略图拖到左侧栏那一行即可。' },
        { term: '批量', text: <>按住 Ctrl 点选多张，或 <Key>Ctrl</Key>+<Key>A</Key> 全选当前相册，底部会浮出批量栏，一次移动、改判、加标签。</> },
        { term: '反悔', text: <>移动过照片后顶栏「↩ 撤回」会变亮，可以连着多退几步。<Key>Delete</Key> 丢进废弃库（在废弃库里按则是还原）。</> },
      ],
      note: <>网格布局就是一行铺满的缩略图（软件唯一布局）；一行摆几张，用顶栏「一行 N 张」按钮直接选，也能按住 <Key>Ctrl</Key> 滚轮缩放；双击任意小图看大图。</>,
    },
    {
      tour: 'export',
      prefer: 'below',
      title: '第 8 步 · 导出交付',
      lead: <>确认完就出片，导出不收费。</>,
      lines: [
        { term: '选范围', text: '整库、按档位、勾选要导或要排除的分类，也可以只导多选的那几张；面板下方实时显示将导出多少张、大约多大。' },
        { term: '默认原格式', text: 'RAW 还是 RAW，不压缩、不转格式；也可以统一转 JPG / PNG，或保留原文件名、重名自动加序号。' },
        { term: '目录结构', text: '平铺成一个文件夹，或按三档建子文件夹（子目录名用你设置里的档名）。' },
      ],
      note: '「待确认」里还有没拍板的照片时，点导出会先提醒你——它们默认不在导出范围里。可以先确认完再导，也可以仍然导出，或在面板勾选「包含待确认」。',
    },
    {
      // 教程中心在侧栏最底部，如果卡片还放右侧，卡片顶部会被 clamp 上来，
      // 手指会跟着卡片走反而离亮框更远（实测踩坑），改成"上方"让手指朝下戳住它。
      tour: 'tutorial',
      prefer: 'above',
      title: '第 9 步 · 忘了就看这里',
      lead: <>侧栏最底下这两枚按钮，一个给文档，一个给带路。</>,
      lines: [
        { term: '📖 教程中心', text: '七章完整文档：快速上手、侧栏分类怎么看、常用操作、AI 复审、积分与会员、兑换权益、系统设置。' },
        { term: '🎓 新手指导', text: '就是你现在看到的这套手指指着走的带路；关掉之后随时能从这里重放。' },
        { term: '问价、开通、充值', text: '教程中心左下角就是客服二维码，扫码找人。' },
      ],
      note: '点右下角「开始使用」或右上角 × 都能出去，你的照片一张都不会动。',
    },
  ]
}

export default function OnboardingGuide(): JSX.Element | null {
  const open = useStore((s) => s.showOnboarding)
  const updateOpen = useStore((s) => s.showUpdate)
  const close = useStore((s) => s.closeOnboarding)
  const tierNames = useStore((s) => s.settings.tierNames)
  /** 引导内容跟着模式走：精简模式下侧栏没有三档/重复照片/废弃库，文案不能照标准版念（用户 10-20 指出） */
  const slim = useStore((s) => s.settings.uiMode === 'slim')
  /** 暂停态存在 store 里：App 的全局快捷键要据此放开（暂停时用户可以随便按） */
  const paused = useStore((s) => s.onboardingPaused)
  const pause = useStore((s) => s.pauseOnboarding)
  const resume = useStore((s) => s.resumeOnboarding)
  const [idx, setIdx] = useState(0)
  const [geo, setGeo] = useState<Geo | null>(null)
  const [tick, setTick] = useState(0)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [cardH, setCardH] = useState(280)

  const steps = buildSteps(tierNames?.length ? tierNames : DEFAULT_TIER_NAMES, slim)
  const step = steps[Math.min(idx, steps.length - 1)]
  const last = idx >= steps.length - 1

  useEffect(() => {
    if (open) {
      setIdx(0)
      resume()
    }
  }, [open, resume])

  // 重测时机：步骤变了、窗口改了大小或换了缩放、内容区滚动导致行位置变化（低频轮询兜住这三种）
  useEffect(() => {
    if (!open || paused) return
    const onResize = (): void => setTick((t) => t + 1)
    window.addEventListener('resize', onResize)
    const iv = setInterval(() => setTick((t) => t + 1), 500)
    return () => {
      window.removeEventListener('resize', onResize)
      clearInterval(iv)
    }
  }, [open, paused, idx])

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1440
  const vh = typeof window !== 'undefined' ? window.innerHeight : 900
  const cw = Math.min(CARD_W, vw * 0.9)

  // 卡片真实高度只有渲染完才知道；量到变化就再排一次版，避免卡片底部捅出窗口
  useLayoutEffect(() => {
    const el = cardRef.current
    if (!el) return
    const h = el.offsetHeight
    setCardH((prev) => (Math.abs(prev - h) < 2 ? prev : h))
    // 依赖只放不透明的量：step 是每次渲染新建的对象，把它放进依赖会让本 effect 每帧跑一次
  }, [idx, open, paused, step.title, cardH])

  // 排亮框 / 卡片 / 手指。用 layout 阶段：改完 state 在浏览器画之前重排，不会看到跳一帧
  useLayoutEffect(() => {
    if (!open || paused) return
    const target = findTarget(step.tour)
    if (target) {
      // 侧栏底部那两枚可能被滚动挡住，先进可视区再量（scrollIntoView 同步生效）
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
    const next: Geo = target
      ? place(target.getBoundingClientRect(), cw, cardH, step.prefer, vw, vh)
      : { ring: null, card: { l: (vw - cw) / 2, t: Math.max(MARGIN, (vh - cardH) / 2), w: cw, h: cardH }, finger: null }
    setGeo((prev) => {
      const same =
        prev !== null &&
        prev.card.l === next.card.l &&
        prev.card.t === next.card.t &&
        ((prev.ring === null && next.ring === null) ||
          (prev.ring !== null && next.ring !== null && prev.ring.l === next.ring.l && prev.ring.t === next.ring.t && prev.ring.w === next.ring.w && prev.ring.h === next.ring.h))
      return same ? prev : next
    })
  }, [open, paused, idx, step.tour, step.prefer, step.title, cw, cardH, vw, vh, tick])

  if (!open || updateOpen) return null

  // 暂停态：亮层收起，只剩底部一颗胶囊，底下的界面完全交还给用户
  if (paused) {
    return (
      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[81] flex justify-center">
        <div className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-brand/60 bg-panel px-4 py-2 shadow-2xl">
          <span className="text-[13px] font-semibold text-fg">
            新手指导暂停中 · 第 {idx + 1} / {steps.length} 步
          </span>
          <button className="btn-primary whitespace-nowrap px-3 py-1 text-xs" onClick={resume} title="接着刚才那一步继续看">
            继续
          </button>
          <button className="btn whitespace-nowrap px-2.5 py-1 text-xs" onClick={close} title="结束引导（之后可在侧栏「新手指导」重看）">
            结束
          </button>
        </div>
      </div>
    )
  }

  const g = geo ?? { ring: null, card: { l: (vw - cw) / 2, t: MARGIN, w: cw, h: cardH }, finger: null }

  return (
    <div className="fixed inset-0 z-[80]">
      {/* 亮框：一圈 9999px 的阴影就是压暗的遮罩，框内保持原样亮着；这层不吃点击，点击由外层整屏接住 */}
      {g.ring ? (
        <div
          className="tour-ring pointer-events-none absolute rounded-lg border-2 border-brand"
          style={{ left: g.ring.l, top: g.ring.t, width: g.ring.w, height: g.ring.h, boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.72)' }}
        />
      ) : (
        <div className="pointer-events-none absolute inset-0 bg-black/72" />
      )}

      {g.finger && (
        <div className="tour-finger pointer-events-none absolute select-none" style={{ left: g.finger.l, top: g.finger.t }}>
          <span
            className="inline-block"
            style={{
              fontSize: 30,
              lineHeight: 1,
              transform: `rotate(${g.finger.rot}deg)`,
              fontFamily: '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif',
              filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.5))',
            }}
          >
            👆
          </span>
        </div>
      )}

      <div
        ref={cardRef}
        className="fade-in absolute flex max-h-[min(66vh,620px)] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
        style={{ left: g.card.l, top: g.card.t, width: cw }}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-2.5">
          <div className="text-[13px] font-bold text-fg">新手指导</div>
          <div className="flex items-center gap-2.5">
            <span className="text-[12px] tabular-nums text-fg3">
              第 {idx + 1} / {steps.length} 步
            </span>
            <button
              onClick={close}
              title="关闭引导（不影响继续使用，之后可在侧栏「新手指导」重看）"
              className="cursor-pointer rounded-md px-1.5 text-[16px] leading-none text-fg3 transition-colors hover:bg-line/60 hover:text-fg"
            >
              ×
            </button>
          </div>
        </div>
        {/* 进度靠一条细线说，不摆圆点徽标 */}
        <div className="h-[3px] w-full shrink-0 bg-line">
          <div className="h-full bg-brand transition-all duration-200" style={{ width: `${((idx + 1) / steps.length) * 100}%` }} />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <h2 className="text-[17px] font-bold leading-snug text-fg">{step.title}</h2>
          {step.lead && <p className="mt-2 text-[13px] leading-relaxed text-fg2">{step.lead}</p>}
          {step.lines && (
            <div className="mt-3.5 space-y-2">
              {step.lines.map((l) => (
                <div key={l.term} className="text-[13px] leading-relaxed">
                  <span className="font-semibold text-fg">{l.term}</span>
                  <span className="text-fg3"> —— </span>
                  <span className="text-fg2">{l.text}</span>
                </div>
              ))}
            </div>
          )}
          {step.note && <div className="mt-3.5 rounded-r-md border-l-2 border-brand/50 bg-panel2/60 px-3 py-2 text-[12px] leading-relaxed text-fg3">{step.note}</div>}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-line px-5 py-3">
          <button className="btn whitespace-nowrap text-xs" onClick={pause} title="先别看引导了，把界面还给你自己动手点；底部胶囊点「继续」能回到这一步">
            停下，我自己试试
          </button>
          <div className="flex items-center gap-2">
            {idx > 0 && (
              <button className="btn whitespace-nowrap text-sm" onClick={() => setIdx((i) => Math.max(0, i - 1))}>
                上一步
              </button>
            )}
            {last ? (
              <button className="btn-primary whitespace-nowrap px-4 text-sm" onClick={close} title="关闭引导，开始用软件">
                开始使用
              </button>
            ) : (
              <button className="btn-primary whitespace-nowrap px-4 text-sm" onClick={() => setIdx((i) => Math.min(steps.length - 1, i + 1))}>
                下一步
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
