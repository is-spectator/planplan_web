import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useSession } from '../auth/SessionProvider'
import { ApiError, withSessionLock } from './api'
import { readPending, removePending, savePending, type PendingRequest } from './recovery-store'

interface Completion { entry: PendingRequest; result: unknown }
interface RecoveryContextValue {
  entry: PendingRequest | null
  busy: boolean
  message: string
  messageId: string | null
  completed: Completion | null
  conflict: { entry: PendingRequest; details: Record<string, unknown>; message: string } | null
  clearConflict: () => void
  submit: <T>(entry: PendingRequest) => Promise<T | null>
  reconcile: (retry?: boolean, confirm?: boolean) => Promise<void>
  cancelConfirmation: () => Promise<void>
}
const RecoveryContext = createContext<RecoveryContextValue | null>(null)

function validResult(result: unknown, kind: PendingRequest['kind']): boolean {
  if (!result || typeof result !== 'object') return false
  const data = result as Record<string, unknown>
  if (kind === 'community') return typeof data.clientOpId === 'string' && typeof data.kind === 'string' && data.transient === false && ['listing', 'preview', 'submission', 'report'].some(key => !!data[key] && typeof data[key] === 'object')
  if (kind === 'feedback') return typeof data.clientOpId === 'string' && typeof data.kind === 'string' && data.transient === false && !!data.ticket && typeof data.ticket === 'object'
  if (kind === 'creation') {
    if (typeof data.clientOpId !== 'string' || typeof data.kind !== 'string' || typeof data.transient !== 'boolean') return false
    if (data.kind === 'delete') {
      const deleted = data.deleted as Record<string, unknown> | undefined
      return data.transient === false && !!deleted && typeof deleted.draftId === 'string' && typeof deleted.templateId === 'string'
    }
    return !!data.draft && typeof data.draft === 'object' && typeof (data.draft as Record<string, unknown>).id === 'string'
  }
  return kind === 'operation'
    ? typeof data.operationId === 'string' && Array.isArray(data.items) && typeof data.dataVersion === 'number'
    : !!data.user && !!data.assistant && typeof data.transient === 'boolean' && typeof data.dataVersion === 'number'
}

