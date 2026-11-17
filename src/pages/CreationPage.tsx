import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, FilePenLine, Plus, RefreshCw } from 'lucide-react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useSession } from '../auth/SessionProvider'
import { PageState } from '../components/PageState'
import { useCreationRequest } from '../features/creation/useCreationRequest'
import type { CreationDraft, CreationResult, PrivateTemplate } from '../features/creation/types'
import { DeleteCreation } from '../features/creation/DeleteCreation'
import { CreationWorkspace } from '../features/creation/CreationWorkspace'
import type { OperationResult, TemplateDefinition } from '../lib/contracts'
import { useOperation } from '../lib/useOperation'
import { useRecovery } from '../lib/RecoveryProvider'
import { supportsGeneric } from '../features/templates/dynamic-fields'
import { useOperationCompletion } from '../features/plans/useOperationCompletion'
import { TemplateStylePreview } from '../features/templates/TemplateStylePreview'
import { GenericPreview } from '../features/templates/GenericPreview'
import { errorMessage } from '../features/plans/format'
import '../styles/plans.css'
import '../styles/templates.css'
import '../styles/creation.css'

function CreationAccess({ children }: { children: React.ReactNode }) {
  const { user, loading, error, refresh } = useSession()
  if (loading) return <p className="plan-loading" role="status">正在读取账户…</p>
  if (!user) return <PageState icon={<FilePenLine size={28} />} title={error ? '暂时无法读取账户' : '创建自己的模板'} tone={error ? 'error' : 'neutral'} action={error ? <button className="button primary" onClick={() => void refresh()}>重新连接</button> : <Link className="button primary" to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}>登录后创作</Link>}><p>{error ?? '告诉我们想记录什么，让模板适合你的日常。作品会保存在你的账户里。'}</p></PageState>
  return children
}

export function CreationPage() {
  const { user } = useSession()
  return <div className="standard-page creation-page"><CreationAccess><CreationList key={user?.id} /></CreationAccess></div>
}

