import { useState, type FormEvent } from 'react'
import type { Action, ChangeScope, TemplatePlanState } from '../../lib/contracts'
import { useOperation } from '../../lib/useOperation'
import { useOperationCompletion } from '../plans/useOperationCompletion'
import { inputFromCents, money } from '../plans/format'
import { canonicalNumber } from './dynamic-fields'
import { GoalPeriodReview, useGoalPeriodReview } from './GoalPeriodReview'

export function LedgerSettings({ state, today, onClose }: { state: TemplatePlanState; today: string; onClose: () => void }) {
  const [initial] = useState(state.config)
  const [name, setName] = useState(initial.name)
  const [budget, setBudget] = useState(inputFromCents(initial.budgetCents ?? null))
  const [touched, setTouched] = useState(false)
  const [scope, setScope] = useState<ChangeScope>('current_and_future')
  const [error, setError] = useState('')
  const { submit, busy, pending, feedback, completed, lastClientOpId } = useOperation()
  const accept = useOperationCompletion(completed, lastClientOpId, busy, onClose)
  const field = state.definition.configurationFields.find((item) => item.id === 'budgetCents')
  const periodReview = useGoalPeriodReview(today, ['month'], scope, touched)
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || pending || periodReview.needsReview) return
    if (!name.trim()) { setError('请给这个计划起个名字。'); return }
    const cents = budget.trim() && field ? canonicalNumber(field, budget) : null
    if (budget.trim() && (!field || cents === null || cents < (field.min ?? 1) || cents > (field.max ?? Number.MAX_SAFE_INTEGER))) { setError('预算请输入有效金额，最多两位小数。'); return }
    setError('')
    const patch: Extract<Action, { type: 'configure_ledger_plan' }>['patch'] = {}
    if (name.trim() !== initial.name) patch.name = name.trim()
    if (touched || cents !== initial.budgetCents) patch.budgetCents = cents
    const result = await submit([{ type: 'configure_ledger_plan', planId: state.planId, expectedVersion: initial.version, patch, reviewedOn: today, completeSetup: true, goalScope: scope }])
    if (result) accept(result)
  }
  return <section className="plan-form-panel" aria-labelledby="ledger-settings-heading"><h2 id="ledger-settings-heading">设置月预算</h2><form onSubmit={save}><fieldset className="plan-form-fields" disabled={busy || pending}><legend className="sr-only">月预算设置</legend><label>计划名称<input required maxLength={20} value={name} onChange={(event) => setName(event.target.value)} /></label><p className="plan-form-hint">原月预算：{initial.budgetCents === null || initial.budgetCents === undefined ? '未设置' : money(initial.budgetCents)}。设置预算不会产生支出，也不会改变已有账目。</p><label>月预算（元，可留空）<input inputMode="decimal" maxLength={18} value={budget} onChange={(event) => { setBudget(event.target.value); setTouched(true) }} /></label><label>预算生效范围<select value={scope} onChange={(event) => { setScope(event.target.value as ChangeScope); setTouched(true) }}><option value="current_and_future">本月及以后</option><option value="current_only">仅本月</option><option value="next_and_future">下月及以后</option></select></label><GoalPeriodReview review={periodReview} /><p className="plan-form-hint">留空表示不设预算，已有支出和退款继续保留。</p>{initial.nextMonthBudget && initial.nextMonthBudget.value !== initial.budgetCents && <p className="plan-form-hint">{initial.nextMonthBudget.startsOn} 起的预算：{initial.nextMonthBudget.value === null ? '未设置' : money(initial.nextMonthBudget.value)}</p>}{error && <p role="alert" className="plan-form-error">{error}</p>}<div className="plan-form-actions"><button className="button primary" type="submit" disabled={periodReview.needsReview}>{busy ? '正在保存…' : '保存预算'}</button>{initial.setupStatus === 'pending' && <button className="button plan-secondary" type="button" onClick={async () => { const result = await submit([{ type: 'configure_ledger_plan', planId: state.planId, expectedVersion: initial.version, patch: {}, completeSetup: true }]); if (result) accept(result) }}>暂不设置，开始记账</button>}<button className="text-link" type="button" onClick={onClose}>取消</button></div></fieldset>{feedback}<p className="plan-form-hint">如果预算已在别处调整，请取消当前编辑，刷新后重新核对。</p></form></section>
}
