/**
 * 教程中心（侧栏底部「📖 教程中心」按钮打开）
 * 一个弹窗当文档中心用：左边目录页签、右边正文，六个章节——
 * 快速上手 / 侧栏分类怎么看 / 常用操作 / AI 复审 / 积分与会员 / 系统设置。
 * 内容口径全部对齐真实界面（TopBar / SettingsDialog / MemberCenterDialog /
 * JudgmentBar / TagEditor / App 快捷键），写错一句就等于误导用户，改功能记得同步这里。
 * 层级只靠排版：大字标题 + 小字浅色说明 + 键帽符号，不套方框徽标（用户审美红线）。
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SysConfig } from '../../../shared/ipc'

/** 页签定义：顺序即目录顺序，first = 打开时默认停在「快速上手」 */
const TABS = [
  { key: 'start', icon: '🚀', label: '快速上手' },
  { key: 'sidebar', icon: '📚', label: '侧栏分类怎么看' },
  { key: 'ops', icon: '🖱', label: '常用操作' },
  { key: 'areview', icon: '✨', label: 'AI 复审' },
  { key: 'member', icon: '👑', label: '积分与会员' },
  { key: 'settings', icon: '⚙️', label: '系统设置' },
] as const

type TabKey = (typeof TABS)[number]['key']

/** 章节内的小节标题 */
function H({ children }: { children: ReactNode }): JSX.Element {
  return <div className="mt-6 mb-1.5 text-[15px] font-bold text-fg first:mt-0">{children}</div>
}

/** 小节内的三级标题（操作名等） */
function H3({ children }: { children: ReactNode }): JSX.Element {
  return <div className="mt-4 mb-1 text-[13px] font-bold text-fg">{children}</div>
}

/** 名词解释行：左列名词、右列说明（侧栏分类一节用） */
function Def({ term, children }: { term: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex gap-3 py-1.5 border-b border-line/50 last:border-b-0">
      <div className="w-24 shrink-0 text-[13px] font-semibold text-fg leading-5">{term}</div>
      <div className="min-w-0 flex-1 text-[13px] text-fg2 leading-5">{children}</div>
    </div>
  )
}

/** 键帽：快捷键的统一呈现 */
function Key({ children }: { children: ReactNode }): JSX.Element {
  return <kbd className="inline-block min-w-[22px] text-center rounded border border-line bg-panel2 px-1.5 py-0.5 text-[11px] font-semibold text-fg2 tabular-nums">{children}</kbd>
}

/** 无序要点列表 */
function Ul({ children }: { children: ReactNode }): JSX.Element {
  return <ul className="ml-4 space-y-1.5 list-disc text-[13px] text-fg2 leading-relaxed marker:text-fg3">{children}</ul>
}

/** 提示条：一句话的"为什么/注意"，靠浅色底和左边线跟正文区分 */
function Note({ children }: { children: ReactNode }): JSX.Element {
  return <div className="mt-2 rounded-r-md border-l-2 border-brand/50 bg-panel2/60 px-3 py-2 text-[12px] text-fg3 leading-relaxed">{children}</div>
}

/* ---------------- 各章节正文 ---------------- */

