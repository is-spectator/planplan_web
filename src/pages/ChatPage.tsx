import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ArrowUp, ArrowUpRight, Asterisk, BookOpen, Wallet, X } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { useSession } from '../auth/SessionProvider'
import { MessageCards } from '../features/chat/MessageCards'
import { useChatCompletion } from '../features/chat/useChatCompletion'
import type { ChatInput, MessagesResponse, MessageView } from '../features/chat/types'
import type { PlansResponse, TemplatePlanState } from '../lib/contracts'
import { useChatRequest } from '../lib/useChatRequest'
import { useOperation } from '../lib/useOperation'
import { ApiError } from '../lib/api'
import '../styles/chat.css'

const suggestions = [
  { title: '把日常开销，记清楚', text: '我想省钱，帮我记账', icon: Wallet, tone: 'ledger' },
  { title: '给想做的事，留点时间', text: '每周阅读 5 天，每天 20 分钟', icon: BookOpen, tone: 'study' },
]

function ChatContent() {
  const { user, loading, error, request, refresh } = useSession()
  const { send, busy, pending, feedback, completed, lastClientMsgId } = useChatRequest()
  const { undo } = useOperation()
  const [search, setSearch] = useSearchParams()
  const scopePlanId = search.get('plan')
  const sourceMessageId = search.get('message')
  const sourceMessage = useQuery({ queryKey: ['user', user?.id, 'source-message', sourceMessageId], enabled: !!user && !!sourceMessageId, queryFn: ({ signal }) => request<{ message: MessageView }>(`/v1/messages/${encodeURIComponent(sourceMessageId!)}`, { signal }) })
  const [draft, setDraft] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const composer = useRef<HTMLTextAreaElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const submitting = useRef(false)
  const submittedDraft = useRef<string | null>(null)
  const accept = useChatCompletion(completed, lastClientMsgId, busy, () => {
    const original = submittedDraft.current
    if (original !== null) setDraft(current => current === original ? '' : current)
    setAnnouncement('已收到回复。')
  })
  const messages = useInfiniteQuery({
    queryKey: ['user', user?.id, 'messages', scopePlanId],
    initialPageParam: null as { type: 'cursor' | 'before'; value: string } | null,
    queryFn: ({ signal, pageParam }) => {
      const parameters = new URLSearchParams()
      if (pageParam) parameters.set(pageParam.type, pageParam.value)
      if (scopePlanId) parameters.set('scopePlanId', scopePlanId)
      return request<MessagesResponse>(`/v1/messages${parameters.size ? `?${parameters}` : ''}`, { signal })
    },
    getNextPageParam: page => page.nextCursor !== undefined ? (page.nextCursor ? { type: 'cursor' as const, value: page.nextCursor } : undefined) : page.messages.length >= 50 && page.messages[0] ? { type: 'before' as const, value: page.messages[0].createdAt } : undefined,
    enabled: !!user,
  })
  const scope = useQuery({
    queryKey: ['user', user?.id, 'chat-scope-plan', scopePlanId],
    queryFn: async ({ signal }) => {
      const active = await request<PlansResponse>('/v1/plans', { signal })
      const current = active.plans.find(card => card.plan.id === scopePlanId)?.plan
      if (current) return current
      const archived = await request<PlansResponse>('/v1/plans?status=archived', { signal })
      return archived.plans.find(card => card.plan.id === scopePlanId)?.plan ?? null
    },
    enabled: !!user && !!scopePlanId,
  })
  const scopePlan = scope.data
  const template = useQuery({
    queryKey: ['user', user?.id, 'template', scopePlanId],
    queryFn: async ({ signal }) => {
      try { return await request<TemplatePlanState>(`/v1/plans/${encodeURIComponent(scopePlanId!)}/template`, { signal }) }
      catch (reason) { if (reason instanceof ApiError && reason.code === 'not_found') return null; throw reason }
    },
    enabled: !!user && !!scopePlanId,
  })
  const reading = template.data?.source === 'official' && template.data.templateId === 'official.reading' ? template.data : null
  const history = [...new Map((messages.data?.pages.slice().reverse().flatMap(page => page.messages) ?? []).map(message => [message.id, message])).values()]
  const lastMessageId = history.at(-1)?.id
  const canSend = !!user?.aiConsent && !busy && !pending && !loading && (!scopePlanId || (!!scopePlan && !scope.isError))

  useEffect(() => {
    if (lastMessageId && !sourceMessageId) bottom.current?.scrollIntoView({ block: 'nearest' })
  }, [lastMessageId, sourceMessageId])

  function chooseExample(text: string) {
    setDraft(text)
    setAnnouncement('已填入输入框，你可以继续编辑。')
    composer.current?.focus()
  }

  async function submitMessage(event?: FormEvent) {
    event?.preventDefault()
    if (!canSend || !draft.trim() || submitting.current || composing.current) return
    submitting.current = true
    const text = draft
    submittedDraft.current = text
    try {
      const reply = await send({ text: text.trim(), scopePlanId })
      if (reply) {
        accept(reply)
        composer.current?.focus()
      }
    } finally { submitting.current = false }
  }

  function onComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) {
      event.preventDefault()
      void submitMessage()
    }
  }

  async function choose(input: ChatInput) {
    if (canSend && !submitting.current) {
      submitting.current = true
      submittedDraft.current = null
      try { await send({ ...input, scopePlanId }) } finally { submitting.current = false }
    }
  }

  return (
    <div className={`chat-page${history.length ? ' has-messages' : ''}`}>
      {sourceMessageId && <section className="plan-notice source-message" aria-label="来源对话"><h2>来源对话</h2>{sourceMessage.isPending && <p role="status">正在读取来源消息…</p>}{sourceMessage.isError && <p role="alert">暂时无法读取这条来源消息，请刷新重试。</p>}{sourceMessage.data && <><time>{new Date(sourceMessage.data.message.createdAt).toLocaleString('zh-CN')}</time><p>{sourceMessage.data.message.text}</p></>}<button className="text-link" type="button" onClick={() => { const next = new URLSearchParams(search); next.delete('message'); setSearch(next) }}>关闭来源消息</button></section>}
      {!loading && !history.length && !messages.isError && !user?.id && <Welcome onExample={chooseExample} />}
      {user && messages.isPending && <p className="chat-loading" role="status">正在读取对话…</p>}
      {user && messages.isSuccess && history.length === 0 && (scopePlan ? <ScopedWelcome name={scopePlan.name} reading={reading} template={template.data ?? null} onExample={chooseExample} /> : !scopePlanId ? <Welcome onExample={chooseExample} /> : null)}
      {error && <div className="chat-access-note" role="alert"><p>{error}</p><button type="button" className="text-link chat-text-button" onClick={() => void refresh()}>重新连接</button></div>}
      {user && messages.isError && <div className="chat-access-note" role="alert"><p>暂时无法读取对话，请重试。</p><button type="button" className="text-link chat-text-button" onClick={() => void messages.refetch()}>重新读取</button></div>}
      {user && scopePlanId && (scope.isError || (scope.isSuccess && !scopePlan)) && <div className="chat-access-note" role="alert"><p>{scope.isError ? '暂时无法读取当前计划，请重试。' : '当前计划不可用，请返回计划列表选择。'}</p>{scope.isError ? <button type="button" className="text-link chat-text-button" onClick={() => void scope.refetch()}>重新读取计划</button> : <Link to="/plans" className="text-link">查看计划</Link>}</div>}
      {history.length > 0 && <section className="message-history" aria-label="对话记录">
        {messages.hasNextPage && <button type="button" className="button chat-secondary chat-history-more" disabled={messages.isFetchingNextPage} onClick={() => void messages.fetchNextPage()}>{messages.isFetchingNextPage ? '正在读取…' : '查看更早的对话'}</button>}
        {history.map(message => <article key={message.id} className={`chat-message message-${message.role}`} aria-label={message.role === 'user' ? '你' : 'PlanPlan'}>
          {message.role === 'assistant' && <span className="assistant-avatar"><Asterisk size={20} aria-hidden="true" /></span>}
          <div className="message-body">{message.text && <p className="message-text">{message.text}</p>}{message.cards.length > 0 && <MessageCards cards={message.cards} busy={busy || pending || !user} canChoose={canSend} onChoice={choose} onUndo={async operationId => !!(await undo(operationId))} />}</div>
        </article>)}
      </section>}
      <div className="composer-region">
        {!loading && !user && !error && <div className="chat-access-note"><p>登录后，开始记录你的日常。</p><Link className="button primary" to="/login">登录或注册</Link></div>}
        {user && !user.aiConsent && <div className="chat-access-note"><p>使用对话前，请先阅读并选择是否同意 AI 服务说明。</p><div className="chat-choice-list"><Link className="button primary" to="/me">查看 AI 服务说明</Link><Link className="button chat-secondary" to="/plans">手动记录</Link></div></div>}
        {feedback}
        {scopePlan?.status === 'archived' && <div className="chat-reading-context"><span>这个计划已归档，仍可查询历史。继续记录前，会先请你确认是否恢复计划。</span><Link className="text-link" to={`/plans/${encodeURIComponent(scopePlan.id)}`}>查看计划</Link></div>}
        {reading && <div className="chat-reading-context"><span>{reading.config.currentBook ? `当前书籍：《${reading.config.currentBook}》（来自计划设置）` : '尚未设置当前书籍；记录时可以直接提供书名。'}</span><Link className="text-link" to={`/plans/${encodeURIComponent(reading.planId)}`}>{reading.config.setupStatus === 'pending' ? '完善计划' : '计划设置'}</Link></div>}
        {template.data && template.data.engine !== 'study' && <div className="chat-reading-context"><span>{template.data.config.setupStatus === 'pending' ? '可以先记录实际发生的内容，目标之后再补。' : '目标与实际记录分别保存。'}</span><Link className="text-link" to={`/plans/${encodeURIComponent(template.data.planId)}`}>计划设置与手动记录</Link></div>}
        {scopePlanId && <div className="chat-scope"><span>对话范围：{scopePlan?.name ?? '当前计划'}</span><button type="button" aria-label="清除计划范围" onClick={() => setSearch(previous => { const next = new URLSearchParams(previous); next.delete('plan'); return next })}><X size={16} aria-hidden="true" /></button></div>}
        <form className="composer" onSubmit={(event) => void submitMessage(event)}>
          <label className="sr-only" htmlFor="message">消息</label>
          <textarea id="message" ref={composer} value={draft} disabled={loading} onChange={(event) => setDraft(event.target.value)}
            onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={onComposerKey}
            rows={2} maxLength={500} placeholder={reading ? '比如「今天读了 25 分钟，读到第 35 页」' : scopePlan?.kind === 'study' ? '告诉我实际完成的时长，或问问这个计划的进度' : scopePlan?.kind === 'generic' ? '告诉我实际完成的数量和单位，或问问今天的进度' : '说点什么，比如「午饭 20 元」'} aria-describedby="chat-keyboard-hint" />
          <div className="composer-toolbar"><span id="chat-keyboard-hint">Enter 发送 · Shift + Enter 换行</span><span className="chat-composer-actions">{draft.length > 400 && <span>{draft.length}/500</span>}<button type="submit" className="send-button" disabled={!canSend || !draft.trim()} aria-label="发送消息"><ArrowUp size={19} aria-hidden="true" /></button></span></div>
        </form>
        <span role="status" className="sr-only">{announcement}</span>
      </div>
      <div className="chat-scroll-end" ref={bottom} />
    </div>
  )
}

