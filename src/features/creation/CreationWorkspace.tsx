import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, ArrowUp, FilePenLine, MessageCircle, Pencil, RotateCcw } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { useSession } from '../../auth/SessionProvider'
import { PageState } from '../../components/PageState'
import { OriginalMessage } from '../../components/OriginalMessage'
import { dismissManual, setManualIntent, useManualIntent } from '../../lib/manual-handoff'
import { useRecovery } from '../../lib/RecoveryProvider'
import type { OperationResult, TemplateDefinition } from '../../lib/contracts'
import { useOperation } from '../../lib/useOperation'
import { useOperationCompletion } from '../plans/useOperationCompletion'
import { errorMessage } from '../plans/format'
import { GenericPreview } from '../templates/GenericPreview'
import { periodLabel } from '../templates/dynamic-fields'
import { TemplateStylePreview } from '../templates/TemplateStylePreview'
import { DeleteCreation } from './DeleteCreation'
import { DefinitionEditor } from './DefinitionEditor'
import type { CreationDraft, CreationResult } from './types'
import { useCreationRequest } from './useCreationRequest'

const starter = '我想做一个阅读记录模板，记录书名、阅读分钟、读到的位置和收获，按天汇总阅读时长。'
export function CreationWorkspace({ draftId }: { draftId: string }) {
  const { user, request } = useSession()
  const navigate = useNavigate()
  const recovery = useRecovery()
  const { submit, busy, pending, completed, feedback } = useCreationRequest()
  const operations = useOperation()
  const [text, setText] = useState('')
  const [inputError, setInputError] = useState('')
  const [tab, setTab] = useState<'chat' | 'preview'>('chat')
  const [editing, setEditing] = useState<{ definition: TemplateDefinition | null; version: number } | null>(null)
  const manual = useManualIntent()
  const handoff = manual?.kind === 'creation' && manual.draftId === draftId ? manual : null
  const [apply, setApply] = useState(false)
  const handled = useRef<string | null>(completed?.clientOpId ?? null)
  const operationOnArrival = useRef(recovery.completed?.entry.id)
  const composer = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const sending = useRef(false)
  const end = useRef<HTMLDivElement>(null)
  const query = useQuery({ queryKey: ['user', user!.id, 'creation-draft', draftId], queryFn: ({ signal }) => request<CreationDraft>(`/v1/creation/drafts/${encodeURIComponent(draftId)}`, { signal }) })
  const draft = query.data
  useEffect(() => {
    if (!draft || !handoff || handoff.opened || editing) return
    // Latest fetched definition, never the failed request's expectedVersion.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEditing({ definition: draft.definition, version: draft.version })
    setTab('preview')
    setManualIntent({ ...handoff, opened: true })
  }, [draft, handoff, editing])
  useEffect(() => {
    if (!handoff?.opened || !editing) return
    document.querySelector<HTMLElement>('#creation-preview-panel input')?.focus()
  }, [handoff?.opened, editing])
  const definition = draft?.definition
  const locked = busy || pending
  const enterPlan = (result: OperationResult) => { if (result.templatePlan) navigate(`/plans/${result.templatePlan.planId}${result.templatePlan.config.setupStatus === 'pending' ? '?setup=1' : ''}`) }
  const acceptOperation = useOperationCompletion(operations.completed, operations.lastClientOpId, operations.busy, enterPlan)
  useEffect(() => {
    const entry = recovery.entry
    if (entry?.kind === 'creation' && entry.body.action === 'message' && entry.body.draftId === draftId && typeof entry.body.text === 'string') {
      const original = entry.body.text
      // Restore the original input after the external IndexedDB recovery queue hydrates.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setText((current) => current || original)
    }
  }, [recovery.entry, draftId])
  const acceptCreation = useCallback((completed: CreationResult) => {
    if (completed.clientOpId === handled.current || completed.draft.id !== draftId) return
    handled.current = completed.clientOpId
    setEditing(null)
    setApply(false)
    const original = recovery.completed?.entry.body.text
    if (completed.kind === 'message' && typeof original === 'string') setText((current) => current.trim() === original ? '' : current)
  }, [draftId, recovery.completed])
  // The shared recovery queue emits this completion after an asynchronous retry or lookup.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (completed) acceptCreation(completed) }, [completed, acceptCreation])
  useEffect(() => {
    const recovered = recovery.completed
    if (!recovered || recovered.entry.id === operationOnArrival.current || recovered.entry.kind !== 'operation') return
    const actions = recovered.entry.body.actions as { type?: string; templateId?: string; planId?: string }[] | undefined
    const matches = actions?.some((action) => action.type === 'adopt_template' && action.templateId === draft?.savedTemplate?.id || action.type === 'apply_private_template' && action.planId === draft?.sourcePlanId)
    const result = recovered.result as OperationResult
    if (matches && result.templatePlan) navigate(`/plans/${result.templatePlan.planId}${result.templatePlan.config.setupStatus === 'pending' ? '?setup=1' : ''}`)
  }, [recovery.completed, draft?.savedTemplate?.id, draft?.sourcePlanId, navigate])
  const lastMessage = draft?.messages.at(-1)?.id
  useEffect(() => { if (lastMessage) end.current?.scrollIntoView({ block: 'nearest' }) }, [lastMessage])
  async function send(event?: FormEvent) {
    event?.preventDefault()
    if (text.length > 2000) { setInputError('消息最多2000字，请分成两次发送。'); return }
    if (!draft || locked || editing || !user?.aiConsent || !text.trim() || sending.current || composing.current) return
    sending.current = true
    try { await submit({ action: 'message', draftId, expectedVersion: draft.version, text: text.trim() }) }
    finally { sending.current = false }
  }
  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) { event.preventDefault(); void send() }
  }
  async function adoptSaved() {
    const saved = draft?.savedTemplate
    if (!saved || locked || editing) return
    const result = await operations.submit([{ type: 'adopt_template', templateId: saved.id, templateVersion: saved.version }])
    if (result) acceptOperation(result)
  }
  return <>
    <Link className="text-link back-link" to="/create"><ArrowLeft size={17} />返回我的作品</Link>
    {query.isPending && <p className="plan-loading" role="status">正在读取创作草稿…</p>}
    {query.isError && <PageState icon={<FilePenLine size={28} />} title="暂时无法打开草稿" tone="error" action={<button className="button primary" onClick={() => void query.refetch()}>重新读取</button>}><p>{errorMessage(query.error)}</p>{handoff && <><p>不会新建另一份草稿。</p><Link className="text-link" to="/create">返回我的作品</Link><OriginalMessage text={handoff.text} /></>}</PageState>}
    {draft && <>
      <header className="page-heading creation-workbench-heading"><div><h1>{definition?.name || '新的创作'}</h1><p>在这里设计模板，选用之后再开始记录。</p></div><div className="creation-header-actions"><button className="button plan-secondary" type="button" disabled={locked || !!editing || !draft.canUndo} onClick={async () => { await submit({ action: 'undo', draftId, expectedVersion: draft.version }) }}><RotateCcw size={16} />撤回修改</button>{draft.savedTemplate && !editing ? <button className="button primary" type="button" disabled={locked} onClick={() => void adoptSaved()}>使用模板<ArrowRight size={16} /></button> : <button className="button primary" type="button" disabled={locked || !!editing || !definition} onClick={async () => { await submit({ action: 'save', draftId, expectedVersion: draft.version }) }}>保存私人模板</button>}</div></header>
      {draft.sourcePlanId && <p className="creation-source-note">正在为一个已有计划设计私人模板。保存模板后，还需单独确认应用，原计划才会更新。</p>}
      {feedback}{operations.feedback}
      <div className="creation-mobile-tabs" role="tablist" aria-label="创作视图"><button type="button" role="tab" aria-selected={tab === 'chat'} aria-controls="creation-chat-panel" onClick={() => setTab('chat')}>对话</button><button type="button" role="tab" aria-selected={tab === 'preview'} aria-controls="creation-preview-panel" onClick={() => setTab('preview')}>预览</button></div>
      <div className={`creation-workbench show-${tab}`}>
        <section className="creation-conversation" id="creation-chat-panel" aria-label="创作对话"><div className="creation-panel-heading"><MessageCircle size={18} /><h2>描述你的想法</h2></div>
          <div className="creation-messages">{draft.messages.length === 0 ? <div className="creation-welcome"><h3>你想让这个模板做什么？</h3><p>说说每次想记录的内容，以及希望看到哪些结果。</p><button type="button" className="creation-example" disabled={locked || !!editing} onClick={() => { setText(starter); composer.current?.focus() }}>试试：做一个有书名和阅读位置的阅读模板<ArrowRight size={16} /></button></div> : draft.messages.map((message) => <article key={message.id} className={`creation-message ${message.role}`} aria-label={message.role === 'user' ? '你' : '创作助手'}><span>{message.role === 'user' ? '你' : 'PlanPlan'}</span><p>{message.text}</p></article>)}<div ref={end} /></div>
          {!user!.aiConsent && <div className="creation-ai-note"><p>对话创作需要先同意 AI 服务，也可以直接手动设计。</p><Link className="text-link" to="/me">查看 AI 服务说明</Link></div>}
          <form className="creation-composer" onSubmit={send}><label htmlFor="creation-message" className="sr-only">创作消息</label><textarea id="creation-message" ref={composer} rows={3} maxLength={2000} value={text} onChange={(event) => { setText(event.target.value); setInputError('') }} onPaste={(event) => { const area = event.currentTarget; if (text.length - (area.selectionEnd - area.selectionStart) + event.clipboardData.getData('text').length > 2000) { event.preventDefault(); setInputError('粘贴内容超过2000字，请分成两次发送，当前内容未改动。') } }} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={onKey} placeholder="例如：再加一个记录心情的选项" />{inputError && <p role="alert" className="plan-form-error">{inputError}</p>}<div><span>{text.length > 1700 ? `${text.length}/2000` : 'Enter 发送 · Shift + Enter 换行'}</span><button type="submit" className="button primary" aria-label="发送创作消息" disabled={locked || !!editing || !user!.aiConsent || !text.trim()}>{busy ? '处理中…' : '发送'}<ArrowUp size={17} /></button></div></form>
        </section>
        <section className="creation-preview-pane" id="creation-preview-panel" aria-label="模板预览"><div className="creation-panel-heading"><h2>模板预览</h2><button type="button" className="text-link" disabled={locked || !!editing} onClick={() => { setEditing({ definition: draft.definition, version: draft.version }); setTab('preview') }}><Pencil size={15} />手动编辑</button></div>
          {handoff && <OriginalMessage text={handoff.text} />}
          {editing ? <DefinitionEditor initial={editing.definition} today={user!.today} locked={locked} onCancel={() => { setEditing(null); if (handoff?.opened) dismissManual() }} onSave={async (value) => { const result = await submit({ action: 'update', draftId, expectedVersion: editing.version, definition: value }); if (result && handoff) dismissManual() }} /> : definition ? <>
            <section className="creation-description"><h3>功能简介</h3><p>{definition.description}</p><dl><div><dt>每次记录</dt><dd>{definition.recordFields.map((field) => field.label).join('、')}</dd></div><div><dt>统计结果</dt><dd>{definition.metrics.map((metric) => `${metric.label}（每${periodLabel[metric.period]}）`).join('、') || '查看记录列表'}</dd></div></dl></section>
            {draft.changeSummary.length > 0 && <details className="creation-changes"><summary>查看这次修改</summary><ul>{draft.changeSummary.map((change, index) => <li key={index}>{change}</li>)}</ul></details>}
            <section className="creation-style" aria-label="样式预览"><h3>样式预览</h3><TemplateStylePreview definition={definition} /></section>
            <details className="template-trial"><summary><strong>试填体验</strong></summary><div className="template-trial-content"><p className="plan-form-hint">修改模板后，试填会重新开始；正式记录保持不变。</p><GenericPreview key={JSON.stringify([definition.name, definition.description, definition.configurationFields, definition.recordFields, definition.metrics, definition.components, definition.example, definition.configurationDefaults, definition.recordDefaults])} definition={definition} today={user!.today} /></div></details>
          </> : <div className="creation-empty"><FilePenLine size={30} /><h3>让想法变成可以使用的模板</h3><p>对话生成或手动编辑后，就能看到样式、填写内容和统计效果。</p><button className="button plan-secondary" type="button" disabled={locked} onClick={() => setEditing({ definition: null, version: draft.version })}>从空白开始设计</button></div>}
        </section>
      </div>
      {draft.savedTemplate && !editing && <section className="creation-saved"><div><h2>私人模板已保存</h2><p>只有你能看到。可以创建计划，也可以继续创作。</p></div><div className="plan-form-actions"><Link className="button plan-secondary" to={`/create/templates/${encodeURIComponent(draft.savedTemplate.id)}?version=${draft.savedTemplate.version}`}>查看已保存模板<ArrowRight size={16} /></Link>{draft.sourcePlanId && draft.sourcePlanVersion !== null && <button className="button plan-secondary" type="button" disabled={locked} onClick={() => setApply(true)}>应用到原计划</button>}</div></section>}
      {!editing && <DeleteCreation draftId={draftId} version={draft.version} name={draft.name} />}
      {apply && draft.savedTemplate && draft.sourcePlanId && draft.sourcePlanVersion !== null && <section className="plan-notice creation-apply" role="alert"><h2>把这些修改应用到原计划？</h2><p>只应用兼容的新增可选项目和展示修改。原记录保持原值；新增内容不会自动补写到旧记录中。若计划已在别处更改，会停止应用并提示你重新核对。</p>{draft.changeSummary.length > 0 && <ul>{draft.changeSummary.map((item, index) => <li key={index}>{item}</li>)}</ul>}<div className="plan-form-actions"><button className="button primary" type="button" disabled={locked} onClick={async () => { const result = await operations.submit([{ type: 'apply_private_template', planId: draft.sourcePlanId!, templateId: draft.savedTemplate!.id, templateVersion: draft.savedTemplate!.version, expectedVersion: draft.sourcePlanVersion! }]); if (result) acceptOperation(result) }}>确认应用修改</button><button className="button plan-secondary" type="button" disabled={locked} onClick={() => setApply(false)}>暂不应用</button></div></section>}
    </>}
  </>
}