function StartTab(): JSX.Element {
  return (
    <div>
      <H>三步就能出片</H>
      <ol className="ml-4 space-y-2.5 list-decimal text-[13px] text-fg2 leading-relaxed marker:text-fg3">
        <li><b className="text-fg">导入照片</b>：点顶栏「导入照片」，可以选单张、多选，也可以直接选整个文件夹（或把照片拖进窗口）。支持 JPG、CR2、CR3、ARW、NEF 等常见格式。</li>
        <li><b className="text-fg">开始筛选</b>：点顶栏「开始筛选」，AI 自动逐张分析——有没有闭眼、模糊、曝光异常这些毛病，画面里有几个人，并给出清晰度评分。跑完后左侧栏就能看到分类结果。</li>
        <li><b className="text-fg">导出交付</b>：人工确认没问题后点顶栏「导出交付」，选择导出范围和目录结构，把成品图打包到指定位置。默认导出原文件（包括 RAW），不压缩、不转格式。</li>
      </ol>
      <Note>只有「开始筛选」这一步消耗积分（1 张 = 1 积分），导入、浏览、手动分类、导出都免费，详见「积分与会员」。</Note>

      <H>顶栏上都有什么</H>
      <Ul>
        <li><b>导入照片 ▾</b> — 文件 / 文件夹两个入口，文件夹可勾选递归导入全部子目录</li>
        <li><b>开始筛选</b> — 启动 AI 分析；旁边的小菜单里有「重新筛选全部」</li>
        <li><b>↩ 撤回</b> — 移动过照片后变亮，点一下撤回最近一次移动，可依次多撤几步</li>
        <li><b>清空图库</b> — 删光软件里的导入记录与修正记录（磁盘上的原始照片一张不动），导入错了想重新来时用</li>
        <li><b>场景下拉</b> — 按婚礼 / 棚拍 / 儿童等场景微调判定松紧，具体项在设置 → 高级设置里查看</li>
        <li><b>搜文件名</b> — 按文件名过滤当前相册（只影响显示，不改分类）；可以一次粘多个名字，用空格、逗号或换行分隔，Esc 清空</li>
        <li><b>排序</b> — 默认 / 文件名 / 置信度（优先抽查拿不准的）/ 最新在前</li>
        <li><b>视图</b> — 网格 / 列表 / 瀑布流三种布局，旁边「大图」按钮直接打开放大窗口</li>
        <li><b>导出交付</b> — 把选中的分类导出到指定文件夹</li>
        <li><b>⚙️</b> — 设置；<b>积分数字</b> — 会员中心；<b>☀️ / 🌙</b> — 切换简白 / 暗夜主题</li>
      </Ul>

      <H>几个顺手的快捷键</H>
      <div className="space-y-1.5 text-[13px] text-fg2">
        <div><Key>1</Key> <Key>2</Key> <Key>3</Key>　切换网格 / 列表 / 瀑布流视图</div>
        <div><Key>4</Key>　打开大图（从当前选中的第一张开始，没选中就从列表第一张）</div>
        <div><Key>←</Key> <Key>→</Key>　大图里翻上一张 / 下一张</div>
        <div><Key>Esc</Key>　关闭大图、弹窗，或清空搜索框</div>
        <div><Key>Delete</Key>　把选中的照片丢进废弃库（在废弃库里按则是还原）</div>
        <div><Key>Ctrl</Key>+<Key>A</Key>　全选当前相册</div>
      </div>
    </div>
  )
}

