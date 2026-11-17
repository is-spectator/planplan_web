import { useState } from 'react'
import { useSession } from '../auth/SessionProvider'
import type { ChatReply } from '../features/chat/types'
import { RecoveryFeedback, useRecovery } from './RecoveryProvider'

export function useChatRequest() {
  const { user } = useSession()
  const recovery = useRecovery()
  const [lastId, setLastId] = useState<string | null>(null)
  async function send(input: { text: string; pendingId?: string | null; choice?: string | null; scopePlanId?: string | null }) {
    if (!user) return null
    const id = crypto.randomUUID()
    setLastId(id)
    return recovery.submit<ChatReply>({ userId: user.id, id, kind: 'chat', path: '/v1/chat', lookup: `/v1/chat/${id}`, body: { ...input, clientMsgId: id, inputAt: new Date().toISOString() }, createdAt: Date.now(), status: 'unknown' })
  }
  return {
    send,
    lastClientMsgId: lastId,
    completed: recovery.completed?.entry.kind === 'chat' ? recovery.completed.result as ChatReply : null,
    busy: recovery.busy,
    pending: !!recovery.entry,
    feedback: <RecoveryFeedback requestId={lastId} />,
  }
}
