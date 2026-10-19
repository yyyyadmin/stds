/**
 * 界面缩放（整屏等比例缩放）的档位与换算。
 *
 * 为什么需要：软件里文字/按钮/标签/格子全是固定像素，4K 大屏一行 14 格看着清爽，
 * 1440 宽的笔记本一行只剩 8 格，同一套字号就显得"字大、图小、标签挤不下"。
 * 做法不是重排布局，而是借 Chromium 的整页缩放（浏览器 Ctrl+/Ctrl- 同款）：
 * 文字、按钮、标签、格子按同一倍率一起缩，比例关系跟大屏上一模一样。
 *
 * 倍率由渲染层算、主进程执行（window.api.setUiZoom → webContents.setZoomFactor）：
 * 缩放后 window.innerWidth 等坐标体系自动变成"有效 CSS px"，弹层定位/框选/拖拽代码无需改动。
 */
import type { AppSettings } from '../../shared/types'

export type UiScaleSetting = NonNullable<AppSettings['uiScale']>

/** 设置下拉的可选项（'auto' 单独走自动判定，不钉死） */
export const UI_SCALE_OPTIONS: UiScaleSetting[] = ['auto', '80%', '85%', '90%', '100%']

/** 手动档：百分号字符串 → 倍率 */
export function uiScaleFactorOf(v: Exclude<UiScaleSetting, 'auto'>): number {
  return parseInt(v, 10) / 100
}

/**
 * 自动档判定的基准宽度：用屏幕物理分辨率 window.screen.width，而不是窗口 innerWidth。
 *
 * 【为什么不能用 innerWidth（曾经的 bug）】：setZoomFactor 会改变 innerWidth（缩放后有效宽度
 * = 原宽 ÷ 倍率），而自动档又拿这个宽度去选倍率——形成自我反馈环。物理宽约 1360~1440 的窗口
 * （Mac M1 就卡在这）会 0.85→0.9→0.85 来回跳：0.85 档算出有效宽 1600 落进 0.9 区，0.9 档又算出
 * 1511 落回 0.85 区，软件一打开界面就一会儿大一会儿小地抖。
 * screen.width 是显示器 DIP 分辨率，不受网页缩放影响，拿它当基准这个反馈环就断了。
 * 窗口拖到另一块屏时 screen.width 会变，resize 监听据此重新选档（仍不会再自激）。
 */
export function autoScaleBaseWidth(): number {
  return typeof window !== 'undefined' ? window.screen.width : 1920
}

/**
 * 自动档分档：以 4K 台式机上验证过的观感为 100% 基准，屏幕越小缩得越多。
 * 阈值取自实测两台机器的屏幕物理分辨率：Mac M1 笔记本屏 1440（嫌字大图小）、
 * Windows 台式 4K 常用逻辑分辨率 2560（正好）。
 */
export function autoUiScaleFactor(screenWidth: number): number {
  if (screenWidth < 1600) return 0.85
  if (screenWidth < 2000) return 0.9
  return 1
}

/** 当前设置对应的倍率：auto 按屏幕物理分辨率算，手动档钉死 */
export function effectiveUiScale(v: UiScaleSetting | undefined): number {
  return !v || v === 'auto' ? autoUiScaleFactor(autoScaleBaseWidth()) : uiScaleFactorOf(v)
}
