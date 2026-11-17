import { useState, type FormEvent } from 'react'
import type { Action, ChangeScope, TemplatePlanState } from '../../lib/contracts'
import { useOperation } from '../../lib/useOperation'
import { positiveInteger, validDate } from '../plans/format'
import { useOperationCompletion } from '../plans/useOperationCompletion'
import { GoalPeriodReview, useGoalPeriodReview } from './GoalPeriodReview'

export function ReadingSettings({ state, today, hasRecords, reading = true, onClose }: { state: TemplatePlanState; today: string; hasRecords: boolean; reading?: boolean; onClose: () => void }) {
  // The opening version belongs to this draft, even if another page saves first.
  const [initial] = useState(state.config)
  const [name, setName] = useState(initial.name)
  const [startDate, setStartDate] = useState(initial.startDate)
  const [book, setBook] = useState(initial.currentBook ?? '')
  const [days, setDays] = useState(initial.daysPerWeek?.toString() ?? '')
  const [minutes, setMinutes] = useState(initial.minMinutes?.toString() ?? '')
  const [scope, setScope] = useState<ChangeScope>('current_and_future')
  const [goalTouched, setGoalTouched] = useState({ days: false, minutes: false })
  const [error, setError] = useState('')
  const { submit, busy, pending, feedback, completed, lastClientOpId } = useOperation()
  const accept = useOperationCompletion(completed, lastClientOpId, busy, onClose)
  const locked = busy || pending
  const canChangeStart = initial.canChangeStartDate ?? (initial.setupStatus === 'pending' && !hasRecords && initial.daysPerWeek === null && initial.minMinutes === null)
  const periodReview = useGoalPeriodReview(today, ['week'], scope, goalTouched.days || goalTouched.minutes)

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (locked || periodReview.needsReview) return
    setError('')
    if (!name.trim()) { setError('请给这个计划起个名字。'); return }
    const daysPerWeek = days.trim() ? positiveInteger(days, 7) : null
    const minMinutes = minutes.trim() ? positiveInteger(minutes, 1440) : null
    if ((days.trim() && daysPerWeek === null) || (minutes.trim() && minMinutes === null)) { setError('每周天数需为 1–7 的整数，每日时长需为 1–1440 的整数分钟。'); return }
    if (!validDate(startDate) || startDate > today) { setError('开始日期请选择今天或以前的有效日期。'); return }
    const patch: Extract<Action, { type: 'configure_reading_plan' }>['patch'] = {}
    if (name.trim() !== initial.name) patch.name = name.trim()
    if (startDate !== initial.startDate) patch.startDate = startDate
    if (reading && (book.trim() || null) !== initial.currentBook) patch.currentBook = book.trim() || null
    if (goalTouched.days || daysPerWeek !== initial.daysPerWeek) patch.daysPerWeek = daysPerWeek
    if (goalTouched.minutes || minMinutes !== initial.minMinutes) patch.minMinutes = minMinutes
    const result = await submit([{ type: 'configure_reading_plan', planId: state.planId, expectedVersion: initial.version, patch, reviewedOn: today, completeSetup: true, goalScope: scope }])
    if (result) accept(result)
  }
  async function skip() {
    if (locked) return
    const result = await submit([{ type: 'configure_reading_plan', planId: state.planId, expectedVersion: initial.version, patch: {}, completeSetup: true }])
    if (result) accept(result)
  }
  return <section className="plan-form-panel" aria-labelledby="reading-settings-title">
    <h2 id="reading-settings-title">{initial.setupStatus === 'pending' ? '让计划更适合你' : '计划设置'}</h2>
    <form onSubmit={save}>
      <fieldset className="plan-form-fields" disabled={locked}>
        <legend className="sr-only">计划设置</legend>
        <div className="plan-field-pair"><label>计划名称<input required maxLength={20} value={name} onChange={(event) => setName(event.target.value)} /></label><label>开始日期<input type="date" required max={today} value={startDate} disabled={!canChangeStart} onChange={(event) => setStartDate(event.target.value)} /></label></div>
        {reading && <label>当前书籍（可留空）<input maxLength={80} value={book} onChange={(event) => setBook(event.target.value)} placeholder="例如：置身事内" /></label>}
        <div className="plan-field-pair"><label>每周目标天数（可留空）<input inputMode="numeric" maxLength={1} value={days} onChange={(event) => { setDays(event.target.value); setGoalTouched({ ...goalTouched, days: true }) }} placeholder="例如 5" /></label><label>每日目标分钟（可留空）<input inputMode="numeric" maxLength={4} value={minutes} onChange={(event) => { setMinutes(event.target.value); setGoalTouched({ ...goalTouched, minutes: true }) }} placeholder="例如 20" /></label></div>
        <label>目标生效范围<select value={scope} onChange={(event) => { setScope(event.target.value as ChangeScope); setGoalTouched({ days: true, minutes: true }) }}><option value="current_and_future">本周及以后</option><option value="current_only">仅本周</option><option value="next_and_future">下周及以后</option></select></label>
        <p className="plan-form-hint">表单保留打开设置时的目标。{initial.nextWeekGoals && `已安排的目标（${initial.nextWeekGoals.startsOn} 起）：每周 ${initial.nextWeekGoals.daysPerWeek ?? '未设置'} 天，每天 ${initial.nextWeekGoals.minMinutes ?? '未设置'} 分钟。`}</p>
        <GoalPeriodReview review={periodReview} />
        <p className="plan-form-hint">目标不是已完成的记录。目标可以留空，之后照常记下{reading ? '阅读' : '学习'}时长；首周目标按计划开始日期计算。{reading && '更换当前书籍不会改动已有记录。'}</p>
        {!canChangeStart && <p className="plan-form-hint">计划开始后保留原开始日期，历史记录和目标周期不会被重置。</p>}
        {error && <p role="alert" className="plan-form-error">{error}</p>}
        <div className="plan-form-actions"><button className="button primary" type="submit" disabled={periodReview.needsReview}>{busy ? '正在保存…' : '保存设置'}</button>{initial.setupStatus === 'pending' && <button className="button plan-secondary" type="button" onClick={() => void skip()}>暂不设置，开始记录</button>}<button className="text-link" type="button" onClick={onClose}>取消</button></div>
      </fieldset>
      {feedback}
      <p className="plan-form-hint">若设置已在别处更新，请取消当前编辑，刷新后重新核对。</p>
    </form>
  </section>
}
