/**
 * 页内「AI 复审」复核条：只挂在「待确认」「瑕疵片」两页列表顶部，作为内容区的固定行（不随列表滚动）。
 *
 * 两个按钮的语义不同：蓝色「立即复审」只提交尚未复核的（含此前点过「不采纳」的，那等于还没结案）；
 * 橙色「再次AI复审」在此之上多跑一批“已判过但用户没表态”的——它们既不在采纳列表也不在默认队列，
 * 没有橙色按钮就永远没人再提交（用户实测抓到的死胡同）。
 * 唯一不再重跑的是结案项（confirmed：采纳过或点过「确认采纳」）——那张用户已经认了结果，
 * 重跑等于同一张烧两次额度（用户 10-15 拍到：采纳后再点“再次AI复审”不应重判它）。
 * 不采纳过的可以重跑是用户 10-15 实测后定的：否掉的是那一份意见，不是“这张永远别再看”。
 * 口径与主进程 db.listPendingAiReviewIds 必须一致，否则顶部条报的张数
 * 与实际消耗的额度对不上。
 *
 * 术语约定（两页 + 弹窗 + toast 共用，不要再各说各的）：
 *  · 功能名：AI 复审（顶栏开关/侧栏/教程同此）；动作描述：云端复核
 *  · 结果：复核结论；与本地检测相同叫「一致」，不同叫「分歧」
 *  · 画质两项用正式维度名：画面模糊、曝光异常（合称画质维度）
 *  · 卡片左上角角标文字固定为「人工复审」/「画质需人工复审」（用户 10-14 二次拍板，不得自己改字）
 *
 * 文案原则（用户 10-14：“话术太多”+“不要看着很 low”）：一句主句 + 一行浅灰小字，
 * 计数用“分歧 3 · 一致 5 · 待归档 1”这种短清单而不是整句口语，能力边界只说一次。
 *
 * 尺寸（用户 10-15：“小屏幕电脑上看着有点大了”）：主句与按钮 text-sm、数字 text-base、
 * 行内补充 text-xs，上下内边距 py-2。上一版为“看不清”放到 text-base/text-xl，
 * 在小屏上整条占了近一行高；层级靠字号差与大数字拉开，不靠尺寸堆砌。
 *
 * 五态互斥：运行中 → 就地反馈 → 额度确认 → 结论待确认 → 空闲（含“全部已结案”与“仅剩人工裁定”）
 *
 * 精简模式（settings.uiMode==='slim'）：不给人确认入口——复审跑完由 store.settleSlimAiReview
 * 自动采纳并归位；但「跑复审」这个动作要保留（用户 10-20：精简模式同样要能手动复审），
 * 所以运行态、就地反馈与待确认 / 瑕疵片两页的「立即复审 / 再次AI复审」照常出现。
 * 瑕疵片也要有（用户 10-20 补充）：人工移入的瑕疵只有云端能再核一遍，判完自动采纳，
 * 云端否掉的瑕疵会撤销标签、图自动离开本栏。
 */
import { useState } from 'react'
import { useStore, hasAiReviewDiff, hasAiReviewAction, aiReviewShouldHome, needsManualReview } from '../store'
import { isTrashLike } from '../../../shared/types'
import { isVip } from '../../../shared/membership'
import type { AiReviewScope } from '../../../shared/types'

