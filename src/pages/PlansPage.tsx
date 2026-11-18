import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, BookOpen, LayoutGrid, Plus, RefreshCw, Shapes, Wallet } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { PageState } from '../components/PageState'
import { OriginalMessage } from '../components/OriginalMessage'
import { useSession } from '../auth/SessionProvider'
import { chooseManualPlan, useManualIntent } from '../lib/manual-handoff'
import type { PlansResponse, PlanStatus } from '../lib/contracts'
import { useOperation } from '../lib/useOperation'
import { CreatePlanForm } from '../features/plans/CreatePlanForm'
import { PlanDetail } from '../features/plans/PlanDetail'
import { errorMessage, money } from '../features/plans/format'
import { metricText } from '../features/templates/dynamic-fields'
import '../styles/plans.css'

function SessionState() {
  const { loading, error, refresh } = useSession()
  if (loading) return <p className="plan-loading" role="status">正在读取账户…</p>
  return <PageState icon={<LayoutGrid size={28} />} title={error ? '暂时无法读取账户' : '登录后，开始积累'} tone={error ? 'error' : 'neutral'} action={<div className="plan-form-actions">{error && <button type="button" className="button plan-secondary" onClick={() => void refresh()}>重新连接</button>}<Link className="button primary" to="/login">登录或注册<ArrowRight size={17} aria-hidden="true" /></Link></div>}><p>{error ?? '你的所有计划，会在登录后显示在这里。'}</p></PageState>
}

export function PlansPage() {
  const { user } = useSession()
  return <div className="standard-page plans-page"><header className="page-heading"><h1>计划</h1><p>日常的开销，长久的习惯，都在这里慢慢积累。</p></header>{user ? <PlansContent key={user.id} /> : <SessionState />}</div>
}

function PlansContent() {
  const { user, request } = useSession()
  const navigate = useNavigate()
  const manual = useManualIntent()
  const choosing = manual?.kind === 'chat' && manual.planId === null
  const [status, setStatus] = useState<PlanStatus>('active')
  const shownStatus = choosing ? 'active' : status
  const [creating, setCreating] = useState(false)
  const { feedback } = useOperation()
  const query = useQuery({
    queryKey: ['user', user!.id, 'plans', shownStatus, user!.today],
    queryFn: ({ signal }) => request<PlansResponse>(`/v1/plans?status=${shownStatus}`, { signal }),
  })
  return <>
    {choosing && <section className="plan-notice" role="status"><h2>选择要记录的计划</h2><p>请点选一个进行中的计划后再填写。不会自动选中，也不会新建计划。</p><OriginalMessage text={manual.text} /></section>}
    <div className="plan-toolbar">
      <div className="plan-tabs" role="group" aria-label="计划状态"><button type="button" aria-pressed={shownStatus === 'active'} onClick={() => setStatus('active')}>进行中</button>{!choosing && <button type="button" aria-pressed={status === 'archived'} onClick={() => setStatus('archived')}>已归档</button>}</div>
      <div className="plan-toolbar-actions"><button type="button" className="button plan-secondary" aria-label="刷新计划" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} aria-hidden="true" /><span>刷新</span></button><Link className="button plan-secondary" to="/market">去市场挑选</Link><button type="button" className="button primary" onClick={() => setCreating(true)} disabled={creating}><Plus size={17} aria-hidden="true" />新建计划</button></div>
    </div>
    {creating ? <CreatePlanForm onClose={() => setCreating(false)} /> : feedback}
    {query.isPending && <p className="plan-loading" role="status">正在读取计划…</p>}
    {query.isError && <div className="plan-notice plan-form-error" role="alert"><p>{errorMessage(query.error)}</p><button type="button" className="text-link" onClick={() => void query.refetch()}>重新读取</button></div>}
    {query.data?.plans.length === 0 && <PageState icon={<LayoutGrid size={28} />} title={shownStatus === 'active' ? '给想做的事，一个位置' : '还没有归档的计划'} action={shownStatus === 'active' && !creating ? <><Link className="button plan-secondary" to="/market">去市场挑选</Link><button type="button" className="button primary" onClick={() => setCreating(true)}>新建计划</button></> : undefined}><p>{shownStatus === 'active' ? '从一个小目标开始，创建属于你的计划。' : '归档的计划会保留记录，需要时可以恢复。'}</p></PageState>}
    <div className="plan-list">{query.data?.plans.map(({ plan, ledger, study, generic }) => {
      const body = <>
      <span className={`category-icon ${plan.kind}`}>{plan.kind === 'ledger' ? <Wallet size={22} aria-hidden="true" /> : plan.kind === 'generic' ? <Shapes size={22} aria-hidden="true" /> : <BookOpen size={22} aria-hidden="true" />}</span>
      <div className="plan-list-copy"><h2>{plan.name}</h2>{ledger && <><p>本月净支出 <strong>{money(ledger.netCents)}</strong></p><small>{ledger.budgetCents === null ? '未设月预算' : `月预算 ${money(ledger.budgetCents)}`}</small></>}{study && <><p>{plan.template?.id === 'official.reading' ? '本周阅读' : '本周学习'} <strong>{study.totalMinutes} 分钟</strong></p><small>{study.interrupted ? '本周暂不评定达标' : study.goalComplete ? `达标 ${study.metDays ?? 0} / ${study.targetDays ?? 0} 天` : `已记录 ${study.recordDays} 天 · ${plan.template?.id === 'official.reading' ? '未设完整目标' : '目标待完善'}`}</small></>}{generic && <>{generic.metrics.filter((metric) => metric.operation !== 'goal_progress').slice(0, 2).map((metric) => <p key={metric.id}>{metric.label} <strong>{metricText(metric)}</strong></p>)}<small>今日 {generic.recordCount} 条记录</small></>}{plan.template?.setupStatus === 'pending' && <span className="plan-status-label">待完善</span>}{plan.status === 'archived' && <span className="plan-status-label">已归档</span>}</div>
      <ArrowRight className="plan-row-arrow" size={18} aria-hidden="true" />
      </>
      return choosing ? <button key={plan.id} type="button" className={`plan-list-item ${plan.kind}`} onClick={() => { chooseManualPlan(plan.id); navigate(`/plans/${plan.id}`) }}>{body}</button> : <Link key={plan.id} to={`/plans/${plan.id}`} className={`plan-list-item ${plan.kind}`}>{body}</Link>
    })}</div>
  </>
}

export function PlanDetailPage() {
  const { user } = useSession()
  const { planId = '' } = useParams()
  return user ? <PlanDetail key={`${user.id}:${planId}`} planId={planId} /> : <div className="standard-page"><SessionState /></div>
}
