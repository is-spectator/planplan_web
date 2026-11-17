import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Download, FilePenLine, LogOut, Monitor, Moon, Sun, UserRound } from 'lucide-react'
import { FeedbackPanel } from '../features/feedback/FeedbackPanel'
import { RecoveryCenter } from '../components/RecoveryCenter'
import { useTheme } from '../theme/ThemeProvider'
import { useSession } from '../auth/SessionProvider'
import { api } from '../lib/api'
import { RecoveryFeedback, useRecovery } from '../lib/RecoveryProvider'

const themes = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
] as const
interface LegalMetadata { consentVersion: string; aiRecipient: string; aiService: string; aiProcessingDisclosure: string; modelUsageDisclosure: string }

export function AccountPage() {
  const { theme, setTheme } = useTheme()
  const { user, loading, error, accountNotice, request, refresh, logout, deleteAccount } = useSession()
  const { entry } = useRecovery()
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [confirmation, setConfirmation] = useState<'logout' | 'delete' | null>(null)
  const [password, setPassword] = useState('')
  const [deletionWord, setDeletionWord] = useState('')
  const legal = useQuery({ queryKey: ['legal'], queryFn: ({ signal }) => api<LegalMetadata>('/legal/metadata', { signal }), enabled: !!user })

  async function consent(granted: boolean) {
    if (busy || (granted && !legal.data)) return
    setBusy(true); setFeedback('')
    try {
      await request('/v1/me/ai-consent', { method: 'PUT', body: { granted, ...(granted ? { consentVersion: legal.data!.consentVersion } : {}) } })
      await refresh()
      setFeedback(granted ? '已开启 AI 对话。' : '已关闭 AI 对话，手动记录仍可使用。')
    } catch (reason) { setFeedback(reason instanceof Error ? reason.message : '设置没有完成，请重试。') }
    finally { setBusy(false) }
  }
  async function exportData() {
    if (!user || busy) return
    setBusy(true); setFeedback('')
    try {
      const blob = await request<Blob>('/v1/export', { responseType: 'blob' })
      const url = URL.createObjectURL(blob)
      const download = document.createElement('a')
      download.href = url; download.download = `planplan-${user.today}.zip`
      download.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setFeedback('导出文件已生成。')
    } catch (reason) { setFeedback(reason instanceof Error ? reason.message : '导出失败，请重试。') }
    finally { setBusy(false) }
  }
  async function confirmAction() {
    if (!user || busy || entry) return
    setBusy(true); setFeedback('')
    try {
      if (confirmation === 'logout') {
        await logout()
      } else if (confirmation === 'delete') {
        await deleteAccount(deletionWord, password)
      }
      setConfirmation(null); setPassword(''); setDeletionWord('')
    } catch (reason) { setFeedback(reason instanceof Error ? reason.message : '操作没有完成，请重试。') }
    finally { setBusy(false) }
  }
  return <div className="standard-page account-page">
    <header className="page-heading"><h1>我的</h1><p>留一点空间，给自己的偏好。</p></header>
    <section className="account-card" aria-labelledby="account-title">
      <span className="account-avatar"><UserRound size={27} aria-hidden="true" /></span>
      <div><h2 id="account-title">{loading ? '正在读取账户…' : user ? '欢迎回来' : '欢迎来到 PlanPlan'}</h2>{!loading && !user && <Link className="text-link" to="/login">登录或注册</Link>}{user && <p className="field-hint">你的记录已与账户关联。</p>}</div>
    </section>
    {error && <div className="inline-feedback" role="alert">{error}<button className="button secondary" onClick={() => void refresh()}>重新连接</button></div>}
    <section className="settings-section" aria-labelledby="appearance-title">
      <div className="section-heading"><h2 id="appearance-title">外观</h2><p>选择看起来舒服的样子。</p></div>
      <fieldset className="theme-options"><legend className="sr-only">外观主题</legend>{themes.map(({ value, label, icon: Icon }) => <label key={value} className={`theme-option${theme === value ? ' selected' : ''}`}><input type="radio" name="theme" value={value} checked={theme === value} onChange={() => setTheme(value)} /><Icon size={21} aria-hidden="true" /><span>{label}</span></label>)}</fieldset>
    </section>
    <section className="settings-section"><h2>我的作品</h2><p>继续编辑草稿，或使用自己保存的模板。</p><Link className="button secondary" to="/create"><FilePenLine size={17} />查看我的作品</Link><Link className="text-link" to="/community">管理社区作品</Link>{user?.roles?.includes('reviewer') && <Link className="text-link" to="/review">模板审核</Link>}</section>
    {user && <>
      <RecoveryCenter /><FeedbackPanel />
      <section className="settings-section consent-section"><h2>AI 对话</h2>
        {user.aiConsent ? <><p>已开启。你可以通过对话记录和查询，也可以随时关闭。</p><button className="button secondary" disabled={busy} onClick={() => void consent(false)}>关闭 AI 对话</button></> : <>
          <p>开启后，发送的消息、相关计划和近期记录会交给 {legal.data?.aiRecipient ?? 'AI 服务商'} 处理。不开启也能手动创建计划和记录。</p>
          {legal.data && <details><summary>查看 AI 服务说明</summary><p>{legal.data.aiService}</p><p>{legal.data.aiProcessingDisclosure}</p><p>{legal.data.modelUsageDisclosure}</p></details>}
          {legal.isError && <p className="inline-feedback">暂时无法读取服务说明。<button type="button" className="text-button" onClick={() => void legal.refetch()}>重试</button></p>}
          <button className="button primary" disabled={busy || !legal.data} onClick={() => void consent(true)}>同意并开启 AI 对话</button>
        </>}
        <div className="action-row"><a className="text-link" href="/legal/privacy" target="_blank" rel="noreferrer">隐私政策</a><a className="text-link" href="/legal/terms" target="_blank" rel="noreferrer">用户协议</a></div>
      </section>
      <section className="settings-section"><h2>账户与数据</h2><div className="account-actions"><button className="button secondary" disabled={busy} onClick={() => void exportData()}><Download size={17} />导出数据</button><button className="button secondary" disabled={busy || !!entry} onClick={() => setConfirmation('logout')}><LogOut size={17} />退出所有设备</button><button className="button danger-button" disabled={busy || !!entry} onClick={() => setConfirmation('delete')}>删除账户</button></div></section>
      {entry && <RecoveryFeedback />}
      {confirmation && <form className="data-form confirmation-panel" onSubmit={(event) => { event.preventDefault(); void confirmAction() }}>
        <h2>{confirmation === 'logout' ? '退出所有设备？' : '删除账户？'}</h2><p>{confirmation === 'logout' ? '此浏览器、其他网页和手机上的登录都会失效。' : '账户及其计划、记录、草稿和反馈将被删除。公开作品停止展示，其他人已采用的模板副本继续可用，作者身份会移除。操作无法撤回，建议先导出数据。'}</p>
        {confirmation === 'delete' && <><label>输入 DELETE 确认<input required value={deletionWord} onChange={(event) => setDeletionWord(event.target.value)} pattern="DELETE" autoComplete="off" /></label><label>账户密码<input required type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label></>}
        <div className="action-row"><button className="button danger-button" disabled={busy}>{busy ? '正在处理…' : confirmation === 'logout' ? '确认退出所有设备' : '确认删除账户'}</button><button className="button secondary" type="button" disabled={busy} onClick={() => { setConfirmation(null); setPassword('') }}>取消</button></div>
      </form>}
    </>}
    {(feedback || accountNotice) && <p className="inline-feedback" role="status">{feedback || accountNotice}</p>}
  </div>
}
