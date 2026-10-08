/**
 * SQLite 封装：基于 sql.js（WASM 版 SQLite），无需任何原生编译，
 * Windows / macOS / Linux 行为完全一致；数据库文件为标准 SQLite 格式。
 * 对外 API 对齐 better-sqlite3：prepare().run/get/all、exec、transaction、pragma。
 * 持久化：写事务打脏标记，防抖 300ms 原子落盘（临时文件 + rename），退出前强制 flush。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from 'sql.js'
import { app } from 'electron'

export type ParamValue = string | number | Uint8Array | null | undefined
export type Params = ParamValue[] | Record<string, ParamValue>
/** sql.js 官方绑定类型（undefined 统一转 null 后满足） */
type BindArgs = SqlValue[] | Record<string, SqlValue>

export interface RunResult {
  lastInsertRowid: number
  changes: number
}

export interface Statement {
  run(...params: unknown[]): RunResult
  get<T = Record<string, unknown>>(...params: unknown[]): T | undefined
  all<T = Record<string, unknown>>(...params: unknown[]): T[]
}

class SqlJsWrapper {
  private dirty = false
  private saveTimer: NodeJS.Timeout | null = null
  private sqljs: SqlJsStatic | null = null
  private inner: Database | null = null
  private ready: Promise<void>

  constructor(private file: string) {
    this.ready = this.open()
  }

  private async open(): Promise<void> {
    // wasm 定位：开发环境 node_modules；打包后 extraResources / asar 内均可通过 fs 读取
    const candidates = [
      join(app.getAppPath(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
      join(process.resourcesPath || '', 'sql-wasm.wasm'),
      join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
    ]
    let wasmBinary: ArrayBuffer | undefined
    for (const c of candidates) {
      if (c && existsSync(c)) {
        wasmBinary = readFileSync(c).buffer as ArrayBuffer
        break
      }
    }
    this.sqljs = await initSqlJs(wasmBinary ? { wasmBinary } : {})
    if (existsSync(this.file)) {
      this.inner = new this.sqljs.Database(readFileSync(this.file))
    } else {
      mkdirSync(dirname(this.file), { recursive: true })
      this.inner = new this.sqljs.Database()
    }
    // SQLite 标准 PRAGMA（内存态尽力应用）
    try {
      this.inner.run('PRAGMA foreign_keys = ON')
    } catch {
      /* ignore */
    }
    this.markDirty()
  }

  private ensureReady(): Database {
    if (!this.inner || !this.sqljs) throw new Error('database not initialized; await whenReady() first')
    return this.inner
  }

  async whenReady(): Promise<void> {
    await this.ready
  }

  /** @named 参数风格转 sql.js 的 $name */
  private convSql(sql: string): string {
    return sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, '$$$1')
  }

  private convParams(params?: Params): BindArgs | undefined {
    if (!params || Array.isArray(params)) return params?.map((v) => v ?? null)
    const out: Record<string, SqlValue> = {}
    for (const [k, v] of Object.entries(params)) out[`$${k.replace(/^[@:$]/, '')}`] = v ?? null
    return out
  }

  private normParams(args: unknown[]): BindArgs | undefined {
    if (args.length === 0) return undefined
    if (args.length === 1) {
      const a = args[0]
      if (Array.isArray(a)) return (a as ParamValue[]).map((v) => v ?? null)
      if (a && typeof a === 'object') return this.convParams(a as Record<string, ParamValue>)
      return [((a as ParamValue) ?? null) as SqlValue]
    }
    return (args as ParamValue[]).map((v) => v ?? null)
  }

  prepare(sql: string): Statement {
    const db = this.ensureReady()
    const realSql = this.convSql(sql)
    const self = this
    return {
      run: (...args: unknown[]): RunResult => {
        const stmt = db.prepare(realSql)
        try {
          stmt.run(self.normParams(args))
        } finally {
          stmt.free()
        }
        self.markDirty()
        const r = db.exec('SELECT last_insert_rowid(), changes()')
        const row = r[0]?.values[0] as [number, number] | undefined
        return { lastInsertRowid: row ? Number(row[0]) : 0, changes: row ? Number(row[1]) : 0 }
      },
      get: <T>(...args: unknown[]): T | undefined => {
        const stmt = db.prepare(realSql)
        try {
          stmt.bind(self.normParams(args))
          if (stmt.step()) {
            const cols = stmt.getAsObject() as T
            return cols
          }
          return undefined
        } finally {
          stmt.free()
        }
      },
      all: <T>(...args: unknown[]): T[] => {
        const out: T[] = []
        const stmt = db.prepare(realSql)
        try {
          stmt.bind(self.normParams(args))
          while (stmt.step()) out.push(stmt.getAsObject() as T)
        } finally {
          stmt.free()
        }
        return out
      }
    }
  }

  exec(sql: string): void {
    this.ensureReady().run(this.convSql(sql))
    this.markDirty()
  }

  pragma(str: string): void {
    try {
      this.ensureReady().run(`PRAGMA ${str}`)
    } catch {
      /* sql.js 部分 pragma 不支持，忽略 */
    }
  }

  /** better-sqlite3 风格：返回可多次调用的事务函数 */
  transaction<A extends unknown[], T>(fn: (...args: A) => T): (...args: A) => T {
    const db = this.ensureReady()
    return (...args: A): T => {
      db.run('BEGIN')
      try {
        const r = fn(...args)
        db.run('COMMIT')
        this.markDirty()
        return r
      } catch (e) {
        try {
          db.run('ROLLBACK')
        } catch {
          /* ignore */
        }
        throw e
      }
    }
  }

  private markDirty(): void {
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, 300)
  }

  /** 原子落盘 */
  flush(): void {
    if (!this.dirty || !this.inner) return
    try {
      const data = this.inner.export()
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, Buffer.from(data))
      renameSync(tmp, this.file)
      this.dirty = false
    } catch (e) {
      console.error('db flush failed', e)
    }
  }

  close(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.flush()
    this.inner?.close()
  }
}

let wrapper: SqlJsWrapper | null = null

export type SqlDb = SqlJsWrapper

export async function openDb(file: string): Promise<SqlJsWrapper> {
  wrapper = new SqlJsWrapper(file)
  await wrapper.whenReady()
  return wrapper
}

export function getWrapper(): SqlJsWrapper {
  if (!wrapper) throw new Error('db not opened')
  return wrapper
}

export function flushDb(): void {
  wrapper?.flush()
}

export function closeDb(): void {
  wrapper?.close()
}
