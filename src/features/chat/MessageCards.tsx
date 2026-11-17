import { Component, useState, type ReactNode } from 'react'
import { ArrowUpRight, Asterisk, BookOpen, Check, RotateCcw, Wallet } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useSession } from '../../auth/SessionProvider'
import { Link } from 'react-router-dom'
import type { GenericSummary, ItemResult, PlanCard, RecordView, TemplatePlanState } from '../../lib/contracts'
import { formatFieldValue } from '../templates/dynamic-fields'
import { money } from '../plans/format'
import type { Card, ChatInput, QueryCard } from './types'

function CompatibilityNotice() {
  return <p className="chat-card-note">这条内容暂时无法完整显示。可以到<Link to="/plans" className="text-link">计划</Link>核对已有记录。</p>
}

// An unfamiliar card must not hide the other, already-confirmed results.
class CardBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <CompatibilityNotice /> : this.props.children }
}

function PlanLink({ id, children }: { id: string; children: ReactNode }) {
  return <Link className="chat-plan-link" to={`/plans/${encodeURIComponent(id)}`}>{children}<ArrowUpRight size={15} aria-hidden="true" /></Link>
}

function GenericRecordValues({ record }: { record: RecordView }) {
  const { user, request } = useSession()
  const template = useQuery({
    queryKey: ['user', user?.id, 'template', record.planId],
    queryFn: ({ signal }) => request<TemplatePlanState>(`/v1/plans/${encodeURIComponent(record.planId)}/template`, { signal }),
    enabled: !!user,
  })
  if (!template.data) return <span>{template.isPending ? '正在读取记录…' : '记录已保存，详情中可查看'}</span>
  const fields = template.data.definition.recordFields.filter(field => field.id !== 'date' && field.id !== 'note' && record.fields?.[field.id] != null)
  return <span className="chat-generic-values">{fields.map(field => <span key={field.id}>{field.label}：{formatFieldValue(field, record.fields![field.id])}{record.defaultedFields?.includes(field.id) ? '（沿用设置）' : ''}</span>)}</span>
}

function GenericStats({ summary }: { summary: GenericSummary }) {
  return <><p className="chat-card-note">{summary.from === summary.to ? summary.from : `${summary.from} — ${summary.to}`} · 已记录 {summary.recordCount} 条</p><dl className="chat-stat-list chat-generic-stats">{summary.metrics.map(metric => <div key={metric.id}><dt>{metric.label}</dt><dd>{formatFieldValue({ unit: metric.unit }, metric.value)}{metric.target !== null && <small>目标 {formatFieldValue({ unit: metric.unit }, metric.target)}{metric.remaining !== null ? ` · 还差 ${formatFieldValue({ unit: metric.unit }, metric.remaining)}` : ''}{metric.progressPct !== null ? ` · ${metric.progressPct}%` : ''}</small>}</dd></div>)}</dl></>
}

function RecordLink({ record, current }: { record: RecordView; current?: 'same' | 'modified' | 'deleted' }) {
  const kind = record.kind === 'generic' ? '记录' : record.kind === 'study' ? '学习' : record.kind === 'refund' ? '退款' : '支出'
  const isDeleted = current === 'deleted' || record.deleted
  return <div className="receipt-record">
    <Link className="receipt-record-main" to={`/plans/${encodeURIComponent(record.planId)}?record=${encodeURIComponent(record.id)}`}>
      <span><strong>{record.note || kind}</strong><small>{record.date}{record.category ? ` · ${record.category}` : ''}</small></span>
      <b>{record.kind === 'generic' ? <GenericRecordValues record={record} /> : record.kind === 'study' ? `${record.minutes} 分钟` : money(record.amountCents ?? 0)}</b>
      <ArrowUpRight size={15} aria-hidden="true" />
    </Link>
    {isDeleted ? <small className="chat-card-note">这条记录现已删除。</small> : current === 'modified' ? <small className="chat-card-note">这条记录后来有过修改，点开查看最新内容。</small> : null}
    {record.refundOf && <Link className="text-link" to={`/plans/${encodeURIComponent(record.planId)}?record=${encodeURIComponent(record.refundOf)}`}>查看关联的原支出</Link>}
  </div>
}

