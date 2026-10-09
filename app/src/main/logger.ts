/**
 * 运行错误日志（按天分文件）：<logRoot>/log/MM/DD/error.txt
 * - 只记录运行错误：主进程未捕获异常、未处理的 Promise 拒绝、console.error、渲染进程控制台 error
 * - logRoot 优先取安装目录（exe 同级），不可写（如 Program Files）时回退到 userData
 * - 跨天自动切换目录（每次写入按当前日期计算路径）
 */
import { app } from 'electron'
import { join, dirname } from 'path'
import { mkdirSync, appendFileSync } from 'fs'

let logRoot = ''

/** 解析可写的日志根目录：安装目录优先，回退 userData */
function resolveLogRoot(): string {
  if (app.isPackaged) {
    const installLog = join(dirname(app.getPath('exe')), 'log')
    try {
      mkdirSync(installLog, { recursive: true })
      appendFileSync(join(installLog, '.writetest'), '')
      return installLog
    } catch {
      // 安装目录不可写（权限限制）→ 回退用户数据目录
    }
  }
  const udLog = join(app.getPath('userData'), 'log')
  try {
    mkdirSync(udLog, { recursive: true })
  } catch {
    /* 兜底：即使创建失败也返回该路径，写入时再容错 */
  }
  return udLog
}

/** 把任意错误对象格式化为可读多行文本 */
function format(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}${err.stack ? '\n' + err.stack : ''}`
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/** 追加一条错误记录到当天 error.txt */
export function logError(tag: string, err: unknown): void {
  if (!logRoot) logRoot = resolveLogRoot()
  const now = new Date()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const dir = join(logRoot, mm, dd)
  const ts = `${now.getFullYear()}-${mm}-${dd} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}`
  const line = `[${ts}] [${tag}] ${format(err)}\n`
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'error.txt'), line, 'utf8')
  } catch {
    /* 日志写入本身失败时静默，绝不能再抛异常拖垮主流程 */
  }
}

/** 日志根目录（初始化后可取，用于启动时提示用户位置） */
export function getLogRoot(): string {
  if (!logRoot) logRoot = resolveLogRoot()
  return logRoot
}

/**
 * 安装错误采集：进程级异常 + console.error 旁路 + 渲染进程 error。
 * 需在 app ready 前尽早调用，以便捕获启动期错误。
 */
export function setupErrorLogger(): void {
  logRoot = resolveLogRoot()

  // 1) 旁路 console.error：保留原输出，同时落盘（scanner / python / index 等既有 console.error 自动被捕获）
  const origError = console.error.bind(console)
  console.error = (...args: unknown[]): void => {
    origError(...args)
    const msg = args
      .map((a) => (a instanceof Error ? format(a) : typeof a === 'string' ? a : format(a)))
      .join(' ')
    logError('console.error', msg)
  }

  // 2) 主进程未捕获异常 / 未处理 Promise 拒绝（有监听器后不会直接崩溃退出，改为记录并继续）
  process.on('uncaughtException', (err) => {
    logError('uncaughtException', err)
  })
  process.on('unhandledRejection', (reason) => {
    logError('unhandledRejection', reason)
  })

  // 3) 开发环境写一条自检记录，便于立即看到目录结构与格式（生产版不写）
  if (!app.isPackaged) {
    logError('selftest', '错误日志自检：开发环境启动验证，非运行错误。此后运行期错误将按天记录到本文件。')
  }
}

/** 供渲染进程错误经 IPC 汇入主进程日志（level>=3 为 error） */
export function logRendererError(message: string, source?: string, line?: number): void {
  const where = source ? ` (${source}${line != null ? ':' + line : ''})` : ''
  logError('renderer', message + where)
}
