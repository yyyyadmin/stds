/** @type {import('tailwindcss').Config} */
// 颜色全部走 CSS 变量（rgb 通道三元组，支持 /alpha 修饰符），
// 由 index.css 中 :root（简白，默认）与 [data-theme="dark"]（暗夜）切换。
const rgb = (v) => `rgb(var(${v}) / <alpha-value>)`

module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        base: rgb('--c-base'),
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