function SidebarTab(): JSX.Element {
  return (
    <div>
      <H>先弄明白：侧栏是两个世界</H>
      <div className="text-[13px] text-fg2 leading-relaxed">
        侧栏那些数字<b className="text-fg">不能全都加在一起</b>。它分成上下两个世界，区别就一条——<b className="text-fg">每张图算几次</b>：
      </div>
      <Ul>
        <li><b className="text-fg">上面「筛选结果」+ 底部「废片」＝ 分开装</b>：交付库、瑕疵片、待确认、重复照片、废弃库这五栏互不重复，每张图只进其中一栏，正常情况加起来 ≈ 全部照片。</li>
        <li><b className="text-fg">下面「类型」「瑕疵」「自定义分类」＝ 重看重叠</b>：是换个角度把同一批图再筛一遍，同一张会同时出现在好几栏，这些数字<b className="text-fg">不能相加</b>，也别跟上面比大小。</li>
      </Ul>
      <Note>比如一张黑白合影：会同时出现在「合影」和「黑白照」两行；它同时只属于上面五栏里的一栏（交付库）。侧栏每行悬停都有一句话解释，看不清就悬停看看。</Note>

      <H>逐栏说明</H>
      <Def term="全部文件">不管分没分类，所有导入的照片都在这里，数字 = 整个图库。点它回到全局视图。</Def>
      <Def term="筛选结果">AI 分析后按"这张图怎么处理"做的互斥切分，下面五栏每张图只进一栏。交付库能直接导出；瑕疵片、待确认、重复照片默认不导出但能捞回；废弃库永不导出但能还原。</Def>
      <Def term="交付库">AI 判定没毛病、默认全部参与导出的好片。里面再按画面清不清楚分优质 / 良好 / 一般三档，<b>三档加起来就是交付库</b>。注意：不能把图直接拖到"交付库"这一行，要拖到它下面三个档位之一。</Def>
      <Def term="瑕疵片">AI 挑出毛病（闭眼、模糊、曝光异常、半截头、表情崩坏）的图，默认不导出。觉得判错了，删掉标签或拖进交付库即放行。</Def>
      <Def term="待确认">AI 拿不准的，需要你人眼定夺，暂不导出。要了选档进交付库，不要丢废弃库。</Def>
      <Def term="重复照片">同一瞬间多拍的那批：每组已经自动挑了一张更好的进交付库，剩下这些默认不导出。点进去是整组视图，想多留一张在组里再选即可。</Def>
      <Def term="类型">按画面里几个人、是不是黑白重看一遍，只是客观属性、不分好坏。一张黑白单人照会同时出现在「单人照」和「黑白照」两栏。</Def>
      <Def term="瑕疵">按缺陷种类逐个看。一张图同时闭眼又模糊，会在两行各算一次，所以各行加起来会比上面的「瑕疵片」多。</Def>
      <Def term="废片 → 废弃库">你亲手丢掉的图都集中在这一个地方，永不导出。点进去左边按"从哪丢的"分栏，可以一键还原回原来的地方，也能直接选档捞进交付库。</Def>
      <Def term="自定义分类">你自己建的相册（比如「主桌」「伴娘」「外景」），照常导出、可以单独勾选导出；删除相册时里面的图自动回归交付库，不会丢。</Def>

      <H>交付库三档怎么理解</H>
      <Ul>
        <li><b>优质</b> — 实测最清楚的一档，放大精修放心用</li>
        <li><b>良好</b> — 清晰度居中，正常出片够用；早年放行时没留下清晰度记录的也先归这里</li>
        <li><b>一般</b> — 画面偏软，适合当备选凑数，不建议大尺寸放大</li>
      </Ul>
      <Note>三档只告诉你"先看哪批"，不影响哪张照片被拦下来——拦谁由瑕疵判定说了算。档位目录名可以在设置里改（比如改成 精修 / 初修 / 直出）。</Note>
    </div>
  )
}

