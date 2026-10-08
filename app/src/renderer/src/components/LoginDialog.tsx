/**
 * 登录 / 注册对话框（③）
 * - 双 Tab：登录（账号=手机号/邮箱统一放 phone 字段）/ 注册（手机号或邮箱 + 验证码 + 密码）
 * - 验证码发送带 60s 倒计时；注册成功后自动登录（见 auth.ts）
 * - 对接 API：login.php / register.php / send_captcha.php
 */
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'

type Tab = 'login' | 'register'
type Contact = 'phone' | 'email'

export default function LoginDialog(): JSX.Element | null {
  const showLogin = useStore((s) => s.showLogin)
  const close = useStore((s) => s.closeLogin)
  const doLogin = useStore((s) => s.doLogin)
  const doRegister = useStore((s) => s.doRegister)
  const sendCaptcha = useStore((s) => s.sendCaptcha)

  const [tab, setTab] = useState<Tab>('login')
  const [contact, setContact] = useState<Contact>('phone')
  const [account, setAccount] = useState('')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
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

  const reset = (): void => {
    setErr('')
  }

  const onSendCaptcha = async (): Promise<void> => {
    setErr('')
    const who = contact === 'email' ? { email, type: 'register' as const } : { phone: account, type: 'register' as const }
    if (contact === 'email' ? !email : !account) {
      setErr(contact === 'email' ? '请先填写邮箱' : '请先填写手机号')
      return
    }
    setBusy(true)
    const r = await sendCaptcha(who)
    setBusy(false)
    if (r.ok) setCountdown(60)
    else setErr(r.message)
  }

  const onSubmit = async (): Promise<void> => {
    setErr('')
    setBusy(true)
    try {
      if (tab === 'login') {
        const acc = account.trim()
        if (!acc || !password) {
          setErr('请填写账号和密码')
          return
        }
        const r = await doLogin(acc, password)
        if (!r.ok) setErr(r.message)
      } else {
        const identifier = contact === 'email' ? email.trim() : account.trim()
        if (!identifier || !password || !code) {
          setErr('请完整填写手机号/邮箱、验证码和密码')
          return
        }
        if (password.length < 6) {
          setErr('密码至少 6 位')
          return
        }
        const req = contact === 'email' ? { email: identifier, password, code } : { phone: identifier, password, code }
        const r = await doRegister(req)
        if (!r.ok) setErr(r.message)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 fade-in" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="w-[380px] bg-panel border border-line rounded-2xl shadow-2xl p-5">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-bold text-fg">欢迎使用筛图大师</h2>
          <button className="btn-ghost text-fg3" onClick={close} title="关闭（Esc）">✕</button>
        </div>
        <p className="text-xs text-fg2 mb-4">登录后可开始 AI 筛选，1 张照片消耗 1 积分，会员不扣积分。</p>

        <div className="flex gap-1 mb-4 bg-panel2 rounded-lg p-1">
          <button
            className={'flex-1 py-1.5 rounded-md text-sm transition-colors ' + (tab === 'login' ? 'bg-brand text-white' : 'text-fg2 hover:text-fg')}
            onClick={() => { setTab('login'); reset() }}
          >
            登录
          </button>
          <button
            className={'flex-1 py-1.5 rounded-md text-sm transition-colors ' + (tab === 'register' ? 'bg-brand text-white' : 'text-fg2 hover:text-fg')}
            onClick={() => { setTab('register'); reset() }}
          >
            注册
          </button>
        </div>

        {tab === 'register' && (
          <div className="flex gap-1 mb-3 text-xs">
            <button
              className={'flex-1 py-1 rounded-md border transition-colors ' + (contact === 'phone' ? 'border-brand text-brand bg-brand/10' : 'border-line text-fg2')}
              onClick={() => setContact('phone')}
            >
              手机号注册
            </button>
            <button
              className={'flex-1 py-1 rounded-md border transition-colors ' + (contact === 'email' ? 'border-brand text-brand bg-brand/10' : 'border-line text-fg2')}
              onClick={() => setContact('email')}
            >
              邮箱注册
            </button>
          </div>
        )}

        <div className="space-y-3">
          {tab === 'login' ? (
            <input
              className="input w-full"
              placeholder="手机号 / 邮箱"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              autoFocus
            />
          ) : (
            <>
              {contact === 'phone' ? (
                <input
                  className="input w-full"
                  placeholder="手机号"
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                  autoFocus
                />
              ) : (
                <input
                  className="input w-full"
                  placeholder="邮箱"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoFocus
                />
              )}
              <div className="flex gap-2">
                <input
                  className="input flex-1"
                  placeholder="验证码"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
                <button
                  className="btn whitespace-nowrap disabled:opacity-50"
                  disabled={busy || countdown > 0}
                  onClick={() => void onSendCaptcha()}
                >
                  {countdown > 0 ? `${countdown}s` : '获取验证码'}
                </button>
              </div>
            </>
          )}

          <input
            className="input w-full"
            type="password"
            placeholder={tab === 'register' ? '设置密码（至少 6 位）' : '密码'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void onSubmit() }}
          />

          {err && <div className="text-xs text-bad">{err}</div>}

          <button className="btn-primary w-full disabled:opacity-50" disabled={busy} onClick={() => void onSubmit()}>
            {busy ? '处理中…' : tab === 'login' ? '登录' : '注册并登录'}
          </button>

          <button className="btn-ghost w-full text-xs text-fg3" onClick={close}>
            暂不登录，先逛逛
          </button>
        </div>
      </div>
    </div>
  )
}
