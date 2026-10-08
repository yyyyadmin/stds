/**
 * Python AI 引擎接入：定位解释器、spawn ai-engine/main.py、stdio JSON-RPC
 * - 支持进程池（CPU 模式多进程加速，第十章 10.1）
 * - 引擎崩溃自动重启；Python 不可用时由 EngineManager 降级到 Node 内置引擎
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { EventEmitter } from 'events'

export interface EngineCapabilities {
  faceBackend?: string
  eyes?: string
  emotion?: boolean
  embedding?: boolean
  onnxruntime?: boolean
  faceOnnx?: boolean
  gazeOnnx?: boolean
  ocecOnnx?: boolean
  [k: string]: unknown
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

/** 单个工作进程 */
class RpcWorker {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buf = ''
  private seq = 0
  private pending = new Map<number, Pending>()
  readonly events = new EventEmitter()
  capabilities: EngineCapabilities | null = null
  device = 'cpu'
  private ready = false
  private readyWaiters: Array<() => void> = []
  private stderrLog: string[] = []

  constructor(
    private pythonPath: string,
    private engineDir: string,
    private devicePref: string,
    private bundled = false
  ) {}

  async start(): Promise<void> {
    if (this.proc) return
    // bundled：PyInstaller 自包含可执行文件本身即入口，直接传 --device；
    // 普通：系统 python 解释器 + main.py 脚本
    const cmd = this.bundled ? [] : [join(this.engineDir, 'main.py')]
    this.proc = spawn(this.pythonPath, [...cmd, '--device', this.devicePref], {
      cwd: this.engineDir,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
    })
    this.proc.stdout.setEncoding('utf-8')
    this.proc.stderr.setEncoding('utf-8')
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk))
    this.proc.stderr.on('data', (chunk: string) => {
      this.stderrLog.push(chunk)
      if (this.stderrLog.length > 200) this.stderrLog.shift()
    })
    this.proc.on('exit', (code) => {
      this.ready = false
      this.proc = null
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error('engine exited code=' + code + '\n' + this.stderrLog.slice(-20).join('')))
      }
      this.pending.clear()
      this.events.emit('dead', code)
    })
    return new Promise<void>((resolve) => {
      if (this.ready) return resolve()
      this.readyWaiters.push(resolve)
      setTimeout(() => {
        if (!this.ready) {
          this.readyWaiters = this.readyWaiters.filter((r) => r !== resolve)
          resolve() // 超时后仍继续，让请求自然失败
        }
      }, 30000)
    })
  }

  private onData(chunk: string): void {
    this.buf += chunk
    let idx: number
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      if (!line) continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (msg.event === 'ready') {
        this.capabilities = (msg.capabilities as EngineCapabilities) || null
        this.device = (msg.device as string) || 'cpu'
        this.ready = true
        this.events.emit('ready', this.capabilities)
        const ws = this.readyWaiters
        this.readyWaiters = []
        ws.forEach((w) => w())
        continue
      }
      if (msg.event === 'log') {
        this.events.emit('log', msg.msg, msg.level)
        continue
      }
      const id = msg.id as number
      const p = this.pending.get(id)
      if (p) {
        this.pending.delete(id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(String(msg.error)))
        else p.resolve(msg.result)
      }
    }
  }

  call<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs = 120000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.proc) return reject(new Error('engine not started'))
      const id = ++this.seq
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('engine timeout: ' + method))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  stop(): void {
    if (this.proc) {
      try {
        this.proc.stdin.write(JSON.stringify({ id: -1, method: 'shutdown', params: {} }) + '\n')
        this.proc.stdin.end()
      } catch {
        /* ignore */
      }
      const proc = this.proc
      this.proc = null
      setTimeout(() => {
        try {
          proc.kill()
        } catch {
          /* ignore */
        }
      }, 3000)
    }
  }
}

export class PythonEnginePool {
  private workers: RpcWorker[] = []
  private rr = 0
  readonly events = new EventEmitter()
  started = false

  constructor(
    private pythonPath: string,
    private engineDir: string,
    private device: string,
    private size: number,
    private bundled = false
  ) {}

