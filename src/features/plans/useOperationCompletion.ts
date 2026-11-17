import { useCallback, useEffect, useRef } from 'react'
import type { OperationResult } from '../../lib/contracts'

// A recovered response must finish the originating form just like its direct response.
// The hook-local client ID prevents another form's completion from clearing this draft.
export function useOperationCompletion(completed: OperationResult | null, lastClientOpId: string | null, busy: boolean, onSaved: (result: OperationResult) => void) {
  const handled = useRef<string | null>(null)
  const accept = useCallback((result: OperationResult) => {
    if (handled.current === result.clientOpId) return
    handled.current = result.clientOpId
    onSaved(result)
  }, [onSaved])

  useEffect(() => {
    if (!busy && completed && completed.clientOpId === lastClientOpId) accept(completed)
  }, [completed, lastClientOpId, busy, accept])
  return accept
}
