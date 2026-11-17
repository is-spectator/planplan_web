import { useState } from 'react'
import type { ChangeScope } from '../../lib/contracts'
import { periodRange } from './dynamic-fields'

type Period = 'day' | 'week' | 'month'

function periodDescription(today: string, period: Period, scope: ChangeScope) {
  const from = periodRange(today, period).from
  const next = new Date(`${from}T12:00:00Z`)
  if (period === 'month') next.setUTCMonth(next.getUTCMonth() + 1)
  else next.setUTCDate(next.getUTCDate() + (period === 'week' ? 7 : 1))
  const nextStart = next.toISOString().slice(0, 10)
  next.setUTCDate(next.getUTCDate() - 1)
  const end = next.toISOString().slice(0, 10)
  const label = { day: '日目标', week: '周目标', month: '月目标' }[period]
  return `${label}：${scope === 'current_only' ? `${from} 至 ${end}` : `${scope === 'next_and_future' ? nextStart : from} 起`}`
}

// eslint-disable-next-line react-refresh/only-export-components
export function useGoalPeriodReview(today: string, periods: Period[], scope: ChangeScope, affectsGoals: boolean) {
  const unique = [...new Set(periods)].sort()
  const key = scope + '|' + unique.map((period) => `${period}:${periodRange(today, period).from}`).join('|')
  const [openedOn] = useState(today)
  const openedKey = scope + '|' + unique.map((period) => `${period}:${periodRange(openedOn, period).from}`).join('|')
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null)
  const changed = affectsGoals && openedKey !== key
  return {
    changed,
    needsReview: changed && confirmedKey !== key,
    confirmed: !changed || confirmedKey === key,
    confirm: (confirmed: boolean) => setConfirmedKey(confirmed ? key : null),
    description: unique.map((period) => periodDescription(today, period, scope)).join('；'),
  }
}

export function GoalPeriodReview({ review }: { review: ReturnType<typeof useGoalPeriodReview> }) {
  if (!review.changed) return null
  return <div className="plan-notice" role="alert">
    <p>日期已进入新的周期，你填写的内容已保留。保存前请核对这次目标的生效范围。</p>
    <p>{review.description}。</p>
    <label className="definition-check"><input type="checkbox" checked={review.confirmed} onChange={(event) => review.confirm(event.target.checked)} />已核对新的生效周期</label>
  </div>
}
