import { useState } from 'react'
import type { OperationResult } from '../../lib/contracts'
import { useOperation } from '../../lib/useOperation'
import { useOperationCompletion } from './useOperationCompletion'

export function UndoPlanOperation({ operation, onDone }: { operation: OperationResult; onDone: () => void }) {
  const [confirm, setConfirm] = useState(false)
  const { undo, busy, pending, feedback, completed, lastClientOpId } = useOperation()
  const accept = useOperationCompletion(completed, lastClientOpId, busy, onDone)
  return <section className="plan-notice" aria-label="最近保存的记录">
    <p>{confirm ? '撤销这次更改？如果记录已在别处更新，会先提示冲突。' : '记录已保存，统计已更新。'}</p>
    <div className="plan-form-actions"><button className="button plan-secondary" type="button" disabled={busy || pending} onClick={async () => { if (!confirm) { setConfirm(true); return }; const result = await undo(operation.operationId); if (result) accept(result) }}>{busy ? '正在撤销…' : confirm ? '确认撤销更改' : '撤销这次更改'}</button><button className="text-link" type="button" disabled={busy || pending} onClick={() => confirm ? setConfirm(false) : onDone()}>{confirm ? '保留更改' : '关闭提示'}</button></div>
    {feedback}
  </section>
}
