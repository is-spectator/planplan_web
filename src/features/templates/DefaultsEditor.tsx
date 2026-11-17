import type { TemplateField } from '../../lib/contracts'
import { DynamicFields } from './DynamicFields'
import type { FieldDraft } from './dynamic-fields'

export function DefaultsEditor({ fields, selected, draft, onSelected, onDraft, prefix }: { fields: TemplateField[]; selected: string[]; draft: FieldDraft; onSelected: (ids: string[]) => void; onDraft: (draft: FieldDraft) => void; prefix: string }) {
  const available = fields.filter((field) => !['name', 'startDate', 'date'].includes(field.id))
  if (!available.length) return <p className="plan-form-hint">添加可填写的项目后，可以为它设置建议值。</p>
  return <div className="defaults-editor">{available.map((field) => <div key={field.id}><label className="definition-check"><input type="checkbox" checked={selected.includes(field.id)} onChange={(event) => onSelected(event.target.checked ? [...selected, field.id] : selected.filter((id) => id !== field.id))} />{prefix}{field.label}</label>{selected.includes(field.id) && <DynamicFields fields={[field]} values={draft} onChange={onDraft} prefix="默认：" />}</div>)}</div>
}
