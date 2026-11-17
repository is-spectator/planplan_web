import type { GenericMetricValue, GenericSummary, GenericValue, TemplateDefinition, TemplateField } from '../../lib/contracts'
import { inputFromCents, money, validDate } from '../plans/format'

export type FieldDraft = Record<string, string>
export type FieldUnits = Record<string, string>
export const supportedGenericFields = new Set(['text', 'integer', 'date', 'duration', 'money', 'single_select', 'multi_select', 'boolean'])
export function supportsGeneric(definition: TemplateDefinition) {
  return definition.schemaVersion === 1 && definition.engine === 'generic'
    && definition.requiredCapabilities.every((capability) => capability === 'generic-record-v1' || capability === 'private-template-v1' || capability === 'generic-template-v2' || capability === 'community-template-v1')
    && [...definition.configurationFields, ...definition.recordFields].every((field) => supportedGenericFields.has(field.type))
    && definition.recordFields.some((field) => field.id === 'date' && field.type === 'date' && field.required)
    && definition.configurationFields.filter((field) => ['name', 'startDate'].includes(field.id)).every((field) => field.type === (field.id === 'name' ? 'text' : 'date'))
    && definition.components.every((component) => ['summary', 'goal', 'records', 'trend', 'categories'].includes(component))
    && definition.components.includes('records')
    && definition.metrics.every((metric) => ['day', 'week', 'month'].includes(metric.period) && (metric.sourceRule === undefined || metric.sourceRule === 'generic_records') && (metric.operation !== 'count' || metric.fieldId === undefined) && ['sum', 'count', 'distinct_days', 'mean', 'goal_progress'].includes(metric.operation))
}
export function draftFromValues(fields: TemplateField[], values: Record<string, GenericValue> = {}): FieldDraft {
  return Object.fromEntries(fields.map((field) => {
    const value = values[field.id]
    return [field.id, value === null || value === undefined ? '' : field.type === 'multi_select' && Array.isArray(value) ? JSON.stringify(value) : field.type === 'money' && typeof value === 'number' ? inputFromCents(value) : String(value)]
  }))
}
export function canonicalNumber(field: TemplateField, input: string, unit?: string): number | null {
  const value = input.trim()
  const decimalPlaces = field.type === 'money' ? 2 : field.unit === 'ml' && unit === 'L' ? 3 : 0
  const match = new RegExp(`^(-?)(\\d+)${decimalPlaces ? `(?:\\.(\\d{1,${decimalPlaces}}))?` : ''}$`).exec(value)
  if (!match) return null
  const factor = 10 ** decimalPlaces
  const number = (Number(match[2]) * factor + Number((match[3] ?? '').padEnd(decimalPlaces, '0'))) * (match[1] ? -1 : 1)
  return Number.isSafeInteger(number) ? number : null
}
export function parseFields(fields: TemplateField[], draft: FieldDraft, units: FieldUnits = {}, latestDate?: string): { values: Record<string, GenericValue>; error: string | null } {
  const values: Record<string, GenericValue> = {}
  for (const field of fields) {
    const raw = draft[field.id]?.trim() ?? ''
    if (!raw) {
      if (field.required) return { values, error: `请填写${field.label}。` }
      values[field.id] = null
      continue
    }
    if (['integer', 'money', 'duration'].includes(field.type)) {
      const value = canonicalNumber(field, raw, units[field.id])
      if (value === null || (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) return { values, error: `${field.label}需${field.type === 'money' ? '最多两位小数' : field.unit === 'ml' ? '能精确换算为整数毫升' : '为整数'}${field.min === undefined && field.max === undefined ? '' : `，范围 ${formatFieldValue(field, field.min ?? null)} 至 ${formatFieldValue(field, field.max ?? null)}`}。` }
      values[field.id] = value
    } else if (field.type === 'date') {
      if (!validDate(raw) || (latestDate && raw > latestDate)) return { values, error: `${field.label}请选择${latestDate ? '今天或以前的' : ''}有效日期。` }
      values[field.id] = raw
    } else if (field.type === 'text') {
      if (raw.length > (field.maxLength ?? 200)) return { values, error: `${field.label}最多 ${field.maxLength ?? 200} 字。` }
      values[field.id] = raw
    } else if (field.type === 'single_select' && field.options?.includes(raw)) values[field.id] = raw
    else if (field.type === 'boolean' && ['true', 'false'].includes(raw)) values[field.id] = raw === 'true'
    else if (field.type === 'multi_select') {
      let selected: unknown
      try { selected = JSON.parse(raw) } catch { return { values, error: `请重新选择${field.label}。` } }
      if (!Array.isArray(selected) || !selected.every((item): item is string => typeof item === 'string' && !!field.options?.includes(item)) || new Set(selected).size !== selected.length || field.required && selected.length === 0) return { values, error: `请选择${field.label}${field.required ? '，至少一项' : ''}。` }
      values[field.id] = selected
    }
    else return { values, error: `暂时无法填写${field.label}，请更新页面后再试。` }
  }
  return { values, error: null }
}
export function unitLabel(unit?: string) { return ({ minute: '分钟', day_per_week: '天/周', CNY_cent: '元' } as Record<string, string>)[unit ?? ''] ?? unit ?? '' }
export function formatFieldValue(field: { unit?: string }, value: GenericValue | undefined): string {
  if (value === null || value === undefined) return '未设置'
  if (field.unit === 'CNY_cent' && typeof value === 'number') return money(value)
  const shown = Array.isArray(value) ? value.join('、') : typeof value === 'boolean' ? value ? '是' : '否' : typeof value === 'number' ? value.toLocaleString('zh-CN', { maximumFractionDigits: 3 }) : value
  return `${shown}${field.unit ? ` ${unitLabel(field.unit)}` : ''}`
}
export function metricText(metric: GenericMetricValue) {
  return metric.value === null ? '—' : formatFieldValue({ unit: metric.unit }, metric.value)
}

export const periodLabel = { day: '日', week: '周', month: '月' } as const
export function periodRange(date: string, period: 'day' | 'week' | 'month') {
  const value = new Date(`${date}T12:00:00Z`)
  if (period === 'week') value.setUTCDate(value.getUTCDate() - (value.getUTCDay() + 6) % 7)
  if (period === 'month') value.setUTCDate(1)
  return { from: value.toISOString().slice(0, 10), to: date }
}
// Only the isolated preview computes sample aggregates; real plans render server results.
export function previewSummary(definition: TemplateDefinition, config: Record<string, GenericValue>, records: Record<string, GenericValue>[], date: string): GenericSummary {
  return { planId: 'preview', from: date, to: date, recordCount: records.filter((record) => record.date === date).length, metrics: definition.metrics.map((metric) => {
    const range = periodRange(date, metric.period)
    const selected = records.filter((record) => typeof record.date === 'string' && record.date >= range.from && record.date <= range.to)
    const field = definition.recordFields.find((item) => item.id === metric.fieldId)
    const operation = metric.operation === 'goal_progress' ? metric.goalAggregation ?? 'sum' : metric.operation
    const aggregate = (items: Record<string, GenericValue>[]) => {
      const numbers = items.map((record) => record[metric.fieldId ?? '']).filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      const sum = numbers.reduce((total, value) => total + value, 0)
      const value = operation === 'count' ? items.length : operation === 'distinct_days' ? new Set(items.map((record) => record[metric.fieldId ?? 'date']).filter((value) => value !== null && value !== undefined)).size : operation === 'mean' ? numbers.length ? sum / numbers.length : null : sum
      return { value, sampleCount: ['count', 'distinct_days'].includes(operation) ? items.length : numbers.length, recordCount: items.length }
    }
    const aggregated = aggregate(selected)
    const targetValue = config[metric.goalFieldId ?? '']
    const target = date >= String(config.startDate ?? '') && metric.operation === 'goal_progress' && typeof targetValue === 'number' && targetValue > 0 ? targetValue : null
    const dates: string[] = []
    const cursor = new Date(`${range.from}T12:00:00Z`)
    while (cursor.toISOString().slice(0, 10) <= range.to) { dates.push(cursor.toISOString().slice(0, 10)); cursor.setUTCDate(cursor.getUTCDate() + 1) }
    const groupField = definition.recordFields.find((item) => item.id === metric.groupByFieldId)
    const keys: (string | boolean | null)[] = groupField?.type === 'boolean' ? [false, true] : [...groupField?.options ?? []]
    if (groupField && selected.some((record) => record[groupField.id] === null || record[groupField.id] === undefined)) keys.push(null)
    const end = new Date(`${range.from}T12:00:00Z`); if (metric.period === 'week') end.setUTCDate(end.getUTCDate() + 6); else if (metric.period === 'month') { end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0) }
    return { id: metric.id, label: metric.label, operation: metric.operation, fieldId: metric.fieldId, unit: ['count', 'distinct_days'].includes(operation) ? undefined : field?.unit, ...aggregated, target, remaining: target === null ? null : Math.max(0, target - (aggregated.value ?? 0)), progressPct: target === null ? null : Math.round((aggregated.value ?? 0) / target * 10000) / 100, period: metric.period, ...range, partialPeriod: range.from < String(config.startDate ?? '') && String(config.startDate ?? '') <= end.toISOString().slice(0, 10), groups: groupField ? keys.map((key) => ({ key, label: key === null ? '未填写' : formatFieldValue(groupField, key), ...aggregate(selected.filter((record) => (record[groupField.id] ?? null) === key)) })) : undefined, series: dates.map((date) => ({ date, ...aggregate(selected.filter((record) => record.date === date)) })) }
  }) }
}