  /**
   * 自带（PyInstaller 打包）引擎可执行文件探测：优先级最高，实现“每台设备免安装 Python 即完整 12 维”。
   * - 打包后：resources/engine/screener-engine(.exe)
   * - 开发环境：app/engine-dist/<platform>/screener-engine(.exe)
   */
  static findBundledEngine(): { exe: string; dir: string } | null {
    const bin = process.platform === 'win32' ? 'screener-engine.exe' : 'screener-engine'
    const dirName = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'
    const candidates = [
      join(process.resourcesPath || '', 'engine', bin),
      join(process.resourcesPath || '', 'engine', bin.replace('.exe', ''), bin),
      join(app.getAppPath(), '..', 'app', 'engine-dist', dirName, bin),
      join(app.getAppPath(), 'engine-dist', dirName, bin),
      join(__dirname, '..', '..', '..', '..', 'app', 'engine-dist', dirName, bin),
      join(__dirname, '..', '..', '..', 'engine-dist', dirName, bin)
    ]
    for (const c of candidates) {
      if (c && existsSync(c)) return { exe: c, dir: join(c, '..') }
    }
    return null
  }

  static findEngineDir(): string | null {
    const candidates = [
      // 开发环境：仓库根 ai-engine
      join(app.getAppPath(), '..', 'ai-engine'),
      join(__dirname, '..', '..', '..', '..', 'ai-engine'),
      join(process.resourcesPath || '', 'ai-engine'),
      join(app.getAppPath(), 'resources', 'ai-engine')
    ]
    for (const c of candidates) {
      if (c && existsSync(join(c, 'main.py'))) return c
    }
    return null
  }

  /** 查找可用 Python：环境变量 > python/python3/py > 常见安装位置 */
  static findPython(): string | null {
    if (process.env.AI_ENGINE_PYTHON && existsSync(process.env.AI_ENGINE_PYTHON)) {
      return process.env.AI_ENGINE_PYTHON
    }
    const names = process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python']
    for (const name of names) {
      try {
        const r = spawnSync(name, ['--version'], { windowsHide: true, timeout: 8000 })
        // Windows Store 别名占位程序会返回 exit 9009/9009 之类
        if (r.status === 0 && /Python 3\./.test((r.stdout || '').toString() + (r.stderr || '').toString())) {
          // 校验能 import cv2（缺库也允许运行：引擎会自报降级）；至少能执行
          const check = spawnSync(name, ['-c', 'import sys;print(sys.version_info[0])'], { windowsHide: true, timeout: 8000 })
          if (check.status === 0 && check.stdout.toString().trim() === '3') return name
        }
      } catch {
        /* continue */
      }
    }
    return null
  }

  async start(): Promise<EngineCapabilities> {
    if (this.started && this.workers.length) {
      return this.workers[0].capabilities || {}
    }
    // 快速探测：先起 1 个进程拿 capabilities
    const probe = new RpcWorker(this.pythonPath, this.engineDir, this.device, this.bundled)
    const caps = await new Promise<EngineCapabilities>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('engine startup timeout (30s)')), 30000)
      probe.events.once('ready', (c: EngineCapabilities) => {
        clearTimeout(t)
        resolve(c || {})
      })
      probe.events.once('dead', (code: unknown) => {
        clearTimeout(t)
        reject(new Error('engine exited early, code=' + code))
      })
      probe.start().catch((e) => {
        clearTimeout(t)
        reject(e)
      })
    })
    probe.stop()
    // 重新拉起 probe 作为工作进程（保持连接存活）
    await probe.start()
    this.workers = [probe]
    const n = Math.max(1, this.size)
    for (let i = 1; i < n; i++) {
      const w = new RpcWorker(this.pythonPath, this.engineDir, this.device, this.bundled)
      w.events.on('log', (m: string, lv: string) => this.events.emit('log', m, lv))
      await w.start()
      this.workers.push(w)
    }
    this.started = true
    return caps
  }

  private pick(): RpcWorker {
    this.rr = (this.rr + 1) % this.workers.length
    return this.workers[this.rr]
  }

  getDevice(): string {
    return this.workers[0]?.device || 'cpu'
  }

  async detect(path: string, imageId: number): Promise<unknown> {
    const w = this.pick()
    try {
      return await w.call('detect', { path, imageId })
    } catch (e) {
      // 崩溃自动重启一次
      await w.start().catch(() => undefined)
      return await w.call('detect', { path, imageId })
    }
  }

  stop(): void {
    this.workers.forEach((w) => w.stop())
    this.workers = []
    this.started = false
  }
}
