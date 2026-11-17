import { z } from 'zod';
import { isBizDate } from '../domain/time.js';

export const TEMPLATE_CAPABILITY = 'reading-template-v1';
export const GENERIC_TEMPLATE_V2_CAPABILITY = 'generic-template-v2';
export const genericValueSchema = z.union([z.string().max(200), z.number().finite(), z.boolean(), z.array(z.string().max(40)).max(20), z.null()]);
export type GenericValue = z.infer<typeof genericValueSchema>;
export type GenericValues = Record<string, GenericValue>;
const valuesSchema = z.record(z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/), genericValueSchema).refine(v => Object.keys(v).length <= 20);
export const templateFieldSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/), label: z.string().trim().min(1).max(40),
  type: z.enum(['text', 'integer', 'decimal', 'money', 'date', 'duration', 'single_select', 'multi_select', 'boolean']),
  required: z.boolean(), unit: z.enum(['CNY_cent', 'minute', 'ml', 'day_per_week']).optional(),
  min: z.number().finite().optional(), max: z.number().finite().optional(), maxLength: z.number().int().min(1).max(200).optional(),
  options: z.array(z.string().trim().min(1).max(40)).min(1).max(20).optional(),
}).superRefine((f, c) => {
  const numeric = ['integer', 'decimal', 'money', 'duration'].includes(f.type);
  if (!numeric && (f.min !== undefined || f.max !== undefined)) c.addIssue({ code: 'custom', message: '只有数值字段可以定义数值范围。' });
  if (f.type !== 'text' && f.maxLength !== undefined) c.addIssue({ code: 'custom', message: '只有文本字段可以定义长度。' });
  if (f.type !== 'decimal' && numeric && [f.min, f.max].some(n => n !== undefined && !Number.isSafeInteger(n))) c.addIssue({ code: 'custom', message: '整数范围必须是安全整数。' });
  if (f.min !== undefined && f.max !== undefined && f.min > f.max) c.addIssue({ code: 'custom', message: '字段范围不合法。' });
  if (['single_select', 'multi_select'].includes(f.type) !== !!f.options) c.addIssue({ code: 'custom', message: '选项与字段类型不匹配。' });
  if (f.options && new Set(f.options).size !== f.options.length) c.addIssue({ code: 'custom', message: '选项不能重复。' });
  if (f.unit && !['integer', 'decimal', 'money', 'duration'].includes(f.type)) c.addIssue({ code: 'custom', message: '该字段不能使用计量单位。' });
  if (f.type === 'money' && f.unit !== 'CNY_cent') c.addIssue({ code: 'custom', message: '金额必须使用整数分。' });
  if (f.type === 'duration' && f.unit !== 'minute') c.addIssue({ code: 'custom', message: '时长必须使用分钟。' });
  if (f.unit === 'CNY_cent' && f.type !== 'money') c.addIssue({ code: 'custom', message: '分只能用于金额字段。' });
  if (f.unit === 'minute' && f.type !== 'duration') c.addIssue({ code: 'custom', message: '分钟只能用于时长字段。' });
  if (['ml', 'day_per_week'].includes(f.unit ?? '') && f.type !== 'integer') c.addIssue({ code: 'custom', message: '该计量单位使用整数。' });
});
export const templateMetricSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/), label: z.string().trim().min(1).max(40),
  operation: z.enum(['sum', 'count', 'distinct_days', 'mean', 'goal_progress']),
  fieldId: z.string().optional(), period: z.enum(['day', 'week', 'month']), goalFieldId: z.string().optional(),
  goalAggregation: z.enum(['sum','count','distinct_days']).optional(), groupByFieldId: z.string().optional(),
  sourceRule: z.enum(['ledger_expenses', 'ledger_net', 'study_week', 'generic_records']).optional(),
});
export const templateDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(1), id: z.string().regex(/^[a-z][a-z0-9.-]{0,79}$/), version: z.number().int().min(1),
  name: z.string().trim().min(1).max(40), description: z.string().trim().min(1).max(300), engine: z.enum(['ledger', 'study', 'generic']),
  source: z.enum(['official','private','community']), requiredCapabilities: z.array(z.enum(['reading-template-v1', 'ledger-template-v1', 'generic-record-v1','private-template-v1','generic-template-v2','community-template-v1'])).min(1).max(6),
  configurationFields: z.array(templateFieldSchema).max(20), recordFields: z.array(templateFieldSchema).min(1).max(20),
  metrics: z.array(templateMetricSchema).max(10), components: z.array(z.enum(['summary', 'goal', 'calendar', 'records', 'trend', 'budget', 'categories'])).min(1).max(7),
  example: z.strictObject({ config: z.record(z.string(), z.unknown()), record: z.record(z.string(), z.unknown()) }),
  configurationDefaults: valuesSchema.optional(), recordDefaults: valuesSchema.optional(),
}).superRefine((d, c) => {
  for (const fields of [d.configurationFields, d.recordFields, d.metrics]) if (new Set(fields.map(f => f.id)).size !== fields.length) c.addIssue({ code: 'custom', message: '字段或指标标识重复。' });
  if (!d.components.includes('records') || new Set(d.components).size !== d.components.length) c.addIssue({ code: 'custom', message: '记录入口不可缺少或重复。' });
  const required = d.engine === 'study' ? 'reading-template-v1' : d.engine === 'ledger' ? 'ledger-template-v1' : 'generic-record-v1';
  if (!d.requiredCapabilities.includes(required)) c.addIssue({ code: 'custom', message: '引擎能力声明不匹配。' });
  if (new Set(d.requiredCapabilities).size !== d.requiredCapabilities.length || (d.source === 'private' && (d.engine !== 'generic' || !d.requiredCapabilities.includes('private-template-v1')))) c.addIssue({ code: 'custom', message: '私人模板能力声明不匹配。' });
  if(d.source==='community'&&(d.engine!=='generic'||!d.requiredCapabilities.includes('community-template-v1')||d.requiredCapabilities.includes('private-template-v1')))c.addIssue({code:'custom',message:'社区模板能力声明不匹配。'});
  for (const metric of d.metrics) {
    const field = d.recordFields.find(f => f.id === metric.fieldId);
    const aggregation=metric.operation==='goal_progress'?(metric.goalAggregation??'sum'):metric.operation;
    if ((aggregation !== 'count' || metric.fieldId !== undefined) && !field) c.addIssue({ code: 'custom', message: '指标引用了未知字段。' });
    if (['sum', 'mean'].includes(aggregation) && field && !['integer', 'decimal', 'money', 'duration'].includes(field.type)) c.addIssue({ code: 'custom', message: '只能聚合数值字段。' });
    if (aggregation === 'distinct_days' && field?.type !== 'date') c.addIssue({ code: 'custom', message: '天数只能聚合日期。' });
    if (aggregation==='count'&&metric.fieldId!==undefined) c.addIssue({code:'custom',message:'次数统计不指定数值字段。'});
    if (metric.goalAggregation!==undefined&&metric.operation!=='goal_progress') c.addIssue({code:'custom',message:'只有目标进度可指定目标聚合方法。'});
    if (metric.groupByFieldId&&!d.recordFields.some(f=>f.id===metric.groupByFieldId&&['single_select','boolean'].includes(f.type))) c.addIssue({code:'custom',message:'分类统计需要单选或是否字段。'});
    if (metric.operation === 'goal_progress') {
      const goal = d.configurationFields.find(f => f.id === metric.goalFieldId);
      if (!goal || (aggregation==='sum'?(!['integer', 'decimal', 'money', 'duration'].includes(goal.type)||goal.type!==field?.type||goal.unit!==field?.unit):(goal.type!=='integer'||goal.unit!==undefined))) c.addIssue({ code: 'custom', message: '目标字段或单位不匹配。' });
      if(d.metrics.some(other=>other!==metric&&other.goalFieldId===metric.goalFieldId&&(other.period!==metric.period||(other.goalAggregation??'sum')!==aggregation||other.fieldId!==metric.fieldId))) c.addIssue({code:'custom',message:'同一个目标不能同时表示不同周期或统计口径。'});
    }
    if (d.engine === 'ledger' && !['ledger_expenses', 'ledger_net'].includes(metric.sourceRule ?? '')) c.addIssue({ code: 'custom', message: '记账指标必须声明支出或净支出口径。' });
    if (d.engine !== 'ledger' && metric.sourceRule?.startsWith('ledger_')) c.addIssue({ code: 'custom', message: '记账统计口径只能用于支持记账的计划。' });
  }
  if (d.engine === 'ledger' && d.example.record.recordRole === 'refund' && !z.uuid().safeParse(d.example.record.refundOf).success) c.addIssue({ code: 'custom', message: '退款示例必须关联原支出。' });
  for (const [key, fields] of [['config', d.configurationFields], ['record', d.recordFields]] as const) {
    for (const fieldId of Object.keys(d.example[key])) if (!fields.some(f => f.id === fieldId)) c.addIssue({ code: 'custom', message: '示例包含未知字段。' });
    for (const f of fields) {
      const v = d.example[key][f.id];
      if (v === undefined || v === null) { if (f.required) c.addIssue({ code: 'custom', message: '示例缺少必填字段。' }); continue; }
      const numeric = ['integer', 'decimal', 'money', 'duration'].includes(f.type);
      if (numeric && (typeof v !== 'number' || !Number.isFinite(v) || (f.type !== 'decimal' && !Number.isSafeInteger(v)) || (f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max))) c.addIssue({ code: 'custom', message: '示例数值不符合范围。' });
      if (f.type === 'text' && (typeof v !== 'string' || (f.required && !v.trim()) || v.length > (f.maxLength ?? 200))) c.addIssue({ code: 'custom', message: '示例文本不合法。' });
      if (f.type === 'date' && (typeof v !== 'string' || !isBizDate(v))) c.addIssue({ code: 'custom', message: '示例日期不合法。' });
      if (f.type === 'boolean' && typeof v !== 'boolean') c.addIssue({ code: 'custom', message: '示例布尔值不合法。' });
      if (f.type === 'single_select' && (typeof v !== 'string' || !f.options?.includes(v))) c.addIssue({ code: 'custom', message: '示例选项不合法。' });
      if (f.type === 'multi_select' && (!Array.isArray(v) || (f.required && v.length === 0) || new Set(v).size !== v.length || v.some(x => typeof x !== 'string' || !f.options?.includes(x)))) c.addIssue({ code: 'custom', message: '示例选项不合法。' });
    }
  }
});
export type TemplateDefinition = z.infer<typeof templateDefinitionSchema>;
export type TemplateField = z.infer<typeof templateFieldSchema>;
export type TemplateMetric = z.infer<typeof templateMetricSchema>;