function ReceiptItem({ item, current }: { item: ItemResult; current?: Record<string, 'same' | 'modified' | 'deleted'> }) {
  switch (item.type) {
    case 'plan_created':
      return <div className="receipt-item">
        <PlanLink id={item.plan.id}>{item.plan.name}</PlanLink>
        <p>{item.plan.kind === 'generic' ? '可以先记录，目标之后再完善。' : item.plan.kind === 'ledger' ? item.budgetCents === null ? '预算未设置' : `月预算 ${money(item.budgetCents)}` : [item.daysPerWeek === null ? '每周天数未设置' : `每周 ${item.daysPerWeek} 天`, item.minMinutes === null ? '每日时长未设置' : `每天 ${item.minMinutes} 分钟`].join(' · ')}</p>
        {item.goalStartsOn && <p>目标从 {item.goalStartsOn} 起生效。</p>}
        {item.firstWeekTarget !== null && !item.goalStartsOn && <p>首周目标 {item.firstWeekTarget} 天。</p>}
        {item.goalPending && <p className="chat-card-note">可以先记录，之后再完善目标。</p>}
      </div>
    case 'expense_added':
    case 'refund_added':
    case 'study_added':
    case 'generic_added':
      return <div className="receipt-item"><RecordLink record={item.record} current={current?.[item.record.id]} /></div>
    case 'record_edited':
      return <div className="receipt-item"><p className="receipt-item-label">已修改</p><RecordLink record={item.record} current={current?.[item.record.id]} /><p className="chat-card-note">修改前：{item.before.kind === 'generic' ? <GenericRecordValues record={item.before} /> : item.before.kind === 'study' ? `${item.before.minutes} 分钟` : money(item.before.amountCents ?? 0)} · {item.before.date}{item.before.category ? ` · ${item.before.category}` : ''}{item.before.note ? ` · ${item.before.note}` : ''}</p></div>
    case 'record_deleted':
      return <div className="receipt-item"><p className="receipt-item-label">已删除 {item.records.length} 条记录</p>{item.records.map(record => <RecordLink key={record.id} record={record} current={current?.[record.id] ?? 'deleted'} />)}</div>
    case 'goal_set': {
      const goal = item.param === 'budget_cents' ? `月预算 ${money(item.value)}` : item.param === 'days_per_week' ? `每周 ${item.value} 天` : `每天 ${item.value} 分钟`
      const previous = item.previous === null ? '未设置' : item.param === 'budget_cents' ? money(item.previous) : `${item.previous}${item.param === 'days_per_week' ? ' 天' : ' 分钟'}`
      return <div className="receipt-item"><PlanLink id={item.plan.id}>{item.plan.name}</PlanLink><p>{goal}</p><p className="chat-card-note">原目标：{previous}。{item.scope === 'current_only' ? '仅当前周期' : item.scope === 'next_and_future' ? '下个及以后周期' : '当前及以后周期'}生效，起始周期 {item.effectiveFrom}。</p>{item.replacedFuture.map(rule => <p key={rule.fromPeriod} className="chat-card-note">原定 {rule.fromPeriod} 的目标 {item.param === 'budget_cents' ? money(rule.value) : rule.value} 已替换。</p>)}</div>
    }
    case 'plan_updated':
      return <div className="receipt-item"><PlanLink id={item.plan.id}>{item.plan.name}</PlanLink><p>{{ renamed: '名称已更新', archived: '已归档，历史记录仍然保留', restored: '已恢复', view: '展示偏好已更新' }[item.change]}</p></div>
    case 'undone':
      return <div className="receipt-item"><p className="receipt-item-label">已撤销</p>{item.records.map(record => <RecordLink key={record.id} record={record} current={current?.[record.id]} />)}{item.plans.map(plan => <PlanLink key={plan.id} id={plan.id}>{plan.name}</PlanLink>)}</div>
    default: return <CompatibilityNotice />
  }
}

function PlanSummary({ card }: { card: PlanCard }) {
  return <div className={`chat-plan-summary ${card.plan.kind}`}>
    <div className="chat-card-heading">{card.plan.kind === 'ledger' ? <Wallet size={18} aria-hidden="true" /> : card.plan.kind === 'generic' ? <Asterisk size={18} aria-hidden="true" /> : <BookOpen size={18} aria-hidden="true" />}<PlanLink id={card.plan.id}>{card.plan.name}</PlanLink></div>
    {card.ledger && <><p className="chat-card-note">{card.ledger.month} · 已记录净支出</p><p className="chat-card-number">{money(card.ledger.netCents)}</p><p>{card.ledger.budgetCents === null ? '未设预算' : `月预算 ${money(card.ledger.budgetCents)}`}{card.ledger.remainingCents !== null ? ` · 剩余 ${money(card.ledger.remainingCents)}` : ''}</p></>}
    {card.study && <><p className="chat-card-note">{card.study.week} 这一周</p><p className="chat-card-number">{card.study.totalMinutes}<small> 分钟</small></p><p>已记录 {card.study.recordDays} 天{card.study.metDays !== null ? ` · 达标 ${card.study.metDays} / ${card.study.targetDays} 天` : ''}</p><p>今天 {card.study.todayMinutes} 分钟</p>{!card.study.goalComplete && <p className="chat-card-note">目标待完善</p>}{card.study.interrupted && <p className="chat-card-note">本周有归档或恢复，不评价周目标。</p>}</>}
    {card.generic && <GenericStats summary={card.generic} />}
    {card.plan.status === 'archived' && <p className="chat-card-note">已归档</p>}
  </div>
}