export default function AiReviewBar(): JSX.Element | null {
  const activeCategory = useStore((s) => s.activeCategory)
  const aiReview = useStore((s) => s.aiReview)
  const images = useStore((s) => s.images)
  const auth = useStore((s) => s.auth)
  const startAiReview = useStore((s) => s.startAiReview)
  const stopAiReview = useStore((s) => s.stopAiReview)
  const reopenSummary = useStore((s) => s.reopenAiReviewSummary)
  const feedback = useStore((s) => s.aiReviewFeedback)
  const slim = useStore((s) => s.settings.uiMode === 'slim')
  const [confirmRerun, setConfirmRerun] = useState(false)

  // 只在待确认 / 瑕疵片两页出现，且本页作用域就是当前分类
  if (activeCategory !== 'review' && activeCategory !== 'flaws') return null
  // 非会员不占页面：复审是会员专属，给非会员挂一条复审栏只会“看得到按不了”。
  // 结论弹窗（AiReviewModal）不受此限：会员期间跑出的结论仍需他确认，入口不能断。
  const isMember = auth.loggedIn && isVip(auth.user)
  if (!isMember) return null
  const scope: AiReviewScope = activeCategory
  const running = !!aiReview?.running && (aiReview?.scope ?? 'review') === scope
  // 本页可参与复审的图（废弃类不算）
  const inScope = images.filter((i) => !isTrashLike(i.category))
  const judgedCount = inScope.filter((i) => !!i.ai_review).length
  const unjudgedCount = inScope.length - judgedCount
  // 等你表态的：有分歧的（按 AI 改）+ 与本地一致的（确认采纳）+ 已结案但该归位的（一键搬出待确认），一个都不能漏（用户 10-14 拍板）
  const pendingCount = inScope.filter((i) => hasAiReviewAction(i)).length
  const diffCount = inScope.filter((i) => hasAiReviewDiff(i)).length
  // 已转人工定画质的：AI 复审帮不上、排在本栏最前的那批
  const manualCount = inScope.filter((i) => needsManualReview(i)).length
  // 已复核干净、只差一个归位动作的（存量手动停泊的干净图）：重跑它也不会变干净，不列进复审
  const homeCount = inScope.filter((i) => aiReviewShouldHome(i)).length
  // 只有结案（confirmed：采纳过或点过「确认采纳」）才不再提交云端；不采纳过的仍算可复审（用户 10-15 实测拍板）。
  // manualCount / homeCount 都是 confirmed 的子集（两个谓词都要求 confirmed），所以只减结案数，
  // 再减一次会把同一批图算两遍——与主进程 db.listPendingAiReviewIds 同一口径，报的数才对得上实际烧的额度。
  const rerunnable = inScope.filter((i) => !i.ai_review?.confirmed).length
  const settledCount = inScope.length - rerunnable
  // 一致 = 总数 - 有分歧 - 等你归位（夹 0：极少数“已结案又手动改回标签”的图会同时占两个桶，不能报负数）
  const agreeCount = Math.max(0, pendingCount - diffCount - homeCount)

  // 固定行（在滚动容器外）：实底背景 + 下分隔线，天然顶满整行两边，不需要 sticky/负 margin
  const shell = 'shrink-0 flex items-center justify-center gap-3 border-b border-line bg-panel px-4 py-2'

  if (running) {
    return (
      <div className={shell}>
        <span className="inline-flex items-center gap-2.5 text-sm text-fg2 tabular-nums whitespace-nowrap">
          <span className="inline-block w-4 h-4 shrink-0 rounded-full border-2 border-brand border-t-transparent animate-spin" />
          云端复核进行中 {aiReview?.done ?? 0}/{aiReview?.total ?? 0}
        </span>
        <button className="btn text-sm px-3.5 py-1.5 whitespace-nowrap" onClick={() => void stopAiReview()} title="中止复核：在当前张停止，已生成的结论保留">
          停止
        </button>
      </div>
    )
  }

  // 就地反馈（点击后未启动成功）：优先于其它态显示，带手动收起入口，6 秒后 store 自动清
  if (feedback && !running) {
    return (
      <div className={shell}>
        <span className="text-sm font-semibold text-orange-400">{feedback}</span>
        <button className="btn text-sm px-3.5 py-1.5 whitespace-nowrap" onClick={() => useStore.setState({ aiReviewFeedback: null })}>知道了</button>
      </div>
    )
  }

  // 精简模式（用户 10-20）：结果自动采纳归位，不弹确认面板；但复审入口要留下——
  // 待确认 / 瑕疵片两页都显示本栏还剩多少张没判，点一下直接提交（不再走“重判前确认额度”那一屏）。
  if (slim) {
    if (!inScope.length) return null
    const doneAll = unjudgedCount === 0
    const slimFlaws = activeCategory === 'flaws'
    return (
      <div className={shell}>
        <span className="text-sm text-fg2">
          {doneAll ? (
            <>本栏 <strong className="text-base font-bold text-fg tabular-nums">{judgedCount}</strong> 张已完成云端复核</>
          ) : (
            <>本栏 <strong className="text-base font-bold text-fg tabular-nums">{unjudgedCount}</strong> 张尚未复核</>
          )}
          <span className="text-xs text-fg3 ml-2.5">
            {slimFlaws ? '复核完自动写回判定，云端否掉的瑕疵自动撤销' : '复核完自动写回判定并归位，不用逐张确认'}
          </span>
        </span>
        {doneAll ? (
          rerunnable > 0 && (
            <button
              className="btn-warn text-sm px-3.5 py-1.5 whitespace-nowrap"
              onClick={() => void startAiReview(scope, true)}
              title="再次 AI 复审：重判本栏尚未结案的照片（含判过没表态的），重新消耗今日额度；跑完自动归位"
            >
              再次AI复审
            </button>
          )
        ) : (
          <button
            className="btn-primary text-sm px-3.5 py-1.5 whitespace-nowrap"
            onClick={() => void startAiReview(scope)}
            title="AI 复审（会员专属，计入每日额度）：复核本栏尚未判过的照片；跑完自动写回判定并归位"
          >
            立即复审
          </button>
        )}
      </div>
    )
  }

  // 用户点了橙色“再次AI复审”：先给应用内额度确认（不走 window.confirm），说清重判范围与跳过项
  if (confirmRerun) {
    return (
      <div className={shell}>
        <span className="text-sm text-orange-400">
          本次将重判 <strong className="font-semibold">{rerunnable}</strong> 张{settledCount > 0 ? `，已结案的 ${settledCount} 张自动跳过` : ''}，将消耗今日额度，是否继续？
        </span>
        <button className="btn text-sm px-3.5 py-1.5 whitespace-nowrap" onClick={() => setConfirmRerun(false)}>取消</button>
        <button className="btn-warn text-sm px-3.5 py-1.5 whitespace-nowrap" onClick={() => { setConfirmRerun(false); void startAiReview(scope, true) }} title="提交重判：本栏尚未结案的每张照片都重判（含此前不采纳的），已采纳过或点过「确认采纳」的不再重判，消耗今日额度">确认复核</button>
      </div>
    )
  }

  // 本轮仍有未确认的结论（含“稍后处理”收起后）：蓝色查看结论与橙色再次复审并存（入口不互斥，用户要求）
  if (pendingCount > 0) {
    const parts: string[] = []
    if (diffCount > 0) parts.push(`分歧 ${diffCount}`)
    if (agreeCount > 0) parts.push(`一致 ${agreeCount}`)
    if (homeCount > 0) parts.push(`待归档 ${homeCount}`)
    if (manualCount > 0) parts.push(`待人工定画质 ${manualCount}`)
    return (
      <div className={shell}>
        <span className="text-sm text-fg2">
          <strong className="text-base font-bold text-fg tabular-nums">{pendingCount}</strong> 张复核结论待确认
          {parts.length > 0 && <span className="text-xs text-fg3 ml-2.5 tabular-nums">{parts.join(' · ')}</span>}
        </span>
        <button className="btn-primary text-sm px-3.5 py-1.5 whitespace-nowrap" onClick={reopenSummary} title="打开本轮复核结果，逐项比对后可单张或批量应用">
          查看复核结论 ({pendingCount})
        </button>
        {rerunnable > 0 && (
          <button className="btn-warn text-sm px-3.5 py-1.5 whitespace-nowrap" onClick={() => setConfirmRerun(true)} title="再次 AI 复审：重判本栏尚未结案的照片（含不采纳过的与判过没表态的；已采纳、转人工裁定与待归档的自动跳过），重新消耗今日额度">再次AI复审</button>
        )}
      </div>
    )
  }

  return (
    <div className={shell}>
      {manualCount > 0 ? (
        // 结论已全部确认，但本栏剩这批：画面模糊/曝光异常不在复核范围，只能人工裁定，不能一句“已结案”带过
        <span className="text-sm text-fg2">
          <strong className="text-base font-bold text-fg tabular-nums">{manualCount}</strong> 张待人工裁定画质
          <span className="text-xs text-fg3 ml-2.5">画面模糊、曝光异常不在云端复核范围内，请点卡片左上角红标人工确认</span>
        </span>
      ) : judgedCount > 0 && unjudgedCount === 0 ? (
        <span className="text-sm text-fg2">
          本栏 <strong className="text-base font-bold text-fg tabular-nums">{judgedCount}</strong> 张已完成云端复核
          <span className="text-xs text-fg3 ml-2.5">复核项：人数归属、闭眼、半截头、表情；画质维度由本地引擎判定</span>
        </span>
      ) : (
        <span className="text-sm text-fg2">
          将本栏<strong className="font-semibold text-fg">尚未复核</strong>的照片提交云端二次核验
          <span className="text-xs text-fg3 ml-2.5">仅生成结论，经确认后方写回标签与归属</span>
        </span>
      )}
      {unjudgedCount === 0 ? (
        rerunnable > 0 && <button className="btn-warn text-sm px-3.5 py-1.5 whitespace-nowrap" onClick={() => setConfirmRerun(true)} title="再次 AI 复审：重判本栏尚未结案的照片（含不采纳过的与判过没表态的；已采纳、转人工裁定与待归档的自动跳过），重新消耗今日额度">再次AI复审</button>
      ) : (
        <button className="btn-primary text-sm px-3.5 py-1.5 whitespace-nowrap" onClick={() => void startAiReview(scope)} title="AI 复审（会员专属，计入每日额度）：逐张复核本栏尚未结案的照片（没判过的与此前不采纳的），已采纳过或点过「确认采纳」的不重复提交">立即复审</button>
      )}
    </div>
  )
}
