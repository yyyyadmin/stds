/**
 * 校准数据自动落盘（开发者诊断用，完全无 UI、用户不可见）
 * - 每次筛选结束/停止、以及应用退出时，把全库图片的判定数值写成 JSONL：
 *   <logRoot>/calib/calib-v<版本>-<时间戳>.jsonl（logRoot 与 error.txt 同根：安装目录 log/ 优先，不可写回退 userData）
 * - 每行一张图：文件名 + AI 分类 + 是否被用户纠正 + 人脸数 + 各维度 [confidence, level, reason, method]。
 *   reason 里含引擎注入的诊断数值（ear=/blink=/占图高%/亮度/贴边距离等），是阈值校准的唯一真实分布来源。
 * - 隐私边界：只含文件名与数字文本，不含照片内容、目录路径；此文件仅私下传给开发者，严禁提交进仓库。
 * - 落盘失败绝不影响主流程（整体 try/catch 静默）。
 */
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs'
import { getDb, getSettings } from '../db'
import { getLogRoot } from '../logger'

/** 只保留最近 N 份校准文件，避免诊断产物在用户机器上无限堆积 */
const KEEP_FILES = 20

function pruneOldCalib(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith('calib-') && f.endsWith('.jsonl'))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const old of files.slice(KEEP_FILES)) {
      try {
        unlinkSync(join(dir, old.f))
      } catch {
        /* 单个删除失败忽略 */
      }
    }
  } catch {
    /* 清理失败静默 */
  }
}

export function dumpCalibration(): void {
  try {
    const s = getSettings()
    const rows = getDb()
      .prepare(`SELECT filename, category, category_by, tags, details FROM images WHERE status = 'done'`)
      .all() as Array<{
      filename: string
      category: string
      category_by: string | null
      tags: string | null
      details: string | null
    }>
    const dir = join(getLogRoot(), 'calib')
    mkdirSync(dir, { recursive: true })
    const now = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
    const file = join(dir, `calib-v${app.getVersion()}-${stamp}.jsonl`)

    const lines: string[] = []
    lines.push(
      JSON.stringify({
        _meta: 1,
        ver: app.getVersion(),
        at: now.toISOString(),
        scene: s.scene,
        strictness: s.strictness,
        mid: s.midThreshold,
        high: s.highThreshold,
        tuned: s.tunedThresholds || {},
        count: rows.length
      })
    )
    for (const r of rows) {
      let tags: Record<string, { confidence?: number; level?: string; reason?: string; method?: string }> = {}
      try {
        tags = r.tags ? JSON.parse(r.tags) : {}
      } catch {
        /* 单行解析失败跳过该图，不影响整体 */
      }
      let faceCount: number | null = null
      try {
        faceCount = r.details ? JSON.parse(r.details).faceCount ?? null : null
      } catch {
        /* ignore */
      }
      const d: Record<string, [number, string, string, string]> = {}
      for (const [k, v] of Object.entries(tags)) {
        if (!v || typeof v.confidence !== 'number') continue
        d[k] = [v.confidence, v.level || '', v.reason || '', v.method || '']
      }
      lines.push(JSON.stringify({ f: r.filename, cat: r.category, by: r.category_by || 'ai', fc: faceCount, d }))
    }
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')
    pruneOldCalib(dir)
  } catch {
    /* 校准落盘失败静默：绝不干扰筛选/退出主流程 */
  }
}
