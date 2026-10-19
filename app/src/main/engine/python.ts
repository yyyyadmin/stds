/**
 * Python AI 引擎接入：定位解释器、spawn ai-engine/main.py、stdio JSON-RPC
 * - 支持进程池（CPU 模式多进程加速，第十章 10.1）
 * - 引擎崩溃自动重启；Python 不可用时由 EngineManager 降级到 Node 内置引擎
 */
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { EventEmitter } from 'events'

const execFileAsync = promisify(execFile)

/**
 * 序列化为纯 ASCII 的 JSON：把所有非 ASCII 字符转义成 \uXXXX。
 * 这样写进引擎 stdin 的字节全是 ASCII，无论 PyInstaller 冻结 exe 用 GBK 还是 UTF-8
 * 解码都完全一致，彻底避免含中文的照片路径在 stdio 传输阶段被解成乱码（导致 cannot decode）。
 */
function asciiJson(obj: unknown): string {
  return JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) => {
    const h = c.charCodeAt(0).toString(16)
    return '\\u' + '0'.repeat(4 - h.length) + h
  })
}

export interface EngineCapabilities {
  faceBackend?: string
  eyes?: string
  emotion?: boolean
  embedding?: boolean
  onnxruntime?: boolean
  faceOnnx?: boolean
  gazeOnnx?: boolean
  ocecOnnx?: boolean
  /** 引擎签名：引擎自报的整数，改动检测公式即 +1，软件据此判断存量结果是否需用新引擎重扫 */
  engineSig?: number
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

  call<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs = 60000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.proc) return reject(new Error('engine not started'))
      const id = ++this.seq
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('engine timeout: ' + method))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.proc.stdin.write(asciiJson({ id, method, params }) + '\n')
    })
  }

  stop(): void {
    if (this.proc) {
      try {
        this.proc.stdin.write(asciiJson({ id: -1, method: 'shutdown', params: {} }) + '\n')
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
  private booting = new Set<RpcWorker>()
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

  /** 查找可用 Python（异步非阻塞，避免 spawnSync 卡死主进程事件循环）：环境变量 > python/python3/py */
  static async findPython(): Promise<string | null> {
    if (process.env.AI_ENGINE_PYTHON && existsSync(process.env.AI_ENGINE_PYTHON)) {
      return process.env.AI_ENGINE_PYTHON
    }
    const names = process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python']
    for (const name of names) {
      try {
        const r = await execFileAsync(name, ['--version'], { timeout: 6000, windowsHide: true })
        const out = String(r.stdout || '') + String(r.stderr || '')
        if (/Python 3\./.test(out)) {
          // 校验能拿到主版本号（Windows Store 别名占位程序不会返回 3）
          const check = await execFileAsync(name, ['-c', 'import sys;print(sys.version_info[0])'], { timeout: 6000, windowsHide: true })
          if (String(check.stdout || '').trim() === '3') return name
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
    // 1 号工人：起一个进程，就绪后【直接留用】——不再“探测完杀掉再重启”（省一整次冷启动：Python 加载 + 读模型）。
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
    probe.events.on('log', (m: string, lv: string) => this.events.emit('log', m, lv))
    this.workers = [probe]
    this.started = true
    // 其余工人【后台并行补齐】，不阻塞返回：此刻 1 号已能 detect，引擎状态立刻变“运行中”，
    // 慢机器不必等全部工人冷启动完才能用（工人只影响并发吞吐，不影响单张判定）。
    this.spawnWorkersInBackground()
    return caps
  }

  /** 后台并行拉起剩余工人：就绪一个挂进池子一个；单个起不来只少一个工人，继不挂进池就不会被 detect 碰到，绝不拖垮已可用的引擎。 */
  private spawnWorkersInBackground(): void {
    const n = Math.max(1, this.size)
    for (let i = this.workers.length; i < n; i++) {
      const w = new RpcWorker(this.pythonPath, this.engineDir, this.device, this.bundled)
      w.events.on('log', (m: string, lv: string) => this.events.emit('log', m, lv))
      this.booting.add(w)
      w.events.once('ready', () => {
        this.booting.delete(w)
        if (this.started) {
          this.workers.push(w)
        } else {
          w.stop() // 池子已停（如切换引擎/退出），这个刚就绪的工人别留成孤儿
        }
      })
      w.events.once('dead', () => {
        this.booting.delete(w)
      })
      void w.start().catch(() => {
        this.booting.delete(w)
      })
    }
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
      // 超时不重试（避免单张卡死时长翻倍，使“停止”长时间无效）；仅引擎进程崩溃才重启重试一次
      if (String((e as Error)?.message || e).includes('timeout')) throw e
      await w.start().catch(() => undefined)
      return await w.call('detect', { path, imageId })
    }
  }

  stop(): void {
    this.workers.forEach((w) => w.stop())
    this.booting.forEach((w) => w.stop()) // 连后台正在冷启动的工人一起收，避免孤儿进程
    this.workers = []
    this.booting.clear()
    this.started = false
  }
}
