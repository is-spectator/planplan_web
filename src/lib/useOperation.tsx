import { useState } from 'react'
import { useSession } from '../auth/SessionProvider'
import type { Action, OperationResult } from './contracts'
import { RecoveryFeedback, useRecovery } from './RecoveryProvider'

export function useOperation() {
  const { user } = useSession()
  const recovery = useRecovery()
  const [lastClientOpId, setLastClientOpId] = useState<string | null>(null)
  async function execute(path: string, body: Record<string, unknown>) {
    if (!user) return null
    const id = crypto.randomUUID()
    setLastClientOpId(id)
    return recovery.submit<OperationResult>({ userId: user.id, id, kind: 'operation', path, lookup: `/v1/operations/${id}`, body: { ...body, clientOpId: id, inputAt: new Date().toISOString() }, createdAt: Date.now(), status: 'unknown' })
  }
  return {
    lastClientOpId,
    submit: (actions: Action[]) => execute('/v1/operations', { actions }),
    undo: (operationId: string, recordId?: string) => execute(`/v1/operations/${encodeURIComponent(operationId)}/undo`, recordId ? { recordId } : {}),
    busy: recovery.busy,
    pending: !!recovery.entry,
    completed: recovery.completed?.entry.kind === 'operation' ? recovery.completed.result as OperationResult : null,
    feedback: <RecoveryFeedback requestId={lastClientOpId} />,
  }
}
