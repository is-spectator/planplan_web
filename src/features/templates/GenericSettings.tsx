import { useState, type FormEvent } from 'react'
import type { ChangeScope, GenericValue, TemplatePlanState } from '../../lib/contracts'
import { useOperation } from '../../lib/useOperation'
import { useOperationCompletion } from '../plans/useOperationCompletion'
import { DefaultsEditor } from './DefaultsEditor'
import { DynamicFields } from './DynamicFields'
import { draftFromValues, formatFieldValue, parseFields, type FieldUnits } from './dynamic-fields'
import { GoalPeriodReview, useGoalPeriodReview } from './GoalPeriodReview'

export function GenericSettings({ state, today, onClose }: { state: TemplatePlanState; today: string; onClose: () => void }) {
  const [initial] = useState(state.config)
  const fields = state.definition.configurationFields
  const [draft, setDraft] = useState(() => draftFromValues(fields, { ...initial.values, name: initial.name, startDate: initial.startDate }))
  const [useDefaults, setUseDefaults] = useState(false)
  const [defaultIds, setDefaultIds] = useState(() => Object.keys(initial.recordDefaults ?? {}))
  const [defaultDraft, setDefaultDraft] = useState(() => draftFromValues(state.definition.recordFields, initial.recordDefaults))
  const [units, setUnits] = useState<FieldUnits>({})
  const [scope, setScope] = useState<ChangeScope>('current_and_future')
  const [scopeChanged, setScopeChanged] = useState(false)
  const [touched, setTouched] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState('')
  const { submit, busy, pending, feedback, completed, lastClientOpId } = useOperation()
  const accept = useOperationCompletion(completed, lastClientOpId, busy, onClose)
  const locked = busy || pending
  const goalMetrics = state.definition.metrics.filter((metric) => metric.goalFieldId)
  const suggestedDefaults = { ...state.definition.configurationDefaults, ...initial.proposedDefaults }
  const affectedGoals = goalMetrics.filter((metric) => scopeChanged || touched.has(metric.goalFieldId!) || useDefaults && metric.goalFieldId! in suggestedDefaults)
  const periodReview = useGoalPeriodReview(today, affectedGoals.map((metric) => metric.period), scope, affectedGoals.length > 0)
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (locked || periodReview.needsReview) return
    const parsed = parseFields(fields, draft, units, today)
    setError(parsed.error ?? '')
    if (parsed.error) return
    const defaults = parseFields(state.definition.recordFields.filter((field) => defaultIds.includes(field.id)), defaultDraft)
    if (defaults.error) { setError(defaults.error); return }
    const { name, startDate, ...values } = parsed.values
    const patch: { name?: string; startDate?: string; values?: Record<string, GenericValue> } = {}
    if (typeof name === 'string' && name !== initial.name) patch.name = name
    if (typeof startDate === 'string' && startDate !== initial.startDate) patch.startDate = startDate
    const changed = Object.fromEntries(Object.entries(values).filter(([id, value]) => touched.has(id) || JSON.stringify(value) !== JSON.stringify(initial.values?.[id] ?? null) || scopeChanged && state.definition.metrics.some((metric) => metric.goalFieldId === id)))
    if (Object.keys(changed).length) patch.values = changed
    const result = await submit([{ type: 'configure_generic_plan', planId: state.planId, expectedVersion: initial.version, patch, reviewedOn: today, completeSetup: true, goalScope: scope, applyTemplateDefaults: useDefaults, recordDefaults: defaults.values }])
    if (result) accept(result)
  }
  return <section className="plan-form-panel" aria-labelledby="generic-settings-heading"><h2 id="generic-settings-heading">{initial.setupStatus === 'pending' ? '完善计划设置' : '计划设置'}</h2><form onSubmit={save}><fieldset className="plan-form-fields" disabled={locked}><legend className="sr-only">计划设置</legend>
    {initial.setupStatus === 'pending' && Object.keys(initial.proposedDefaults ?? state.definition.configurationDefaults ?? {}).length > 0 && <section className="plan-notice"><h3>模板建议设置</h3><dl className="generic-inline-fields">{Object.entries(initial.proposedDefaults ?? state.definition.configurationDefaults ?? {}).map(([id, value]) => <div key={id}><dt>{fields.find((field) => field.id === id)?.label ?? '设置'}</dt><dd>{formatFieldValue(fields.find((field) => field.id === id) ?? {}, value)}</dd></div>)}</dl><label className="definition-check"><input type="checkbox" checked={useDefaults} onChange={(event) => { setUseDefaults(event.target.checked); setDraft((current) => ({ ...draftFromValues(fields, { ...initial.values, ...(event.target.checked ? { ...state.definition.configurationDefaults, ...initial.proposedDefaults } : {}), name: initial.name, startDate: initial.startDate }), ...Object.fromEntries(Object.entries(current).filter(([id]) => touched.has(id))) })) }} />确认使用这些建议，仍可逐项修改</label></section>}
    <DynamicFields fields={fields} values={draft} onChange={(next) => { setTouched((current) => new Set([...current, ...Object.keys(next).filter((id) => next[id] !== draft[id])])); setDraft(next) }} units={units} onUnitsChange={setUnits} latestDate={today} readOnly={initial.canChangeStartDate ? [] : ['startDate']} />
    {state.definition.metrics.some((metric) => metric.goalFieldId) && <label>目标生效范围<select value={scope} onChange={(event) => { setScope(event.target.value as ChangeScope); setScopeChanged(true) }}><option value="current_and_future">本周期及以后</option><option value="current_only">仅本周期</option><option value="next_and_future">下个周期及以后</option></select></label>}
    <p className="plan-form-hint">各项目按自身的日、周或月周期生效。设置目标不会产生完成记录；可选项可以留空。</p>
    <GoalPeriodReview review={periodReview} />
    {Object.entries(initial.nextPeriodValues ?? {}).filter(([id, next]) => JSON.stringify(next.value) !== JSON.stringify(initial.values?.[id] ?? null)).map(([id, next]) => <p key={id} className="plan-form-hint">{fields.find((field) => field.id === id)?.label ?? '目标'}从 {next.startsOn} 起：{formatFieldValue(fields.find((field) => field.id === id) ?? {}, next.value)}</p>)}
    <details className="preview-settings"><summary>新增记录的常用值</summary><p className="plan-form-hint">仅在新增记录未提供这个项目时沿用。已保存的记录保持原样；每次都可以修改或明确留空。</p>{Object.keys(state.definition.recordDefaults ?? {}).length > 0 && <button type="button" className="text-link" onClick={() => { setDefaultIds(Object.keys(state.definition.recordDefaults!)); setDefaultDraft(draftFromValues(state.definition.recordFields, state.definition.recordDefaults)) }}>载入模板建议，保存后启用</button>}<DefaultsEditor fields={state.definition.recordFields} selected={defaultIds} draft={defaultDraft} onSelected={setDefaultIds} onDraft={setDefaultDraft} prefix="沿用" /></details>
    {error && <p role="alert" className="plan-form-error">{error}</p>}
    <div className="plan-form-actions"><button type="submit" className="button primary" disabled={periodReview.needsReview}>{busy ? '正在保存…' : '保存设置'}</button>{initial.setupStatus === 'pending' && fields.every((field) => !field.required || ['name', 'startDate'].includes(field.id) || initial.values?.[field.id] !== null && initial.values?.[field.id] !== undefined) && <button type="button" className="button plan-secondary" onClick={async () => { const result = await submit([{ type: 'configure_generic_plan', planId: state.planId, expectedVersion: initial.version, patch: {}, completeSetup: true }]); if (result) accept(result) }}>暂不设置，开始记录</button>}<button type="button" className="text-link" onClick={onClose}>取消</button></div>
  </fieldset>{feedback}<p className="plan-form-hint">如果设置已在别处更新，请取消当前编辑，刷新后重新核对。</p></form></section>
}