export const adoptTemplateActionSchema = z.strictObject({ type: z.literal('adopt_template'), templateId: z.string().min(1).max(80), templateVersion: z.number().int().positive(), existingPlanId: z.uuid().optional(), existingLedgerAction: z.enum(['reuse', 'restore']).optional() });
export const configureReadingActionSchema = z.strictObject({
  type: z.literal('configure_reading_plan'), reviewedOn: z.string().refine(isBizDate).optional(), planId: z.uuid(), expectedVersion: z.number().int().positive(),
  patch: z.strictObject({ name: z.string().trim().min(1).max(20).optional(), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    currentBook: z.string().trim().min(1).max(80).nullable().optional(), daysPerWeek: z.number().int().min(1).max(7).nullable().optional(), minMinutes: z.number().int().min(1).max(1440).nullable().optional() }),
  completeSetup: z.boolean().optional(), goalScope: z.enum(['current_only', 'current_and_future', 'next_and_future']).optional(),
});
export type AdoptTemplateAction = z.infer<typeof adoptTemplateActionSchema>;
export const applyPrivateTemplateActionSchema = z.strictObject({type:z.literal('apply_private_template'),planId:z.uuid(),templateId:z.string().min(1).max(80),templateVersion:z.number().int().positive(),expectedVersion:z.number().int().positive()});
export type ApplyPrivateTemplateAction = z.infer<typeof applyPrivateTemplateActionSchema>;
export type ConfigureReadingAction = z.infer<typeof configureReadingActionSchema>;
const unitsSchema = z.record(z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/), z.string().min(1).max(20)).refine(v => Object.keys(v).length <= 20).optional();
const configScope = z.enum(['current_only', 'current_and_future', 'next_and_future']).optional();
export const configureLedgerActionSchema = z.strictObject({ type: z.literal('configure_ledger_plan'), reviewedOn: z.string().refine(isBizDate).optional(), planId: z.uuid(), expectedVersion: z.number().int().positive(), patch: z.strictObject({ name: z.string().trim().min(1).max(20).optional(), budgetCents: z.number().int().min(1).max(99_999_999).nullable().optional() }), completeSetup: z.boolean().optional(), goalScope: configScope });
export const configureGenericActionSchema = z.strictObject({ type: z.literal('configure_generic_plan'), reviewedOn: z.string().refine(isBizDate).optional(), planId: z.uuid(), expectedVersion: z.number().int().positive(), patch: z.strictObject({ name: z.string().trim().min(1).max(20).optional(), startDate: z.string().optional(), values: valuesSchema.optional() }), completeSetup: z.boolean().optional(), goalScope: configScope, units: unitsSchema, recordDefaults:valuesSchema.optional(), applyTemplateDefaults:z.boolean().optional() });
export const addGenericActionSchema = z.strictObject({ type: z.literal('add_generic_record'), planId: z.uuid(), values: valuesSchema, units: unitsSchema });
export const editGenericActionSchema = z.strictObject({ type: z.literal('edit_generic_record'), recordId: z.uuid(), expectedVersion: z.number().int().positive(), values: valuesSchema, units: unitsSchema });
export type ConfigureLedgerAction = z.infer<typeof configureLedgerActionSchema>;
export type ConfigureGenericAction = z.infer<typeof configureGenericActionSchema>;
export type AddGenericAction = z.infer<typeof addGenericActionSchema>;
export type EditGenericAction = z.infer<typeof editGenericActionSchema>;
export interface TemplatePlanState {
  planId: string; templateId: string; templateVersion: number; source: 'official' | 'legacy' | 'private'|'community'; engine: 'study' | 'ledger' | 'generic'; definition: TemplateDefinition;
  config: { version: number; setupStatus: 'pending' | 'ready'; name: string; startDate: string; currentBook: string | null; daysPerWeek: number | null; minMinutes: number | null;
    goalEffectiveFrom: { daysPerWeek: string | null; minMinutes: string | null };
    nextWeekGoals?: { startsOn: string; daysPerWeek: number | null; minMinutes: number | null };
    canChangeStartDate?: boolean; budgetCents?: number | null; budgetEffectiveFrom?: string | null; nextMonthBudget?: { startsOn: string; value: number | null };
    values?: GenericValues; recordDefaults?:GenericValues; proposedDefaults?:GenericValues;
    goals?:GenericGoalState[]; nextPeriodValues?: Record<string, { startsOn: string; value: GenericValue }> };
}
export type GenericPeriod='day'|'week'|'month';
export interface GenericGoalState {fieldId:string;period:GenericPeriod;from:string;to:string;value:GenericValue;effectiveFrom:string|null;next:{startsOn:string;value:GenericValue};partialPeriod:boolean}
export interface GenericMetricGroup {key:string|boolean|null;label:string;value:number|null;sampleCount:number;recordCount:number}
export interface GenericMetricPoint {date:string;value:number|null;sampleCount:number;recordCount:number}
export interface GenericMetricValue { id: string; label: string; operation: TemplateMetric['operation']; fieldId?: string; unit?: TemplateField['unit']; value: number | null; target: number | null; remaining: number | null; progressPct: number | null;
  sampleCount?:number;period?:GenericPeriod;from?:string;to?:string;partialPeriod?:boolean;groups?:GenericMetricGroup[];series?:GenericMetricPoint[] }
export interface GenericSummary { planId: string; from: string; to: string; recordCount: number; metrics: GenericMetricValue[] }
