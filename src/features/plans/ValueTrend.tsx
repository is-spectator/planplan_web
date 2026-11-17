import { useId } from 'react'

export interface TrendPoint { date: string; value: number | null }

export function ValueTrend({ title, points, format, description }: { title: string; points: TrendPoint[]; format: (value: number) => string; description?: string }) {
  const heading = useId()
  const values = points.flatMap(point => point.value === null ? [] : [point.value])
  if (!values.length) return <section className="value-trend" aria-labelledby={heading}><h3 id={heading}>{title}</h3><p className="plan-form-hint">这个周期还没有可展示的数据。</p></section>
  const upper = Math.max(0, ...values), lower = Math.min(0, ...values)
  const span = upper - lower || 1
  const x = (index: number) => 58 + index * 542 / Math.max(1, points.length - 1)
  const y = (value: number) => 22 + (upper - value) * 168 / span
  const segments: string[] = []
  let segment = ''
  points.forEach((point, index) => { if (point.value === null) { if (segment) segments.push(segment); segment = '' } else segment += `${segment ? ' L' : 'M'}${x(index)},${y(point.value)}` })
  if (segment) segments.push(segment)
  return <section className="value-trend" aria-labelledby={heading}>
    <h3 id={heading}>{title}</h3>{description && <p className="plan-form-hint">{description}</p>}
    <p className="trend-range"><span>最低 {format(Math.min(...values))}</span><span>最高 {format(Math.max(...values))}</span></p>
    <svg className="value-trend-chart" viewBox="0 0 624 225" role="img" aria-label={`${title}，最低${format(Math.min(...values))}，最高${format(Math.max(...values))}；详细数据在下方表格。`}>
      <line className="trend-zero" x1="58" x2="600" y1={y(0)} y2={y(0)} />
      <text className="trend-axis" x="52" y={y(0) + 4} textAnchor="end">0</text>
      {segments.map((path, index) => <path className="trend-line" d={path} key={index} />)}
      {points.map((point, index) => point.value !== null && <circle key={point.date} className={point.value < 0 ? 'trend-point negative' : 'trend-point'} cx={x(index)} cy={y(point.value)} r={points.length > 40 ? 2 : 3}><title>{point.date}：{format(point.value)}</title></circle>)}
      {[...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].map(index => <text key={index} className="trend-axis" x={x(index)} y="216" textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}>{points[index]?.date.slice(5)}</text>)}
    </svg>
    <details className="trend-data"><summary>查看每日数据</summary><div className="trend-table-wrap"><table><thead><tr><th scope="col">日期</th><th scope="col">数值</th></tr></thead><tbody>{points.map(point => <tr key={point.date}><th scope="row">{point.date}</th><td>{point.value === null ? '未记录' : format(point.value)}</td></tr>)}</tbody></table></div></details>
  </section>
}
