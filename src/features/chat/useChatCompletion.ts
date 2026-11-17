import { useCallback, useEffect, useRef } from 'react'
import type { ChatReply } from './types'

// A recovered reply completes only its originating draft, once.
export function useChatCompletion(completed: ChatReply | null, lastClientMsgId: string | null, busy: boolean, onReceived: (reply: ChatReply) => void) {
  const handled = useRef<string | null>(null)
  const accept = useCallback((reply: ChatReply) => {
    const id = reply.user.clientMsgId
    if (!id || handled.current === id) return
    handled.current = id
    onReceived(reply)
  }, [onReceived])
  useEffect(() => {
    if (!busy && completed && completed.user.clientMsgId === lastClientMsgId) accept(completed)
  }, [completed, lastClientMsgId, busy, accept])
  return accept
}