function OpsTab(): JSX.Element {
  return (
    <div>
      <H3>怎么复核一栏（进度条 + 自动连跳）？</H3>
      <Ul>
        <li>适用栏：待确认 / 瑕疵片 / 任一具体瑕疵（闭眼、模糊等）。点开这一栏后双击任意一张进大图，大图顶部会出现「▶ 开始复核」。</li>
        <li>点一下就开始连续判：每判完一张，它自动离开当前栏、大图自动跳到下一张；顶部计数变成「已判 X / 共 Y」，让你知道还剩多少。</li>
        <li>这一栏判完（列表空了），大图自动关掉并提示「本组复核完成」；中途想停再点一次退出复核即可。判定仍用现有按钮（选档 / 不合格 / 删标签），没有额外的快捷键。</li>
      </Ul>

      <H3>怎么用 AI 复审（会员功能）？</H3>
      <div className="text-[13px] text-fg2 leading-relaxed">
        这一项单独成章，见左侧<b className="text-fg">「AI 复审」</b>页签：它复核什么、会员权益与每日额度、开关在哪、自动跑还是手动跑、建议怎么采纳和撤回。
      </div>

      <H3>有照片没跑成怎么办？</H3>
      <Ul>
        <li>筛选结束后，若有的照片读不出来（无法解码的 RAW、文件损坏、或已被移动删除），顶栏会出现红色小徽章「N 张没跑成」。</li>
        <li>点徽章打开列表，逐张看是哪张、在哪个文件夹；确认原文件还在后点「重试这 N 张」重新跑一遍（不会重复消耗已跑好的那些）。只要还有失败的，徽章就一直在。</li>
      </Ul>

      <H3>怎么把照片移到别的分类？</H3>
      <Ul>
        <li><b>拖</b>：选中一张或多张，直接拖到左侧栏的目标分类行上松手。进交付库要拖到优质 / 良好 / 一般三个档位行之一（「交付库」那一行本身不接受拖入）。</li>
        <li><b>按钮</b>：双击小图打开大图，右栏有「✓ 合格 → 交付库（选档）」「✕ 不合格 → 废弃库」两个动作；勾选照片后底部工具条也是这两个，再加一个「标签管理」。要去待确认或自己的相册，把图拖到左侧栏那一行就行。</li>
      </Ul>
      <Note>为什么要移动：你的每次移动都会被软件记下来当成"标准答案"，AI 会朝你的习惯逐步修正判定，越用越准。移动错了别慌，顶栏「↩ 撤回」按一下就去。</Note>

      <H3>怎么丢弃照片？丢错了怎么找回？</H3>
      <Ul>
        <li>丢弃：把图拖进「废弃库」，或在大图里点「✕ 不合格」，或选中后按 <Key>Delete</Key>（会先弹确认）。</li>
        <li>找回：点开底部「废弃库」，左边按"从哪丢的"分栏——点某一栏只看这一来源的；选中后点「♻️ 还原」，从哪来的回哪去；也可以直接选个档位捞进交付库。</li>
      </Ul>
      <Note>废弃库里的图永不导出，但永远不会被真删——磁盘上的原片始终不动。</Note>

      <H3>怎么删标签 / 加标签？</H3>
      <Ul>
        <li>在哪操作：大图右栏的标签区，或选中照片后点「标签管理」按钮，不用进大图也能批量增删。</li>
        <li>删：「当前标签」里点那枚标签上的 <b>✕</b>。人物分类不能删只能换（四选一）；如果某枚标签带着定位针 📍，说明这张图正是靠它才出现在当前分类里，删掉它就会移出当前列表（会先跟你确认）。</li>
        <li>加：「其他标签」区点一下就加上；人数按四个按钮切换，点谁换谁。</li>
      </Ul>
      <Note>为什么要删标签：标签就是 AI 给照片贴的"问题条"，带着瑕疵标签的图会被拦在导出外面。判错了删掉标签，图就自动离开瑕疵分类、恢复导出资格；手动加标签则是告诉 AI"这张确实有这个毛病"。两种操作都会喂给自学习。</Note>

      <H3>怎么批量处理？</H3>
      <Ul>
        <li>点图选中，Ctrl+点加选 / 减选，<Key>Ctrl</Key>+<Key>A</Key> 全选当前相册。</li>
        <li>选中一批后：整批拖到侧栏分类 = 批量移动；标签管理里操作一次 = 对全部选中图生效（按钮上的 n/m 表示已覆盖几张）。</li>
      </Ul>

      <H3>怎么看大图、搜文件？</H3>
      <Ul>
        <li>双击小图或按 <Key>4</Key> 打开放大窗口（加载原图细节），<Key>←</Key> <Key>→</Key> 翻页，<Key>Esc</Key> 关闭。</li>
        <li>顶栏搜索框输入文件名快速定位；可以一次粘一串名字（空格 / 逗号 / 换行分隔），只影响显示，不改分类。</li>
      </Ul>
    </div>
  )
}

/**
 * AI 复审单独成章（用户指定：介绍 + 会员权益 + 功能操作）。
 * 口径全部对着代码写的：开关在 TopBar（非会员灰锁 +「今日剩 N 张」）、只跑「尚无建议」的图（db.listPendingAiReviewIds）、
 * 复核维度 = 人数四分类 + 闭眼/半截头/表情崩坏（types.AiReviewSuggestion）、按钮文案对着 AiReviewBar / AiReviewModal。
 */
