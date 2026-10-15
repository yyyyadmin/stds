/**
 * 「联系客服开通」二维码弹窗（用户 2026-10-15 定稿）
 *
 * 为什么单独做一个弹窗：以前点「开通」会先去后台下单一条订单，再把二维码摊在会员中心
 * 页面最底下——那东西在滚动区里，用户点完常以为"没反应"；而且终身卡后端根本不支持下单，
 * 下单失败也得照样给人扫码。现在统一成一条路：软件内不收钱，点「开通」只弹这张码，
 * 扫码加客服、报套餐名付款、回来点「刷新状态」。create_order.php 通道保留但界面不再调。
 *
 * 谁能弹它：① 已登录的人在会员中心点任一档「开通」（带套餐名与价目）；
 * ② 未登录的人从顶栏灰锁 / 特权卡上的「联系客服开通」/ 未登录引导区 / 教程中心底部入口点进来
 *   （不带套餐，说"任一套餐"）。未登录不给他看套餐列表（用户明确要求），这条路上也没有价目可带。
 */
import { useEffect, useState } from 'react'
import { useStore } from '../store'
import type { SysConfig } from '../../../shared/ipc'

export default function ContactServiceDialog(): JSX.Element | null {
  const open = useStore((s) => s.showContactQr)
  const plan = useStore((s) => s.contactQrPlan)
  const close = useStore((s) => s.closeContactQr)
  const auth = useStore((s) => s.auth)
  const refreshAuth = useStore((s) => s.refreshAuth)
  const [cfg, setCfg] = useState<SysConfig | null>(null)
  const [qrFailed, setQrFailed] = useState(false)

  // 每次打开重拉一次配置：客服码可能被人换过，缓存太久会给用户一张过期的码
  useEffect(() => {
    if (!open) return
    setQrFailed(false)
    void window.api
      .sysConfig()
      .then(setCfg)
      .catch(() => setQrFailed(true))
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  if (!open) return null

  // 取值顺序：客服码优先，没有再退回微信码（config.php 里那两个字段）。全站只在这里拉码——
  // 教程中心、会员中心以前自己拉一份直接摆出来，现在都改成点一下开这个弹窗。
  const qr = cfg?.customer_service_qrcode || cfg?.wechat_qrcode || ''
  const loggedIn = auth.loggedIn

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 fade-in p-4" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="w-[440px] max-w-full max-h-[88vh] overflow-y-auto bg-panel border border-line rounded-2xl shadow-2xl">
        <div className="px-6 pt-5 pb-4 border-b border-line flex items-start gap-3">
          <div className="min-w-0">
            <h3 className="text-[16px] font-bold text-fg">微信扫码 · 联系客服开通</h3>
            <div className="text-[12px] text-fg2 mt-1">
              {plan ? (
                <>
                  <b className="text-fg">{plan.name}</b>
                  <span className="mx-1.5 text-fg3">·</span>
                  <span className="text-brand font-semibold tabular-nums">¥{plan.price}</span>
                  {plan.original_price && plan.original_price !== plan.price && (
                    <span className="ml-1.5 text-fg3 line-through tabular-nums">¥{plan.original_price}</span>
                  )}
                  {plan.points_gift > 0 && (
                    <>
                      <span className="mx-1.5 text-fg3">·</span>
                      <span className="text-warn tabular-nums">赠 {plan.points_gift} 积分</span>
                    </>
                  )}
                </>
              ) : (
                'AI 复审会员 · 任一套餐均可解锁，档位和价格当面问客服'
              )}
            </div>
          </div>
          <span className="flex-1" />
          <button className="btn-ghost text-fg3 shrink-0" onClick={close} title="关闭（Esc）">✕</button>
        </div>

        <div className="px-6 py-5 flex flex-col items-center gap-4">
          {qr ? (
            <img src={qr} alt="客服微信二维码" className="w-48 h-48 rounded-lg border border-line object-contain bg-white p-2" draggable={false} />
          ) : (
            <div className="w-48 h-48 rounded-lg border border-dashed border-line flex items-center justify-center text-center px-6">
              <span className="text-[12px] leading-relaxed text-fg3">
                {qrFailed ? '连不上服务器，拿不到客服二维码。稍后再试，或检查网络后重开本窗口。' : '正在获取客服二维码…'}
              </span>
            </div>
          )}

          <ol className="w-full text-[13px] leading-[1.9] text-fg2">
            <li>
              <span className="text-fg3 mr-1.5">1</span>用微信扫上面这张码，添加客服
            </li>
            <li>
              <span className="text-fg3 mr-1.5">2</span>
              {plan ? (
                <>
                  把要开通的档位发给客服：<b className="text-fg">「{plan.name}」</b>，按客服给的收款方式付款
                </>
              ) : (
                <>
                  跟客服说要开通<b className="text-fg">会员</b>，问清档位后付款
                </>
              )}
            </li>
            <li>
              <span className="text-fg3 mr-1.5">3</span>
              {loggedIn ? (
                <>付完回到这里点下面「刷新状态」，积分与会员自动到账</>
              ) : (
                <>付款后回本软件注册 / 登录，会员和赠送积分会自动到账</>
              )}
            </li>
          </ol>

          <div className="w-full text-[11px] leading-relaxed text-fg3 border-t border-line pt-3">
            本软件不在应用内直接收款，也不接入任何第三方支付页面。客服若要求你点陌生链接、下载远程软件或提供账号密码，都是假的，请立即停止。
          </div>
        </div>

        <div className="px-6 py-4 border-t border-line flex items-center gap-2">
          {loggedIn && (
            <button
              className="btn text-sm px-4 py-2"
              onClick={() => {
                void refreshAuth()
                close()
              }}
              title="向服务器确认一次会员与积分状态（付款到账后点这里）"
            >
              刷新状态
            </button>
          )}
          <span className="flex-1" />
          <button className="btn-primary text-sm px-5 py-2" onClick={close}>知道了</button>
        </div>
      </div>
    </div>
  )
}
