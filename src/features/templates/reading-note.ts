export interface ReadingNote { book: string; position: string; insight: string; note: string }

const labels = { '书名': 'book', '阅读位置': 'position', '收获': 'insight' } as const

// Reading details remain labelled note text in the study engine.
export function parseReadingNote(note: string): ReadingNote {
  const result: ReadingNote = { book: '', position: '', insight: '', note: '' }
  const rest: string[] = []
  for (const line of note.split('\n')) {
    const match = /^(书名|阅读位置|收获)[：:]\s*(.*)$/.exec(line)
    const key = match ? labels[match[1] as keyof typeof labels] : null
    if (key && !result[key]) result[key] = match![2]!
    else rest.push(line)
  }
  result.note = rest.join('\n')
  return result
}

export function formatReadingNote(value: ReadingNote): string {
  return [value.book.trim() ? `书名：${value.book.trim()}` : '', value.position.trim() ? `阅读位置：${value.position.trim()}` : '', value.insight.trim() ? `收获：${value.insight.trim()}` : '', value.note.trim()].filter(Boolean).join('\n')
}
