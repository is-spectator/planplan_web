import type { GenericSummary, TemplateDefinition } from '../../lib/contracts'
import { ValueTrend } from '../plans/ValueTrend'
import { formatFieldValue, metricText, periodLabel } from './dynamic-fields'

export function GenericMetrics({ definition, summary, component, rangeSelected = false }: { definition: TemplateDefinition; summary: GenericSummary; component: 'summary' | 'goal' | 'trend' | 'categories'; rangeSelected?: boolean }) {
  const metrics = definition.metrics.filter((metric) => component === 'goal' ? metric.operation === 'goal_progress' : component === 'summary' ? metric.operation !== 'goal_progress' : component === 'categories' ? !!metric.groupByFieldId : true)
  if (!metrics.length) return null
  if (component === 'trend') return <>{metrics.map((definitionMetric) => { const metric = summary.metrics.find((value) => value.id === definitionMetric.id); return metric?.series && <ValueTrend key={metric.id} title={`${metric.label}趋势`} points={metric.series} format={(value) => formatFieldValue({ unit: metric.unit }, value)} description={`${metric.from ?? summary.from} 至 ${metric.to ?? summary.to} · 按日展示，空白表示没有可计算的数值。`} /> })}</>
  if (component === 'categories') return <>{metrics.map((definitionMetric) => { const metric = summary.metrics.find((value) => value.id === definitionMetric.id); return <section key={definitionMetric.id} className="plan-summary" aria-label={`${definitionMetric.label}分类`}><h2>{definitionMetric.label} · 分类</h2><p className="plan-form-hint">{metric?.from ?? summary.from} 至 {metric?.to ?? summary.to}</p>{metric?.groups?.length ? <div className="category-table-wrap"><table className="category-table"><thead><tr><th>类别</th><th>结果</th><th>有效样本</th></tr></thead><tbody>{metric.groups.map((group) => <tr key={String(group.key)}><th>{group.label}</th><td>{formatFieldValue({ unit: metric.unit }, group.value)}</td><td>{group.sampleCount}</td></tr>)}</tbody></table></div> : <p className="plan-form-hint">这个范围还没有分类数据。</p>}</section> })}</>
  return <section className={`plan-summary generic-summary ${component === 'goal' ? 'generic-goals' : ''}`} aria-label={component === 'goal' ? '目标进度' : '记录统计'}>
    <h2>{component === 'goal' ? '目标进度' : '记录统计'}</h2>
    <dl className="generic-metric-grid">{metrics.map((definitionMetric) => {
      const metric = summary.metrics.find((value) => value.id === definitionMetric.id)
      return <div key={definitionMetric.id}><dt>{definitionMetric.label.replace(/^今日/, '当日')}</dt><dd><p className="plan-form-hint">{rangeSelected ? '所选范围' : `按${periodLabel[metric?.period ?? definitionMetric.period]}`} · {metric?.from ?? summary.from}{(metric?.from ?? summary.from) !== (metric?.to ?? summary.to) ? ` 至 ${metric?.to ?? summary.to}` : ''}{metric?.partialPeriod ? ' · 首个周期未满，目标不折算' : ''}</p><strong>{metric ? metricText(metric) : '—'}</strong>{definitionMetric.operation === 'mean' && <p>有效样本 {metric?.sampleCount ?? 0} 条</p>}{component === 'goal' && <>
        <p>{!metric || metric.target === null ? rangeSelected ? '所选范围暂无可对比的目标，记录照常统计。' : '未设置目标，记录照常累积。' : `目标 ${formatFieldValue({ unit: metric.unit }, metric.target)} · 剩余 ${formatFieldValue({ unit: metric.unit }, metric.remaining)}`}</p>
        {metric?.progressPct !== null && metric?.progressPct !== undefined && <><span className="generic-progress-label">已完成 {metric.progressPct}%</span><div className="budget-track" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, metric.progressPct))}%` }} /></div></>}
      </>}</dd></div>
    })}</dl>
  </section>
}
