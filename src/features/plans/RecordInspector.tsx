import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useSession } from '../../auth/SessionProvider'
import { useOperation } from '../../lib/useOperation'
import { useRecovery } from '../../lib/RecoveryProvider'
import type { OperationResult, PlanView, RecordResponse, RecordView, RefundSnapshot } from '../../lib/contracts'
import { errorMessage, money } from './format'
import { RecordForm } from './RecordForm'
import { useOperationCompletion } from './useOperationCompletion'

function DeleteRecord({ record, refundSnapshot, onSaved, onCancel, onRecheck }: { record: RecordView; refundSnapshot: RefundSnapshot | null | undefined; onSaved: (result: OperationResult) => void; onCancel: () => void; onRecheck: () => void }) {
  const [original] = useState(record)
  const [snapshot] = useState(() => refundSnapshot ? { ...refundSnapshot } : null)
  const [includeRefunds, setIncludeRefunds] = useState(false)
  const [rejected, setRejected] = useState(false)
  const { submit, busy, pending, feedback, completed, lastClientOpId } = useOperation()
  const { conflict } = useRecovery()
  const accept = useOperationCompletion(completed, lastClientOpId, busy, onSaved)
  const expense = original.kind === 'expense'
  const validSnapshot = !!snapshot && /^refunds-v1:[a-f0-9]{64}$/.test(snapshot.token) && Number.isSafeInteger(snapshot.count) && snapshot.count >= 0 && Number.isSafeInteger(snapshot.totalCents) && snapshot.totalCents >= 0
  const missingSnapshot = expense && !validSnapshot
  const hasRefunds = expense && validSnapshot && snapshot.count > 0
  // A cleared global notice must not make this already-rejected confirmation valid again.
  if (!rejected && lastClientOpId && conflict?.entry.id === lastClientOpId) setRejected(true)
  return <div className="record-delete-confirm">
    <h3>确认删除这条记录？</h3>
    <p>删除后，这条记录将移出统计。</p>
    {expense && validSnapshot && <p className="plan-form-hint">本次核对：关联退款 {snapshot.count} 条，合计 {money(snapshot.totalCents)}。确认期间若有变化，会停止删除并请你重新核对。</p>}
    {missingSnapshot && <p role="alert" className="plan-form-error">暂时无法核对关联退款，请刷新记录后重新确认删除。</p>}
    {hasRefunds && <label className="plan-checkbox"><input type="checkbox" disabled={busy || pending || rejected} checked={includeRefunds} onChange={(event) => setIncludeRefunds(event.target.checked)} />同时删除关联退款（{snapshot.count} 条，共 {money(snapshot.totalCents)}）</label>}
    {rejected && <p className="plan-notice">这次删除没有执行。请取消并重新核对，再决定是否删除当前记录及关联退款。</p>}
    <div className="plan-form-actions">
      <button type="button" className="button plan-danger" disabled={busy || pending || missingSnapshot || rejected || (hasRefunds && !includeRefunds)} onClick={async () => {
        const result = await submit([{ type: 'delete_record', recordId: original.id, expectedVersion: original.version, includeRefunds, ...(expense && snapshot ? { expectedRefundSnapshot: snapshot.token } : {}), correctionReason: 'normal_adjustment' }])
        if (result) accept(result)
      }}>{busy ? '正在删除…' : '确认删除'}</button>
      <button type="button" className="button plan-secondary" disabled={busy || pending} onClick={onCancel}>保留记录</button>
      {(rejected || missingSnapshot) && <button type="button" className="text-link" disabled={busy || pending} onClick={onRecheck}>取消并重新核对</button>}
    </div>
    {feedback}
  </div>
}

