import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSession } from '../../auth/SessionProvider'
import { useRecovery, RecoveryFeedback } from '../../lib/RecoveryProvider'
interface DeletionResult { clientOpId: string; kind: 'delete'; transient: false; deleted: { draftId: string; templateId: string | null } }
export function DeleteCreation({ draftId, version, name }: { draftId: string; version: number; name: string }) {
  const { user } = useSession(), recovery = useRecovery(), navigate = useNavigate()
  const [open, setOpen] = useState(false), [lastId, setLastId] = useState<string | null>(null)
  const handled = useRef(recovery.completed?.entry.id)
  const locked = recovery.busy || !!recovery.entry
  useEffect(() => {
    const completed = recovery.completed
    if (!completed || completed.entry.id === handled.current || completed.entry.kind !== 'creation' || completed.entry.body.action !== 'delete' || completed.entry.body.draftId !== draftId) return
    handled.current = completed.entry.id
    setOpen(false)
    navigate('/create', { replace: true })
  }, [recovery.completed, draftId, navigate])
  if (!open) return <button type="button" className="text-link plan-danger-quiet" disabled={locked} aria-label={`删除私人作品${name}`} onClick={() => setOpen(true)}>删除私人作品</button>
  return <section className="plan-notice delete-creation" role="alert"><h3>删除「{name || '未命名草稿'}」的私人草稿和模板？</h3><p>删除后不能继续编辑、查看或新选用这份私人作品，操作无法撤回。已经采用的计划与记录会保留；独立公开的社区作品不会下架，可到社区作品中另行管理。</p><div className="plan-form-actions"><button type="button" className="button plan-danger" disabled={locked} onClick={async () => { const id = crypto.randomUUID(); setLastId(id); const result = await recovery.submit<DeletionResult>({ userId: user!.id, id, kind: 'creation', path: '/v1/creation/requests', lookup: `/v1/creation/requests/${id}`, body: { clientOpId: id, action: 'delete', draftId, expectedVersion: version, confirmDelete: true }, createdAt: Date.now(), status: 'unknown' }); if (result) { handled.current = id; setOpen(false); navigate('/create', { replace: true }) } }}>确认删除私人作品</button><button type="button" className="button plan-secondary" disabled={locked} onClick={() => setOpen(false)}>保留作品</button></div><RecoveryFeedback requestId={lastId} /></section>
}