export function RecoveryProvider({ children }: { children: ReactNode }) {
  const { user, request, refresh } = useSession()
  const cache = useQueryClient()
  const activeUser = useRef(user?.id)
  const [entry, setEntry] = useState<PendingRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [messageId, setMessageId] = useState<string | null>(null)
  const [completed, setCompleted] = useState<Completion | null>(null)
  const [conflict, setConflict] = useState<RecoveryContextValue['conflict']>(null)
  const channel = useRef<BroadcastChannel | null>(null)
  useEffect(() => { activeUser.current = user?.id }, [user?.id])

  const sync = useCallback(async () => {
    const id = user?.id
    try {
      const saved = id ? await readPending(id) : null
      if (id === activeUser.current) { setEntry(saved); setMessage(''); setMessageId(null); setCompleted(null) }
    } catch (reason) { if (id === activeUser.current) setMessage(reason instanceof Error ? reason.message : '无法读取待核对记录。') }
  }, [user?.id])

  useEffect(() => {
    // IndexedDB is the source of truth after a page reload or account change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void sync()
    const onChange = () => { void sync() }
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel('planplan-recovery')
      channel.current.addEventListener('message', onChange)
    }
    window.addEventListener('focus', onChange)
    return () => { channel.current?.close(); channel.current = null; window.removeEventListener('focus', onChange) }
  }, [sync])

  async function finish(item: PendingRequest, result: unknown) {
    if (activeUser.current !== item.userId) return
    await removePending(item.userId)
    setEntry(null)
    setCompleted({ entry: item, result })
    setMessageId(item.id)
    setMessage(item.kind === 'creation' ? item.body.action === 'delete' ? '私人草稿和模板已删除，已采用计划及公开作品保留。' : item.body.action === 'save' ? '私人模板已保存。' : item.body.action === 'message' ? '已收到创作回复。' : '草稿已保存。' : item.kind === 'chat' ? '已收到回复。' : '已保存。')
    channel.current?.postMessage('changed')
    await cache.invalidateQueries({ queryKey: ['user', item.userId] })
    await refresh()
  }

  async function post<T>(item: PendingRequest): Promise<T | null> {
    try {
      const result = await request<T>(item.path, { method: 'POST', body: item.body, headers: item.confirmationId ? { 'X-PlanPlan-Confirmation': item.confirmationId } : undefined })
      if (!validResult(result, item.kind)) throw new ApiError('invalid_response', '回复无法识别，请先核对保存结果。')
      if ((item.kind === 'chat' || item.kind === 'creation') && (result as { transient?: boolean }).transient) {
        const reply = result as { message?: string; assistant?: { text?: string; cards?: { type?: string; message?: string }[] } }
        const errorCard = reply.assistant?.cards?.find(card => card.type === 'error' && typeof card.message === 'string')
        const retryable: PendingRequest = { ...item, status: 'transient', message: reply.message || reply.assistant?.text || errorCard?.message || '这次对话没有完成，可以重试同一条消息。' }
        await savePending(retryable)
        setEntry(retryable)
        return null
      }
      await finish(item, result)
      return result
    } catch (reason) {
      if (activeUser.current !== item.userId) return null
      if (reason instanceof ApiError && reason.code === 'duplicate_confirmation_required' && typeof reason.details?.confirmationId === 'string') {
        const confirmation: PendingRequest = { ...item, status: 'confirmation', confirmationId: reason.details.confirmationId, message: reason.message }
        await savePending(confirmation)
        setEntry(confirmation)
      } else if (reason instanceof ApiError && reason.status >= 400 && reason.status < 500 && !['invalid_response', 'account_mismatch'].includes(reason.code)) {
        await removePending(item.userId)
        setEntry(null)
        if (reason.details?.kind !== 'goal_period_changed' && ['version_conflict', 'refund_confirmation_required'].includes(reason.code)) setConflict({ entry: item, details: reason.details ?? {}, message: reason.message })
        const configuration = Array.isArray(item.body.actions) && item.body.actions.some(action => ['configure_reading_plan', 'configure_ledger_plan', 'configure_generic_plan'].includes(action?.type))
        const refundSnapshot = reason.details?.refundSnapshot
        const refundDeletion = refundSnapshot !== null && typeof refundSnapshot === 'object' && Array.isArray(item.body.actions) && item.body.actions.some(action => action?.type === 'delete_record')
        setMessage(reason.code === 'version_conflict' && !refundDeletion && reason.details?.kind !== 'goal_period_changed' ? `${item.kind === 'creation' ? '草稿' : configuration ? '计划设置' : '记录'}已被修改。请查看最新内容，再决定如何调整。` : reason.message)
        if (reason.details?.kind === 'goal_period_changed') await refresh()
        await cache.invalidateQueries({ queryKey: ['user', item.userId] })
      } else {
        const unknown: PendingRequest = { ...item, status: 'unknown', message: '还不能确定是否已保存，请先核对结果。' }
        await savePending(unknown)
        setEntry(unknown)
      }
      channel.current?.postMessage('changed')
      return null
    }
  }

  async function submit<T>(item: PendingRequest): Promise<T | null> {
    if (busy || item.userId !== activeUser.current) return null
    setBusy(true)
    setMessage('')
    setConflict(null)
    setMessageId(item.id)
    try {
      return await withSessionLock(async () => {
        if (item.userId !== activeUser.current) return null
        const existing = await readPending(item.userId)
        if (existing) { setEntry(existing); setMessage('请先处理上一条待核对的记录。'); return null }
        await savePending(item)
        setEntry(item)
        channel.current?.postMessage('changed')
        return post<T>(item)
      })
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : '暂时无法保存，请稍后重试。'); return null }
    finally { setBusy(false) }
  }

  async function reconcile(retry = false, confirm = false) {
    const id = user?.id
    if (!id || busy) return
    setBusy(true)
    setMessage('')
    try {
      await withSessionLock(async () => {
        const pending = await readPending(id)
        if (!pending || activeUser.current !== id) { await sync(); return }
        setMessageId(pending.id)
        let missing = false
        try {
          const response = await request<{ status: string; result?: unknown }>(pending.lookup)
          if (response.status === 'succeeded' && validResult(response.result, pending.kind)) { await finish(pending, response.result); return }
          if (response.status === 'processing') { setMessage('仍在处理中，请稍后再核对。'); return }
          missing = response.status === 'not_found'
          if (!missing) throw new ApiError('invalid_response', '暂时无法核对回复，请稍后再试。')
        } catch (reason) { if (reason instanceof ApiError && reason.status === 404) missing = true; else throw reason }
        if (missing && retry && (pending.status !== 'confirmation' || confirm)) {
          if (Date.now() - pending.createdAt > 29 * 86400_000) { setMessage('这条记录已超过重试期限，请核对计划中的历史记录。'); return }
          if (Date.now() - pending.createdAt < 3000) { setMessage('请稍等片刻，再核对一次。'); return }
          await post(pending)
        } else setMessage('尚未查到结果。你可以稍后核对，或继续提交这同一条记录。')
      })
    } catch (reason) { if (id === activeUser.current) setMessage(reason instanceof Error ? reason.message : '暂时无法核对，请稍后重试。') }
    finally { setBusy(false) }
  }

  async function cancelConfirmation() {
    const id = user?.id
    if (!id || busy) return
    await withSessionLock(async () => {
      const saved = await readPending(id)
      if (saved?.status !== 'confirmation' && saved?.status !== 'transient') return
      await removePending(id)
      setMessageId(saved.id)
      setEntry(null)
      setMessage(saved.status === 'transient' ? saved.kind === 'creation' ? '已取消本次创作重试，草稿仍会保留，可以继续手动编辑。' : '本次未生成记录，已取消重试。你可以继续手动记录。' : '已取消本次提交。')
      channel.current?.postMessage('changed')
    })
  }

  return <RecoveryContext.Provider value={{ entry: entry?.userId === user?.id ? entry : null, completed: completed?.entry.userId === user?.id ? completed : null, conflict: conflict?.entry.userId === user?.id ? conflict : null, clearConflict: () => setConflict(null), busy, message, messageId, submit, reconcile, cancelConfirmation }}>{children}</RecoveryContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useRecovery() {
  const value = useContext(RecoveryContext)
  if (!value) throw new Error('RecoveryProvider is required')
  return value
}

