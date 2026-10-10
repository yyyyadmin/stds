/**
 * 下拉/弹层的「点外面就关」通用行为。
 * 用户预期：面板打开后，任何别处的点击（选别的图、点别的按钮、点空白）都算“我不做了”，
 * 面板必须自动收起，而不是逼着去找「✕ 收起」。
 * 用 pointerdown + capture：早于 React onClick 关闭，且不会被父容器的 overflow/stopPropagation 吃掉；
 * 事件继续向下传播，所以“点别的图片”既关掉面板也照常选中那张图。
 */
import { useEffect, type RefObject } from 'react'

export function useOutsideClose(
  open: boolean,
  onClose: () => void,
  // 面板与触发按钮都不算“外面”
  ...refs: Array<RefObject<HTMLElement | null> | null | undefined>
): void {
  useEffect(() => {
    if (!open) return
    const onDown = (e: Event): void => {
      const t = e.target as Node | null
      if (!t) return
      for (const r of refs) if (r?.current?.contains(t)) return
      onClose()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose])
}
