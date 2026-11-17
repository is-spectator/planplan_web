import { templateDefinitionSchema, type TemplateDefinition } from './contracts.js';
import { MAX_EXPENSE_CENTS } from '../domain/money.js';
import { CATEGORIES } from '../domain/ledger.js';

const date = { id: 'date', label: '日期', type: 'date', required: true } as const;
const note = { id: 'note', label: '备注', type: 'text', required: false, maxLength: 200 } as const;
const name = { id: 'name', label: '计划名称', type: 'text', required: true, maxLength: 20 } as const;
const start = { id: 'startDate', label: '开始日期', type: 'date', required: true } as const;
export const READING_TEMPLATE: TemplateDefinition = templateDefinitionSchema.parse({
  schemaVersion: 1, id: 'official.reading', version: 1, name: '阅读', description: '记录阅读时长，按周查看坚持的天数。书名、阅读位置和收获保存在备注中。', engine: 'study', source: 'official', requiredCapabilities: ['reading-template-v1'],
  configurationFields: [name, start, { id: 'currentBook', label: '当前在读', type: 'text', required: false, maxLength: 80 }, { id: 'daysPerWeek', label: '每周目标天数', type: 'integer', required: false, unit: 'day_per_week', min: 1, max: 7 }, { id: 'minMinutes', label: '每日目标分钟', type: 'duration', required: false, unit: 'minute', min: 1, max: 1440 }],
  recordFields: [date, { id: 'minutes', label: '阅读分钟', type: 'duration', required: true, unit: 'minute', min: 1, max: 1440 }, note],
  metrics: [{ id: 'totalMinutes', label: '本周阅读分钟', operation: 'sum', fieldId: 'minutes', period: 'week' }, { id: 'recordDays', label: '本周记录天数', operation: 'distinct_days', fieldId: 'date', period: 'week' }], components: ['goal', 'calendar', 'summary', 'records'],
  example: { config: { name: '我的阅读', startDate: '2026-11-16', daysPerWeek: 5, minMinutes: 20 }, record: { date: '2026-11-16', minutes: 60, note: '书名：示例书籍\n阅读位置：第 35 页' } },
});
export const LEDGER_TEMPLATE: TemplateDefinition = templateDefinitionSchema.parse({
  schemaVersion: 1, id: 'official.ledger', version: 1, name: '记账', description: '使用唯一人民币账本记录支出与退款，按自然月查看预算。', engine: 'ledger', source: 'official', requiredCapabilities: ['ledger-template-v1'],
  configurationFields: [{ id: 'budgetCents', label: '每月预算', type: 'money', required: false, unit: 'CNY_cent', min: 1, max: MAX_EXPENSE_CENTS }],
  recordFields: [date, { id: 'recordRole', label: '记录类型', type: 'single_select', required: true, options: ['expense', 'refund'] }, { id: 'amountCents', label: '金额', type: 'money', required: true, unit: 'CNY_cent', min: 1, max: MAX_EXPENSE_CENTS }, { id: 'category', label: '分类', type: 'single_select', required: true, options: [...CATEGORIES] }, { id: 'refundOf', label: '退款对应原支出', type: 'text', required: false, maxLength: 36 }, note],
  metrics: [{ id: 'amount', label: '本月支出', operation: 'sum', fieldId: 'amountCents', period: 'month', sourceRule: 'ledger_expenses' }], components: ['summary', 'budget', 'records'],
  example: { config: { budgetCents: 200000 }, record: { date: '2026-11-16', recordRole: 'expense', amountCents: 2000, category: '餐饮', note: '示例午饭' } },
});
export const WATER_TEMPLATE: TemplateDefinition = templateDefinitionSchema.parse({
  schemaVersion: 1, id: 'official.water', version: 1, name: '饮水', description: '以整数毫升记录饮水量，按日求和。明确的升数按 1 升 = 1000 毫升换算，不猜测杯容量。', engine: 'generic', source: 'official', requiredCapabilities: ['generic-record-v1'],
  configurationFields: [name, start, { id: 'dailyGoalMl', label: '每日目标毫升', type: 'integer', required: false, unit: 'ml', min: 1, max: 100000 }],
  recordFields: [date, { id: 'amountMl', label: '饮水毫升', type: 'integer', required: true, unit: 'ml', min: 1, max: 100000 }, note],
  metrics: [{ id: 'dailyMl', label: '今日饮水量', operation: 'sum', fieldId: 'amountMl', period: 'day' }, { id: 'progress', label: '目标进度', operation: 'goal_progress', fieldId: 'amountMl', goalFieldId: 'dailyGoalMl', period: 'day' }], components: ['summary', 'goal', 'records'],
  example: { config: { name: '饮水', startDate: '2026-11-16', dailyGoalMl: 2000 }, record: { date: '2026-11-16', amountMl: 500 } },
});
export const LEGACY_STUDY_TEMPLATE = templateDefinitionSchema.parse({ ...READING_TEMPLATE, id: 'legacy.study', name: '学习', description: '保留原有学习计划及目标、时长、历史记录。', configurationFields: READING_TEMPLATE.configurationFields.filter(f => f.id !== 'currentBook'), example: { ...READING_TEMPLATE.example, config: { name: '学习', startDate: '2026-11-16' } } });
export const TEMPLATE_DEFINITIONS = [READING_TEMPLATE, LEDGER_TEMPLATE, WATER_TEMPLATE, LEGACY_STUDY_TEMPLATE] as const;
