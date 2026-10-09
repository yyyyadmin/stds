#!/usr/bin/env node
/**
 * build-engine.mjs —— 把 ai-engine 打成自包含可执行引擎（PyInstaller onedir）
 *
 * 目标（需求⑨）：让每台设备（Windows / macOS）无需安装 Python，装上安装包即自动升级
 * 到完整 12 维检测。本脚本在「有 Python 3.9+ 的构建机 / CI」上运行，产物复制到
 * app/engine-dist/<platform>/，随后 electron-builder 会把它打进安装包的 resources/engine。
 *
 * 用法：
 *   node scripts/build-engine.mjs            # 当前平台
 *   node scripts/build-engine.mjs --clean     # 先清理旧产物与临时目录
 *   AI_ENGINE_PYTHON=.../python  node scripts/build-engine.mjs
 *
 * 步骤：
 *   1) 定位 Python（env AI_ENGINE_PYTHON > python3 > python）
 *   2) 建/复用虚拟环境 .venv-engine，装 requirements.txt + pyinstaller
 *   3) 在 ai-engine 下跑 pyinstaller engine.spec --noconfirm
 *   4) 把 dist/screener-engine/* 复制到 app/engine-dist/<platform>/
 *   5) 附带 models/ 目录（含 README），用户放 ONNX 权重即提精度，无需重新打包
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_DIR = resolve(__dirname, '..')
const REPO_DIR = resolve(APP_DIR, '..')
const ENGINE_SRC = join(REPO_DIR, 'ai-engine')

const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'
const exeName = platform === 'win' ? 'screener-engine.exe' : 'screener-engine'
const outDir = join(APP_DIR, 'engine-dist', platform)
const clean = process.argv.includes('--clean')

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd, env: process.env })
  if (r.status !== 0) {
    console.error(`命令失败（exit ${r.status}）：${cmd} ${args.join(' ')}`)
    process.exit(r.status || 1)
  }
}

function findPython() {
  const candidates = []
  if (process.env.AI_ENGINE_PYTHON) candidates.push(process.env.AI_ENGINE_PYTHON)
  candidates.push(platform === 'win' ? 'python' : 'python3', 'python3.12', 'python3.11', 'python3.10', 'python3.9', 'python')
  for (const p of candidates) {
    const r = spawnSync(p, ['--version'], { encoding: 'utf-8' })
    const out = (r.stdout || '') + (r.stderr || '')
    if (r.status === 0 && /Python 3\.\d+/.test(out)) {
      console.log(`使用 Python：${p}（${out.trim()}）`)
      return p
    }
  }
  console.error('未找到 Python 3.9+。请在构建机安装 Python，或设置环境变量 AI_ENGINE_PYTHON 指向解释器。')
  process.exit(1)
}

const py = findPython()
const venvDir = join(ENGINE_SRC, '.venv-engine')
const venvPy = platform === 'win' ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', 'python')

if (clean) {
  console.log('清理旧产物…')
  rmSync(join(ENGINE_SRC, 'dist'), { recursive: true, force: true })
  rmSync(join(ENGINE_SRC, 'build'), { recursive: true, force: true })
  rmSync(outDir, { recursive: true, force: true })
}

// 1) 虚拟环境（隔离依赖，避免污染系统 Python）
if (!existsSync(venvPy)) {
  console.log('创建虚拟环境 .venv-engine…')
  run(py, ['-m', 'venv', venvDir])
}
const P = venvPy

// 2) 依赖 + PyInstaller
console.log('安装引擎依赖与 PyInstaller…')
run(P, ['-m', 'pip', 'install', '--upgrade', 'pip'])
run(P, ['-m', 'pip', 'install', '-r', join(ENGINE_SRC, 'requirements.txt')])
// 可选：尽力安装 mediapipe（失败仅告警，不阻断构建——引擎回落 YuNet）
console.log('尝试安装可选依赖 mediapipe（失败可忽略，将回落 YuNet）…')
const mp = spawnSync(P, ['-m', 'pip', 'install', '-r', join(ENGINE_SRC, 'requirements-optional.txt')], { stdio: 'inherit', env: process.env })
if (mp.status !== 0) {
  console.warn('⚠️ mediapipe 安装失败：本平台将回落 YuNet（不影响构建成功）。')
}
run(P, ['-m', 'pip', 'install', 'pyinstaller>=6.0'])

// 3) PyInstaller 打包（onedir）
console.log('PyInstaller 打包中（首次较慢，请耐心等待）…')
run(P, ['-m', 'PyInstaller', 'engine.spec', '--noconfirm'], { cwd: ENGINE_SRC })

// 4) 复制到 app/engine-dist/<platform>/
const distEngine = join(ENGINE_SRC, 'dist', 'screener-engine')
if (!existsSync(distEngine)) {
  console.error(`未找到打包产物：${distEngine}（请检查 engine.spec 是否成功）`)
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })
console.log(`复制 ${distEngine}/* → ${outDir}`)
for (const item of readdirSync(distEngine)) {
  cpSync(join(distEngine, item), join(outDir, item), { recursive: true })
}

// 5) 附带 models/（外部权重目录，用户放 ONNX 即提精度，无需重新打包）
const outModels = join(outDir, 'models')
mkdirSync(outModels, { recursive: true })
const srcModelsReadme = join(ENGINE_SRC, 'models', 'README.md')
if (existsSync(srcModelsReadme)) cpSync(srcModelsReadme, join(outModels, 'README.md'))
// 复制仓库里已有的任何 onnx 权重（若有）
const srcModels = join(ENGINE_SRC, 'models')
for (const f of existsSync(srcModels) ? readdirSync(srcModels) : []) {
  if (f.toLowerCase().endsWith('.onnx')) cpSync(join(srcModels, f), join(outModels, f))
}
// 复制仓库里的 MediaPipe 权重（.task），随 models/ 分发
for (const f of existsSync(srcModels) ? readdirSync(srcModels) : []) {
  if (f.toLowerCase().endsWith('.task')) cpSync(join(srcModels, f), join(outModels, f))
}
// 复制仓库里的 MediaPipe 人体模型（.tflite），随 models/ 分发
for (const f of existsSync(srcModels) ? readdirSync(srcModels) : []) {
  if (f.toLowerCase().endsWith('.tflite')) cpSync(join(srcModels, f), join(outModels, f))
}
// 硬校验：YuNet 人脸权重必须随包（已入库）。缺失说明构建未取到仓库文件，
// 绝不能打包成人脸退化为 haar 的残缺版本（会导致无人物照/半截头等人脸维度全废）。
const hasYunet = existsSync(outModels) && readdirSync(outModels).some((f) => /face_detection_yunet.*\.onnx$/i.test(f))
if (!hasYunet) {
  console.error(
    `\n❌ 引擎缺少 YuNet 人脸权重（face_detection_yunet*.onnx），实际 models/ 内容：` +
      `${existsSync(outModels) ? readdirSync(outModels).join(', ') : '(目录不存在)'}\n` +
      '该文件已随仓库提交，若仍缺失请确认构建机拉到了完整仓库。拒绝打包残缺引擎。'
  )
  process.exit(1)
}
// 硬校验：face_landmarker.task 必须随包（已入库）。缺失说明构建未取到仓库文件。
const hasTask = existsSync(outModels) && readdirSync(outModels).some((f) => /face_landmarker.*\.task$/i.test(f))
if (!hasTask) {
  console.error(
    `\n❌ 引擎缺少 MediaPipe 权重（face_landmarker.task），实际 models/ 内容：` +
      `${existsSync(outModels) ? readdirSync(outModels).join(', ') : '(目录不存在)'}\n` +
      '该文件已随仓库提交，若仍缺失请确认构建机拉到了完整仓库。拒绝打包残缺引擎。'
  )
  process.exit(1)
}
// 硬校验：人体检测模型（efficientdet*.tflite）必须随包（由 fetch-models 从 Google storage 自动下载，与 YuNet 同构）。缺失拒绝打包，
// 避免人数分类静默退化回人脸计数（与 yunet/face_landmarker 同构的防残缺包机制）。
const hasPerson = existsSync(outModels) && readdirSync(outModels).some((f) => /efficientdet.*\.tflite$|person_.*\.tflite$/i.test(f))
if (!hasPerson) {
  console.error(
    `\n❌ 引擎缺少人体检测模型（efficientdet*.tflite），实际 models/ 内容：` +
      `${existsSync(outModels) ? readdirSync(outModels).join(', ') : '(目录不存在)'}\n` +
      '该文件由 `npm run fetch-models` 从 Google storage 自动下载（未随仓库提交）；若缺失请先跑 fetch-models（或用 npm run build:engine:ai 一步拉取+打包）。拒绝打包残缺引擎。'
  )
  process.exit(1)
}
writeFileSync(
  join(outModels, '放权重看这里.txt'),
  '把 ONNX 深度学习权重放入本 models/ 目录后重启软件，即可从规则算法升级为深度学习完整精度。\n' +
    '文件名关键字示例：face_detection_yunet*.onnx / ocec*.onnx / mobilegaze*.onnx / *emotion*.onnx。\n' +
    '详见 README.md。缺权重时引擎用 OpenCV Haar + 几何规则兜底，功能不中断。\n',
  'utf-8'
)

const exePath = join(outDir, exeName)
if (!existsSync(exePath)) {
  console.error(
    `\n❌ 未在预期位置找到引擎可执行文件：${exePath}\n` +
      '请核对 PyInstaller 输出目录结构（dist/screener-engine/）。绝不可在无引擎的情况下继续打包，' +
      '否则安装包会静默降级为 Node 基础引擎。'
  )
  process.exit(1)
}
console.log(`\n✅ 自带引擎已生成：${exePath}`)
console.log('现在运行 `npm run dist`（electron-builder）会把 engine-dist/' + platform + ' 打进安装包的 resources/engine。')