function Query({ card }: { card: QueryCard }) {
  if (card.kind === 'none') return <p>{card.message}</p>
  if (card.kind === 'overview') return <><h3>{card.label}</h3><div className="chat-plan-overview">{card.plans.map(plan => <PlanSummary key={plan.plan.id} card={plan} />)}</div></>
  if (card.kind === 'ledger_month' || card.kind === 'ledger_range') {
    const categoryLine = card.category ? card.byCategory.find(line => line.category === card.category) : null
    const net = categoryLine?.netCents ?? (card.category ? 0 : card.netCents)
    return <>
      <PlanLink id={card.plan.id}>{card.plan.name}</PlanLink>
      <p className="chat-card-note">{card.from} — {card.to}{card.category ? ` · ${card.category}` : ''}</p>
      {card.kind === 'ledger_range' && card.keywords?.length ? <p>备注包含：{card.keywords.join('、')}{card.count !== undefined ? ` · ${card.count} 笔支出` : ''}</p> : null}
      <p className="chat-card-note">已记录净支出</p><p className="chat-card-number">{money(net)}</p>
      <dl className="chat-stat-list"><div><dt>支出</dt><dd>{money(categoryLine?.spendCents ?? (card.category ? 0 : card.spendCents))}</dd></div><div><dt>退款</dt><dd>{money(categoryLine?.refundCents ?? (card.category ? 0 : card.refundCents))}</dd></div>
        {card.kind === 'ledger_month' && !card.category && <><div><dt>月预算</dt><dd>{card.budgetCents === null ? '未设置' : money(card.budgetCents)}</dd></div>{card.remainingCents !== null && <div><dt>预算剩余</dt><dd>{money(card.remainingCents)}</dd></div>}{card.usagePct !== null && <div><dt>预算使用</dt><dd>{card.usagePct}%</dd></div>}</>}
      </dl>
      {!card.category && card.byCategory.length > 0 && <details className="chat-category-details"><summary>按分类查看</summary><dl className="chat-stat-list">{card.byCategory.map(line => <div key={line.category}><dt>{line.category}</dt><dd>{money(line.netCents)}</dd></div>)}</dl></details>}
    </>
  }
  if (card.kind === 'generic_period') return <><PlanLink id={card.plan.id}>{card.plan.name}</PlanLink><GenericStats summary={card.summary} /></>
  if (card.kind === 'study_week') return <>
    <PlanLink id={card.plan.id}>{card.plan.name}</PlanLink><p className="chat-card-note">{card.label} · {card.stats.week} 这一周</p>
    <p className="chat-card-number">{card.stats.totalMinutes}<small> 分钟</small></p>
    <p>已记录 {card.stats.recordDays} 天{card.stats.metDays !== null ? ` · 达标 ${card.stats.metDays} / ${card.stats.targetDays} 天` : ''}</p>
    {card.stats.goalComplete ? <p>每周 {card.stats.daysPerWeek} 天，每天 {card.stats.minMinutes} 分钟</p> : <p className="chat-card-note">目标待完善，先积累每一次记录。</p>}
    {card.stats.interrupted && <p className="chat-card-note">本周有归档或恢复，不评价周目标。</p>}
    <dl className="chat-stat-list">{card.stats.days.map(day => <div key={day.date}><dt>{day.date}</dt><dd>{day.minutes} 分钟 · {{ future: '尚未到来', before_start: '开始前', none: '未记录', recorded: '已记录', below: '未达标', met: '已达标' }[day.status]}</dd></div>)}</dl>
  </>
  if (card.kind === 'study_range') return <><PlanLink id={card.plan.id}>{card.plan.name}</PlanLink><p className="chat-card-note">{card.label} · {card.from} — {card.to}</p><p className="chat-card-number">{card.totalMinutes}<small> 分钟</small></p><p>已记录 {card.recordDays} 天</p><p className="chat-card-note">记录天数不代表达标天数。</p></>
  if (card.kind === 'comparison') {
    const value = (amount: number) => card.unit === 'minutes' ? `${amount} 分钟` : money(amount)
    return <><PlanLink id={card.plan.id}>{card.plan.name}</PlanLink><h3>{{ spend: '支出对比', refund: '退款对比', net: '净支出对比', minutes: '学习时长对比' }[card.metric]}</h3>
      {card.category && <p>{card.category}</p>}{card.keywords?.length ? <p>备注包含：{card.keywords.join('、')}</p> : null}
      <dl className="chat-stat-list">{[card.current, card.previous].map((period, index) => <div key={index}><dt>{period.label}<small>{period.from} — {period.to}</small></dt><dd>{value(period.value)}</dd></div>)}</dl>
      <p>{card.delta === 0 ? '两段相同' : `前者${card.delta > 0 ? '增加' : '减少'} ${value(Math.abs(card.delta))}`}{card.changePct === null ? '' : ` · ${card.changePct > 0 ? '+' : ''}${card.changePct}%`}</p>
      <p className="chat-card-note">基于已记录数据{card.changePct === null ? '；基准为零或负数，不计算百分比。' : '。'}</p>
    </>
  }
  return <CompatibilityNotice />
}

