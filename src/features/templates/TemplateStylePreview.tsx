import type { GenericValue, TemplateDefinition } from '../../lib/contracts'
import { GenericMetrics } from './GenericMetrics'
import { money } from '../plans/format'
import { formatFieldValue, metricText, previewSummary, supportsGeneric } from './dynamic-fields'

function PreviewProgress({ value, label }: { value: number; label: string }) {
  return <div className="style-progress"><span>{label}</span><div className="budget-track" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div></div>
}

function LedgerStyle({ definition }: { definition: TemplateDefinition }) {
  const amount = Number(definition.example.record.amountCents) || 0
  const budget = Number(definition.example.config.budgetCents) || 0
  return <>
    <div className="style-panel"><div className="style-primary"><span>本月净支出</span><strong>{money(amount)}</strong></div><dl className="style-stats"><div><dt>支出</dt><dd>{money(amount)}</dd></div><div><dt>退款</dt><dd>{money(0)}</dd></div><div><dt>剩余预算</dt><dd>{budget ? money(budget - amount) : '未设置'}</dd></div></dl>{budget > 0 && <PreviewProgress value={amount / budget * 100} label={`月预算 ${money(budget)}`} />}</div>
    <div className="style-panel style-records"><span className="style-section-label">最近账目</span><div className="style-record"><div><strong>{String(definition.example.record.note || '日常开销')}</strong><span>{String(definition.example.record.category || '其他')} · 支出</span></div><b>{money(amount)}</b></div></div>
  </>
}

function ReadingStyle({ definition }: { definition: TemplateDefinition }) {
  const minutes = Number(definition.example.record.minutes) || 0
  const goal = Number(definition.example.config.minMinutes) || 0
  const days = Number(definition.example.config.daysPerWeek) || 0
  const date = String(definition.example.record.date)
  const day = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7
  const met = goal > 0 && minutes >= goal
  return <>
    <div className="style-panel"><div className="style-primary"><span>本周阅读</span><strong>{minutes}<small> 分钟</small></strong></div><dl className="style-stats"><div><dt>记录天数</dt><dd>1 天</dd></div><div><dt>达标天数</dt><dd>{met ? 1 : 0} 天</dd></div><div><dt>每周目标</dt><dd>{days ? `${days} 天` : '未设置'}</dd></div></dl><div className="style-week">{['一', '二', '三', '四', '五', '六', '日'].map((label, index) => <div key={label} className={index === day && met ? 'met' : ''}><span>{label}</span><strong>{index === day ? minutes : '—'}</strong></div>)}</div></div>
    <div className="style-panel style-records"><span className="style-section-label">阅读记录</span><div className="style-record"><div><strong>一次安静的阅读</strong><span>{goal ? `每日目标 ${goal} 分钟` : '按自己的节奏积累'}</span></div><b>{minutes} 分钟</b></div></div>
  </>
}

function GenericStyle({ definition }: { definition: TemplateDefinition }) {
  const config = definition.example.config as Record<string, GenericValue>
  const record = definition.example.record as Record<string, GenericValue>
  const summary = previewSummary(definition, config, [record], String(record.date))
  return <>{definition.components.map((component) => {
    if (component === 'trend' || component === 'categories') return <GenericMetrics key={component} definition={definition} summary={summary} component={component} />
    if (component === 'records') return <div className="style-panel style-records" key={component}><span className="style-section-label">当日记录</span><dl className="style-field-list">{definition.recordFields.filter((field) => field.type !== 'date' && record[field.id] != null).map((field) => <div key={field.id}><dt>{field.label}</dt><dd>{formatFieldValue(field, record[field.id])}</dd></div>)}</dl></div>
    const metrics = summary.metrics.filter((metric) => component === 'goal' ? metric.operation === 'goal_progress' : metric.operation !== 'goal_progress')
    if (!metrics.length) return null
    return <div className={`style-panel style-${component}`} key={component}>{metrics.map((metric) => <div key={metric.id} className="style-primary"><span>{metric.label}</span>{component === 'goal' ? <><strong>{metric.progressPct === null ? '未设置' : `${metric.progressPct}%`}</strong>{metric.target !== null && <PreviewProgress value={metric.progressPct ?? 0} label={`目标 ${formatFieldValue({ unit: metric.unit }, metric.target)} · 剩余 ${formatFieldValue({ unit: metric.unit }, metric.remaining)}`} />}</> : <strong>{metricText(metric)}</strong>}</div>)}</div>
  })}</>
}

/** Read-only example from the public template; never reads or writes a user's plan. */
export function TemplateStylePreview({ definition, compact = false }: { definition: TemplateDefinition; compact?: boolean }) {
  return <div className={`template-style-preview ${definition.engine}${compact ? ' compact' : ''}`} aria-hidden={compact || undefined}>
    <div className="style-window-bar"><span>PlanPlan <span className="style-window-divider">/</span> {definition.name}</span><span className="style-example-label">示例数据</span></div>
    <div className="style-window-content">{definition.engine === 'ledger' ? <LedgerStyle definition={definition} /> : definition.engine === 'study' ? <ReadingStyle definition={definition} /> : supportsGeneric(definition) ? <GenericStyle definition={definition} /> : <p className="plan-form-hint">查看模板详情，了解适用功能。</p>}</div>
  </div>
}