function AiReviewTab(): JSX.Element {
  return (
    <div>
      <H>它是干什么的</H>
      <div className="text-[13px] text-fg2 leading-relaxed">
        本地筛完之后，「待确认」里是 AI 拿不准该归哪类的，「瑕疵片」里是被判了毛病、但可能判冤枉的。<b className="text-fg">AI 复审</b>就是把这些照片再送云端大模型看第二遍，给你一份「这张我建议改成什么」的意见。<b className="text-fg">只对这两栏生效</b>，其他栏的照片它不看。
      </div>
      <Ul>
        <li><b>只给建议，绝不动手</b>：跑完之后照片的分类和标签一个字都不会变，你点「采纳」才生效。</li>
        <li><b>采纳了也能反悔</b>：采纳等于你亲手改的，顶栏「↩ 撤回」随时恢复原样。</li>
        <li><b>不重跑本地筛选</b>：它是筛完之后的附加复核，本地引擎的结论摆着不动。</li>
      </Ul>

      <H>会员权益</H>
      <Ul>
        <li><b>谁能用</b>：会员专属，月度 / 季度 / 年度 / 终身都含。非会员在顶栏看到的是灰锁「AI 复审 🔒」，点它会打开会员中心。</li>
        <li><b>谁出钱</b>：云端调用费由平台承担，会员用复审不另外扣积分。</li>
        <li><b>每天能跑多少</b>：每个账号每天有复审张数上限，用完自动停、第二天恢复；顶栏开关上实时显示「今日剩 N 张」。</li>
        <li><b>不重复花额度</b>：已经出过建议的照片不会再跑一遍，“再次复审”只补还没判过的（以及你明确点过「不采纳」、想让它重新看的那些）。</li>
      </Ul>

      <H>怎么开</H>
      <Ul>
        <li>顶栏「AI 复审」开关（在筛选目录前面）：会员点一下开、再点关，它记的是<b>自动复审</b>的偏好。</li>
        <li>第一次开启会弹一个确认窗口，写清楚「照片压缩后上传阿里云做识别」，你确认了才会开始。</li>
        <li>未登录会先弹登录；关了开关只是不再自动跑，已经跑出来的建议还在。</li>
      </Ul>

      <H>怎么跑</H>
      <Ul>
        <li><b>自动（只跑待确认）</b>：开关开着时，每次筛选结束、只要「待确认」里有照片，就在后台自动复审。期间你正常操作别的分类——只有「待确认」这一页会被进度窗口暂时占住（显示进度、可随时停止）；人不在这一页时，只在顶栏看到一行小字进度，不挡任何操作。</li>
        <li><b>手动（两栏都能跑）</b>：「待确认」「瑕疵片」两页顶部各有一条常驻按钮：没判过的显示「立即复审」，判过之后再点是「再次复审」（会再消耗额度、先弹确认）。瑕疵片只手动跑、不自动扫，省额度。</li>
        <li><b>跑到哪了</b>：正在复审时，左侧栏「待确认」「瑕疵片」那两行会在名字后面显示「AI 复审中 x/y」，跑完自动消失。</li>
      </Ul>

      <H>怎么看结果、怎么采纳</H>
      <Ul>
        <li>跑完弹小结：共复审多少张、其中多少张跟本地判定有不同意见。先不看可以点「以后再说」，之后从页顶「查看复审建议」再进来。</li>
        <li>点「逐张复核」看前后对比：上方大图，下方只列「现状 → AI 建议」有分歧的项和 AI 给的理由，可以「上一张 / 下一张」。</li>
        <li>认可就点「采纳这张」（或在小结里点「全部采纳 N 条」）；不认可点「不采纳」，照片保持原样，这张也不再计入本轮分歧。</li>
      </Ul>

      <H>复核哪些项、效果边界在哪</H>
      <Ul>
        <li><b>复核四项</b>：人数归属（单人 / 多人合拍 / 多人混合 / 无人物）、闭眼、半截头、表情崩坏——都是“看得见”的内容问题，也是云端模型比较擅长的地方。</li>
        <li><b>画质问题不碰</b>：模糊、曝光异常、黑白这类一律不判——本地引擎在画质上判得更准，再花额度复核是浪费。</li>
        <li><b>它是第二意见，不是终审</b>：两边不一致的才会列出来给你看，判定本来就没分歧的照片不会占你的复核时间。</li>
      </Ul>
      <Note>没网或云端暂时不可用时自动跳过，本地筛选结果不受影响；中途手动停止，已经跑出来的建议照样能看、能采纳。</Note>
    </div>
  )
}

