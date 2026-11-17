import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useOperation } from '../../lib/useOperation'
import type { Action, PlanKind } from '../../lib/contracts'
import { centsFromInput, positiveInteger } from './format'
import { useOperationCompletion } from './useOperationCompletion'

export function CreatePlanForm({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<PlanKind>('ledger')
  const [budget, setBudget] = useState('')
  const [name, setName] = useState('')
  const [activity, setActivity] = useState('')
  const [days, setDays] = useState('')
  const [minutes, setMinutes] = useState('')
  const [error, setError] = useState('')
  const { submit, busy, feedback, pending, completed, lastClientOpId } = useOperation()
  const navigate = useNavigate()
  const locked = busy || pending
  const accept = useOperationCompletion(completed, lastClientOpId, busy, (result) => {
    const created = result.items.find((item) => item.type === 'plan_created')
    if (created?.type === 'plan_created') navigate(`/plans/${created.plan.id}`)
    onClose()
  })

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (locked) return
    setError('')
    let action: Action
    if (kind === 'ledger') {
      const budgetCents = budget.trim() ? centsFromInput(budget) : null
      if (budget.trim() && budgetCents === null) { setError('预算请输入 0.01 至 999,999.99 元，最多两位小数。'); return }
      action = { type: 'create_ledger', budgetCents }
    } else {
      if (!name.trim()) { setError('给学习计划取个名字。'); return }
      const daysPerWeek = days.trim() ? positiveInteger(days, 7) : null
      const minMinutes = minutes.trim() ? positiveInteger(minutes, 1440) : null
      if (days.trim() && daysPerWeek === null) { setError('每周天数请输入 1 到 7 的整数。'); return }
      if (minutes.trim() && minMinutes === null) { setError('每日时长请输入 1 到 1440 的整数。'); return }
      action = { type: 'create_study', name: name.trim(), activity: activity.trim() || name.trim(), daysPerWeek, minMinutes }
    }
    const result = await submit([action])
    if (result) accept(result)
  }

  return (
    <section className="plan-form-panel" aria-labelledby="create-plan-title">
      <h2 id="create-plan-title">新建计划</h2>
      <form onSubmit={create}>
        <fieldset disabled={locked} className="plan-form-fields">
          <legend className="sr-only">计划信息</legend>
          <div className="plan-kind-options" role="group" aria-label="计划类型">
            <button type="button" aria-pressed={kind === 'ledger'} onClick={() => setKind('ledger')}>记账</button>
            <button type="button" aria-pressed={kind === 'study'} onClick={() => setKind('study')}>学习计划</button>
          </div>
          {kind === 'ledger' ? <>
            <p className="plan-form-hint">用一个计划记录日常开销。已有计划可以直接使用；归档后可恢复。</p>
            <label>月预算（元，可留空）<input name="budget" inputMode="decimal" value={budget} onChange={(event) => setBudget(event.target.value)} placeholder="例如 3000" maxLength={12} /></label>
          </> : <>
            <label>计划名称<input name="name" required maxLength={20} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：阅读" /></label>
            <label>学习内容（可留空）<input name="activity" maxLength={20} value={activity} onChange={(event) => setActivity(event.target.value)} placeholder="例如：英语阅读" /></label>
            <div className="plan-field-pair">
              <label>每周天数（可留空）<input name="daysPerWeek" inputMode="numeric" value={days} onChange={(event) => setDays(event.target.value)} placeholder="1–7 天" maxLength={1} /></label>
              <label>每日分钟（可留空）<input name="minMinutes" inputMode="numeric" value={minutes} onChange={(event) => setMinutes(event.target.value)} placeholder="例如 20" maxLength={4} /></label>
            </div>
            <p className="plan-form-hint">目标可以稍后设定。未设完整目标时，仍然可以记录学习时长。</p>
          </>}
          {error && <p className="plan-form-error" role="alert">{error}</p>}
          <div className="plan-form-actions"><button className="button primary" type="submit">{busy ? '正在创建…' : '创建计划'}</button><button type="button" className="button plan-secondary" onClick={onClose}>取消</button></div>
        </fieldset>
        {feedback}
      </form>
    </section>
  )
}
