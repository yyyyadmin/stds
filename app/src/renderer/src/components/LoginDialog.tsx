/**
 * 登录 / 注册对话框（③）
 * - 左右两栏（880px 宽）：左是品牌展示区（把「本地跑图 / 1 张 1 积分 / 新号送 500 积分」三句摆够气派），右是表单
 * - 登录两种走法：密码 / 验证码。验证码复用注册那套发码接口，只是 type 从 register 换成 login；
 *   提交时手机号发 {phone, code}、邮箱发 {email, code}（见 auth.ts 的 loginWithCode）
 * - 注册：手机号或邮箱 + 验证码 + 密码，注册成功自动登录
 * - 底部协议勾选：默认不勾，不勾就一个登录/注册请求都不发（用户 2026-10-15 定，合规要求）
 *
 * 状态一律不持久化，也不用手动 reset：App 里是 {showLogin && <LoginDialog />}，关掉即卸载，
 * 重开自然回到「空表单 + 未勾选」。反过来，读协议时本框不关（协议弹窗 z-[80] 压在上面），
 * 回来时勾没勾、填到哪都还在——不然用户读完回来发现白填一遍，比多一次点击更恼火。
 *
 * 一稿做成 520px 被用户判"太小气不好看"（2026-10-15），这稿的改法不是等比放大，而是：
 * 左栏给到真展示区（大字号品名 + 三行带留白的卖点 + 一处柔光），右栏表单靠"高度和留白"呼吸
 * ——输入框 52px 高、字号 15px、行间 20px、标题 22px；二级选项（密码/验证码、手机号/邮箱）
 * 从带边框的小方块换成 underline 文字页签，少两层框就少一分小气（用户审美红线：层级靠排版）。
 */
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import AgreementDialog from './AgreementDialog'
import { USER_AGREEMENT, PRIVACY_POLICY } from '../agreements'

type Tab = 'login' | 'register'
type Contact = 'phone' | 'email'
type LoginMode = 'password' | 'code'

/** 左栏三句卖点。措辞逐条对着代码核实过，不能为了好看吹：复审确实会把那一张送出本机，所以第 1 句明说 */
const BRAND_POINTS: Array<[string, string, string]> = [
  ['🖼', '原片默认不出本机', '识别全在你电脑上跑；只有开了 AI 复审，那一张才压缩后送云端'],
  ['⚡', '1 张照片 1 积分', '开通会员后筛选不扣积分，云端复审的模型费由平台承担'],
  ['🎁', '新注册送 500 积分', '相当于免费体验 500 张，不用先付钱']
]

