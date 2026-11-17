import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useSession } from '../../auth/SessionProvider'
import type { CommunityReport, MarketTemplate } from './types'
import { useCommunityRequest } from './useCommunityRequest'
export function ReportTemplate({ card }: { card: MarketTemplate }) {
  const { user } = useSession()
  const [open, setOpen] = useState(false), [done, setDone] = useState(false)
  const [reason, setReason] = useState<CommunityReport['reason']>('misleading'), [details, setDetails] = useState('')
  const { submit, locked, feedback } = useCommunityRequest()
  if (!open) return <button type="button" className="text-link" onClick={() => setOpen(true)}>举报这个模板</button>
  return <section className="plan-notice"><h2>举报模板</h2>{done ? <p role="status">举报已提交，审核人员会核对这个公开版本。</p> : user ? <form onSubmit={async (event) => { event.preventDefault(); const result = await submit({ action: 'report', listingId: card.id, templateVersion: card.templateVersion, reason, details }); if (result) setDone(true) }}><fieldset className="plan-form-fields" disabled={locked}><label>原因<select value={reason} onChange={(event) => setReason(event.target.value as CommunityReport['reason'])}><option value="misleading">功能或说明有误</option><option value="privacy">泄露个人信息</option><option value="unsafe">有害内容</option><option value="other">其他问题</option></select></label><label>补充说明<textarea maxLength={1000} value={details} onChange={(event) => setDetails(event.target.value)} /></label><button className="button primary">提交举报</button></fieldset>{feedback}</form> : <Link className="text-link" to={`/login?next=${encodeURIComponent(location.pathname)}`}>登录后提交举报</Link>}<button className="text-link" type="button" onClick={() => setOpen(false)}>关闭</button></section>
}
