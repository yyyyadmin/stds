/**
 * 统一缓存清理：一个入口覆盖软件产生的全部"可再生"数据。
 *
 * 为什么要有这个文件：用户卸载 / 升级后看到的"残留"（日志、照片缓存、AI 模型缓存、
 * Electron 缓存+数据）散落在 6 个地方，各自清一遍会漏。这里把范围固化成一份清单，
 * 三个调用方共用同一套口径：
 *   1) 设置面板「清理缓存」按钮（手动）
 *   2) 安装 / 升级后首次启动（自动，见 ipc.ts 的 cacheSweepVersion 门控）
 *   3) NSIS 卸载脚本 app/build/uninstall-clean.nsh（删除范围与本文件保持一致，但它是
 *      bat 语法无法 import，改动本清单时必须同步改它）
 *
 * 铁律：只删"删了能自己长回来"的东西。绝不碰 data/screener.db（图库与检测结果）、
 * auth.json（登录态）、settings 表（用户偏好）、Local Storage（存网格缩放偏好）。
 *
 * 所有函数都是同步的——启动清理必须跑在 runBackfill() 之前，否则缩略图会按旧缓存重建，
 * 清完又满了。
 */
import { app } from 'electron'
import { join } from 'path'
import { tmpdir } from 'os'
import { existsSync, readdirSync, statSync, rmSync } from 'fs'
import { clearThumbCache } from './importer'
import { clearBigCache } from './big'
import { clearEngineInputCache } from './rawPreview'
import { getLogRoot } from '../logger'

/** 一次清理的完整结果，供界面回报"清掉了什么、释放多少空间" */
export interface SweepResult {
  /** 缩略图文件数 */
  thumbs: number
  /** RAW/HEIC 大图预览文件数 */
  big: number
  /** 引擎归一化中间图文件数 */
  engineInput: number
  /** 日志文件数 */
  logs: number
  /** Electron 自带缓存条目数（Cache/Code Cache/GPUCache 等） */
  electronCache: number
  /** 引擎模型副本目录数 */
  modelCopies: number
  /** 释放的磁盘空间，MB（四舍五入到 1 位小数） */
  freedMB: number
}

/** userData 下的应用数据根（图库、缩略图、大图、中间图都在这里） */
function dataRoot(): string {
  return join(app.getPath('userData'), 'data')
}

/** 递归统计目录字节数；目录不存在返回 0。单项 stat 失败跳过，不影响整体。 */
function dirBytes(dir: string): number {
  let total = 0
  if (!existsSync(dir)) return 0
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of entries) {
    const p = join(dir, name)
    try {
      const st = statSync(p)
      if (st.isDirectory()) total += dirBytes(p)
      else total += st.size
    } catch {
      /* 正被占用的文件统计不到就算了，不是要紧事 */
    }
  }
  return total
}

/**
 * 整棵目录树删除（含目录本身）。Windows 下 Chromium 正锁着的文件会 EBUSY/EPERM，
 * rmSync 抛错即放弃该项——缓存下次启动还能清，不能因为删不掉拖垮启动流程。
 */
function removeTree(dir: string): boolean {
  if (!existsSync(dir)) return false
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 1 })
    return true
  } catch {
    return false
  }
}

/** 只删目录里的文件、保留目录本身（日志目录被进程持有句柄时整删会失败，逐文件删能成功一半） */
function removeFilesIn(dir: string): number {
  if (!existsSync(dir)) return 0
  let n = 0
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of entries) {
    const p = join(dir, name)
    try {
      if (statSync(p).isDirectory()) n += removeFilesIn(p)
      else {
        rmSync(p, { force: true, maxRetries: 1 })
        n++
      }
    } catch {
      /* 占用中的日志文件跳过 */
    }
  }
  return n
}

/**
 * 引擎模型副本目录：安装路径含中文时，OpenCV 读不了 ONNX/级联文件，引擎会把模型复制到
 * 纯 ASCII 目录下（见 ai-engine/engine/face.py 的 _ascii_model_path）。换版本后旧副本
 * 没人认领，白白占着一份模型体积，必须清。
 */
function modelCopyDirs(): string[] {
  const base = [
    tmpdir(),
    process.env.PROGRAMDATA || '',
    process.env.SYSTEMDRIVE ? process.env.SYSTEMDRIVE + '\\' : '',
  ].filter(Boolean)
  return base.map((b) => join(b, 'screener-engine-models'))
}

/** Electron 落盘缓存目录名（userData 下）。Local Storage 不在此列——里面是用户偏好。 */
const ELECTRON_CACHE_DIRS = ['Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'DawnCache', 'blob_storage', 'Default/Cache', 'Default/Code Cache', 'Default/GPUCache']

/**
 * 执行一次全量清理。
 *
 * @param opts.keepLogs 一般不传（日志也清）；日志是排查问题的第一手材料，若某轮清理
 *        只想腾磁盘、保留现场，传 true。
 */
export function sweepCaches(opts: { keepLogs?: boolean } = {}): SweepResult {
  const ud = app.getPath('userData')
  const dr = dataRoot()

  // 先量体积再删：删完目录就空了，量不到"这次到底释放了多少"
  const bytesBefore =
    dirBytes(join(dr, 'thumbs')) +
    dirBytes(join(dr, 'big')) +
    dirBytes(join(dr, 'engine-input')) +
    dirBytes(join(ud, 'log')) +
    ELECTRON_CACHE_DIRS.reduce((s, d) => s + dirBytes(join(ud, d)), 0) +
    modelCopyDirs().reduce((s, d) => s + dirBytes(d), 0)

  // 1) 三类图片缓存：沿用各自服务里的删文件逻辑（口径已验证），避免这里再写一份 glob
  const thumbs = clearThumbCache()
  const big = clearBigCache()
  const engineInput = clearEngineInputCache()

  // 2) 日志：优先清真正的写入目录（getLogRoot，可能是 exe 同级），顺带清历史回退位置
  let logs = 0
  if (!opts.keepLogs) {
    const logTargets = [getLogRoot(), join(ud, 'log'), join(ud, 'logs')]
    for (const dir of logTargets) {
      try {
        logs += removeFilesIn(dir)
      } catch {
        /* ignore */
      }
    }
  }

  // 3) Electron 自带缓存：整目录删除。启动期调用时主 Cache 目录常被 Chromium 占用，
  //    删不掉就留给手动清理按钮（那时可另外走 session.clearCache()）。
  let electronCache = 0
  for (const rel of ELECTRON_CACHE_DIRS) {
    if (removeTree(join(ud, rel))) electronCache++
  }

  // 4) 引擎模型副本
  let modelCopies = 0
  for (const dir of modelCopyDirs()) {
    if (removeTree(dir)) modelCopies++
  }

  return {
    thumbs,
    big,
    engineInput,
    logs,
    electronCache,
    modelCopies,
    freedMB: Math.round((bytesBefore / 1024 / 1024) * 10) / 10,
  }
}
