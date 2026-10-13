/**
 * 侧栏导航图标：16×16 视框、stroke=currentColor，实际按 12px 画。
 *
 * 为什么不用 emoji（👁 ◎ ☀ 这类）：Windows 的 Segoe UI Emoji 会把它们当彩色位图渲染，
 * 既盖不掉系统自己的颜色（我们按维度分配的 7 色就用不上了），也不随浅色/暗夜主题变。
 * SVG 走 currentColor 才能跟左侧同一套语义色绑定，真正实现「颜色 + 图形」双编码——
 * 色弱用户（红绿色盲约占男性 8%）靠形状也能把闭眼/模糊/曝光分开，而不是只靠颜色。
 *
 * 为什么不引图标库：整个应用零图标依赖，为 16 个形状装一个包不值。形状全写在这里，
 * 改一处全栏生效；认不出来的名字统一落到 dot，宁可退化成圆点也不要出现空白或崩溃。
 */
import type { ReactNode } from 'react'

/** key = 维度 key（与 DIMENSION_LABELS 同名）或特殊桶名 */
const SHAPES: Record<string, ReactNode> = {
  all: (
    <>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </>
  ),
  library: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M5.2 8.2l2 2 3.6-4.3" />
    </>
  ),
  review: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M6.3 6.1a1.8 1.8 0 1 1 2.5 1.7c-.6.3-.9.7-.9 1.3v.3" />
      <path d="M8 12.3v.01" />
    </>
  ),
  /* 帮助问号：圆圈 + 问号，分组标题行悬停看详细说明（与 review 的“待确认”区分，笔画更标准）*/
  help: (
    <>
      <circle cx="8" cy="8" r="6.4" />
      <path d="M6.1 6.2a2 2 0 1 1 2.9 1.8c-.7.4-1 .85-1 1.5v.2" />
      <path d="M7.9 12.2v.02" />
    </>
  ),
  /* 闭眼：下弯的上睑弧线 + 三根下垂睫毛（早期用“眼廓 + 一条横线”，12px 下读成禁止标志）*/
  eyes_closed: (
    <>
      <path d="M2.5 6.8c1.6 2.6 3.5 3.9 5.5 3.9s3.9-1.3 5.5-3.9" />
      <path d="M4.6 9.4l-.6 1.8M8 11.5v1.9M11.4 9.4l.6 1.8" />
    </>
  ),
  /* 斜眼：同样的眼廓，瞳孔挪到右上角 */
  eyes_side: (
    <>
      <path d="M1.8 8S4.2 3.8 8 3.8 14.2 8 14.2 8 11.8 12.2 8 12.2 1.8 8 1.8 8z" />
      <circle cx="10.3" cy="6.9" r="1.5" fill="currentColor" stroke="none" />
    </>
  ),
  /* 面部狰狞：圆脸 + 两只 X 眼 + 下撇的嘴 */
  face_ugly: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M4.5 5.8l1.6 1.6M6.1 5.8l-1.6 1.6" />
      <path d="M9.9 5.8l1.6 1.6M11.5 5.8l-1.6 1.6" />
      <path d="M5.4 11.6c.7-.9 1.6-1.3 2.6-1.3s1.9.4 2.6 1.3" />
    </>
  ),
  /* 画面模糊：两个错位的重影圆（早期用“圆 + 右侧两道弧”，12px 下读成音量图标） */
  blur: (
    <>
      <circle cx="6.6" cy="8" r="4.2" />
      <circle cx="9.8" cy="8" r="4.2" strokeOpacity={0.45} />
    </>
  ),
  /* 曝光异常：太阳（与用户提的 ☀ 同形） */
  exposure: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.4v1.9M8 12.7v1.9M1.4 8h1.9M12.7 8h1.9M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M12.7 3.3l-1.4 1.4M4.7 11.3l-1.4 1.4" />
    </>
  ),
  /* 半截头：相框压住半个头 */
  half_head: (
    <>
      <rect x="2" y="2" width="12" height="12" rx="1.5" />
      <circle cx="3.4" cy="8" r="3" />
    </>
  ),
  /* 重复/连拍：两个叠放的框 */
  duplicate: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.6H4.1A1.6 1.6 0 0 0 2.5 5.2v6.4" />
    </>
  ),
  /* 单人照：一个人 */
  single_person: (
    <>
      <circle cx="8" cy="5.4" r="2.4" />
      <path d="M3.4 13.6c.5-2.7 2.4-4 4.6-4s4.1 1.3 4.6 4" />
    </>
  ),
  /* 多人合拍照：两个人并排、同一基线（“成排”是合影的图形语义） */
  group_photo: (
    <>
      <circle cx="5.9" cy="5.6" r="2.2" />
      <path d="M1.9 13.4c.4-2.4 2.1-3.6 4-3.6s3.6 1.2 4 3.6" />
      <circle cx="11.5" cy="6.4" r="1.7" />
      <path d="M10.7 10.1c1.8.1 3.1 1.3 3.5 3.3" />
    </>
  ),
  /* 多人混合照：三颗头前后错落、不在一排（与合拍照「并排同基线」刻意拉开：
     一个说“人在摆拍”，一个说“人各干各的事”——接亲、做游戏那种情节片）*/
  mixed_photo: (
    <>
      <circle cx="3.6" cy="3.8" r="1.7" />
      <circle cx="11.8" cy="5.4" r="2" />
      <circle cx="7.2" cy="8.6" r="2.3" />
      <path d="M4.6 14.4c.4-1.9 1.5-3 3-3 1.6 0 2.8 1.1 3.2 3" />
    </>
  ),
  /* 无人物场景：山景照片（有画面、没有人） */
  no_person: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <circle cx="5.6" cy="6" r="1.2" />
      <path d="M2.7 12.3l3.2-3.5 2.4 2.6 2.2-2.5 3 3.4" />
    </>
  ),
  /* 黑白照：半明半暗的对比圆 */
  black_white: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor" stroke="none" />
    </>
  ),
  trash: (
    <>
      <path d="M2.6 4.4h10.8" />
      <path d="M5.8 4.4V3.1A1.1 1.1 0 0 1 6.9 2h2.2a1.1 1.1 0 0 1 1.1 1.1v1.3" />
      <path d="M4.2 4.4l.8 8.3a1.5 1.5 0 0 0 1.5 1.4h3a1.5 1.5 0 0 0 1.5-1.4l.8-8.3" />
    </>
  ),
  /* 重复/连拍-废弃：叠框 + 一道斜杠 */
  dup_trash: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.6H4.1A1.6 1.6 0 0 0 2.5 5.2v6.4" />
      <path d="M1.6 1.6l12.8 12.8" />
    </>
  ),
  folder: (
    <path d="M1.8 4.3a1.2 1.2 0 0 1 1.2-1.2h2.9l1.5 1.8h5.6a1.2 1.2 0 0 1 1.2 1.2v6.7a1.2 1.2 0 0 1-1.2-1.2H3a1.2 1.2 0 0 1-1.2-1.2z" />
  ),
  dot: <circle cx="8" cy="8" r="2.6" fill="currentColor" stroke="none" />
}

/** color 省略时继承行内文字色（选中态会跟着变品牌色） */
export function NavIcon(props: { name: string; color?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      className="w-3 h-3 shrink-0"
      style={props.color ? { color: props.color } : undefined}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {SHAPES[props.name] ?? SHAPES.dot}
    </svg>
  )
}
