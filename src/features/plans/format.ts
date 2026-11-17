export function money(cents: number) {
  const sign = cents < 0 ? '−' : ''
  const absolute = Math.abs(cents)
  return `${sign}¥${Math.floor(absolute / 100).toLocaleString('zh-CN')}.${String(absolute % 100).padStart(2, '0')}`
}

export function centsFromInput(input: string): number | null {
  const clean = input.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null
  const [whole = '', decimal = ''] = clean.split('.')
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, '0'))
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 99_999_999 ? cents : null
}

export function inputFromCents(cents: number | null) {
  if (cents === null) return ''
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
}

export function positiveInteger(value: string, maximum: number): number | null {
  if (!/^\d+$/.test(value.trim())) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 1 && number <= maximum ? number : null
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '暂时无法读取，请稍后再试。'
}

export function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
}
