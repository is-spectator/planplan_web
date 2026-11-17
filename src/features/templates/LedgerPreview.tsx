import { useState, type FormEvent } from 'react'
import type { TemplateDefinition } from '../../lib/contracts'
import { money } from '../plans/format'
import { DynamicFields } from './DynamicFields'
import { draftFromValues, parseFields } from './dynamic-fields'

export function LedgerPreview({ definition, today }: { definition: TemplateDefinition; today: string }) {
  const fields = definition.recordFields.filter((field) => !['recordRole', 'refundOf'].includes(field.id))
  const [draft, setDraft] = useState(() => draftFromValues(fields, { date: today, category: '餐饮' }))
  const [records, setRecords] = useState<{ id: number; amount: number; note: string; refundOf: number | null }[]>([])
  const [refundOf, setRefundOf] = useState('')
  const [mode, setMode] = useState<'expense' | 'refund'>('expense')
  const [error, setError] = useState('')
  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const parsed = parseFields(fields, draft, {}, today)
    if (parsed.error) { setError(parsed.error); return }
    const amount = parsed.values.amountCents as number
    const expense = records.find((record) => record.id === Number(refundOf) && record.refundOf === null)
    const refunded = records.filter((record) => record.refundOf === expense?.id).reduce((sum, record) => sum + record.amount, 0)
    if (mode === 'refund' && (!expense || amount > expense.amount - refunded)) { setError('请选择原支出，退款不能超过其剩余可退金额。'); return }
    setRecords((current) => [...current, { id: current.length + 1, amount, note: String(parsed.values.note ?? ''), refundOf: mode === 'refund' ? expense!.id : null }])
    setError('')
    setDraft(draftFromValues(fields, { date: today, category: '餐饮' }))
  }
  const spend = records.filter((record) => record.refundOf === null).reduce((sum, record) => sum + record.amount, 0)
  const refunds = records.filter((record) => record.refundOf !== null).reduce((sum, record) => sum + record.amount, 0)
  return <section className="plan-form-panel template-preview" aria-labelledby="ledger-preview-heading"><div className="plan-section-heading"><h2 id="ledger-preview-heading">先试着记一笔</h2><span className="template-badge">独立试填</span></div><p className="plan-form-hint">这里只使用示例账目，不会创建计划、改变预算或进入真实导出。</p><form onSubmit={add}><fieldset className="plan-form-fields"><legend className="sr-only">记账试填</legend><label>试填记录类型<select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="expense">支出</option><option value="refund">退款</option></select></label>{mode === 'refund' && <label>试填原支出<select required value={refundOf} onChange={(event) => setRefundOf(event.target.value)}><option value="">请选择</option>{records.filter((record) => record.refundOf === null).map((record, index) => <option key={record.id} value={record.id}>示例 {index + 1} · {money(record.amount)} {record.note}</option>)}</select></label>}<DynamicFields fields={fields} values={draft} onChange={setDraft} prefix="试填：" latestDate={today} />{error && <p className="plan-form-error" role="alert">{error}</p>}<div className="plan-form-actions"><button className="button plan-secondary" type="submit">加入试填</button><button className="text-link" type="button" onClick={() => { setRecords([]); setRefundOf(''); setError('') }}>清空试填</button></div></fieldset></form><dl className="plan-stat-grid"><div><dt>示例支出</dt><dd>{money(spend)}</dd></div><div><dt>示例退款</dt><dd>{money(refunds)}</dd></div><div><dt>示例净支出</dt><dd>{money(spend - refunds)}</dd></div><div><dt>示例记录</dt><dd>{records.length} 条</dd></div></dl></section>
}
