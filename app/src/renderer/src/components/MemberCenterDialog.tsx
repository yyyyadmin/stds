/**
 * 会员中心对话框（③）
 * - 展示积分余额 / 会员等级 / 到期时间
 * - 套餐列表（plans.php）；点「开通」弹「联系客服开通」二维码弹窗（ContactServiceDialog）
 * - 退出登录：与身份行的到期时间同一水平线，靠右排成一行；右上角只留关闭 ✕
 *
 * 会员身份下两个积分数字（当前积分 / 累计消耗）不抹掉也不置零：数字原样留着但划上中间横线、
 * 颜色改浅，旁边一句「会员期间不扣积分 / 会员到期后即恢复积分制」说清它为什么暂停（用户 2026-10-15 定）。
 * 会员只是这段不记账，到期后接着用原来的余额，所以这两个数字仍是真数据，不能假装它不存在。
 * 退出登录不放在右上角 ✕ 旁边：用户 2026-10-15 要求与到期时间同一水平行，且得是个真按钮（带边框底色）。
 *
 * 2026-10-15 改了收款路径：不再调 create_order.php 下单，也不再把二维码摊在本页滚动区最底下
 * （那个位置用户点完常以为“没反应”，而终身卡后端根本不支持下单）。现在只在这里放价目表，
 * 真要付钱一律交给那个弹窗。未登录不给看套餐（用户明确要求），只给登录引导 + 联系客服入口。
 */
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { membershipName, isVip } from '../../../shared/membership'
import { CAT_REVIEW, CAT_FLAWS } from '../../../shared/types'
import type { PlanInfo, SysConfig, PointsHistoryItem } from '../../../shared/ipc'

