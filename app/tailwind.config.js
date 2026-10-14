/** @type {import('tailwindcss').Config} */
// 颜色全部走 CSS 变量（rgb 通道三元组，支持 /alpha 修饰符），
// 由 index.css 中 :root（简白，默认）与 [data-theme="dark"]（暗夜）切换。
const rgb = (v) => `rgb(var(${v}) / <alpha-value>)`

module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // 3xl（1760px）：顶栏「完整模式」门槛。1920 台式机去掉任务栏后约 1900 CSS px 能进这一档，
      // 而笔记本常见 1366/1440 物理宽再叠加 125%~150% 缩放只有 1000~1300 CSS px，
      // 走紧凑模式（次要动作收进「⋯ 更多」、视图按钮只留图标），避免顶栏被挤变形。
      screens: {
        '3xl': '1760px'
      },
      colors: {
        // 【坑】页面底色这个令牌叫 canvas，不能叫 base：Tailwind 自带 text-base（字号 16px），
        // 一旦颜色表里有 base，text-base 就被当作颜色工具（文字色=页面底色），
        // 浅色主题下白底白字、暗色主题下黑底黑字，按钮字直接消失（用户 10-14 实测抓到）。
        canvas: rgb('--c-base'),
        panel: rgb('--c-panel'),
        panel2: rgb('--c-panel2'),
        line: rgb('--c-line'),
        fg: rgb('--c-fg'),
        fg2: rgb('--c-fg2'),
        fg3: rgb('--c-fg3'),
        brand: rgb('--c-brand'),
        warn: rgb('--c-warn'),
        bad: rgb('--c-bad'),
        good: rgb('--c-good'),
        // 兼容既有 text-gray-* 用法：重映射为语义令牌，随主题自动切换
        gray: {
          100: rgb('--c-fg'),
          200: rgb('--c-fg'),
          300: rgb('--c-fg'),
          400: rgb('--c-fg2'),
          500: rgb('--c-fg3'),
          600: rgb('--c-fg3'),
          700: rgb('--c-fg3'),
          800: rgb('--c-fg3'),
          900: rgb('--c-fg3')
        },
        slate: {
          100: rgb('--c-fg'),
          200: rgb('--c-fg'),
          300: rgb('--c-fg'),
          400: rgb('--c-fg2'),
          500: rgb('--c-fg3'),
          600: rgb('--c-fg3')
        }
      }
    }
  },
  plugins: []
}
