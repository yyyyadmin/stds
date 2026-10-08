/** 生成测试图片：模糊/过曝/欠曝/黑白/重复连拍/正常，供端到端冒烟 */
const sharp = require('sharp')
const fs = require('fs')
const path = require('path')
const dir = path.join(__dirname, '..', 'test-photos')
fs.mkdirSync(dir, { recursive: true })

const base = (hue) => Buffer.from(
  `<svg width="800" height="600"><rect width="800" height="600" fill="hsl(${hue},70%,55%)"/>` +
  Array.from({ length: 40 }, (_, i) => `<circle cx="${(i * 97) % 800}" cy="${(i * 151) % 600}" r="${20 + (i % 5) * 10}" fill="hsl(${(hue + i * 23) % 360},80%,${30 + (i % 7) * 8}%)"/>`).join('') +
  `<text x="40" y="80" font-size="48" fill="white">TEST ${hue}</text></svg>`, 'utf-8')

;(async () => {
  const jobs = [
    ['normal_color.jpg', (c) => c],
    ['blurry.jpg', (c) => c.blur(12)],
    ['overexposed.jpg', (c) => c.linear(1.8, 60)],
    ['underexposed.jpg', (c) => c.linear(0.3, -40)],
    ['blackwhite.png', (c) => c.grayscale()],
    ['dup_a.jpg', (c) => c],
    ['dup_b.jpg', (c) => c],
    ['normal2.jpg', (c) => c]
  ]
  for (const [name, fn] of jobs) {
    const hue = name.includes('2') ? 200 : name.startsWith('dup') ? 300 : parseInt(name.replace(/\D/g, '')) || 30
    let img = sharp(base(name.startsWith('dup') ? 300 : hue))
    img = fn(img)
    await img.jpeg({ quality: 90 }).toFile(path.join(dir, name))
  }
  console.log('OK:', fs.readdirSync(dir).join(', '))
})()
