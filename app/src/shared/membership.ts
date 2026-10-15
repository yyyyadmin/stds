/**
 * 会员身份判定的唯一真源（主进程与渲染层共用，别再各写一套 level 比较）
 *
 * 2026-10-15 后端交付新约定（见 API文档.md §1.4）：
 * - 判断是不是会员 → 用 user_info.php 的 membership.is_vip（非 free 且未过期即 true，含体验卡）
 * - 显示叫什么 → 用 membership.name（后台套餐配置改什么就显示什么，如「3天体验卡」「年卡会员」）
 * - 剩余天数 → 用 membership.days_left（永久会员与非会员均为 null）
 * - 严禁对 level 做固定枚举映射：后台动态套餐的代码是 custom3d 这类，写死名单必然误判
 *
 * is_vip 缺省（老版本后端、login.php 扁平响应）时才退回按 level 判，保证不因为后端没升级而全员变非会员。
 */
import type { AuthUser } from './ipc'

/** 后端没给 name 时的兜底名；动态代号（custom3d 这类）没有兜底名，落到通用「会员」 */
const FALLBACK: Record<string, string> = {
  free: '普通会员',
  monthly: '月卡会员',
  quarterly: '季卡会员',
  yearly: '年卡会员',
  lifetime: '终身会员'
}

export function isVip(user: AuthUser | null | undefined): boolean {
  const m = user?.membership
  if (!m) return false
  if (typeof m.is_vip === 'boolean') return m.is_vip && !m.is_expired
  return (m.level || 'free') !== 'free' && !m.is_expired
}

export function membershipName(user: AuthUser | null | undefined): { text: string; paid: boolean } {
  const m = user?.membership
  if (!m || !isVip(user)) return { text: FALLBACK.free, paid: false }
  const name = String(m.name || '').trim()
  return { text: name || FALLBACK[m.level] || '会员', paid: true }
}