export default function LoginDialog(): JSX.Element | null {
  const showLogin = useStore((s) => s.showLogin)
  const close = useStore((s) => s.closeLogin)
  const doLogin = useStore((s) => s.doLogin)
  const doLoginCode = useStore((s) => s.doLoginCode)
  const doRegister = useStore((s) => s.doRegister)
  const sendCaptcha = useStore((s) => s.sendCaptcha)

  const [tab, setTab] = useState<Tab>('login')
  const [loginMode, setLoginMode] = useState<LoginMode>('password')
  const [contact, setContact] = useState<Contact>('phone')
  const [account, setAccount] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [reading, setReading] = useState<'user' | 'privacy' | null>(null)
  const [countdown, setCountdown] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (countdown <= 0) return
    timerRef.current = setInterval(() => setCountdown((c) => (c <= 1 ? 0 : c - 1)), 1000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [countdown])

  if (!showLogin) return null

  // 账号是一个框同时收手机号和邮箱（密码登录本来就这样，后端 phone 字段认邮箱）。
  // 再让他多选一次"手机号还是邮箱"纯属多余：有没有 @ 一眼就能定，发码和提交都按它走。
  // （注册区仍保留显式分段——那里要在填之前就知道码发到哪。）
  const trimAccount = (): string => account.trim()
  const accountIsEmail = (v: string): boolean => v.includes('@')

  /** 协议闸门：没勾就一个请求都不发。返回 false 时错误提示已经写好 */
  const gateAgreement = (): boolean => {
    if (agreed) return true
    setErr('请先阅读并勾选《用户注册协议》和《隐私政策》')
    return false
  }

  /** 界面只认这个错字：走到这一步只能是 IPC 本身抛了（通道没注册 / 主进程比界面旧）。
   *  以前不接住，失败就是“点登录什么也没发生”（用户 2026-10-15 实测），比报个错难查得多。 */
  const crashHint = (e: unknown, what: string): string =>
    '【' + what + '失败】' + String((e as Error)?.message ?? e) + '——请重启软件后再试'

  /** 发验证码，登录和注册共用这一个口子，只有 type 不同（login / register） */
  const sendCode = async (useEmail: boolean, type: 'login' | 'register'): Promise<void> => {
    setErr('')
    const who = trimAccount()
    if (!who) {
      setErr('请先填写手机号或邮箱')
      return
    }
    setBusy(true)
    let r: { ok: boolean; message: string }
    try {
      r = await sendCaptcha(useEmail ? { email: who, type } : { phone: who, type })
    } catch (e) {
      setBusy(false)
      setErr(crashHint(e, '发送验证码'))
      return
    }
    setBusy(false)
    // 倒计时是全局 60 秒一道闸：切 Tab / 换登录方式都不清零，宁可让他多等几秒，也不能给刷短信留口子
    if (r.ok) setCountdown(60)
    else setErr(r.message)
  }

  const onSubmit = async (): Promise<void> => {
    setErr('')
    if (!gateAgreement()) return
    // 粘贴进来的验证码常常带个空格或换行，带上去后端一定判错，而报错文案只会说“验证码错误或已过期”
    const c = code.trim()
    setBusy(true)
    try {
      if (tab === 'login' && loginMode === 'password') {
        const acc = trimAccount()
        if (!acc || !password) {
          setErr('请填写账号和密码')
          return
        }
        const r = await doLogin(acc, password)
        if (!r.ok) setErr(r.message)
      } else if (tab === 'login') {
        const acc = trimAccount()
        if (!acc || !c) {
          setErr('请填写账号和验证码')
          return
        }
        const r = await doLoginCode(accountIsEmail(acc) ? { email: acc, code: c } : { phone: acc, code: c })
        if (!r.ok) setErr(r.message)
      } else {
        const identifier = trimAccount()
        if (!identifier || !password || !c) {
          setErr('请完整填写手机号/邮箱、验证码和密码')
          return
        }
        if (password.length < 6) {
          setErr('密码至少 6 位')
          return
        }
        const req = contact === 'email' ? { email: identifier, password, code: c } : { phone: identifier, password, code: c }
        const r = await doRegister(req)
        if (!r.ok) setErr(r.message)
      }
    } catch (e) {
      setErr(crashHint(e, tab === 'login' ? '登录' : '注册'))
    } finally {
      setBusy(false)
    }
  }

  /* ---------- 样式小工具：一处定义，避免同一个类串抄四遍 ---------- */
  const primaryTab = (on: boolean): string =>
    'flex-1 rounded-lg py-2.5 text-[15px] transition-colors ' + (on ? 'bg-panel text-fg font-semibold shadow-sm' : 'text-fg2 hover:text-fg')
  // 二级选项（登录方式 / 注册用手机号还是邮箱）：underline 文字页签，不再套方框
  const underline = (on: boolean): string =>
    '-mb-px cursor-pointer border-b-2 pb-2.5 text-[14px] transition-colors ' +
    (on ? 'border-brand font-semibold text-brand' : 'border-transparent text-fg2 hover:text-fg')
  const fieldLabel = (t: string): JSX.Element => <span className="mb-1.5 block text-[12px] text-fg2">{t}</span>
  const inputCls = 'input h-[52px] w-full rounded-xl px-4 text-[15px]'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 fade-in" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="flex max-h-[92vh] w-[min(880px,95vw)] overflow-hidden rounded-3xl border border-line bg-panel shadow-2xl">
        {/* ============ 左：品牌展示区 ============ */}
        {/* 一块渐变底 + 一处柔光把这一栏撑起来，不画格子；品名 26px 压场，卖点 14/12 两级，全靠留白分行 */}
        <aside className="relative hidden w-[44%] shrink-0 flex-col justify-between overflow-hidden border-r border-line bg-gradient-to-br from-brand/16 via-brand/[0.05] to-transparent p-9 md:flex">
          <div className="pointer-events-none absolute -right-12 -top-16 h-48 w-48 rounded-full bg-brand/15 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-20 -left-10 h-44 w-44 rounded-full bg-warn/10 blur-3xl" />

          <div className="relative">
            <div className="text-[26px] font-bold leading-none tracking-wide text-fg">筛片大师</div>
            <div className="mt-3 text-[13px] leading-relaxed text-fg2">摄影批量筛图 · 本地 AI 引擎</div>
          </div>

          <div className="relative space-y-6 py-8">
            {BRAND_POINTS.map(([icon, t, d]) => (
              <div key={t} className="flex gap-3.5">
                <span className="mt-[3px] shrink-0 text-[17px] leading-none">{icon}</span>
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold leading-5 text-fg">{t}</div>
                  <div className="mt-1.5 text-[12px] leading-relaxed text-fg2">{d}</div>
                </div>
              </div>
            ))}
          </div>

          {/* 一句实话收尾：筛选确实要登录才能跑（startScan 里有闸），别写成"不登录也能用"骗人 */}
          <div className="relative border-t border-line/70 pt-4 text-[11px] leading-relaxed text-fg3">
            开始筛选需要登录；照片存在你自己的电脑上，账号只用来管积分和会员。
          </div>
        </aside>

        {/* ============ 右：表单 ============ */}
        <div className="relative flex min-w-0 flex-1 flex-col overflow-y-auto px-10 py-9">
          <div className="mb-6 flex items-start justify-between">
            <div className="min-w-0">
              <h2 className="text-[22px] font-bold leading-tight text-fg">{tab === 'login' ? '欢迎回来' : '创建账号'}</h2>
              <p className="mt-2 text-[13px] leading-relaxed text-fg2">
                {tab === 'login' ? '登录后即可开始 AI 筛选与云端复审' : '注册即送 500 积分，填完自动登录'}
              </p>
            </div>
            <button className="btn-ghost -mr-2 -mt-1 shrink-0 px-3 py-2 text-[17px] text-fg3" onClick={close} title="关闭">
              ✕
            </button>
          </div>

          <div className="mb-6 flex gap-1.5 rounded-xl bg-panel2 p-1.5">
            <button className={primaryTab(tab === 'login')} onClick={() => { setTab('login'); setErr('') }}>登录</button>
            <button className={primaryTab(tab === 'register')} onClick={() => { setTab('register'); setErr(''); setCode('') }}>注册</button>
          </div>

          <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); void onSubmit() }}>
            {tab === 'login' ? (
              <div className="flex gap-6 border-b border-line">
                <button type="button" className={underline(loginMode === 'password')} onClick={() => { setLoginMode('password'); setErr('') }}>
                  密码登录
                </button>
                <button type="button" className={underline(loginMode === 'code')} onClick={() => { setLoginMode('code'); setErr('') }}>
                  验证码登录
                </button>
              </div>
            ) : (
              <div className="flex gap-6 border-b border-line">
                <button type="button" className={underline(contact === 'phone')} onClick={() => { setContact('phone'); setErr('') }}>
                  手机号注册
                </button>
                <button type="button" className={underline(contact === 'email')} onClick={() => { setContact('email'); setErr('') }}>
                  邮箱注册
                </button>
              </div>
            )}

            <div>
              {fieldLabel(tab === 'login' ? '手机号 / 邮箱' : contact === 'email' ? '邮箱' : '手机号')}
              <input
                className={inputCls}
                placeholder={tab === 'login' ? '注册时用的手机号或邮箱' : contact === 'email' ? 'name@example.com' : '11 位手机号'}
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                autoFocus
              />
            </div>

            {((tab === 'login' && loginMode === 'code') || tab === 'register') && (
              <div>
                {fieldLabel('验证码')}
                <div className="flex gap-3">
                  <input
                    className={inputCls + ' min-w-0 flex-1'}
                    placeholder="6 位验证码"
                    inputMode="numeric"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn h-[52px] shrink-0 rounded-xl px-5 text-[14px] disabled:opacity-50"
                    disabled={busy || countdown > 0}
                    onClick={() => void sendCode(tab === 'login' ? accountIsEmail(account.trim()) : contact === 'email', tab === 'login' ? 'login' : 'register')}
                  >
                    {countdown > 0 ? `${countdown}s 后重发` : '获取验证码'}
                  </button>
                </div>
                {tab === 'login' && (
                  <div className="mt-2 text-[12px] leading-relaxed text-fg3">
                    {accountIsEmail(account.trim())
                      ? '验证码发到这个邮箱，收不到请查垃圾箱'
                      : account.trim()
                        ? '验证码发到这个手机号；一直收不到就切回「密码登录」'
                        : '手机号或邮箱都可以，验证码直接发到那里'}
                  </div>
                )}
              </div>
            )}

            {(tab === 'register' || loginMode === 'password') && (
              <div>
                {fieldLabel(tab === 'register' ? '设置密码' : '密码')}
                <input
                  className={inputCls}
                  type="password"
                  placeholder={tab === 'register' ? '至少 6 位' : '输入密码'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            )}

            {/* 协议闸门：默认不勾。两个协议名是可点的，点开是应用内全文（离线软件挂外链等于没履行告知）；
                button 里必须 preventDefault，否则它在这个 label 里，点协议名会顺手把勾打上 */}
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                className="mt-[4px] h-4 w-4 shrink-0 cursor-pointer accent-brand"
                checked={agreed}
                onChange={(e) => { setAgreed(e.target.checked); if (e.target.checked) setErr('') }}
              />
              <span className="text-[12px] leading-relaxed text-fg2">
                我已阅读并同意
                <button type="button" className="cursor-pointer text-brand hover:underline" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setReading('user') }}>
                  《用户注册协议》
                </button>
                和
                <button type="button" className="cursor-pointer text-brand hover:underline" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setReading('privacy') }}>
                  《隐私政策》
                </button>
                ，知悉照片默认只在本机处理。
              </span>
            </label>

            {err && (
              <div className="rounded-xl border border-bad/30 bg-bad/10 px-4 py-3 text-[13px] leading-relaxed text-bad">{err}</div>
            )}

            <button type="submit" className="btn-primary w-full rounded-xl py-3.5 text-[16px] font-medium disabled:opacity-50" disabled={busy}>
              {busy ? '处理中…' : tab === 'login' ? '登录' : '注册并登录'}
            </button>

            <button type="button" className="btn-ghost w-full py-1 text-[13px] text-fg3" onClick={close}>
              暂不登录，先逛逛
            </button>
          </form>
        </div>
      </div>

      {reading && <AgreementDialog doc={reading === 'user' ? USER_AGREEMENT : PRIVACY_POLICY} onClose={() => setReading(null)} />}
    </div>
  )
}