function ScopedWelcome({ name, reading, template, onExample }: { name: string; reading: TemplatePlanState | null; template: TemplatePlanState | null; onExample: (text: string) => void }) {
  return <section className="welcome scoped-welcome" aria-labelledby="scope-welcome-title">
    <div className="welcome-mark">{template?.engine === 'generic' ? <Asterisk size={30} aria-hidden="true" /> : template?.engine === 'ledger' ? <Wallet size={30} aria-hidden="true" /> : <BookOpen size={30} aria-hidden="true" />}</div>
    <h1 id="scope-welcome-title">{name}</h1>
    <p className="welcome-copy">{reading ? reading.config.setupStatus === 'pending' ? '先说说你的阅读目标，也可以直接开始记录。' : '记下每一次阅读，看看慢慢积累的进度。' : '在这里记录，或问问这个计划的进度。'}</p>
    {template?.engine === 'generic' && <div className="chat-choice-list"><button type="button" className="button chat-secondary" onClick={() => onExample('今天记录了多少？')}>查看今天进度</button><Link className="button chat-secondary" to={`/plans/${encodeURIComponent(template.planId)}`}>手动记录</Link></div>}
    {reading && <div className="chat-choice-list"><button type="button" className="button chat-secondary" onClick={() => onExample('今天读了 25 分钟')}>记录一次阅读</button><button type="button" className="button chat-secondary" onClick={() => onExample('这周读了多久？')}>查看本周进度</button>{reading.config.setupStatus === 'pending' && <button type="button" className="button chat-secondary" onClick={() => onExample('每周阅读 5 天，每天目标 20 分钟')}>设置阅读目标</button>}</div>}
  </section>
}

function Welcome({ onExample }: { onExample: (text: string) => void }) {
  return <section className="welcome" aria-labelledby="welcome-title">
    <div className="welcome-mark"><Asterisk size={34} strokeWidth={1.7} aria-hidden="true" /></div>
    <h1 id="welcome-title">你好，想管理点什么？</h1>
    <p className="welcome-copy">想控制的开销，或想养成的习惯。<br />直接说出来就行，目标可以以后再补。</p>
    <div className="suggestions">{suggestions.map(({ title, text, icon: Icon, tone }) => <button type="button" key={tone} className={`suggestion ${tone}`} onClick={() => onExample(text)}>
      <span className="suggestion-top"><span className="category-icon"><Icon size={22} aria-hidden="true" /></span><ArrowUpRight size={18} className="suggestion-arrow" aria-hidden="true" /></span>
      <span className="suggestion-title">{title}</span><span className="suggestion-text">{text}</span>
    </button>)}</div>
    <p className="welcome-hint">也可以问问进度：「这个月还剩多少」「这周读了几天」</p>
  </section>
}

export function ChatPage() {
  const { user } = useSession()
  return <ChatContent key={user?.id ?? 'anonymous'} />
}
