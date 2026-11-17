import { useState } from 'react'
import { useSession } from '../../auth/SessionProvider'
import { RecoveryFeedback, useRecovery } from '../../lib/RecoveryProvider'
import type { CreationAction, CreationResult } from './types'

export function useCreationRequest() {
  const { user } = useSession()
  const recovery = useRecovery()
  const [lastId, setLastId] = useState<string | null>(null)
  async function submit(action: CreationAction) {
    if (!user) return null
    const id = crypto.randomUUID()
    setLastId(id)
    const body: Record<string, unknown> = { ...action, clientOpId: id }
    if (action.action === 'update') {
      const { name, description, configurationFields, recordFields, metrics, components, example, configurationDefaults, recordDefaults } = action.definition
      body.definition = { name, description, configurationFields, recordFields, metrics, components, example, configurationDefaults, recordDefaults }
    }
    return recovery.submit<CreationResult>({ userId: user.id, id, kind: 'creation', path: '/v1/creation/requests', lookup: `/v1/creation/requests/${id}`, body, createdAt: Date.now(), status: 'unknown' })
  }
  return { submit, busy: recovery.busy, pending: !!recovery.entry, lastId, completed: recovery.completed?.entry.kind === 'creation' && (recovery.completed.result as { kind?: string }).kind !== 'delete' ? recovery.completed.result as CreationResult : null, feedback: <RecoveryFeedback requestId={lastId} /> }
}
