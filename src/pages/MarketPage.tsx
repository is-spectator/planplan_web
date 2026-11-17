import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, BookOpen, Check, FilePenLine, ChevronDown, RefreshCw, Shapes, Store, Wallet } from 'lucide-react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { MarketTemplate } from '../features/community/types'
import { communityCategories } from '../features/community/types'
import { ReportTemplate } from '../features/community/ReportTemplate'
import { useSession } from '../auth/SessionProvider'
import { PageState } from '../components/PageState'
import { api } from '../lib/api'
import type { OperationResult, PlansResponse, TemplateDefinition } from '../lib/contracts'
import { useOperation } from '../lib/useOperation'
import { useRecovery } from '../lib/RecoveryProvider'
import { useOperationCompletion } from '../features/plans/useOperationCompletion'
import { errorMessage, money } from '../features/plans/format'
import { ReadingPreview } from '../features/templates/ReadingPreview'
import { GenericPreview } from '../features/templates/GenericPreview'
import { LedgerPreview } from '../features/templates/LedgerPreview'
import { supportsGeneric } from '../features/templates/dynamic-fields'
import { TemplateStylePreview } from '../features/templates/TemplateStylePreview'
import { templatePresentation } from '../features/templates/presentation'
import '../styles/plans.css'
import '../styles/templates.css'

function TemplateIcon({ engine }: { engine: TemplateDefinition['engine'] }) {
  const Icon = engine === 'ledger' ? Wallet : engine === 'study' ? BookOpen : Shapes
  return <span className={`category-icon ${engine}`}><Icon size={24} aria-hidden="true" /></span>
}

function adoptionPath(result: OperationResult) {
  const id = result.templatePlan?.planId ?? result.items.find((item) => item.type === 'plan_created')?.plan.id
  return id ? `/plans/${encodeURIComponent(id)}${result.templatePlan?.config.setupStatus === 'pending' ? '?setup=1' : ''}` : null
}

export function MarketPage() {
  const { user, request } = useSession()
  const [search, setSearch] = useSearchParams()
  const [text, setText] = useState(search.get('q') ?? '')
  const source = search.get('source') ?? 'all', category = search.get('category') ?? '', offset = Number(search.get('offset') ?? 0)
  const params = new URLSearchParams({ source, limit: '20', offset: String(offset), ...(category ? { category } : {}), ...(search.get('q') ? { q: search.get('q')! } : {}) })
  const query = useQuery({ queryKey: [user ? 'user' : 'public', user?.id ?? 'anonymous', 'market', params.toString()], queryFn: ({ signal }) => (user ? request : api)<{ templates: MarketTemplate[]; total: number }>(`/v1/market/templates?${params}`, { signal }) })
  function filter(key: string, value: string) { const next = new URLSearchParams(search); if (value) next.set(key, value); else next.delete(key); next.delete('offset'); setSearch(next) }

  return <div className="standard-page market-page">
    <header className="page-heading"><h1>市场</h1><p>看看样式，了解功能，选一个适合你的日常计划。</p></header>
    <div className="market-creation-link"><div><h2>想要更适合自己的模板？</h2><p>通过对话描述想法，或手动设计记录内容。</p></div><Link className="button plan-secondary" to="/create"><FilePenLine size={17} />去创作</Link></div>
    <div className="plan-section-heading"><h2>发现模板</h2><button type="button" className="button plan-secondary" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} aria-hidden="true" />刷新</button></div>
    <form className="market-filters" onSubmit={(event) => { event.preventDefault(); filter('q', text.trim()) }}><label>搜索模板<input type="search" maxLength={80} value={text} onChange={(event) => setText(event.target.value)} placeholder="搜索名称或功能" /></label><button className="button plan-secondary" type="submit">搜索</button><label>来源<select value={source} onChange={(event) => filter('source', event.target.value)}><option value="all">全部模板</option><option value="official">官方模板</option><option value="community">社区模板</option></select></label><label>分类<select value={category} onChange={(event) => filter('category', event.target.value)}><option value="">全部分类</option>{Object.entries(communityCategories).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label></form>
    {query.isPending && <p className="plan-loading" role="status">正在读取模板…</p>}
    {query.isError && <PageState icon={<Store size={28} />} title="暂时无法读取模板" tone="error" action={<button type="button" className="button primary" onClick={() => void query.refetch()}>重新读取</button>}><p>{errorMessage(query.error)}</p></PageState>}
    {query.data?.templates.length === 0 && <PageState icon={<Store size={28} />} title="还没有可用的模板"><p>稍后再来看看。</p></PageState>}
    <div className="template-list">{query.data?.templates.map((card) => {
      const template = card.definition
      const presentation = templatePresentation(template)
      return <Link className="template-card" key={`${template.id}:${template.version}`} to={`/market/${encodeURIComponent(template.id)}`}>
        <TemplateStylePreview definition={template} compact />
        <div className="template-card-copy"><div className="template-card-title"><h2>{template.name}</h2><span className="template-badge">{card.source === 'official' ? '官方' : '社区'}</span></div><p>{card.description}</p><small>{card.author.name}{card.adoptionCount !== null ? ` · ${card.adoptionCount} 次采用` : ''}</small><ul className="template-feature-tags" aria-label="主要功能">{presentation.features.slice(0, 3).map((feature) => <li key={feature.title}>{feature.title}</li>)}</ul><span className="text-link">查看样式与功能<ArrowRight size={16} aria-hidden="true" /></span></div>
      </Link>
    })}</div>{query.data && query.data.total > 20 && <nav className="record-pagination" aria-label="模板分页"><button type="button" className="button plan-secondary" disabled={offset === 0 || query.isFetching} onClick={() => { const next = new URLSearchParams(search); next.set('offset', String(Math.max(0, offset - 20))); setSearch(next) }}>上一页</button><span>{offset + 1}–{Math.min(offset + 20, query.data.total)} / {query.data.total}</span><button type="button" className="button plan-secondary" disabled={offset + 20 >= query.data.total || query.isFetching} onClick={() => { const next = new URLSearchParams(search); next.set('offset', String(offset + 20)); setSearch(next) }}>下一页</button></nav>}
  </div>
}