function MemberTab(): JSX.Element {
  return (
    <div>
      <H>积分规则</H>
      <Ul>
        <li>注册即送 <b>500 积分</b>，1 积分 = 1 张照片的 AI 分析，也就是可以免费体验 500 张。</li>
        <li>只有点「开始筛选」才扣积分，按实际处理的张数计；导入、浏览、手动分类、导出全部免费。</li>
        <li>积分用完了可以单独充值，或者开通会员——会员期间筛选<b>不扣积分</b>，新开通还赠积分。</li>
      </Ul>

      <H>会员怎么开通</H>
      <Ul>
        <li>点顶栏的积分数字，打开<b>会员中心</b>：上面看积分余额、会员等级、到期时间。</li>
        <li>选一个套餐（月度 / 季度 / 年度）点「开通」，出示客服二维码，扫码添加客服完成支付。</li>
        <li>支付成功后回到会员中心点「刷新状态」，积分 / 会员自动到账。</li>
        <li>右下角「退出登录」可换账号；未登录状态只能浏览，不能开始筛选。</li>
      </Ul>
      <Note>如需单独充值积分或有其他问题，会员中心里也有客服微信入口。</Note>

      <H>会员专属特权：AI 复审</H>
      <div className="text-[13px] text-fg2 leading-relaxed">
        把「待确认」「瑕疵片」两栏里本地 AI 拿不准的照片送云端再看一遍，只给建议、你点采纳才生效；云端费用平台承担，每天有张数上限。介绍、权益和具体操作都在左侧<b className="text-fg">「AI 复审」</b>页签里。
      </div>
      <Note>非会员用不了：顶栏「AI 复审」是灰锁按钮，点了会打开会员中心；首次开启还会请你确认「照片压缩后上传阿里云做识别」。</Note>
    </div>
  )
}

function SettingsTab(): JSX.Element {
  return (
    <div>
      <div className="text-[13px] text-fg2 mb-1">点顶栏 <b className="text-fg">⚙️</b> 打开设置，逐块说明：</div>

      <H>环境检测</H>
      <Ul>
        <li><b>引擎偏好 / 计算设备</b> — 不知道选什么就都保持"自动"。有 NVIDIA 显卡可选 GPU 提速。</li>
        <li><b>性能模式</b> — 默认"自动"：低配机器自动去掉动画等装饰换流畅，功能一项不少。下面那行小字会告诉你本机被探测成了什么级别。</li>
        <li><b>当前引擎状态</b> — 显示正在用的是完整 AI 引擎还是降级模式。降级模式只查模糊 / 曝光 / 黑白 / 重复，人脸类（闭眼等）需要完整引擎。</li>
        <li><b>重新筛选全部图片</b> — 把上一轮 AI 分类清零重算。你手动放好的图、手动加的标签、废弃库内容<b>都会保留</b>，不会被冲掉。</li>
      </Ul>

      <H>交付库档位目录名</H>
      <Ul>
        <li>三个名字对应侧栏三档和导出时的子文件夹，可以改成自己顺口的（如 精修 / 初修 / 直出），改完立即可见，不用重筛。</li>
      </Ul>

      <H>判定线是怎么定的（设置里没有阈值旋钮）</H>
      <Ul>
        <li>每类瑕疵的判定线由开发者逐维度统一标定。早先版本设置里的阈值滑条、场景预设、“自动微调”按钮已全部撤除——多层旋钮互相叠加时曾把判定线悄悄推歪，导致偏糊的片子漏标，收口成开发者单点维护更稳。</li>
        <li>你做的纠正（删标签 / 加标签 / 移动分类）仍会逐条保存下来，用于后续版本的判定标定，但不会实时改动当前判定线。</li>
        <li>人数分类、黑白照、重复图是引擎的事实结论，任何设置下都一律照旧，不存在被“调松/调紧”的空间。</li>
      </Ul>

      <H>版本更新 / 数据管理</H>
      <Ul>
        <li><b>检查更新</b> — 有新版本会显示更新内容和下载按钮，下载后运行安装包即可覆盖升级，图库与修正记录保留。</li>
        <li><b>清除缓存</b> — 重建全部缩略图，并重试之前提示"无法解码"的照片（如 CR3 / ARW），已有的检测分类结果保留。</li>
        <li><b>清空图库</b> — 在顶栏「导入照片」旁边：删光软件里的导入记录与修正记录，磁盘上的原始照片一张不动。</li>
      </Ul>
    </div>
  )
}

