/**
 * 会员中心对话框（③）
 * - 展示积分余额 / 会员等级 / 到期时间
 * - 套餐列表（plans.php）+ 购买下单（create_order.php）+ 客服二维码（config.php）引导支付
 * - 退出登录
 */
import { useEffect, useState } from 'react'
import { useStore } from '../store'
import type { PlanInfo, SysConfig } from '../../../shared/ipc'

const LEVEL_LABEL: Record<string, string> = {
  free: '普通用户',
  monthly: '月度会员',
  quarterly: '季度会员',
  yearly: '年度会员'
}

export default function MemberCenterDialog(): JSX.Element | null {
  const showMember = useStore((s) => s.showMember)
  const close = useStore((s) => s.closeMember)
  const auth = useStore((s) => s.auth)
  const openLogin = useStore((s) => s.openLogin)
  const doLogout = useStore((s) => s.doLogout)
  const refreshAuth = useStore((s) => s.refreshAuth)

  const [plans, setPlans] = useState<PlanInfo[]>([])
  const [cfg, setCfg] = useState<SysConfig | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<PlanInfo | null>(null)
  const [orderNo, setOrderNo] = useState('')
  const [qr, setQr] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!showMember) return
    setErr('')
    setOrderNo('')
    setQr('')
    setSelected(null)
    void (async () => {
      setLoading(true)
      const [p, c] = await Promise.all([window.api.plansList(), window.api.sysConfig()])
      setPlans(p)
      setCfg(c)
      setLoading(false)
      void refreshAuth()
    })()
  }, [showMember, refreshAuth])

  if (!showMember) return null

  const user = auth.user
  const balance = user?.points.balance ?? 0
  const level = user?.membership.level || 'free'
  const isMember = auth.loggedIn && level !== 'free' && !user?.membership.is_expired

  const buy = async (plan: PlanInfo): Promise<void> => {
    setErr('')
    if (!auth.loggedIn) {
      openLogin()
      return
    }
    // 下单接口的 product_type = 套餐 code 本身（monthly/quarterly/yearly）；product_id 同传 code（后端会员单以 type 为准）
    const r = await window.api.orderCreate(plan.code, plan.code)
    // 无论下单是否成功都进入扫码联系客服流程：
    //  - 成功：用下单返回的 service_qrcode + 订单号
    //  - 失败（如终身卡后端不支持下单）：回退用 config 的客服二维码，同样引导扫码开通
    setSelected(plan)
    setOrderNo(r.ok ? r.order_no || '' : '')
    setQr(r.service_qrcode || '')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 fade-in p-4" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="w-[560px] max-h-[86vh] overflow-y-auto bg-panel border border-line rounded-2xl shadow-2xl">
        {/* 头部用户卡 */}
        <div className="p-5 bg-gradient-to-br from-brand/15 to-transparent border-b border-line">
          <div className="flex items-start justify-between">
            <div className="min-w-0">
              <div className="text-lg font-bold text-fg truncate">
                {user?.nickname || user?.phone || user?.email || (auth.loggedIn ? '已登录' : '未登录')}
              </div>
              {auth.loggedIn ? (
                <div className="flex items-center gap-2 mt-1.5">
                  <span className={'chip ' + (isMember ? 'bg-warn/20 text-warn border border-warn/40' : 'bg-panel2 text-fg2 border border-line')}>
                    {isMember ? '👑 ' + LEVEL_LABEL[level] : LEVEL_LABEL[level]}
                  </span>
                  {isMember && user?.membership.expire_at && (
                    <span className="text-xs text-fg2">到期 {String(user.membership.expire_at).slice(0, 10)}</span>
                  )}
                </div>
              ) : (
                <div className="text-xs text-fg2 mt-1.5">登录后可查看积分与会员权益</div>
              )}
            </div>
            <button className="btn-ghost text-fg3" onClick={close} title="关闭">✕</button>
          </div>

          {auth.loggedIn && (
            <div className="mt-4 flex items-center gap-6">
              <div>
                <div className="text-2xl font-bold text-brand tabular-nums">{balance}</div>
                <div className="text-xs text-fg2">当前积分</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-fg tabular-nums">{user?.points.total_consumed ?? 0}</div>
                <div className="text-xs text-fg2">累计消耗</div>
              </div>
              <div className="flex-1" />
              <div className="flex gap-2">
                {!auth.loggedIn && (
                  <button className="btn-primary" onClick={() => { close(); openLogin() }}>登录</button>
                )}
                <button className="btn text-fg2" onClick={() => void doLogout()}>退出登录</button>
              </div>
            </div>
          )}
        </div>

        {/* 积分说明 */}
        <div className="px-5 py-3 text-xs text-fg2 bg-panel2/50 border-b border-line">
          1 张照片消耗 <b className="text-fg">1 积分</b>；开通会员后筛选<b className="text-fg">不扣积分</b>，且新会员赠送积分。
        </div>

        {/* 未登录：引导登录 */}
        {!auth.loggedIn ? (
          <div className="p-8 text-center">
            <div className="text-4xl mb-3">🔒</div>
            <div className="text-sm text-fg mb-4">登录后查看积分余额并开通会员</div>
            <button className="btn-primary" onClick={() => { close(); openLogin() }}>去登录 / 注册</button>
          </div>
        ) : (
          <>
            {/* 套餐 */}
            <div className="p-5">
              <div className="text-sm font-semibold text-fg mb-3">会员套餐</div>
              {loading && <div className="text-xs text-fg2 py-6 text-center">加载套餐中…</div>}
              {!loading && !plans.length && <div className="text-xs text-fg2 py-6 text-center">暂无可用套餐</div>}
              <div className="grid grid-cols-2 gap-3">
                {plans.map((plan) => (
                  <div
                    key={plan.code}
                    className={'relative rounded-xl border p-3 transition-colors ' + (plan.is_recommended ? 'border-brand bg-brand/5' : 'border-line bg-panel2/40')}
                  >
                    {plan.is_recommended === 1 && (
                      <span className="absolute -top-2 right-3 chip bg-brand text-white">推荐</span>
                    )}
                    <div className="text-sm font-semibold text-fg">{plan.name}</div>
                    <div className="mt-1 flex items-baseline gap-1">
                      <span className="text-xl font-bold text-brand">¥{plan.price}</span>
                      {plan.original_price && plan.original_price !== plan.price && (
                        <span className="text-xs text-fg3 line-through">¥{plan.original_price}</span>
                      )}
                    </div>
                    {plan.points_gift > 0 && (
                      <div className="text-xs text-warn mt-0.5">赠 {plan.points_gift} 积分</div>
                    )}
                    <ul className="mt-2 space-y-0.5 text-[11px] text-fg2 min-h-[3.2em]">
                      {plan.features.slice(0, 3).map((f, i) => (
                        <li key={i}>· {f}</li>
                      ))}
                    </ul>
                    <button className="btn-primary w-full mt-2 text-xs py-1" onClick={() => void buy(plan)}>
                      开通
                    </button>
                  </div>
                ))}
              </div>
              {err && <div className="text-xs text-bad mt-3">{err}</div>}
            </div>

            {/* 下单后：客服/微信二维码引导支付 */}
            {selected && (
              <div className="px-5 pb-5">
                <div className="rounded-xl border border-line bg-panel2/40 p-4">
                  <div className="text-sm font-semibold text-fg">
                    {orderNo ? `已创建订单：${selected.name}` : `${selected.name} · 扫码联系客服开通`}
                  </div>
                  {orderNo && <div className="text-xs text-fg2 mt-1">订单号 {orderNo}</div>}
                  <div className="text-xs text-fg2 mt-2">
                    请添加客服微信完成支付，支付成功后积分/会员将自动到账（点击下方「刷新状态」同步）。
                  </div>
                  <div className="flex items-center gap-4 mt-3">
                    {(() => {
                      const img = qr || cfg?.customer_service_qrcode || cfg?.wechat_qrcode || ''
                      return img ? (
                        <img
                          src={img}
                          alt="客服二维码"
                          className="w-40 h-40 rounded-lg border border-line object-contain bg-white p-1"
                        />
                      ) : (
                        <div className="text-xs text-fg3">暂未获取到客服二维码，请稍后重试或联系管理员</div>
                      )
                    })()}
                    <div className="flex flex-col gap-2">
                      <button className="btn text-xs" onClick={() => void refreshAuth()}>刷新状态</button>
                      <button className="btn-ghost text-xs text-fg3" onClick={() => setSelected(null)}>收起</button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 积分充值说明 */}
            <div className="px-5 pb-5 text-[11px] text-fg3">
              如需单独充值积分或有其他问题，请联系客服微信{cfg?.site_name ? `（${cfg.site_name}）` : ''}。
            </div>
          </>
        )}
      </div>
    </div>
  )
}
