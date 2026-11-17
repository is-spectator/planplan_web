import { useState } from 'react'
import { useSession } from '../../auth/SessionProvider'
import { RecoveryFeedback, useRecovery } from '../../lib/RecoveryProvider'
import type { CommunityAction, CommunityResult } from './types'
export function useCommunityRequest() {
  const { user } = useSession()
  const recovery = useRecovery()
  const [lastId, setLastId] = useState<string | null>(null)
  async function submit(action: CommunityAction) {
    if (!user) return null
    const id = crypto.randomUUID(); setLastId(id)
    return recovery.submit<CommunityResult>({ userId: user.id, id, kind: 'community', path: '/v1/community/requests', lookup: `/v1/community/requests/${id}`, body: { ...action, clientOpId: id }, createdAt: Date.now(), status: 'unknown' })
  }
  return { submit, locked: recovery.busy || !!recovery.entry, completed: recovery.completed?.entry.kind === 'community' ? recovery.completed.result as CommunityResult : null, feedback: <RecoveryFeedback requestId={lastId} /> }
}
