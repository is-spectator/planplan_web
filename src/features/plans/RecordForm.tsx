import { useState, type FormEvent } from 'react'
import { useOperation } from '../../lib/useOperation'
import { categories, type Action, type Category, type OperationResult, type PlanView, type RecordView } from '../../lib/contracts'
import { centsFromInput, inputFromCents, positiveInteger, validDate } from './format'
import { useOperationCompletion } from './useOperationCompletion'
import { formatReadingNote, parseReadingNote, type ReadingNote } from '../templates/reading-note'

export function RecordForm({ plan, today, record, refundOf, reading, onSaved, onCancel }: {
  plan: PlanView
  today: string
  record?: RecordView
  refundOf?: RecordView
  reading?: { currentBook: string | null }
  onSaved: (result: OperationResult) => void
  onCancel: () => void
}) {
  // Keep the version read on opening this form. Background refreshes must not rebase an edit.
  const [original] = useState(record)
  const [value, setValue] = useState(original?.kind === 'study' ? String(original.minutes ?? '') : inputFromCents(original?.amountCents ?? null))
  const [category, setCategory] = useState<Category>(original?.category ?? '餐饮')
  const [date, setDate] = useState(original?.date ?? today)
  const [note, setNote] = useState(original?.note ?? '')
  const [initialReading] = useState<ReadingNote>(() => original ? parseReadingNote(original.note) : { book: reading?.currentBook ?? '', position: '', insight: '', note: '' })
  const [readingNote, setReadingNote] = useState(initialReading)
  const [error, setError] = useState('')
  const { submit, busy, pending, feedback, completed, lastClientOpId } = useOperation()
  const accept = useOperationCompletion(completed, lastClientOpId, busy, onSaved)
  const study = original ? original.kind === 'study' : plan.kind === 'study'
  const refund = original?.kind === 'refund' || Boolean(refundOf)
  const locked = busy || pending

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (locked) return
    setError('')
    const numeric = study ? positiveInteger(value, 1440) : centsFromInput(value)
    if (numeric === null) { setError(study ? '时长请输入 1 到 1440 的整数分钟。' : '金额请输入 0.01 至 999,999.99 元，最多两位小数。'); return }
    if (!validDate(date)) { setError('请选择有效日期。'); return }
    const unchangedNote = original && Object.keys(initialReading).every((key) => initialReading[key as keyof ReadingNote] === readingNote[key as keyof ReadingNote])
    const savedNote = reading ? unchangedNote ? original.note : formatReadingNote(readingNote) : note.trim()
    if (savedNote.length > 200) { setError('书名、位置、收获和备注合计最多 200 字，请缩短后保存。'); return }
    let action: Action
    if (original) {
      action = { type: 'edit_record', recordId: original.id, expectedVersion: original.version, correctionReason: 'normal_adjustment', patch: { ...(study ? { minutes: numeric } : { amountCents: numeric }), ...(!study && !refund ? { category } : {}), date, note: savedNote } }
    } else if (refundOf) {
      action = { type: 'add_refund', expenseId: refundOf.id, amountCents: numeric, date, note: note.trim() }
    } else if (study) {
      action = { type: 'add_study', planId: plan.id, minutes: numeric, date, note: savedNote }
    } else action = { type: 'add_expense', amountCents: numeric, category, date, note: note.trim() }
    const result = await submit([action])
    if (result) accept(result)
  }

  return <form onSubmit={save} className="record-form">
    <fieldset disabled={locked} className="plan-form-fields">
      <legend className="sr-only">{original ? '修改记录' : refund ? '记录退款' : study ? '记录学习' : '记录支出'}</legend>
      <div className="plan-field-pair">
        <label>{study ? reading ? '阅读时长（分钟）' : '学习时长（分钟）' : refund ? '退款金额（元）' : '支出金额（元）'}<input autoFocus required inputMode={study ? 'numeric' : 'decimal'} value={value} onChange={(event) => setValue(event.target.value)} maxLength={study ? 4 : 12} placeholder={study ? '例如 25' : '例如 25.50'} /></label>
        <label>日期<input type="date" required value={date} onChange={(event) => setDate(event.target.value)} /></label>
      </div>
      {!study && !refund && <label>分类<select value={category} onChange={(event) => setCategory(event.target.value as Category)}>{categories.map((item) => <option key={item}>{item}</option>)}</select></label>}
      {reading ? <div className="reading-note-fields">
        <label>书名（可留空）<input maxLength={80} value={readingNote.book} onChange={(event) => setReadingNote({ ...readingNote, book: event.target.value })} /></label>
        <label>阅读位置（可留空）<input maxLength={80} value={readingNote.position} onChange={(event) => setReadingNote({ ...readingNote, position: event.target.value })} placeholder="例如：第 35 页，或第三章" /></label>
        <label>收获（可留空）<input maxLength={120} value={readingNote.insight} onChange={(event) => setReadingNote({ ...readingNote, insight: event.target.value })} /></label>
        <label>备注（可留空）<textarea maxLength={200} rows={2} value={readingNote.note} onChange={(event) => setReadingNote({ ...readingNote, note: event.target.value })} placeholder="想记住的细节" /></label>
        <p className="plan-form-hint">书名、位置和收获会以带标签的备注保存，合计最多 200 字。阅读进度按分钟统计。</p>
      </div> : <label>备注（可留空）<textarea maxLength={200} rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="想记住的细节" /></label>}
      {error && <p className="plan-form-error" role="alert">{error}</p>}
      <div className="plan-form-actions"><button className="button primary" type="submit">{busy ? '正在保存…' : original ? '保存修改' : '保存记录'}</button><button className="button plan-secondary" type="button" onClick={onCancel}>取消</button></div>
    </fieldset>
    {feedback}
  </form>
}