const CONTENT: Record<TabKey, () => JSX.Element> = {
  start: StartTab,
  sidebar: SidebarTab,
  ops: OpsTab,
  areview: AiReviewTab,
  member: MemberTab,
  settings: SettingsTab,
}

/* ---------------- 弹窗骨架 ---------------- */

export default function TutorialCenter({ onClose }: { onClose: () => void }): JSX.Element {
  const [tab, setTab] = useState<TabKey>('start')
  // 客服二维码：接口 config.php 提供，打开时拉一次；与会员中心同样的取值顺序（客服码优先，回退微信码）
  const [cfg, setCfg] = useState<SysConfig | null>(null)
  useEffect(() => {
    void window.api.sysConfig().then(setCfg).catch(() => {
      /* 拉取失败不阻断教程阅读，底下那块静默不显示 */
    })
  }, [])
  const qr = cfg?.customer_service_qrcode || cfg?.wechat_qrcode || ''
  const Body = CONTENT[tab]
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex w-[min(1180px,94vw)] h-[min(84vh,860px)] overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl">
        {/* 左目录 */}
        <nav className="w-52 shrink-0 border-r border-line bg-panel2/40 flex flex-col py-4">
          <div className="px-5 mb-3 text-[16px] font-bold text-fg tracking-wide">教程中心</div>
          {TABS.map((t) => (
            <button
              key={t.key}
              className={
                'mx-2 flex items-center gap-2 rounded-lg px-3 py-2.5 text-left text-[13px] transition-colors cursor-pointer ' +
                (tab === t.key ? 'bg-brand/15 text-brand font-semibold' : 'text-fg2 hover:bg-line/50 hover:text-fg')
              }
              onClick={() => setTab(t.key)}
            >
              <span className="w-5 shrink-0 text-center">{t.icon}</span>
              {t.label}
            </button>
          ))}
          {/* 客服二维码钉在目录底部：mt-auto 把剩下的空间全顶到它上面，不随页签多少往上跑 */}
          {qr && (
            <div className="mt-auto px-4 pt-4 flex flex-col items-center gap-2">
              <div className="text-[12px] font-semibold text-fg2 text-center">联系客服微信</div>
              <img src={qr} alt="客服二维码" className="w-32 h-32 rounded-lg border border-line object-contain bg-white p-1" draggable={false} />
            </div>
          )}
          <div className={(qr ? '' : 'mt-auto ') + 'px-5 pt-4 pb-1 text-[11px] leading-relaxed text-fg3'}>侧栏每一行悬停都有一句话解释；这里看不到的细节都可以问客服。</div>
        </nav>
        {/* 右正文 */}
        <div className="min-w-0 flex-1 flex flex-col">
          <div className="flex items-center justify-between border-b border-line px-8 h-12 shrink-0">
            <div className="text-[14px] font-bold text-fg">{TABS.find((t) => t.key === tab)?.label}</div>
            <button onClick={onClose} className="rounded-lg px-2 py-1 text-[18px] leading-none text-fg3 hover:bg-line/60 hover:text-fg cursor-pointer" title="关闭（Esc 或点击空白处）">×</button>
          </div>
          <div className="flex-1 overflow-y-auto px-8 py-6">
            <Body />
            <div className="h-6" />
          </div>
        </div>
      </div>
    </div>
  )
}
