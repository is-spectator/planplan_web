import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { OperationResult, RecordResponse, RecordView, TemplatePlanState } from '../../lib/contracts'
import { useSession } from '../../auth/SessionProvider'
import { useOperation } from '../../lib/useOperation'
import { useOperationCompletion } from '../plans/useOperationCompletion'
import { errorMessage } from '../plans/format'
import { GenericRecordForm } from './GenericRecordForm'
import { formatFieldValue } from './dynamic-fields'

function DeleteGenericRecord({ record, onSaved, onCancel }: { record: RecordView; onSaved: (result: OperationResult) => void; onCancel: () => void }) {
  const [original] = useState(record)
  const { submit, busy, pending, feedback, completed, lastClientOpId } = useOperation()
  const accept = useOperationCompletion(completed, lastClientOpId, busy, onSaved)
  return <div className="record-delete-confirm"><h3>确认删除这条记录？</h3><p>删除后移出统计，其他记录会保留。</p><div className="plan-form-actions"><button className="button plan-danger" type="button" disabled={busy || pending} onClick={async () => { const result = await submit([{ type: 'delete_record', recordId: original.id, expectedVersion: original.version }]); if (result) accept(result) }}>{busy ? '正在删除…' : '确认删除'}</button><button className="button plan-secondary" type="button" disabled={busy || pending} onClick={onCancel}>保留记录</button></div>{feedback}</div>
}
export function GenericRecordInspector({ state, recordId, today, onSaved, onClose }: { state: TemplatePlanState; recordId: string; today: string; onSaved: (result: OperationResult) => void; onClose: () => void }) {
  const { user, request } = useSession()
  const [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view')
  const panel = useRef<HTMLElement>(null)
  useEffect(() => { panel.current?.focus({ preventScroll: true }); panel.current?.scrollIntoView({ block: 'start' }) }, [recordId])
  const query = useQuery({ queryKey: ['user', user!.id, 'record', recordId], queryFn: ({ signal }) => request<RecordResponse>(`/v1/records/${encodeURIComponent(recordId)}`, { signal }) })
  const record = query.data?.record
  const matches = record?.planId === state.planId && record.kind === 'generic'
  return <section className="plan-form-panel record-inspector" ref={panel} tabIndex={-1} aria-labelledby="generic-record-heading"><div className="plan-section-heading"><h2 id="generic-record-heading">{mode === 'edit' ? '修改记录' : '记录详情'}</h2>{mode === 'view' && <button className="button plan-secondary" type="button" onClick={onClose}>关闭</button>}</div>
    {query.isPending && <p role="status">正在读取记录…</p>}{query.isError && <div className="plan-form-error" role="alert"><p>{errorMessage(query.error)}</p><button className="text-link" type="button" onClick={() => void query.refetch()}>重试</button></div>}
    {record && !matches && <p role="alert">这条记录不属于当前计划，请返回原计划查看。</p>}
    {record && matches && <><dl className="record-facts">{state.definition.recordFields.map((field) => <div key={field.id}><dt>{field.label}</dt><dd>{formatFieldValue(field, record.fields?.[field.id])}{record.defaultedFields?.includes(field.id) && <small> · 沿用设置</small>}</dd></div>)}</dl>
      {record.sourceMessageId && <Link className="text-link" to={`/chat?message=${encodeURIComponent(record.sourceMessageId)}`}>查看来源对话</Link>}{query.data?.source && <blockquote className="record-source"><span>来自对话</span><p>{query.data.source.text}</p></blockquote>}
      {record.deleted ? <p className="plan-notice">这条记录已删除，已移出统计。</p> : mode === 'edit' ? <GenericRecordForm state={state} today={today} date={record.date} record={record} onSaved={onSaved} onCancel={() => setMode('view')} /> : mode === 'delete' ? <DeleteGenericRecord record={record} onSaved={onSaved} onCancel={() => setMode('view')} /> : <div className="plan-form-actions"><button className="button plan-secondary" type="button" onClick={() => setMode('edit')}>修改记录</button><button className="button plan-danger-quiet" type="button" onClick={() => setMode('delete')}>删除记录</button><button className="button plan-secondary" type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>刷新记录</button></div>}
    </>}
  </section>
}
