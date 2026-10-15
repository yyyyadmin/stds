/**
 * 协议阅读弹窗：显示《用户注册协议》《隐私政策》全文（正文在 agreements.ts）。
 *
 * 为什么做成应用内弹窗而不是外部链接：这是离线桌面软件，合规要求点开的必须是真内容，
 * 挂一个会 404 的外链等于没履行告知义务；且 Electron 里 window.confirm / alert 本就不可依赖。
 *
 * 层级 z-[80]：要能从登录框（z-50）上面打开。登录框不能被协议挤走——用户是"看到勾选行
 * 里的协议名 → 点开读 → 关掉回到原地继续勾"，中间如果把登录框关了，他刚填的账号密码就没了。
 *
 * 排版按用户审美红线：层级靠字号与字重，不铺边框色块；正文用 text-sm，标题压场用 text-fg。
 */
import { useEffect } from 'react'
import type { AgreementDoc } from '../agreements'

/** 行内 **加粗**：协议里关键句（钱、照片权利、免责）用粗体提出来，不额外上颜色 */
function Rich({ text }: { text: string }): JSX.Element {
  const parts = text.split('**')
  return (
    <>
      {parts.map((seg, i) => (i % 2 === 1 ? <b key={i} className="text-fg font-semibold">{seg}</b> : <span key={i}>{seg}</span>))}
    </>
  )
}

export default function AgreementDialog({ doc, onClose }: { doc: AgreementDoc; onClose: () => void }): JSX.Element {
  // ESC 关掉本窗口：全局快捷键对普通弹窗本来就不响应 Escape（只有大图和标签浮层管），
  // 所以这里自己接，不必担心和别处的按键打架。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 fade-in p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-[640px] max-w-full max-h-[86vh] flex flex-col bg-panel border border-line rounded-2xl shadow-2xl overflow-hidden">
        <div className="shrink-0 px-6 py-4 border-b border-line flex items-center gap-3">
          <div className="min-w-0">
            <h3 className="text-[17px] font-bold text-fg">{doc.title}</h3>
            <div className="text-[11px] text-fg3 mt-0.5">
              版本 {doc.version} · 更新于 {doc.updated} · {doc.effective} 起生效
            </div>
          </div>
          <span className="flex-1" />
          <button className="btn-ghost text-fg3 shrink-0" onClick={onClose} title="关闭（Esc）">✕</button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
          <p className="text-[13px] leading-relaxed text-fg2 pb-4 mb-4 border-b border-line">
            <Rich text={doc.intro} />
          </p>
          {doc.blocks.map((b) => (
            <section key={b.h ?? ''} className="mb-5 last:mb-0">
              {b.h && <h4 className="text-[13px] font-bold text-fg mb-1.5">{b.h}</h4>}
              {b.p?.map((t, i) => (
                <p key={i} className="text-[13px] leading-[1.85] text-fg2 mb-2">
                  <Rich text={t} />
                </p>
              ))}
              {b.ul && (
                <ul className="space-y-1.5">
                  {b.ul.map((t, i) => (
                    <li key={i} className="text-[13px] leading-[1.85] text-fg2 pl-4 relative before:content-['·'] before:absolute before:left-1 before:text-fg3">
                      <Rich text={t} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
          <div className="pt-4 mt-2 border-t border-line text-[11px] leading-relaxed text-fg3">
            对本协议或隐私政策有疑问，请通过软件「会员中心」里的客服微信二维码联系我们。
          </div>
        </div>

        <div className="shrink-0 px-6 py-4 border-t border-line flex items-center gap-3">
          <span className="text-[11px] text-fg3">读完回到登录窗口，勾选同意即可继续</span>
          <span className="flex-1" />
          <button className="btn-primary text-sm px-5 py-2" onClick={onClose}>我已阅读</button>
        </div>
      </div>
    </div>
  )
}
