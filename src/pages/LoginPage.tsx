import { useState, type FormEvent } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useSession } from '../auth/SessionProvider'
import { api } from '../lib/api'

export function LoginPage() {
  const { user, authenticate } = useSession()
  const [params] = useSearchParams()
  const [mode, setMode] = useState<'login' | 'register' | 'reset'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [challengeId, setChallengeId] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [cooldownUntil, setCooldownUntil] = useState(0)
  const destination = params.get('next')
  const next = destination?.startsWith('/') && !destination.startsWith('//') ? destination : '/plans'
  if (user) return <Navigate to={next} replace />

  function changeMode(value: typeof mode) { setMode(value); setPassword(''); setCode(''); setChallengeId(''); setFeedback('') }
  async function sendCode() {
    if (!email || mode === 'login' || Date.now() < cooldownUntil) return
    setBusy(true)
    setFeedback('')
    try {
      const response = await api<{ challengeId: string; retryAfter: number; message: string }>('/v1/auth/web/email/code', { method: 'POST', body: { email, purpose: mode } })
      setChallengeId(response.challengeId)
      setCooldownUntil(Date.now() + response.retryAfter * 1000)
      setFeedback(response.message)
    } catch (reason) { setFeedback(reason instanceof Error ? reason.message : '验证码发送失败，请重试。') }
    finally { setBusy(false) }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setFeedback('')
    try {
      if (mode === 'reset') {
        await api('/v1/auth/web/email/reset', { method: 'POST', body: { email, password, code, challengeId } })
        changeMode('login')
        setFeedback('密码已重置，请使用新密码登录。')
      } else await authenticate(mode, mode === 'login' ? { email, password } : { email, password, code, challengeId })
    } catch (reason) { setFeedback(reason instanceof Error ? reason.message : '登录没有完成，请重试。') }
    finally { setBusy(false) }
  }

  return <div className="standard-page auth-page">
    <Link className="text-link" to="/chat"><ArrowLeft size={16} />返回对话</Link>
    <header className="page-heading"><h1>{mode === 'login' ? '欢迎回来' : mode === 'register' ? '开始记录你的日常' : '找回密码'}</h1><p>{mode === 'register' ? '使用受邀邮箱注册 PlanPlan。' : '登录后，继续你的计划与记录。'}</p></header>
    <form className="data-form" onSubmit={(event) => void submit(event)}>
      <label>邮箱<input type="email" autoComplete="email" required value={email} onChange={(event) => { setEmail(event.target.value); setChallengeId('') }} disabled={busy} /></label>
      {mode !== 'login' && <label>邮箱验证码<div className="input-with-action"><input value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" pattern="[0-9]{8}" maxLength={8} autoComplete="one-time-code" required disabled={busy} /><button className="button secondary" type="button" disabled={busy || !email} onClick={() => { if (Date.now() < cooldownUntil) setFeedback('请稍等片刻再发送验证码。'); else void sendCode() }}>发送验证码</button></div></label>}
      <label>{mode === 'login' ? '密码' : '设置密码'}<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'login' ? 1 : 15} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} />{mode !== 'login' && <span className="field-hint">至少 15 个字符，可以使用一句好记的话。</span>}</label>
      {mode === 'register' && <label className="check-label"><input type="checkbox" required />我已阅读并同意<a href="/legal/terms" target="_blank" rel="noreferrer">用户协议</a>和<a href="/legal/privacy" target="_blank" rel="noreferrer">隐私政策</a></label>}
      {feedback && <p className="inline-feedback" role="status">{feedback}</p>}
      <button className="button primary" disabled={busy || (mode !== 'login' && !challengeId)}>{busy ? '正在处理…' : mode === 'login' ? '登录' : mode === 'register' ? '注册并登录' : '重置密码'}</button>
    </form>
    <div className="auth-links">{mode === 'login' ? <><button type="button" disabled={busy} onClick={() => changeMode('register')}>注册账户</button><button type="button" disabled={busy} onClick={() => changeMode('reset')}>忘记密码？</button></> : <button type="button" disabled={busy} onClick={() => changeMode('login')}>已有账户，去登录</button>}</div>
  </div>
}