function CreationList() {
  const { user, request } = useSession()
  const navigate = useNavigate()
  const [search, setSearch] = useSearchParams()
  const [draftOffset, setDraftOffset] = useState(0)
  const [templateOffset, setTemplateOffset] = useState(0)
  const { submit, completed, busy, pending, feedback } = useCreationRequest()
  const handled = useRef(completed?.clientOpId)
  const drafts = useQuery({ queryKey: ['user', user!.id, 'creation-drafts', draftOffset], queryFn: ({ signal }) => request<{ drafts: CreationDraft[]; total: number }>(`/v1/creation/drafts?limit=20&offset=${draftOffset}`, { signal }) })
  const templates = useQuery({ queryKey: ['user', user!.id, 'private-templates', templateOffset], queryFn: ({ signal }) => request<{ templates: PrivateTemplate[]; total: number }>(`/v1/creation/templates?limit=20&offset=${templateOffset}`, { signal }) })
  function accept(result: CreationResult) { handled.current = result.clientOpId; navigate(`/create/${result.draft.id}`) }
  useEffect(() => {
    if (!completed || completed.clientOpId === handled.current || !['create', 'fork'].includes(completed.kind)) return
    handled.current = completed.clientOpId
    navigate(`/create/${completed.draft.id}`)
  }, [completed, navigate])
  const sourcePlanId = search.get('fromPlan')
  const sourceTemplateId = search.get('fromTemplate')
  const sourceTemplateVersion = Number(search.get('version'))
  const fork = sourcePlanId ? { action: 'fork' as const, sourcePlanId } : sourceTemplateId && Number.isSafeInteger(sourceTemplateVersion) && sourceTemplateVersion > 0 ? { action: 'fork' as const, sourceTemplateId, sourceTemplateVersion } : null
  return <>
    <header className="page-heading creation-list-heading"><div><h1>创作</h1><p>从一句想法开始，做一个适合自己的模板。</p></div><button type="button" className="button primary" disabled={busy || pending} onClick={async () => { const result = await submit({ action: 'create' }); if (result) accept(result) }}><Plus size={17} />创建模板</button></header>
    {fork && <section className="plan-notice"><h2>{sourcePlanId ? '调整计划使用的模板' : '基于这个模板创作'}</h2><p>{sourcePlanId ? '先创建一份私人草稿。预览、保存并确认应用后，才会改变这个计划的填写内容。原有记录会保留。' : '复制模板的结构开始创作，原模板保持不变。'}</p><div className="plan-form-actions"><button className="button primary" disabled={busy || pending} onClick={async () => { const result = await submit(fork); if (result) accept(result) }}>创建私人草稿</button><button className="button plan-secondary" type="button" onClick={() => setSearch({})}>取消</button></div></section>}
    <p><Link className="text-link" to="/community">管理我的社区作品</Link></p>
    {feedback}
    <section className="creation-library" aria-labelledby="drafts-heading"><div className="plan-section-heading"><h2 id="drafts-heading">我的草稿</h2><button type="button" className="text-link" disabled={drafts.isFetching} onClick={() => void drafts.refetch()}><RefreshCw size={15} />刷新</button></div>
      {drafts.isPending && <p role="status" className="plan-loading">正在读取草稿…</p>}{drafts.isError && <p role="alert" className="plan-form-error">{errorMessage(drafts.error)}</p>}
      {drafts.data?.drafts.length === 0 && <div className="creation-empty"><FilePenLine size={28} /><h3>先说说你的想法</h3><p>例如：记录读了哪本书、花了多久，以及这次的收获。也可以直接手动设计。</p></div>}
      <div className="creation-draft-list">{drafts.data?.drafts.map((draft) => <div className="creation-library-row" key={draft.id}><Link className="creation-draft-row" to={`/create/${draft.id}`}><FilePenLine size={21} /><span><strong>{draft.name || '未命名草稿'}</strong><small>{draft.savedTemplate ? '已保存私人模板' : draft.definition ? '继续调整与预览' : '等待你的第一个想法'}</small></span><ArrowRight size={17} /></Link><DeleteCreation draftId={draft.id} version={draft.version} name={draft.name} /></div>)}</div>
      {drafts.data && <CreationPagination total={drafts.data.total} offset={draftOffset} busy={drafts.isFetching} onChange={setDraftOffset} />}
    </section>
    <section className="creation-library" aria-labelledby="private-templates-heading"><h2 id="private-templates-heading">我的模板</h2><p className="plan-form-hint">保存后的模板只对你可见，选用后进入自己的计划。</p>{templates.isPending && <p role="status" className="plan-loading">正在读取模板…</p>}{templates.isError && <div role="alert"><p className="plan-form-error">{errorMessage(templates.error)}</p><button type="button" className="text-link" onClick={() => void templates.refetch()}>重新读取模板</button></div>}{templates.data?.templates.length === 0 && <p className="creation-empty-note">还没有保存的模板。完成草稿后，选择“保存私人模板”。</p>}<div className="creation-draft-list">{templates.data?.templates.map((template) => <Link className="creation-draft-row" key={template.id} to={`/create/templates/${encodeURIComponent(template.id)}?version=${template.version}${search.get('listing') ? `&listing=${encodeURIComponent(search.get('listing')!)}` : ''}`}><span><strong>{template.name}</strong><small>{template.description}</small></span><ArrowRight size={17} /></Link>)}</div>{templates.data && <CreationPagination total={templates.data.total} offset={templateOffset} busy={templates.isFetching} onChange={setTemplateOffset} />}</section>
  </>
}

function CreationPagination({ total, offset, busy, onChange }: { total: number; offset: number; busy: boolean; onChange: (value: number) => void }) {
  if (total <= 20 && !offset) return null
  return <nav className="record-pagination" aria-label="作品分页"><button className="button plan-secondary" disabled={busy || offset === 0} onClick={() => onChange(Math.max(0, offset - 20))}>上一页</button><span>第 {Math.floor(offset / 20) + 1} 页</span><button className="button plan-secondary" disabled={busy || offset + 20 >= total} onClick={() => onChange(offset + 20)}>下一页</button></nav>
}

export function CreationDraftPage() {
  const { user } = useSession()
  const { draftId = '' } = useParams()
  return <div className="standard-page creation-page creation-workbench-page"><CreationAccess><CreationWorkspace key={`${user?.id}:${draftId}`} draftId={draftId} /></CreationAccess></div>
}

