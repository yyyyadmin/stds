/**
 * 「待确认」「瑕疵片」行内的 AI 复审运行态小字（挂在标签文字后、数字前）。
 *
 * 位置与字号对齐「交付库」行后的「导出」两字（10px 中等字重、贴基线偏下一点），
 * 只是颜色换成品牌蓝、并且不可点——它只报状态，动作在顶栏开关和页顶复审条上。
 * 平时一个字都不显示：只有本轮复审的作用域正是这一栏、且真的在跑，才出现「AI 复审中 x/y」，跑完自动消失。
 */
import { useStore } from '../store'
import type { AiReviewScope } from '../../../shared/types'

export default function AiReviewTag(props: { scope: AiReviewScope }): JSX.Element | null {
  const aiReview = useStore((s) => s.aiReview)
  if (!aiReview?.running || (aiReview.scope ?? 'review') !== props.scope) return null
  return (
    <span
      className="shrink-0 self-start text-[10px] font-medium text-brand translate-y-[3px] -ml-0.5 whitespace-nowrap tabular-nums"
      title="云端复核在后台执行，切换分类不中断；停留在本栏时可由页顶复核条中止"
    >
      云端复核中 {aiReview.done}/{aiReview.total}
    </span>
  )
}