export function RecordInspector({ recordId, plan, today, reading, onClose, onSaved }: {
  recordId: string
  plan: PlanView
  today: string
  reading?: { currentBook: string | null }
  onClose: () => void
  onSaved: (result: OperationResult) => void
}) {
  const { user, request } = useSession()
  const { feedback } = useOperation()
  const [mode, setMode] = useState<'view' | 'edit' | 'refund' | 'delete'>('view')
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    panel.current?.focus({ preventScroll: true })
    panel.current?.scrollIntoView({ block: 'start' })
  }, [recordId])
  const detail = useQuery({
    queryKey: ['user', user?.id, 'record', recordId],
    queryFn: ({ signal }) => request<RecordResponse>(`/v1/records/${encodeURIComponent(recordId)}`, { signal }),
    enabled: Boolean(user),
  })
  const record = detail.data?.record
  const matches = record?.planId === plan.id

  return <section ref={panel} tabIndex={-1} className="plan-form-panel record-inspector" aria-labelledby="record-detail-heading">
    <div className="plan-section-heading"><h2 id="record-detail-heading">{mode === 'edit' ? '修改记录' : mode === 'refund' ? '记录退款' : '记录详情'}</h2>{(mode === 'view' || record?.deleted) && <button type="button" className="button plan-secondary" onClick={onClose}>关闭</button>}</div>
    {(mode === 'view' || record?.deleted) && feedback}
    {detail.isPending && <p role="status">正在读取记录…</p>}
    {detail.isError && <div role="alert" className="plan-form-error"><p>{errorMessage(detail.error)}</p><button type="button" className="text-link" onClick={() => void detail.refetch()}>重试</button></div>}
    {record && !matches && <p role="alert">这条记录属于其他计划，请返回原计划查看。</p>}
    {record && matches && <>
      <dl className="record-facts">
        <div><dt>{record.kind === 'study' ? reading ? '阅读时长' : '学习时长' : record.kind === 'refund' ? '退款金额' : '支出金额'}</dt><dd>{record.kind === 'study' ? `${record.minutes} 分钟` : money(record.amountCents ?? 0)}</dd></div>
        <div><dt>日期</dt><dd>{record.date}</dd></div>
        {record.category && <div><dt>分类</dt><dd>{record.category}</dd></div>}
        {record.note && <div><dt>备注</dt><dd>{record.note}</dd></div>}
        {(record.refundedCents ?? 0) > 0 && <div><dt>已退款</dt><dd>{money(record.refundedCents ?? 0)}</dd></div>}
      </dl>
      {record.refundOf && <Link className="text-link" to={`/plans/${plan.id}?record=${encodeURIComponent(record.refundOf)}`}>查看关联的原支出</Link>}
      {record.sourceMessageId && <Link className="text-link" to={`/chat?message=${encodeURIComponent(record.sourceMessageId)}`}>查看来源对话</Link>}{detail.data?.source && <blockquote className="record-source"><span>来自对话</span><p>{detail.data.source.text}</p></blockquote>}
      {record.deleted ? <p className="plan-notice">这条记录已删除，已移出统计。</p> : mode === 'view' ? <div className="plan-form-actions">
        <button className="button plan-secondary" type="button" disabled={detail.isFetching || detail.isError} onClick={() => setMode('edit')}>修改记录</button>
        {record.kind === 'expense' && plan.status === 'active' && (record.refundedCents ?? 0) < (record.amountCents ?? 0) && <button className="button plan-secondary" type="button" disabled={detail.isFetching || detail.isError} onClick={() => setMode('refund')}>记录退款</button>}
        <button className="button plan-danger-quiet" type="button" disabled={detail.isFetching || detail.isError} onClick={() => setMode('delete')}>删除记录</button>
        <button className="button plan-secondary" type="button" disabled={detail.isFetching} onClick={() => void detail.refetch()}>刷新记录</button>
      </div> : mode === 'delete' ? <DeleteRecord record={record} refundSnapshot={detail.data?.refundSnapshot} onSaved={onSaved} onCancel={() => setMode('view')} onRecheck={() => { setMode('view'); void detail.refetch() }} /> : <>
        <RecordForm plan={plan} today={today} reading={reading} record={mode === 'edit' ? record : undefined} refundOf={mode === 'refund' ? record : undefined} onSaved={onSaved} onCancel={() => setMode('view')} />
        <p className="plan-form-hint">如果记录已在别处修改，请取消当前编辑，刷新记录后重新核对。</p>
      </>}
    </>}
  </section>
}