export function PrivateTemplatePage() {
  const { user } = useSession()
  const { templateId = '' } = useParams()
  const [search] = useSearchParams()
  const version = Number(search.get('version'))
  return <div className="standard-page market-page"><CreationAccess><PrivateTemplateContent key={`${user?.id}:${templateId}:${version}`} templateId={templateId} version={version} /></CreationAccess></div>
}
function PrivateTemplateContent({ templateId, version }: { templateId: string; version: number }) {
  const { user, request } = useSession()
  const navigate = useNavigate()
  const [publicationSearch] = useSearchParams()
  const query = useQuery({ queryKey: ['user', user!.id, 'private-template', templateId, version], queryFn: ({ signal }) => request<TemplateDefinition>(`/v1/creation/templates/${encodeURIComponent(templateId)}${version > 0 ? `?version=${version}` : ''}`, { signal }) })
  const { submit, busy, pending, completed, lastClientOpId, feedback } = useOperation()
  const enter = (result: OperationResult) => { if (result.templatePlan) navigate(`/plans/${result.templatePlan.planId}${result.templatePlan.config.setupStatus === 'pending' ? '?setup=1' : ''}`) }
  const accept = useOperationCompletion(completed, lastClientOpId, busy, enter)
  const recovery = useRecovery()
  const onArrival = useRef(recovery.completed?.entry.id)
  useEffect(() => {
    const recovered = recovery.completed
    if (!recovered || recovered.entry.kind !== 'operation' || recovered.entry.id === onArrival.current) return
    const actions = recovered.entry.body.actions as { type?: string; templateId?: string }[] | undefined
    const result = recovered.result as OperationResult
    if (actions?.some(action => action.type === 'adopt_template' && action.templateId === templateId) && result.templatePlan) navigate(`/plans/${result.templatePlan.planId}${result.templatePlan.config.setupStatus === 'pending' ? '?setup=1' : ''}`)
  }, [recovery.completed, templateId, navigate])
  const supported = query.data && supportsGeneric(query.data)
  return <><Link className="text-link back-link" to="/create"><ArrowLeft size={17} />返回我的模板</Link>{query.isPending && <p className="plan-loading" role="status">正在读取模板…</p>}{query.isError && <PageState icon={<FilePenLine size={24} />} title="暂时无法打开模板" tone="error" action={<button className="button primary" onClick={() => void query.refetch()}>重新读取</button>}><p>{errorMessage(query.error)}</p></PageState>}{query.data && <><header className="page-heading"><span className="template-badge">我的模板</span><h1>{query.data.name}</h1><p>{query.data.description}</p></header><section aria-label="样式预览"><h2 className="template-section-title">样式预览</h2><TemplateStylePreview definition={query.data} /><p className="template-example-caption">这里展示示例数据，选用后呈现你自己的记录。</p></section><section className="template-adopt"><div><h2>开始自己的计划</h2><p>用这个已保存的模板创建私人计划。</p></div><button className="button primary" disabled={busy || pending || !supported} onClick={async () => { const result = await submit([{ type: 'adopt_template', templateId: query.data!.id, templateVersion: query.data!.version }]); if (result) accept(result) }}>使用模板<ArrowRight size={17} /></button></section>{feedback}<p><Link className="button plan-secondary" to={`/publish/${encodeURIComponent(query.data.id)}?version=${query.data.version}${publicationSearch.get('listing') ? `&listing=${encodeURIComponent(publicationSearch.get('listing')!)}` : ''}`}>准备公开这个模板</Link></p><Link className="text-link" to={`/create?fromTemplate=${encodeURIComponent(query.data.id)}&version=${query.data.version}`}>基于此模板继续创作<ArrowRight size={16} /></Link>{!supported && <p className="plan-notice" role="alert">这个模板包含当前页面尚不能使用的内容，请更新页面后再查看和选用。</p>}{supported && <details className="template-trial"><summary><strong>试填体验</strong></summary><div className="template-trial-content"><GenericPreview definition={query.data} today={user!.today} /></div></details>}</>}</>
}