export function TemplateDetailPage() {
  const { templateId = '' } = useParams()
  const { user, request } = useSession()
  const query = useQuery({ queryKey: user ? ['user', user.id, 'template', templateId] : ['public', 'template', templateId], queryFn: ({ signal }) => (user ? request : api)<MarketTemplate>(`/v1/market/templates/${encodeURIComponent(templateId)}`, { signal }) })
  return <div className="standard-page market-page"><Link className="text-link back-link" to="/market"><ArrowLeft size={17} aria-hidden="true" />返回市场</Link>
    {query.isPending && <p className="plan-loading" role="status">正在读取模板…</p>}
    {query.isError && <PageState icon={<BookOpen size={28} />} title="暂时无法打开这个模板" tone="error" action={<button className="button primary" type="button" onClick={() => void query.refetch()}>重新读取</button>}><p>{errorMessage(query.error)}</p></PageState>}
    {query.data && <TemplateContent key={`${user?.id ?? 'anonymous'}:${templateId}`} template={query.data.definition} card={query.data} />}
  </div>
}

function TemplateContent({ template, card }: { template: TemplateDefinition; card: MarketTemplate }) {
  const { user, request } = useSession()
  const navigate = useNavigate()
  const { submit, busy, pending, feedback, completed, lastClientOpId } = useOperation()
  const recovery = useRecovery()
  const [completionOnArrival] = useState(recovery.completed?.entry.id)
  function enterPlan(result: OperationResult) {
    const destination = adoptionPath(result)
    if (destination) navigate(destination, { replace: true })
  }
  const accept = useOperationCompletion(completed, lastClientOpId, busy, enterPlan)
  // After reload the global queue retains the adoption identity, not this component.
  useEffect(() => {
    const recovered = recovery.completed
    if (!recovered || recovered.entry.id === completionOnArrival || recovered.entry.kind !== 'operation') return
    const result = recovered.result as OperationResult
    const actions = recovered.entry.body.actions as { type?: string; templateId?: string }[] | undefined
    const destination = adoptionPath(result)
    if (actions?.some((action) => action.type === 'adopt_template' && action.templateId === template.id) && destination) navigate(destination, { replace: true })
  }, [recovery.completed, completionOnArrival, template.id, navigate])
  const ledger = template.engine === 'ledger'
  const existing = useQuery({
    queryKey: ['user', user?.id, 'market-ledger'], enabled: Boolean(user) && ledger,
    queryFn: async ({ signal }) => {
      const [active, archived] = await Promise.all([request<PlansResponse>('/v1/plans?status=active', { signal }), request<PlansResponse>('/v1/plans?status=archived', { signal })])
      return [...active.plans, ...archived.plans].find((item) => item.plan.kind === 'ledger') ?? null
    },
  })
  const supported = template.schemaVersion === 1 && template.requiredCapabilities.every((capability) => ['reading-template-v1', 'ledger-template-v1', 'generic-record-v1', 'private-template-v1', 'generic-template-v2', 'community-template-v1'].includes(capability)) && (template.engine === 'generic' ? supportsGeneric(template) : template.engine === 'ledger' || template.id === 'official.reading')
  const today = user?.today ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const existingLedger = existing.data
  const archived = existingLedger?.plan.status === 'archived'
  const presentation = templatePresentation(template)
  return <>
    <header className="page-heading template-detail-heading"><TemplateIcon engine={template.engine} /><div><span className="template-badge">{card.source === 'official' ? 'PlanPlan 官方' : card.author.name}</span><h1>{template.name}</h1><p>{presentation.intro}</p></div></header>
    <div className="template-overview">
      <section className="template-style-section" aria-labelledby="template-style-heading"><div className="template-section-title"><h2 id="template-style-heading">样式预览</h2><span>选用后的页面示例</span></div><TemplateStylePreview definition={template} /><p className="template-example-caption">展示的是示例数据。选用后，页面会呈现你自己的记录。</p></section>
      <section className="template-features" aria-labelledby="template-features-heading"><h2 id="template-features-heading">功能简介</h2><ul>{presentation.features.map((feature) => <li key={feature.title}><span className="template-feature-check"><Check size={16} aria-hidden="true" /></span><div><h3>{feature.title}</h3><p>{feature.text}</p></div></li>)}</ul></section>
    </div>
    {!supported && <p className="plan-notice">这个模板暂时不适用于当前版本。</p>}
    {user && ledger && existing.isPending && <p className="plan-loading" role="status">正在确认你的计划…</p>}
    {user && ledger && existing.isError && <div className="plan-notice" role="alert"><p>暂时无法确认已有计划，请重新读取后再使用。</p><button className="text-link" type="button" onClick={() => void existing.refetch()}>重新读取计划</button></div>}
    {existingLedger && <section className="plan-notice" aria-label="已有计划"><h2>{archived ? '你有一个已归档的计划' : '继续使用已有计划'}</h2><p>{existingLedger.plan.name} · {existingLedger.ledger?.budgetCents === null || existingLedger.ledger?.budgetCents === undefined ? '未设月预算' : `本月预算 ${money(existingLedger.ledger.budgetCents)}`}</p><p>{archived ? '选择恢复后才会继续记账。原有预算、账目和退款关系会保留。' : '使用模板会进入同一个计划，不会重复创建或改变预算。'}</p>{archived && <Link className="text-link" to={`/plans/${existingLedger.plan.id}`}>只查看历史</Link>}</section>}
    <section className="template-adopt"><div><h2>{existingLedger ? archived ? '恢复自己的计划' : '继续自己的计划' : '开始自己的计划'}</h2><p>{existingLedger ? '预算可在计划中另行调整，由你确认后才保存。' : '选用后进入你的私人计划，再设置目标、添加记录。'}</p></div>{supported && (user ? <button type="button" className="button primary" disabled={busy || pending || ledger && (existing.isPending || existing.isError)} onClick={async () => {
      const result = await submit([{ type: 'adopt_template', templateId: template.id, templateVersion: template.version, ...(existingLedger ? { existingPlanId: existingLedger.plan.id, existingLedgerAction: archived ? 'restore' as const : 'reuse' as const } : {}) }])
      if (result) accept(result)
    }}>{busy ? '正在处理…' : existingLedger ? archived ? '恢复并使用计划' : '使用现有计划' : '使用模板'}<ArrowRight size={17} aria-hidden="true" /></button> : <Link className="button primary" to={`/login?next=${encodeURIComponent(`/market/${template.id}`)}`}>登录后使用<ArrowRight size={17} aria-hidden="true" /></Link>)}</section>
    {feedback}
    {card.source === 'community' && <ReportTemplate card={card} />}
    {supported && template.engine === 'generic' && <Link className="text-link" to={`/create?fromTemplate=${encodeURIComponent(template.id)}&version=${template.version}`}>基于此模板创作<ArrowRight size={16} /></Link>}
    {supported && <details className="template-trial"><summary><span><strong>试填体验</strong><span>想动手试试？在这里体验记录，不会保存到计划。</span></span><ChevronDown size={20} aria-hidden="true" /></summary><div className="template-trial-content">{template.engine === 'study' ? <ReadingPreview /> : ledger ? <LedgerPreview definition={template} today={today} /> : <GenericPreview definition={template} today={today} />}</div></details>}
  </>
}
