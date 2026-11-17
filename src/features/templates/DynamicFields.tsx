import type { TemplateField } from '../../lib/contracts'
import { canonicalNumber, unitLabel, type FieldDraft, type FieldUnits } from './dynamic-fields'

export function DynamicFields({ fields, values, onChange, units = {}, onUnitsChange, prefix = '', latestDate, readOnly = [] }: {
  fields: TemplateField[]; values: FieldDraft; onChange: (values: FieldDraft) => void; units?: FieldUnits; onUnitsChange?: (units: FieldUnits) => void; prefix?: string; latestDate?: string; readOnly?: string[]
}) {
  return <div className="dynamic-fields">{fields.map((field) => {
    const label = `${prefix}${field.label}${field.unit && field.unit !== 'ml' ? `（${unitLabel(field.unit)}）` : ''}${field.required ? '' : '（可留空）'}`
    const value = values[field.id] ?? ''
    let selected: string[] = []
    if (field.type === 'multi_select') { try { const parsed: unknown = JSON.parse(value || '[]'); if (Array.isArray(parsed)) selected = parsed.filter((item): item is string => typeof item === 'string') } catch { /* Display no selection until corrected. */ } }
    const common = { 'aria-label': label, value, disabled: readOnly.includes(field.id), required: field.required, onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onChange({ ...values, [field.id]: event.target.value }) }
    return <div className="dynamic-field" key={field.id}>
      {field.type === 'text' ? <label>{label}{field.maxLength && field.maxLength <= 80 ? <input {...common} maxLength={field.maxLength} /> : <textarea {...common} rows={2} maxLength={field.maxLength ?? 200} />}</label>
        : field.type === 'single_select' ? <label>{label}<select {...common}><option value="">请选择</option>{field.options?.map((option) => <option key={option} value={option}>{option === 'expense' ? '支出' : option === 'refund' ? '退款' : option}</option>)}</select></label>
        : field.type === 'boolean' ? <label>{label}<select {...common}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select></label>
        : field.type === 'multi_select' ? <fieldset className="dynamic-multiselect" disabled={readOnly.includes(field.id)}><legend>{label}</legend>{field.options?.map((option) => <label key={option}><input type="checkbox" checked={selected.includes(option)} onChange={(event) => onChange({ ...values, [field.id]: JSON.stringify(event.target.checked ? [...selected, option] : selected.filter((item) => item !== option)) })} />{option}</label>)}</fieldset>
        : ['date', 'integer', 'money', 'duration'].includes(field.type) ? <label>{label}<input {...common} type={field.type === 'date' ? 'date' : 'text'} inputMode={field.type === 'date' ? undefined : field.type === 'money' || units[field.id] === 'L' ? 'decimal' : 'numeric'} max={field.type === 'date' ? latestDate : undefined} maxLength={field.type === 'date' ? undefined : 18} /></label>
        : <p role="alert" className="plan-form-error">暂时无法填写「{field.label}」，请更新页面后再试。</p>}
      {field.unit === 'ml' && onUnitsChange && <label className="dynamic-unit">单位<select aria-label={`${prefix}${field.label}单位`} value={units[field.id] ?? 'ml'} disabled={readOnly.includes(field.id)} onChange={(event) => {
        const next = event.target.value
        const canonical = canonicalNumber(field, value, units[field.id])
        if (canonical !== null) onChange({ ...values, [field.id]: String(next === 'L' ? canonical / 1000 : canonical) })
        onUnitsChange({ ...units, [field.id]: next })
      }}><option value="ml">ml 毫升</option><option value="L">L 升</option></select></label>}
    </div>
  })}</div>
}
import type { ChangeEvent } from 'react'