export default function MemberCenterDialog(): JSX.Element | null {
  const showMember = useStore((s) => s.showMember)
  const close = useStore((s) => s.closeMember)
  const auth = useStore((s) => s.auth)
  const openLogin = useStore((s) => s.openLogin)
  const openContactQr = useStore((s) => s.openContactQr)
  const doLogout = useStore((s) => s.doLogout)
  const refreshAuth = useStore((s) => s.refreshAuth)
  // 非会员卡片上要用“他自己图库里的张数”做钩子：钩子必须在早退之前取（hooks 不能放在条件返回后面）
  const counts = useStore((s) => s.counts)
  // 「立即开通」要滚到的套餐区（弹窗内真正滚动的容器是卡片本身，scrollIntoView 会自己找）
  const plansRef = useRef<HTMLDivElement>(null)

  const [plans, setPlans] = useState<PlanInfo[]>([])
  const [cfg, setCfg] = useState<SysConfig | null>(null)
  const [loading, setLoading] = useState(false)

  // 积分记录（积分变动历史）弹窗：每页 10 条，扣费/充值/兑换等全部混排，点「累计消耗」数字或「消费记录」链接都打开
  const [histOpen, setHistOpen] = useState(false)
  const [histItems, setHistItems] = useState<PointsHistoryItem[]>([])
  const [histPage, setHistPage] = useState(1)
  const [histPages, setHistPages] = useState(1)
  const [histLoading, setHistLoading] = useState(false)
  const [histErr, setHistErr] = useState('')

  // 兑换码：直接摆输入框+按钮（用户 2026-10-15 定，不要点按钮才弹窗）；
  // 会员码 / 积分码同一个接口（redeem_code.php），返回什么兑什么
  const [redeemCode, setRedeemCode] = useState('')
  const [redeeming, setRedeeming] = useState(false)
  const [redeemMsg, setRedeemMsg] = useState<{ ok: boolean; text: string } | null>(null)
  // AI 复审特权卡：权益明细默认收起，一句话概括 + 点「展开」看全部（用户 2026-10-15 定：四行规格表太占位置）
  const [aiDetailOpen, setAiDetailOpen] = useState(false)

  // remark 格式为「类型说明-备注」：按第一个 - 拆分，前半放主行，后半放副行
  const histTitle = (it: PointsHistoryItem): string =>
    (it.remark || it.reason || '积分变动').split('-')[0]
  const histDetail = (it: PointsHistoryItem): string => {
    const i = it.remark.indexOf('-')
    return i > -1 ? it.remark.slice(i + 1) : ''
  }

  const loadHistory = async (page: number): Promise<void> => {
    setHistLoading(true)
    setHistErr('')
    const r = await window.api.pointsHistory({ type: '', page, page_size: 10 })
    if (r.ok) {
      setHistItems(r.list)
      setHistPage(r.page)
      setHistPages(r.total_pages || 1)
    } else {
      setHistItems([])
      setHistErr(r.message || '获取消费记录失败')
    }
    setHistLoading(false)
  }
  const openHistory = async (): Promise<void> => {
    setHistOpen(true)
    await loadHistory(1)
  }

  /** 兑换码提交：成功后按码的类型给一句人话，并刷新用户信息同步顶栏身份与积分 */
  const onRedeem = async (): Promise<void> => {
    const code = redeemCode.trim()
    if (!code) {
      setRedeemMsg({ ok: false, text: '请填写兑换码' })
      return
    }
    setRedeeming(true)
    setRedeemMsg(null)
    const r = await window.api.redeemCode(code)
    if (r.ok && r.result) {
      const d = r.result
      const text =
        d.type === 'points'
          ? `兑换成功，到账 ${d.points} 积分，当前余额 ${d.balance}`
          : d.level === 'lifetime'
            ? '兑换成功！会员已开通，永久有效'
            : `兑换成功！会员有效期至 ${String(d.expire_at || '').slice(0, 10) || '—'}`
      setRedeemMsg({ ok: true, text })
      setRedeemCode('')
      void refreshAuth()
    } else {
      // 后端 400 文案（码不存在/已被使用/已过期）原样给人看，不改编不包装
      setRedeemMsg({ ok: false, text: r.message || '兑换失败，请稍后再试' })
    }
    setRedeeming(false)
  }

  useEffect(() => {
    if (!showMember) return
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
  // 是不是会员一律走单一真源（后端 membership.is_vip 优先，含体验卡等动态套餐；见 shared/membership.ts）
  const isMember = auth.loggedIn && isVip(user)
  // 身份名与顶栏同源：后端 membership.name 优先，本地只兜底
  const memberLabel = membershipName(user)
  // 这两栏正是 AI 复审的作用域，拿真实张数促单比形容词管用
  const reviewPending = counts[CAT_REVIEW] ?? 0
  const flawsPending = counts[CAT_FLAWS] ?? 0
  // 每日张数上限：会员吃后端权威的 user_info.ai_review.daily_limit；非会员只能吃 config.php 的可选字段；
  // 两边都没值就说“每天有上限”，绝不给他编一个数
  const dailyLimit = user?.ai_review?.daily_limit || cfg?.ai_review_daily_limit || 0

  const buy = (plan: PlanInfo): void => {
    // 不在这里下单：软件内不收钱，扫码加客服、报套餐名付款（见 ContactServiceDialog）
    openContactQr(plan)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 fade-in p-4" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="w-[560px] max-h-[86vh] overflow-y-auto bg-panel border border-line rounded-2xl shadow-2xl">
        {/* 头部用户卡 */}
        <div className="p-5 bg-gradient-to-br from-brand/15 to-transparent border-b border-line">
          <div className="flex items-start justify-between">
            <div className="min-w-0 flex-1">
              <div className="text-lg font-bold text-fg truncate">
                {user?.nickname || user?.phone || user?.email || (auth.loggedIn ? '已登录' : '未登录')}
              </div>
              {auth.loggedIn ? (
                // 这一行横向铺满（左列 flex-1）：身份章 + 剩余时长靠左，退出登录靠右，与到期时间同一水平线（用户 2026-10-15 定）
                <div className="flex items-center gap-2 mt-1.5">
                  <span className={'chip ' + (isMember ? 'bg-warn/20 text-warn border border-warn/40' : 'bg-panel2 text-fg2 border border-line')}>
                    {isMember ? '👑 ' + memberLabel.text : memberLabel.text}
                  </span>
                  {/* 剩余时长：后端 days_left 优先；但像体验卡填了 2101 年这种超十年到期日，
                      报「剩 27500 天」看着像 bug，回退成日期更可读 */}
                  {isMember &&
                    (typeof user?.membership.days_left === 'number' && user.membership.days_left <= 3650 ? (
                      <span className="text-xs text-fg2">剩 {user.membership.days_left} 天到期</span>
                    ) : user?.membership.expire_at ? (
                      <span className="text-xs text-fg2">到期 {String(user.membership.expire_at).slice(0, 10)}</span>
                    ) : null)}
                  <span className="flex-1" />
                  {/* 要像个按钮（带边框底色），不是普通灰文字（用户 2026-10-15：“这是按钮不是普通文字”）；
                      尺寸比下方主按钮小一档，不与它抢视觉中心 */}
                  <button
                    className="btn text-xs px-2.5 py-1 text-fg2"
                    onClick={() => void doLogout()}
                    title="退出当前账号：本地图库、标签与判定记录都保留，重新登录后接着用"
                  >
                    退出登录
                  </button>
                </div>
              ) : (
                <div className="text-xs text-fg2 mt-1.5">登录后可查看积分与会员权益</div>
              )}
            </div>
            <button className="btn-ghost shrink-0 text-fg3" onClick={close} title="关闭">✕</button>
          </div>

          {/* 会员专属「AI 云端复审」特权卡：整宽铺在用户行与积分行之间，不再挤在邮箱下面当一小坨灰字。
              层级靠排版：标题 13px 粗 fg + 金色「会员专属」+ 右侧状态（会员看后端权威今日剩余额度，非会员看「开通即享」）
              → 副标 12px fg2（控制在一行内，别让尾词孤零零掉到第二行）→ 四行「浅标签 + 正文」规格表。
              容器只这一层卡片，内部不塞 chip / 方框（用户审美红线）；未开通时整卡发金色光（只换容器颜色），把眼睛引到下面的套餐区。 */}
          <div className={'mt-3.5 rounded-xl border px-4 py-3 ' + (isMember ? 'border-warn/25 bg-panel/70' : 'border-warn/45 bg-gradient-to-r from-warn/[0.10] to-transparent')}>
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-bold text-fg">✨ AI 云端复审</span>
              <span className="text-[10px] font-semibold tracking-wide text-warn">会员专属</span>
              <span className="flex-1" />
              {isMember ? (
                <span className="shrink-0 text-[11px] text-fg2 tabular-nums">
                  今日剩 <b className="text-warn">{user?.ai_review?.remaining ?? '—'}</b> 张
                </span>
              ) : (
                <button
                  className="shrink-0 cursor-pointer rounded-md border border-warn/50 bg-warn/15 px-2 py-0.5 text-[11px] font-semibold text-warn transition-colors hover:bg-warn/25"
                  // 已登录：本页下面就摆着套餐表，滚过去让他自己挑档；
                  // 未登录：不给看套餐（用户 2026-10-15 定），这一步也没法“先登录再开通”，直接给客服码。
                  // 按钮名字跟着动作改：叫“登录后开通”却弹二维码，就是挂羊头卖狗肉。
                  title={auth.loggedIn ? '跳到下方会员套餐' : '扫码加客服，问清档位后开通'}
                  onClick={() => {
                    if (auth.loggedIn) plansRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                    else openContactQr()
                  }}
                >
                  {auth.loggedIn ? '🔓 立即开通' : '🔓 联系客服开通'}
                </button>
              )}
            </div>
            <div className="mt-1 text-[12px] leading-relaxed text-fg2">
              本地拿不准的，云端大模型再看一遍：只给建议，采纳才生效、可撤回。
            </div>
            {/* 非会员多给一句“他自己的数字”；库里还没这两栏照片时退回通用引导句。这句是促单钩子，留在外面不收进展开区 */}
            {!isMember && (
              <div className="mt-1.5 text-[11px] leading-relaxed text-fg2">
                {reviewPending + flawsPending > 0 ? (
                  <>
                    你的图库现在有 <b className="text-warn tabular-nums">{reviewPending}</b> 张待确认、<b className="text-warn tabular-nums">{flawsPending}</b> 张瑕疵片，开通后当天就能送云端复审。
                  </>
                ) : auth.loggedIn ? (
                  <>开通下方任一套餐即可解锁：筛完自动复审「待确认」，瑕疵片可随时手动复审。</>
                ) : (
                  <>开通任一套餐即可解锁：筛完自动复审「待确认」，瑕疵片可随时手动复审。</>
                )}
              </div>
            )}
            {/* 权益明细（四行规格表 + 完整说明指引）默认收起，点一下展开/收起；用小字链接不用按钮框（用户审美红线） */}
            <button
              className="mt-1.5 cursor-pointer text-[11px] text-fg3 transition-colors hover:text-brand"
              onClick={() => setAiDetailOpen((v) => !v)}
            >
              {aiDetailOpen ? '收起全部权益 ▴' : '展开全部权益 ▾'}
            </button>
            {aiDetailOpen && (
              <>
                <div className="mt-2 space-y-1 border-t border-line/70 pt-2.5">
                  {[
                    ['复核范围', '仅「待确认」「瑕疵片」两栏'],
                    ['复核项目', '人数归属、闭眼、半截头、表情崩坏'],
                    ['不复核', '模糊、曝光、黑白（本地引擎判得更准）'],
                    ['费用额度', dailyLimit > 0 ? `云端费平台承担、不扣积分；每天可复审 ${dailyLimit} 张，次日恢复` : '云端费由平台承担、不扣积分；每天有上限，次日恢复']
                  ].map(([k, v]) => (
                    <div key={k} className="flex gap-3 text-[12px] leading-5">
                      <span className="w-14 shrink-0 text-[10px] leading-5 text-fg3">{k}</span>
                      <span className="min-w-0 flex-1 text-fg2">{v}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-2 text-[10px] leading-relaxed text-fg3">
                  {isMember
                    ? '开关在顶栏「AI 复审」，跑动时两页顶部有进度条；完整说明见侧栏「教程中心」→「AI 复审」。'
                    : '完整说明见侧栏「教程中心」→「AI 复审」。'}
                </div>
              </>
            )}
          </div>

          {auth.loggedIn && (
            <>
            {/* 两个积分数字：会员期间不扣积分，数字不抹不置零，只划横线 + 改浅（冻结），右边一句说清为什么。
                非会员一切照旧（品牌色实底数字，不划横线）。 */}
            <div className="mt-4 flex items-center gap-6">
              <div>
                <div className={isMember ? 'text-2xl font-bold text-fg3 line-through tabular-nums' : 'text-2xl font-bold text-brand tabular-nums'} title={isMember ? '会员期间筛选不扣积分，余额保持不动；到期后接着从这里扣' : undefined}>
                  {balance}
                </div>
                <div className="text-xs text-fg2">当前积分</div>
              </div>
              <div>
                <div
                  className={(isMember ? 'text-2xl font-bold text-fg3 line-through tabular-nums' : 'text-2xl font-bold text-fg tabular-nums') + ' cursor-pointer hover:text-brand transition-colors'}
                  title={isMember ? '会员期间不计消耗，到期后恢复累计；点击仍可查看历史消费记录' : '点击查看消费记录'}
                  onClick={() => void openHistory()}
                >
                  {user?.points.total_consumed ?? 0}
                </div>
                <div className="text-xs text-fg2">
                  累计消耗
                  <button className="ml-1.5 text-brand hover:underline cursor-pointer" onClick={() => void openHistory()}>
                    消费记录
                  </button>
                </div>
              </div>
              <div className="flex-1" />
              {isMember && (
                // 只解释“这两条横线是什么意思”，不重复下面那句“会员不扣积分”的规矩（同一信息只留一处）；
                // 层级靠排版：小字靠右、不给边框色块（数字上的横线已是标记）
                <div className="shrink-0 text-right text-[11px] leading-relaxed text-warn">
                  会员期间不扣积分
                  <div className="text-fg3">会员到期后即恢复积分制</div>
                </div>
              )}
            </div>

            {/* 兑换码：单独一张卡（用户 2026-10-15 定：原来挤在积分行下面不明显）；不弹窗直接兑，
                成功绿字/失败红字各一句（对齐消费记录正负色）。层级靠排版：标题粗 fg，副标小字 fg2 */}
            <div className="mt-4 rounded-xl border border-line bg-panel2/40 p-4">
              <div className="text-sm font-bold text-fg">兑换码</div>
              <div className="mt-0.5 text-xs text-fg2">会员码延长会员有效期，积分码加积分，兑换成功即可生效</div>
              <div className="mt-3 flex gap-2">
                <input
                  className="input flex-1 py-2 text-sm"
                  placeholder="粘贴 16 位兑换码，不区分大小写"
                  value={redeemCode}
                  maxLength={32}
                  onChange={(e) => { setRedeemCode(e.target.value); setRedeemMsg(null) }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !redeeming) void onRedeem() }}
                />
                <button
                  className="btn-primary text-sm px-6 whitespace-nowrap"
                  disabled={redeeming || !redeemCode.trim()}
                  onClick={() => void onRedeem()}
                >
                  {redeeming ? '兑换中…' : '兑换'}
                </button>
              </div>
              {redeemMsg && (
                <div className={'mt-2 text-xs leading-relaxed ' + (redeemMsg.ok ? 'text-good' : 'text-bad')}>
                  {redeemMsg.text}
                </div>
              )}
            </div>
            </>
          )}
        </div>

        {/* 积分说明：会员时“到期后恢复积分制”已由积分行右边那句说了，这里不再重复一遍，只留计费单位与赠分规则 */}
        <div className="px-5 py-3 text-xs text-fg2 bg-panel2/50 border-b border-line">
          {isMember
            ? <>1 张照片消耗 <b className="text-fg">1 积分</b>；新会员赠送积分，赠送部分不会因为开通会员而少。</>
            : <>1 张照片消耗 <b className="text-fg">1 积分</b>；开通会员后筛选<b className="text-fg">不扣积分</b>，且新会员赠送积分。</>}
        </div>

        {/* 未登录：不给看套餐（用户 2026-10-15 定），但得给两条路：注册拿免费积分，或直接扫码问客服 */}
        {!auth.loggedIn ? (
          <div className="p-8 text-center">
            <div className="text-4xl mb-3">🔒</div>
            <div className="text-sm text-fg mb-1.5">登录后即可查看积分余额与会员状态</div>
            <div className="text-xs text-fg2 mb-5">新注册送 500 积分，相当于免费体验 500 张筛选</div>
            <div className="flex items-center justify-center gap-2">
              <button className="btn-primary" onClick={() => { close(); openLogin() }}>去登录 / 注册</button>
              <button className="btn" onClick={() => openContactQr()} title="不注册也可以先扫码咨询：开通、充值、问价都找客服">联系客服开通</button>
            </div>
          </div>
        ) : (
          <>
            {/* 套餐 */}
            <div ref={plansRef} className="p-5">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-sm font-semibold text-fg">会员套餐</span>
                {/* 专属感强化：标题旁挂一枚品牌色小章，强调「AI 复审」是开通会员才解锁的特权（与卡片内高亮行呼应） */}
                <span className="chip bg-brand/15 text-brand border border-brand/40">👑 含 AI 复审特权</span>
              </div>
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
                    {/* 套餐卡只留一句 AI 复审权益（用户 2026-10-15 定：详细介绍全砍，权益讲清楚是上方特权卡的事，
                        卡片别再重复一遍——同一信息只留一处） */}
                    <div
                      className="mt-2 min-h-[1.25em] text-xs font-medium text-brand"
                      title="会员专属特权：筛完后自动用云端 AI 复核「待确认」照片，只给建议、点采纳才生效"
                    >
                      🔓 解锁 AI 复审（会员专属）
                    </div>
                    <button className="btn-primary w-full mt-2 text-xs py-1" onClick={() => buy(plan)} title="扫码加客服，报这一档名字付款（本软件不在应用内直接收款）">
                      开通
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* 充值积分也得能拿到码：以前二维码藏在“下单后”那块里，现在整页不再摆码，
                不把这个入口做成可点的，想单独充值的人就真的无处找码了（仍遵守“只有点下去才弹码”）。 */}
            <div className="px-5 pb-5 text-[11px] leading-relaxed text-fg3">
              本软件不在应用内直接收款。如需单独充值积分或有其他问题，
              <button className="text-brand hover:underline cursor-pointer" onClick={() => openContactQr()}>点这里看客服微信二维码</button>
              。
            </div>

            {/* 下单后那块（订单号 + 内嵌二维码）已整块搬进 ContactServiceDialog，不再在滚动区底部重复一份。 */}
          </>
        )}
      </div>

      {/* 消费记录弹窗（叠加在会员中心之上） */}
      {histOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={(e) => e.target === e.currentTarget && setHistOpen(false)}>
          <div className="w-[460px] max-h-[70vh] flex flex-col bg-panel border border-line rounded-2xl shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-line">
              <h3 className="text-[15px] font-bold text-fg">消费记录</h3>
              <button className="btn-ghost text-fg3" onClick={() => setHistOpen(false)} title="关闭">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-2">
              {histLoading && <div className="text-xs text-fg2 py-8 text-center">加载中…</div>}
              {!histLoading && histErr && <div className="text-xs text-bad py-8 text-center">{histErr}</div>}
              {!histLoading && !histErr && !histItems.length && <div className="text-xs text-fg3 py-8 text-center">暂无消费记录</div>}
              {!histLoading && !histErr && (
                <ul className="divide-y divide-line">
                  {histItems.map((it, i) => (
                    <li key={i} className="py-2.5 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-fg truncate">{histTitle(it)}</div>
                        {histDetail(it) && (
                          <div className="text-[11px] text-fg3 mt-0.5 truncate">{histDetail(it)}</div>
                        )}
                        <div className="text-[11px] text-fg3">{it.consume_time}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className={'text-sm font-bold tabular-nums ' + (it.consume_points < 0 ? 'text-bad' : it.consume_points > 0 ? 'text-good' : 'text-fg3')}>
                          {it.consume_points > 0 ? '+' : ''}
                          {it.consume_points}
                        </div>
                        <div className="text-[11px] text-fg3 tabular-nums">余 {it.remaining_points}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex items-center justify-between px-5 py-3 border-t border-line">
              <button className="btn text-xs disabled:opacity-40" disabled={histLoading || histPage <= 1} onClick={() => void loadHistory(histPage - 1)}>上一页</button>
              <span className="text-xs text-fg2">第 {histPage} / {histPages} 页</span>
              <button className="btn text-xs disabled:opacity-40" disabled={histLoading || histPage >= histPages} onClick={() => void loadHistory(histPage + 1)}>下一页</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
