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
 * 自动档分档：以 4K 台式机上验证过的观感为 100% 基准，窗口越窄缩得越多。
 * 阈值取自实测的两台机器：Mac M1 笔记本全屏 1440（嫌字大图小）、Windows 台式 4K 全屏 2560（正好）。
 * 拖动窗口/进全屏会自动重新选档（App.tsx 里防抖监听 resize）。
 *
 * 注意：传进来的宽度是**缩放生效后的有效宽度**（zoom 后 innerWidth 会变），所以这里选的
 * 是"固定点"——每个档自己的有效宽度必须落在同一档的区间里，否则会在两档间来回弹：
 *  - <1600 → 0.85：有效宽 = 原宽/0.85 ∈ [原宽, 1.176×原宽)，原宽<1360 时有效宽<1600 自洽；
 *    原宽 1360~1600 会被推到 0.9 档，再验证 0.9 自洽（1511~1778 落在 [1600,2000)）；
 *  - [1600,2000) → 0.9：有效宽 ∈ [1778, 2222)，其中 [2000,2222) 会升 1.0 档，1.0 不再变——
 *    即 1800~2000 宽的窗口最终稳定在 100%，相当于"窗口够宽就不缩"，行为合理；
 *  - ≥2000 → 1.0：有效宽=原宽，永远自洽。
 */
export function autoUiScaleFactor(cssWidth: number): number {
  if (cssWidth < 1600) return 0.85
  if (cssWidth < 2000) return 0.9
  return 1
}

/** 当前设置对应的倍率：auto 按当前（有效）窗口宽度算，手动档钉死 */
export function effectiveUiScale(v: UiScaleSetting | undefined, cssWidth: number): number {
  return !v || v === 'auto' ? autoUiScaleFactor(cssWidth) : uiScaleFactorOf(v)
}
