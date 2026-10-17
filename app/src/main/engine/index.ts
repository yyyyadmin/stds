/**
 * 引擎管理器：按设置选择 Python 完整引擎 / Node 降级引擎，统一 detect 接口
 */
import { cpus } from 'os'
import { execFile } from 'child_process'
import { join } from 'path'
import { PythonEnginePool, type EngineCapabilities } from './python'
import { NodeEngine } from './node'
import { logError } from '../logger'

/** execFile 异步版：自愈签名绝不能阻塞主进程事件循环（同步 spawn 会卡死整个窗口通信） */
const execFileAsync = (cmd: string, args: string[]): Promise<{ code: number; err: string | undefined }> =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60000 }, (err, _stdout, stderr) =>
      resolve({ code: err ? 1 : 0, err: err ? String(stderr || err).slice(0, 200) : undefined })
    )
  })

export interface EngineStatus {
  type: 'python' | 'node' | 'none'
  device: string
  workers: number
  pythonPath: string | null
  engineDir: string | null
  capabilities: EngineCapabilities
  message: string
}

export class EngineManager {
  private python: PythonEnginePool | null = null
  private node: NodeEngine | null = null
  private status: EngineStatus = { type: 'none', device: 'cpu', workers: 0, pythonPath: null, engineDir: null, capabilities: {}, message: '未初始化' }

  getStatus(): EngineStatus {
    return this.status
  }

  /**
   * 当前引擎签名：Python 引擎在 capabilities 里自报的 engineSig（整数）。
   * 用于判断存量结果是否需用新引擎重扫。Node 降级引擎无此字段时返回 null，
   * 调用方须把 null 当作“签名未知、不做过期判断”，避免把整库误标为待重扫。
   */
  getEngineSig(): number | null {
    const s = (this.status.capabilities as Record<string, unknown>).engineSig
    return typeof s === 'number' ? s : null
  }

  /**
   * Mac 未签名分发引擎被系统处死的自愈（10-18 排查定案）：M 系列芯片对无签名的可执行文件
   * 直接 Killed: 9，DMG 里的一键修复只擦了“网上下载”标记、管不到这一层。自带引擎启动失败时，
   * 先尝试 ad-hoc 签引擎目录和 App 本体再重试一次——签不成也不报错打断，维持原有降级链路。
   * 每次进程启动只试一次（retriedBundled 护栏），防止在签不了的机器上每轮启动都白等几十秒。
   */
  private retriedBundled = false
  private async resignBundledMac(exe: string, dir: string): Promise<void> {
    logError('engine-mac-resign', '自带引擎启动失败，尝试 ad-hoc 重签后重试（mac 未签名分发被 M 芯片拦截自愈）: ' + exe)
    const r1 = await execFileAsync('codesign', ['--force', '--sign', '-', '--timestamp=none', '-vvv', '--deep', dir])
    const bundle = process.resourcesPath ? join(process.resourcesPath, '..') : ''
    let r2: { code: number; err: string | undefined } = { code: -1, err: '跳过（非 .app 路径）' }
    if (bundle.endsWith('.app')) r2 = await execFileAsync('codesign', ['--force', '--deep', '--sign', '-', bundle])
    logError('engine-mac-resign', `重签结果 engine=${r1.code} ${String(r1.err || 'ok')} | app=${r2.code} ${String(r2.err || 'ok')}`)
  }

