import { useEffect, useSyncExternalStore } from 'react'
import { useSession } from '../auth/SessionProvider'
import type { PendingRequest } from './recovery-store'

/** In-memory only. A refresh drops the handoff and does not resend the AI request. */
export interface ManualIntent {
  userId: string
  requestId: string
  kind: 'chat' | 'creation'
  text: string
  planId: string | null
  draftId: string | null
  opened: boolean
}

type EntryLike = Pick<PendingRequest, 'status' | 'kind' | 'body' | 'userId' | 'id'>

export function canHandOff(entry: EntryLike): boolean {
  if (entry.status !== 'transient') return false
  if (entry.kind === 'chat') return true
  return entry.kind === 'creation' && entry.body.action === 'message' && typeof entry.body.draftId === 'string' && entry.body.draftId.length > 0
}

export function handoffLabel(entry: EntryLike): string | null {
  if (!canHandOff(entry)) return null
  if (entry.kind === 'creation') return '取消重试，手动编辑'
  return typeof entry.body.scopePlanId === 'string' && entry.body.scopePlanId ? '取消重试，手动添加记录' : '取消重试，选择计划记录'
}

export function handoffPath(entry: EntryLike): string | null {
  if (!canHandOff(entry)) return null
  if (entry.kind === 'creation' && typeof entry.body.draftId === 'string') return `/create/${entry.body.draftId}`
  const planId = typeof entry.body.scopePlanId === 'string' ? entry.body.scopePlanId : ''
  return planId ? `/plans/${planId}` : '/plans'
}

export function intentFromPending(entry: EntryLike): ManualIntent {
  const text = typeof entry.body.text === 'string' ? entry.body.text : ''
  if (entry.kind === 'creation') {
    return { userId: entry.userId, requestId: entry.id, kind: 'creation', text, planId: null, draftId: typeof entry.body.draftId === 'string' ? entry.body.draftId : null, opened: false }
  }
  const planId = typeof entry.body.scopePlanId === 'string' && entry.body.scopePlanId ? entry.body.scopePlanId : null
  return { userId: entry.userId, requestId: entry.id, kind: 'chat', text, planId, draftId: null, opened: false }
}

let intent: ManualIntent | null = null
const listeners = new Set<() => void>()

export function getManualIntent() { return intent }

export function subscribeManualIntent(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setManualIntent(next: ManualIntent | null) {
  intent = next
  for (const listener of listeners) listener()
}

export function useManualIntent() {
  const { user } = useSession()
  const stored = useSyncExternalStore(subscribeManualIntent, getManualIntent, getManualIntent)
  return stored?.userId === user?.id ? stored : null
}

export function noteManualOpened() {
  const current = getManualIntent()
  if (!current || current.opened) return
  setManualIntent({ ...current, opened: true })
}

export function chooseManualPlan(planId: string) {
  const current = getManualIntent()
  if (!current || current.kind !== 'chat' || current.planId) return
  setManualIntent({ ...current, planId, opened: false })
}

export function dismissManual() {
  if (getManualIntent()) setManualIntent(null)
}

/** Open the existing record form once. An already open form or editor is left untouched. */
export function useManualRecordOpen(planId: string, status: string, blocked: boolean, open: () => void) {
  const manual = useManualIntent()
  const applicable = manual?.kind === 'chat' && manual.planId === planId ? manual : null
  useEffect(() => {
    if (!applicable || applicable.opened || status !== 'active' || blocked) return
    open()
    noteManualOpened()
  }, [applicable, status, blocked, open])
  return applicable
}