function Receipt({ card, busy, onUndo }: { card: Extract<Card, { type: 'receipt' }>; busy: boolean; onUndo: (id: string) => Promise<boolean> }) {
  const [confirming, setConfirming] = useState(false)
  const [undone, setUndone] = useState(false)
  return <>
    <div className="chat-card-heading"><Check size={18} aria-hidden="true" /><h3>{card.kind === 'undo' ? '撤销回执' : '保存回执'}</h3></div>
    {card.items.map((item, index) => <CardBoundary key={index}><ReceiptItem item={item} current={card.current} /></CardBoundary>)}
    {card.undoable && !undone && <div className="receipt-undo">
      {confirming ? <><p>确认撤销这批操作？只撤回本批改动，后来独立保存的记录仍然保留。</p><div className="chat-choice-list"><button type="button" className="button primary" disabled={busy} onClick={() => { void onUndo(card.operationId).then(done => { if (done) { setUndone(true); setConfirming(false) } }) }}>确认撤销</button><button type="button" className="button chat-secondary" disabled={busy} onClick={() => setConfirming(false)}>保留</button></div></>
        : <button type="button" className="text-link chat-text-button" disabled={busy} onClick={() => setConfirming(true)}><RotateCcw size={15} aria-hidden="true" />撤销这次操作</button>}
    </div>}
    {undone && <p className="chat-card-note">已撤销</p>}
  </>
}

function CardContent({ card, busy, canChoose, onChoice, onUndo }: { card: Card; busy: boolean; canChoose: boolean; onChoice: (input: ChatInput) => Promise<void>; onUndo: (id: string) => Promise<boolean> }) {
  switch (card.type) {
    case 'receipt': return <Receipt card={card} busy={busy} onUndo={onUndo} />
    case 'plan': return <><PlanSummary card={card.card} />{card.note && <p className="chat-card-note">{card.note}</p>}</>
    case 'query': return <Query card={card} />
    case 'clarify': return <><h3>{card.question}</h3>{card.items.map((item, index) => <div className="clarify-item" key={index}><p>{item.summary}</p>{item.issue && <small>{item.issue}</small>}</div>)}{card.hint && <p className="chat-card-note">{card.hint}</p>}{card.status === 'open' ? <div className="chat-choice-list">{card.options.map(option => <button key={option.id} type="button" className={`button ${option.style === 'primary' ? 'primary' : 'chat-secondary'}`} disabled={busy || !canChoose} onClick={() => { void onChoice({ text: option.label, pendingId: card.pendingId, choice: option.id }) }}>{option.label}</button>)}</div> : <p className="chat-card-note">{card.status === 'cancelled' ? '已取消' : '已处理'}</p>}</>
    case 'error': return <p role="alert">{card.message}</p>
    case 'notice': return <p>{card.text}</p>
    default: return <CompatibilityNotice />
  }
}

export function MessageCards(props: { cards: Card[]; busy: boolean; canChoose: boolean; onChoice: (input: ChatInput) => Promise<void>; onUndo: (id: string) => Promise<boolean> }) {
  return <div className="message-cards">{props.cards.map((card, index) => <section className={`message-card${card.type === 'error' ? ' message-card-error' : ''}`} key={index}><CardBoundary><CardContent card={card} busy={props.busy} canChoose={props.canChoose} onChoice={props.onChoice} onUndo={props.onUndo} /></CardBoundary></section>)}</div>
}