  /** 引擎初始化：enginePreference = auto | python | node；devicePreference = auto | cpu | cuda */
  async init(enginePreference: 'auto' | 'python' | 'node', devicePreference: 'auto' | 'cpu' | 'cuda'): Promise<EngineStatus> {
    this.shutdown()
    if (enginePreference !== 'node') {
      // 优先级 1：自带（PyInstaller）引擎二进制 —— 免安装 Python 即完整 12 维（⑨）
      const bundled = PythonEnginePool.findBundledEngine()
      if (bundled) {
        try {
          const workers = Math.max(1, Math.min(6, cpus().length - 1))
          this.python = new PythonEnginePool(bundled.exe, bundled.dir, devicePreference, workers, true)
          const caps = await this.python.start()
          const device = this.python.getDevice()
          this.status = {
            type: 'python',
            device,
            workers,
            pythonPath: bundled.exe,
            engineDir: bundled.dir,
            capabilities: caps,
            message: `自带 AI 引擎已启动（${workers} 进程 / ${device} / 人脸后端 ${String(caps.faceBackend || 'haar')}）—— 完整 12 维检测`
          }
          return this.status
        } catch (e) {
          this.python?.stop()
          this.python = null
          // Mac 自愈：未签名包在 M 芯片上必然死在这里（Killed: 9），补签一次再重试
          if (process.platform === 'darwin' && !this.retriedBundled) {
            this.retriedBundled = true
            await this.resignBundledMac(bundled.exe, bundled.dir)
            try {
              this.python = new PythonEnginePool(bundled.exe, bundled.dir, devicePreference, Math.max(1, Math.min(6, cpus().length - 1)), true)
              const caps = await this.python.start()
              const device = this.python.getDevice()
              this.status = {
                type: 'python',
                device,
                workers: Math.max(1, Math.min(6, cpus().length - 1)),
                pythonPath: bundled.exe,
                engineDir: bundled.dir,
                capabilities: caps,
                message: `自带 AI 引擎已启动（重签后恢复 / ${device} / 人脸后端 ${String(caps.faceBackend || 'haar')}）—— 完整 12 维检测`
              }
              logError('engine-mac-resign', 'ad-hoc 重签后自带引擎启动成功')
              return this.status
            } catch (e2) {
              this.python?.stop()
              this.python = null
              logError('engine-mac-resign', '重签后引擎仍启动失败，继续原降级链路：' + String(e2).slice(0, 200))
            }
          }
          this.status.message = '自带引擎启动失败（' + String(e).slice(0, 120) + '），尝试系统 Python'
        }
      }
      // 优先级 2：系统 Python + 仓库 ai-engine 源码
      const pythonPath = await PythonEnginePool.findPython()
      const engineDir = PythonEnginePool.findEngineDir()
      if (pythonPath && engineDir) {
        try {
          const workers = Math.max(1, Math.min(6, cpus().length - 1))
          this.python = new PythonEnginePool(pythonPath, engineDir, devicePreference, workers)
          const caps = await this.python.start()
          const device = this.python.getDevice()
          this.status = {
            type: 'python',
            device,
            workers,
            pythonPath,
            engineDir,
            capabilities: caps,
            message: `Python AI 引擎已启动（${workers} 进程 / ${device} / 人脸后端 ${String(caps.faceBackend || 'haar')}）`
          }
          return this.status
        } catch (e) {
          this.python?.stop()
          this.python = null
          if (enginePreference === 'python') {
            this.status = { type: 'none', device: 'cpu', workers: 0, pythonPath, engineDir, capabilities: {}, message: 'Python 引擎启动失败：' + String(e) }
            return this.status
          }
          this.status.message = 'Python 引擎不可用（' + String(e).slice(0, 120) + '），已降级内置基础引擎'
        }
      } else if (enginePreference === 'python') {
        this.status = { type: 'none', device: 'cpu', workers: 0, pythonPath, engineDir, capabilities: {}, message: '未找到 Python 或 ai-engine 目录' }
        return this.status
      }
    }
    this.node = new NodeEngine()
    const caps = await this.node.start()
    this.status = {
      type: 'node',
      device: 'cpu',
      workers: 1,
      pythonPath: null,
      engineDir: null,
      capabilities: caps,
      message: this.status.message.includes('降级')
        ? this.status.message
        : '内置基础引擎（模糊/曝光/黑白照/重复检测）。发布版安装包已自带 Python 完整引擎；开发环境可装 Python 或运行 npm run build:engine 获得全部 12 维度检测'
    }
    return this.status
  }

  async detect(path: string, imageId: number): Promise<Record<string, unknown>> {
    if (this.python) return (await this.python.detect(path, imageId)) as Record<string, unknown>
    if (this.node) return this.node.detect(path, imageId)
    throw new Error('无可用检测引擎')
  }

  shutdown(): void {
    this.python?.stop()
    this.python = null
    this.node = null
  }
}

export const engineManager = new EngineManager()
