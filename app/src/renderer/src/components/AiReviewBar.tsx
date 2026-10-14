/**
 * 页内「AI 复审」复核条：只挂在「待确认」「瑕疵片」两页列表顶部，作为内容区的固定行（不随列表滚动）。
 *
 * 两个按钮的语义不同：蓝色「立即复审」只提交尚未复核的照片（不重复消耗额度）；
 * 橙色「再次AI复审」则重判本栏除已转人工裁定 / 待归档之外的全部照片（含既往已复核与不予采纳的）。
 * 上一版橙色漏掉“已复核但无分歧”的照片，导致那张既不在结论列表也不在复核队列（用户实测抓到）。
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
 * 五态互斥：运行中 → 就地反馈 → 额度确认 → 结论待确认 → 空闲（含“全部已结案”与“仅剩人工裁定”）
 */
import { useState } from 'react'
import { useStore, hasAiReviewDiff, hasAiReviewAction, aiReviewShouldHome, needsManualReview } from '../store'
import { isTrashLike } from '../../../shared/types'
import type { AiReviewScope } from '../../../shared/types'

export default function AiReviewBar(): JSX.Element | null {
  const activeCategory = useStore((s) => s.activeCategory)
  const aiReview = useStore((s) => s.aiReview)
  const images = useStore((s) => s.images)
  const startAiReview = useStore((s) => s.startAiReview)
  const stopAiReview = useStore((s) => s.stopAiReview)
  const reopenSummary = useStore((s) => s.reopenAiReviewSummary)
  const feedback = useStore((s) => s.aiReviewFeedback)
  const [confirmRerun, setConfirmRerun] = useState(false)

  // 只在待确认 / 瑕疵片两页出现，且本页作用域就是当前分类
  if (activeCategory !== 'review' && activeCategory !== 'flaws') return null
  const scope: AiReviewScope = activeCategory
  const running = !!aiReview?.running && (aiReview?.scope ?? 'review') === scope
  // 本页可参与复审的图（废弃类不算）
  const inScope = images.filter((i) => !isTrashLike(i.category))
  const judgedCount = inScope.filter((i) => !!i.ai_review).length
  const unjudgedCount = inScope.length - judgedCount
  // 等你表态的：有分歧的（按 AI 改）+ 与本地一致的（确认保留）+ 已结案但该归位的（一键搬出待确认），一个都不能漏（用户 10-14 拍板）
  const pendingCount = inScope.filter((i) => hasAiReviewAction(i)).length
  const diffCount = inScope.filter((i) => hasAiReviewDiff(i)).length
  // 已转人工定画质的：AI 复审帮不上、排在本栏最前的那批
  const manualCount = inScope.filter((i) => needsManualReview(i)).length
  // 已复核干净、只差一个归位动作的（存量手动停泊的干净图）：重跑它也不会变干净，不列进复审
  const homeCount = inScope.filter((i) => aiReviewShouldHome(i)).length
  const rerunnable = inScope.length - manualCount - homeCount
  // 一致 = 总数 - 有分歧 - 等你归位（夹 0：极少数“已结案又手动改回标签”的图会同时占两个桶，不能报负数）
  const agreeCount = Math.max(0, pendingCount - diffCount - homeCount)

  // 固定行（在滚动容器外）：实底背景 + 下分隔线，天然顶满整行两边，不需要 sticky/负 margin
  // 字号（用户 10-14：“字这些都大点，看不清”）：主句 text-base、行内补充说明 text-sm、按钮 text-base + 加大内边距
  const shell = 'shrink-0 flex items-center justify-center gap-4 border-b border-line bg-panel px-5 py-3'

  if (running) {
    return (
      <div className={shell}>
        <span className="inline-flex items-center gap-2.5 text-base text-fg2 tabular-nums whitespace-nowrap">
          <span className="inline-block w-4 h-4 shrink-0 rounded-full border-2 border-brand border-t-transparent animate-spin" />
          云端复核进行中 {aiReview?.done ?? 0}/{aiReview?.total ?? 0}
        </span>
        <button className="btn text-base px-5 py-2 whitespace-nowrap" onClick={() => void stopAiReview()} title="中止复核：在当前张停止，已生成的结论保留">
          停止
        </button>
      </div>
    )
  }

  // 就地反馈（点击后未启动成功）：优先于其它态显示，带手动收起入口，6 秒后 store 自动清
  if (feedback && !running) {
    return (
      <div className={shell}>
        <span className="text-base font-semibold text-orange-400">{feedback}</span>
        <button className="btn text-base px-5 py-2 whitespace-nowrap" onClick={() => useStore.setState({ aiReviewFeedback: null })}>知道了</button>
      </div>
    )
  }

  // 用户点了橙色“再次AI复审”：先给应用内额度确认（不走 window.confirm），说清重判范围与跳过项
  if (confirmRerun) {
    return (
      <div className={shell}>
        <span className="text-base text-orange-400">
          本次将重判 <strong className="font-semibold">{rerunnable}</strong> 张{manualCount + homeCount > 0 ? `，已转人工裁定的 ${manualCount} 张与待归档的 ${homeCount} 张自动跳过` : ''}，将消耗今日额度，是否继续？
        </span>
        <button className="btn text-base px-5 py-2 whitespace-nowrap" onClick={() => setConfirmRerun(false)}>取消</button>
        <button className="btn-warn text-base px-5 py-2 whitespace-nowrap" onClick={() => { setConfirmRerun(false); void startAiReview(scope, true) }} title="提交全量重判：含既往已复核与不予采纳的照片，消耗今日额度">确认复核</button>
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
        <span className="text-base text-fg2">
          <strong className="text-xl font-bold text-fg tabular-nums">{pendingCount}</strong> 张复核结论待确认
          {parts.length > 0 && <span className="text-sm text-fg3 ml-3 tabular-nums">{parts.join(' · ')}</span>}
        </span>
        <button className="btn-primary text-base px-5 py-2 whitespace-nowrap" onClick={reopenSummary} title="打开本轮复核结果，逐项比对后可单张或批量应用">
          查看复核结论 ({pendingCount})
        </button>
        {rerunnable > 0 && (
          <button className="btn-warn text-base px-5 py-2 whitespace-nowrap" onClick={() => setConfirmRerun(true)} title="再次 AI 复审：全量重判本栏照片（已转人工裁定与待归档项除外），重新消耗今日额度">再次AI复审</button>
        )}
      </div>
    )
  }

  return (
    <div className={shell}>
      {manualCount > 0 ? (
        // 结论已全部确认，但本栏剩这批：画面模糊/曝光异常不在复核范围，只能人工裁定，不能一句“已结案”带过
        <span className="text-base text-fg2">
          <strong className="text-xl font-bold text-fg tabular-nums">{manualCount}</strong> 张待人工裁定画质
          <span className="text-sm text-fg3 ml-3">画面模糊、曝光异常不在云端复核范围内，请点卡片左上角红标人工确认</span>
        </span>
      ) : judgedCount > 0 && unjudgedCount === 0 ? (
        <span className="text-base text-fg2">
          本栏 <strong className="text-xl font-bold text-fg tabular-nums">{judgedCount}</strong> 张已完成云端复核
          <span className="text-sm text-fg3 ml-3">复核项：人数归属、闭眼、半截头、表情；画质维度由本地引擎判定</span>
        </span>
      ) : (
        <span className="text-base text-fg2">
          将本栏<strong className="font-semibold text-fg">尚未复核</strong>的照片提交云端二次核验
          <span className="text-sm text-fg3 ml-3">仅生成结论，经确认后方写回标签与归属</span>
        </span>
      )}
      {unjudgedCount === 0 ? (
        rerunnable > 0 && <button className="btn-warn text-base px-5 py-2 whitespace-nowrap" onClick={() => setConfirmRerun(true)} title="再次 AI 复审：全量重判本栏照片（已转人工裁定与待归档项除外），重新消耗今日额度">再次AI复审</button>
      ) : (
        <button className="btn-primary text-base px-5 py-2 whitespace-nowrap" onClick={() => void startAiReview(scope)} title="AI 复审（会员专属，计入每日额度）：逐张复核本栏尚未提交的照片，已结案项不重复">立即复审</button>
      )}
    </div>
  )
}
