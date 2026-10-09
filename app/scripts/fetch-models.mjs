#!/usr/bin/env node
/**
 * fetch-models.mjs —— 拉取开源 ONNX 权重到 ai-engine/models/，让引擎从"规则降级模式"
 * 升级为"深度学习完整模式"（准确度是本项目核心，见 ai-engine/models/README.md）。
 *
 * 设计原则：
 *  - 只下载"开源可商用 + URL 稳定 + 与引擎输入契约匹配"的权重，绝不臆造地址。
 *  - 已存在且非空则跳过（--force 强制重下）。
 *  - 下载失败**硬失败**（exit 1），避免 CI 静默产出降级引擎（历史教训：静默降级=灾难）。
 *  - build-engine.mjs 会自动把 ai-engine/models/*.onnx 打进安装包 resources/engine/models。
 *
 * 用法：
 *   node scripts/fetch-models.mjs            # 下载缺失的权重
 *   node scripts/fetch-models.mjs --force    # 强制重下全部
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_DIR = resolve(__dirname, '..', '..')
const MODELS_DIR = join(REPO_DIR, 'ai-engine', 'models')

/**
 * 默认清单：YuNet（人脸检测）+ EfficientDet-Lite0（人体检测）。YuNet 是精度收益最大、体积最小(~228KB)、许可最干净(MIT)、
 * URL 最稳定(opencv_zoo 官方)的人脸权重；引擎 face.py 的 yunet_path() 直接匹配 face_detection_yunet*。
 * EfficientDet-Lite0(Apache-2.0, ~4.6MB int8) 供 engine/person.py ObjectDetector 数人体，人数分类从数脸升级为数体。
 * 两者 URL 均为官方稳定存储（opencv_zoo / Google storage），非已停用的 ONNX Model Zoo LFS。
 *
 * 人脸框精度是 半截头/双人/闭眼/斜眼/狰狞 全部维度的上游，换掉 Haar 即整体跃升。
 *
 * 其余维度（OCEC 闭眼 / MobileGaze 视线 / FER 表情 / ArcFace embedding）的开源 ONNX 缺乏
 * "URL 稳定 + 输入契约(224/24 RGB) 匹配"的权威来源，不在此自动下载；获取后手动放入 models/
 * 即可被引擎按文件名关键字自动识别（见 README.md）。
 */
const MANIFEST = [
  {
    file: 'face_detection_yunet_2023mar.onnx',
    url: 'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
    license: 'MIT',
    unlocks: '人脸检测 Haar→YuNet(DNN)：半截头/双人/闭眼/斜眼/狰狞 的人脸框与关键点精度整体跃升'
  },
  {
    file: 'efficientdet_lite0.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite',
    license: 'Apache-2.0',
    unlocks: '人体检测(MediaPipe ObjectDetector)：单人/多人/无人物 人数分类权威从数人脸切换为数人体，根治背对/侧脸/面纱漏检导致的 undercount'
  }
  // 注意：不要把 onnx/models（ONNX Model Zoo）的 /raw/ 地址加进来——该仓库已于 2025-07-01 起
  // 停用 Git LFS 下载，/raw/ 只会返回 ~130B 的 LFS 指针文本，触发本脚本 <1024B 守卫而硬失败，
  // 进而让整个 CI 构建产不出安装包。FER/OCEC/MobileGaze/ArcFace 若要启用，请手动下载后放入
  // ai-engine/models/（引擎按文件名关键字自动识别），详见 models/README.md。
]

const force = process.argv.includes('--force')

async function download(entry) {
  const dest = join(MODELS_DIR, entry.file)
  if (!force && existsSync(dest) && statSync(dest).size > 0) {
    console.log(`⏭  已存在，跳过：${entry.file} (${statSync(dest).size} bytes)`)
    return
  }
  console.log(`⬇  下载 ${entry.file} …`)
  console.log(`   ${entry.url}`)
  const res = await fetch(entry.url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${entry.url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 1024) throw new Error(`下载内容过小(${buf.length}B)，疑似错误页面：${entry.url}`)
  mkdirSync(MODELS_DIR, { recursive: true })
  writeFileSync(dest, buf)
  console.log(`✅ ${entry.file} (${buf.length} bytes, ${entry.license})`)
  console.log(`   解锁：${entry.unlocks}`)
}

async function main() {
  console.log(`模型目录：${MODELS_DIR}\n`)
  for (const entry of MANIFEST) {
    try {
      await download(entry)
    } catch (e) {
      console.error(`\n❌ 下载失败：${entry.file}\n   ${String(e && e.message ? e.message : e)}`)
      console.error('   权重缺失将导致引擎降级为 Haar+规则（精度不足）。请检查网络后重试，或手动下载放入 models/。')
      process.exit(1)
    }
  }
  console.log('\n完成。运行 `npm run build:engine` 会把 models/*.onnx 打进安装包。')
}

main()
