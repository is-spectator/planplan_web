import { useState, type FormEvent } from 'react'
import type { GenericValue, TemplateDefinition } from '../../lib/contracts'
import { DynamicFields } from './DynamicFields'
import { GenericMetrics } from './GenericMetrics'
import { draftFromValues, formatFieldValue, parseFields, previewSummary, type FieldDraft, type FieldUnits } from './dynamic-fields'

type TrialRecord = { id: string; values: Record<string, GenericValue>; defaultedFields: string[] }

export function GenericPreview({ definition, today }: { definition: TemplateDefinition; today: string }) {
  const initialConfig = () => draftFromValues(definition.configurationFields, { ...definition.example.config, name: definition.name.slice(0, definition.configurationFields.find((field) => field.id === 'name')?.maxLength ?? 20), startDate: today } as Record<string, GenericValue>)
  const [configDraft, setConfigDraft] = useState(initialConfig)
  const [date, setDate] = useState(today)
  const [recordDraft, setRecordDraft] = useState(() => draftFromValues(definition.recordFields, { date: today }))
  const [configUnits, setConfigUnits] = useState<FieldUnits>({})
  const [recordUnits, setRecordUnits] = useState<FieldUnits>({})
  const [useRecordDefaults, setUseRecordDefaults] = useState(false)
  const [touched, setTouched] = useState<string[]>([])
  const [records, setRecords] = useState<TrialRecord[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState('')
  const config = parseFields(definition.configurationFields, configDraft, configUnits, today)
  const summary = previewSummary(definition, config.error ? {} : config.values, records.map((record) => record.values), date)
  const visible = records.filter((record) => record.values.date === date)
  const configDefaults = definition.configurationDefaults ?? {}
  const recordDefaults = definition.recordDefaults ?? {}
  function clearForm(nextDate = date) { setRecordDraft(draftFromValues(definition.recordFields, { ...(useRecordDefaults ? recordDefaults : {}), date: nextDate })); setTouched([]); setRecordUnits({}); setEditing(null); setError('') }
  function changeRecord(next: FieldDraft) { setTouched((current) => [...new Set([...current, ...Object.keys(next).filter((id) => next[id] !== recordDraft[id])])]); setRecordDraft(next) }
  function toggleRecordDefaults(enabled: boolean) {
    const untouched = definition.recordFields.filter((field) => field.id in recordDefaults && !touched.includes(field.id))
    setRecordDraft((current) => ({ ...current, ...draftFromValues(untouched, enabled ? recordDefaults : {}) }))
    setRecordUnits((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !untouched.some((field) => field.id === id))))
    setUseRecordDefaults(enabled); setError('')
  }
  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const parsed = parseFields(definition.recordFields, recordDraft, recordUnits, today)
    if (parsed.error || config.error) { setError(parsed.error ?? config.error!); return }
    setRecords((current) => editing ? current.map((record) => record.id === editing ? { ...record, values: parsed.values, defaultedFields: record.defaultedFields.filter((id) => !touched.includes(id)) } : record) : [...current, { id: crypto.randomUUID(), values: parsed.values, defaultedFields: useRecordDefaults ? Object.keys(recordDefaults).filter((id) => !touched.includes(id)) : [] }])
    if (typeof parsed.values.date === 'string') setDate(parsed.values.date)
    clearForm(typeof parsed.values.date === 'string' ? parsed.values.date : date)
  }
  function reset() { setRecords([]); setDate(today); setConfigDraft(initialConfig()); setConfigUnits({}); setRecordDraft(draftFromValues(definition.recordFields, { date: today })); setRecordUnits({}); setTouched([]); setUseRecordDefaults(false); setEditing(null); setError('') }
  return <section className="template-preview" aria-labelledby="generic-preview-heading">
    <div className="plan-form-panel"><div className="plan-section-heading"><h2 id="generic-preview-heading">先试着记一次</h2><span className="template-badge">独立试填</span></div><p className="plan-form-hint">下面是示例设置。试填仅留在当前页面，不会创建计划、写入记录或进入导出。切换日期会重置未提交的试填表单。</p>
      <details className="preview-settings"><summary>调整试填设置</summary><fieldset className="plan-form-fields"><legend className="sr-only">试填设置</legend>{Object.keys(configDefaults).length > 0 && <div className="plan-notice"><p>首次设置建议：{definition.configurationFields.filter((field) => field.id in configDefaults).map((field) => `${field.label} ${formatFieldValue(field, configDefaults[field.id])}`).join('、')}。</p><button type="button" className="text-link" onClick={() => { setConfigDraft((current) => ({ ...current, ...draftFromValues(definition.configurationFields.filter((field) => field.id in configDefaults), configDefaults) })); setConfigUnits((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !(id in configDefaults)))); setError('') }}>载入首次设置建议</button></div>}<DynamicFields fields={definition.configurationFields} values={configDraft} onChange={setConfigDraft} units={configUnits} onUnitsChange={setConfigUnits} prefix="试填设置：" latestDate={today} /></fieldset></details>
      <form onSubmit={add}><fieldset className="plan-form-fields"><legend className="sr-only">试填记录</legend>{Object.keys(recordDefaults).length > 0 && <div className="plan-notice"><p>常用记录建议：{definition.recordFields.filter((field) => field.id in recordDefaults).map((field) => `${field.label} ${formatFieldValue(field, recordDefaults[field.id])}`).join('、')}。</p><label className="definition-check"><input type="checkbox" checked={useRecordDefaults} disabled={!!editing} onChange={(event) => toggleRecordDefaults(event.target.checked)} />试填时沿用常用记录建议</label><p className="plan-form-hint">只带入新增试填中未填写的项目，可修改或明确留空；修改已有试填时保留原值。</p></div>}<DynamicFields fields={definition.recordFields} values={recordDraft} onChange={changeRecord} units={recordUnits} onUnitsChange={setRecordUnits} prefix="试填：" latestDate={today} />{error && <p role="alert" className="plan-form-error">{error}</p>}<div className="plan-form-actions"><button className="button plan-secondary" type="submit">{editing ? '保存试填修改' : '加入试填'}</button>{editing && <button className="text-link" type="button" onClick={() => clearForm()}>取消修改</button>}<button className="text-link" type="button" onClick={reset}>清空试填</button></div></fieldset></form>
    </div>
    <label className="period-select preview-date">查看试填日期<input type="date" aria-label="查看试填日期" value={date} max={today} onChange={(event) => { const next = event.target.value; if (next) { setDate(next); clearForm(next) } }} /></label>
    {definition.components.map((component) => component === 'records' ? <section className="plan-form-panel" key={component} aria-label="试填记录列表"><h2>试填记录 · {visible.length} 条</h2>{visible.length === 0 ? <p className="plan-form-hint">这一天还没有试填记录。</p> : <ul className="template-preview-records">{visible.map((record, index) => <li key={record.id}><dl className="generic-inline-fields">{definition.recordFields.map((field) => record.values[field.id] !== null && record.values[field.id] !== undefined && <div key={field.id}><dt>{field.label}</dt><dd>{formatFieldValue(field, record.values[field.id])}{record.defaultedFields.includes(field.id) && <small> · 沿用设置</small>}</dd></div>)}</dl><div className="trial-record-actions"><button type="button" className="text-link" aria-label={`修改试填 ${index + 1}`} onClick={() => { setEditing(record.id); setRecordDraft(draftFromValues(definition.recordFields, record.values)); setTouched([]); setRecordUnits({}); setError('') }}>修改</button><button type="button" className="text-link" aria-label={`删除试填 ${index + 1}`} onClick={() => { setRecords((current) => current.filter((item) => item.id !== record.id)); if (editing === record.id) clearForm() }}>移除</button></div></li>)}</ul>}</section> : component === 'summary' || component === 'goal' || component === 'trend' || component === 'categories' ? <GenericMetrics key={component} definition={definition} summary={summary} component={component} /> : null)}
  </section>
}
