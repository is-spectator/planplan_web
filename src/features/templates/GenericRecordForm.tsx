import { useState, type FormEvent } from 'react'
import type { OperationResult, RecordView, TemplatePlanState } from '../../lib/contracts'
import { useOperation } from '../../lib/useOperation'
import { useOperationCompletion } from '../plans/useOperationCompletion'
import { DynamicFields } from './DynamicFields'
import { draftFromValues, parseFields, type FieldUnits } from './dynamic-fields'

export function GenericRecordForm({ state, today, date, record, onSaved, onCancel }: { state: TemplatePlanState; today: string; date: string; record?: RecordView; onSaved: (result: OperationResult) => void; onCancel: () => void }) {
  const [original] = useState(record)
  const [draft, setDraft] = useState(() => draftFromValues(state.definition.recordFields, original?.fields ?? { ...state.config.recordDefaults, date }))
  const [touched, setTouched] = useState<string[]>([])
  const [units, setUnits] = useState<FieldUnits>({})
  const [error, setError] = useState('')
  const { submit, busy, pending, feedback, completed, lastClientOpId } = useOperation()
  const accept = useOperationCompletion(completed, lastClientOpId, busy, onSaved)
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || pending) return
    const parsed = parseFields(state.definition.recordFields, draft, units, today)
    setError(parsed.error ?? '')
    if (parsed.error) return
    if (!original) for (const id of Object.keys(state.config.recordDefaults ?? {})) if (!touched.includes(id)) delete parsed.values[id]
    const result = await submit([original
      ? { type: 'edit_generic_record', recordId: original.id, expectedVersion: original.version, values: parsed.values }
      : { type: 'add_generic_record', planId: state.planId, values: parsed.values }])
    if (result) accept(result)
  }
  return <form onSubmit={save} className="record-form"><fieldset className="plan-form-fields" disabled={busy || pending}><legend className="sr-only">{original ? '修改记录' : '填写记录'}</legend>
    <DynamicFields fields={state.definition.recordFields} values={draft} onChange={(next) => { setTouched((current) => [...new Set([...current, ...Object.keys(next).filter((id) => next[id] !== draft[id])])]); setDraft(next) }} units={units} onUnitsChange={setUnits} latestDate={today} />
    {!original && Object.keys(state.config.recordDefaults ?? {}).length > 0 && <p className="plan-form-hint">已带入常用值：{state.definition.recordFields.filter((field) => field.id in (state.config.recordDefaults ?? {}) && !touched.includes(field.id)).map((field) => field.label).join('、')}。可逐项修改或清空。</p>}
    {error && <p role="alert" className="plan-form-error">{error}</p>}<div className="plan-form-actions"><button type="submit" className="button primary">{busy ? '正在保存…' : original ? '保存修改' : '保存记录'}</button><button type="button" className="button plan-secondary" onClick={onCancel}>取消</button></div>
  </fieldset>{feedback}{original && <p className="plan-form-hint">若记录已在别处修改，请取消当前编辑，刷新后重新核对。</p>}</form>
}
