import { useState, type FormEvent } from 'react'
import { positiveInteger } from '../plans/format'

export function ReadingPreview() {
  const [minutes, setMinutes] = useState('')
  const [records, setRecords] = useState<number[]>([])
  const [error, setError] = useState('')
  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = positiveInteger(minutes, 1440)
    if (value === null) { setError('请输入 1 到 1440 的整数分钟。'); return }
    setRecords((current) => [...current, value])
    setMinutes('')
    setError('')
  }
  const total = records.reduce((sum, value) => sum + value, 0)
  return <section className="plan-form-panel template-preview" aria-labelledby="preview-heading">
    <div className="plan-section-heading"><h2 id="preview-heading">先试着记一次</h2><span className="template-badge">独立试填</span></div>
    <p className="plan-form-hint">这里的内容仅用于试填，离开页面后清除，不会创建计划或保存到你的记录。</p>
    <form onSubmit={add}>
      <fieldset className="plan-form-fields">
        <legend className="sr-only">阅读试填</legend>
        <label>试填阅读时长（分钟）<input required inputMode="numeric" maxLength={4} value={minutes} onChange={(event) => setMinutes(event.target.value)} placeholder="例如 60" /></label>
        {error && <p role="alert" className="plan-form-error">{error}</p>}
        <div className="plan-form-actions"><button className="button plan-secondary" type="submit">加入试填</button><button className="text-link" type="button" onClick={() => { setRecords([]); setMinutes(''); setError('') }}>清空试填</button></div>
      </fieldset>
    </form>
    <div className="template-preview-summary" role="status"><span>试填累计</span><strong>{total} <small>分钟</small></strong><span>{records.length} 条示例 · {records.length ? 1 : 0} 个记录日</span></div>
    {records.length > 0 && <ul className="template-preview-records">{records.map((value, index) => <li key={index}><span>示例 {index + 1} · {value} 分钟</span><button className="text-link" type="button" aria-label={`删除试填 ${index + 1}`} onClick={() => setRecords((current) => current.filter((_, item) => item !== index))}>移除</button></li>)}</ul>}
  </section>
}