export function RecoveryFeedback({ requestId, global = false }: { requestId?: string | null; global?: boolean }) {
  const { entry, busy, message, messageId, reconcile, cancelConfirmation } = useRecovery()
  if (global && !entry) return null
  if (!global && entry) return null
  const showMessage = global || (!!requestId && requestId === messageId)
  if (!entry && (!message || !showMessage)) return null
  return <div className={`recovery-feedback${entry ? ' needs-attention' : ''}`} role="status">
    {entry && <><p>{busy ? '正在处理，请稍候…' : entry.message ?? '还在处理中，请稍候。'}</p><p className="field-hint">待核对内容暂存在此浏览器，确认后自动清除。</p>
      {!busy && <div className="action-row"><button type="button" className="button secondary" onClick={() => void reconcile()}>核对结果</button><button type="button" className="button primary" onClick={() => void reconcile(true, entry.status === 'confirmation')}>{entry.status === 'confirmation' ? '确认又发生了一次' : entry.kind === 'chat' || entry.kind === 'creation' && entry.body.action === 'message' ? '重试原消息' : entry.kind === 'creation' ? '继续原操作' : '继续提交原记录'}</button>{(entry.status === 'confirmation' || entry.status === 'transient') && <button type="button" className="button secondary" onClick={() => void cancelConfirmation()}>{entry.status === 'transient' ? entry.kind === 'creation' ? '暂不重试，手动编辑' : '暂不重试，继续手动记录' : '取消本次提交'}</button>}</div>}</>}
    {showMessage && message && <p>{message}</p>}
  </div>
}
