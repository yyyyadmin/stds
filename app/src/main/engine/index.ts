/**
 * 引擎管理器：按设置选择 Python 完整引擎 / Node 降级引擎，统一 detect 接口
 */
import { cpus } from 'os'
import { PythonEnginePool, type EngineCapabilities } from './python'
import { NodeEngine } from './node'

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
          this.status.message = '自带引擎启动失败（' + String(e).slice(0, 120) + '），尝试系统 Python'
        }
      }
      // 优先级 2：系统 Python + 仓库 ai-engine 源码
      const pythonPath = PythonEnginePool.findPython()
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
