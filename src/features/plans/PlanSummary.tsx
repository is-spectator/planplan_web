import type { LedgerMonthStats, StudyWeekStats } from '../../lib/contracts'
import { money } from './format'
import { ValueTrend } from './ValueTrend'

export function LedgerSummary({ stats }: { stats: LedgerMonthStats }) {
  return <section className="plan-summary ledger-summary" aria-label="计划统计">
    <div className="summary-primary"><span>本月净支出</span><strong>{money(stats.netCents)}</strong><p>{stats.month.replace('-', ' 年 ')} 月</p></div>
    <dl className="plan-stat-grid">
      <div><dt>支出</dt><dd>{money(stats.spendCents)}</dd></div>
      <div><dt>退款</dt><dd>{money(stats.refundCents)}</dd></div>
      <div><dt>月预算</dt><dd>{stats.budgetCents === null ? '未设置' : money(stats.budgetCents)}</dd></div>
      <div><dt>{stats.overCents === null ? '剩余预算' : '超出预算'}</dt><dd className={stats.overCents !== null ? 'plan-text-danger' : undefined}>{stats.budgetCents === null ? '—' : money(stats.overCents ?? stats.remainingCents ?? 0)}</dd></div>
    </dl>
    {stats.usagePct !== null && <div className="budget-progress"><div className="budget-label"><span>预算使用</span><strong>{stats.usagePct}%</strong></div><div className="budget-track" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, stats.usagePct))}%` }} /></div></div>}
    {stats.byCategory.length > 0 && <section className="category-breakdown" aria-label="分类支出与退款"><h3>分类明细</h3><table className="category-table"><thead><tr><th scope="col">分类</th><th scope="col">支出</th><th scope="col">退款</th><th scope="col">净支出</th></tr></thead><tbody>{stats.byCategory.map(line => <tr key={line.category}><th scope="row">{line.category}</th><td>{money(line.spendCents)}</td><td>{money(line.refundCents)}</td><td>{money(line.netCents)}</td></tr>)}</tbody></table></section>}
    <ValueTrend title="每日净支出" points={stats.daily.map(day => ({ date: day.date, value: day.netCents }))} format={money} description="按发生日期统计支出减退款。负数表示当天退款多于支出。" />
  </section>
}

const statusLabel = { future: '尚未到来', before_start: '计划开始前', none: '未记录', recorded: '已记录', below: '未达标', met: '已达标' }
const shortStatusLabel = { ...statusLabel, future: '待开始', before_start: '开始前' }
export function StudySummary({ stats, today, reading = false }: { stats: StudyWeekStats; today: string; reading?: boolean }) {
  return <section className="plan-summary study-summary" aria-label={reading ? '阅读统计' : '学习统计'}>
    <div className="summary-primary"><span>{reading ? '本周累计阅读' : '本周累计学习'}</span><strong>{stats.totalMinutes}<small> 分钟</small></strong><p>{stats.week} 起的一周</p></div>
    <dl className="plan-stat-grid">
      <div><dt>记录天数</dt><dd>{stats.recordDays} 天</dd></div>
      <div><dt>达标天数</dt><dd>{stats.metDays === null ? '暂不评定' : `${stats.metDays} 天`}</dd></div>
      <div><dt>本周目标</dt><dd>{stats.targetDays === null ? '未设完整目标' : `${stats.targetDays} 天`}</dd></div>
      <div><dt>每日目标</dt><dd>{stats.minMinutes === null ? '未设置' : `${stats.minMinutes} 分钟`}</dd></div>
    </dl>
    {stats.interrupted && <p className="plan-notice">这周有归档或恢复，保留{reading ? '阅读' : '学习'}记录，暂不评定达标。</p>}
    {!stats.goalComplete && <p className="plan-notice">目标尚未设完整，{reading ? '阅读' : '学习'}时长照常累积。</p>}
    <div className="study-week" aria-label={reading ? '每日阅读情况' : '每日学习情况'}>{stats.days.map((day, index) => <div key={day.date} className={`study-day ${day.status}${day.date === today ? ' today' : ''}`} aria-label={`${day.date}，${day.minutes} 分钟，${statusLabel[day.status]}`}><span>{['一', '二', '三', '四', '五', '六', '日'][index]}</span><strong>{day.minutes || '—'}</strong><small>{shortStatusLabel[day.status]}</small></div>)}</div>
  </section>
}
