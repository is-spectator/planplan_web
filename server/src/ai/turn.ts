import { CATEGORIES } from '../domain/ledger.js';

export interface TurnGenericField {
  field_id: string;
  value: string | number | boolean | string[] | null;
  unit: string | null;
  unit_size: number | null;
  unit_size_unit: string | null;
}

/** 模型每轮输出的结构。严格模式下所有字段都必须出现，可为空的用 null。 */
export interface TurnWrite {
  op:
    | 'create_ledger'
    | 'create_study'
    | 'add_expense'
    | 'add_refund'
    | 'add_study'
    | 'edit_record'
    | 'delete_record'
    | 'undo_last'
    | 'set_budget'
    | 'set_study_goal'
    | 'configure_reading_plan'
    | 'configure_ledger_plan'
    | 'configure_generic_plan'
    | 'add_generic_record'
    | 'edit_generic_record'
    | 'rename_plan'
    | 'archive_plan'
    | 'restore_plan'
    | 'hide_component'
    | 'show_component'
    | 'reorder_components'
    | 'day_total_claim';
  is_fact: boolean;
  amount_text: string | null;
  currency: 'CNY' | 'other' | null;
  duration_value: number | null;
  duration_unit: 'minute' | 'hour' | null;
  category: (typeof CATEGORIES)[number] | null;
  date_kind: 'today' | 'yesterday' | 'day_before_yesterday' | 'days_ago' | 'absolute' | 'unknown' | 'future';
  days_ago: number | null;
  date: string | null;
  note: string | null;
  plan_id: string | null;
  plan_name: string | null;
  activity: string | null;
  days_per_week: number | null;
  /** 提取用户明确的本周目标；不是确认，确认只来自服务端选项。旧输出省略兼容为 null。 */
  goal_period?: 'this_week' | 'weekly' | null;
  min_minutes: number | null;
  scope: 'current_only' | 'current_and_future' | 'next_and_future' | 'unspecified';
  record_id: string | null;
  component: 'trend' | 'categories' | 'minutes' | null;
  component_order?: string[] | null;
  reading_book?: string | null;
  reading_position?: string | null;
  reading_reflection?: string | null;
  clear_current_book?: boolean;
  complete_setup?: boolean;
  /** Server snapshot only; never accepted from model output. */
  expected_config_version?: number;
  generic_fields?: TurnGenericField[];
  record_defaults?:TurnGenericField[]|null;
  apply_template_defaults?:boolean;
  clear_budget?: boolean;
}

export const QUERY_PERIODS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'recent_7_days', 'custom'] as const;
export const COMPARISON_METRICS = ['spend', 'refund', 'net', 'minutes'] as const;
export interface TurnComparison {
  metric: (typeof COMPARISON_METRICS)[number];
  period: (typeof QUERY_PERIODS)[number];
  from: string | null;
  to: string | null;
}

export interface TurnQuery {
  kind: 'ledger_summary' | 'ledger_category' | 'budget' | 'study_progress' | 'generic_summary' | 'overview';
  plan_id: string | null;
  period: 'today' | 'yesterday' | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'recent_7_days' | 'custom';
  from: string | null;
  to: string | null;
  category: (typeof CATEGORIES)[number] | null;
  /** 按备注匹配的具体消费（如“加油”“咖啡”），比分类更细；任一词命中即算。旧协议省略视为 null。 */
  keywords?: string[] | null;
  /** 主区间减去 compare 区间；两边固定使用同一计划、指标和分类。旧协议省略视为 null。 */
  compare?: TurnComparison | null;
}

export interface Turn {
  intent: 'write' | 'query' | 'write_and_query' | 'smalltalk' | 'unsupported' | 'answer_pending' | 'cancel_pending';
  writes: TurnWrite[];
  query: TurnQuery | null;
  missing: ('amount' | 'minutes' | 'date' | 'plan' | 'currency' | 'target' | 'activity' | 'field' | 'unit')[];
  question: string | null;
  unsupported_kind: 'income' | 'transfer' | 'reminder' | 'sync' | 'ability' | 'multi_currency' | 'page_progress' | 'pause' | 'other' | 'none';
  reply: string;
}

const nullable = (t: object) => ({ anyOf: [t, { type: 'null' }] });
const str = { type: 'string' };
const int = { type: 'integer' };
const enumOf = (values: readonly string[]) => ({ type: 'string', enum: [...values] });

const WRITE_OPS: TurnWrite['op'][] = [
  'create_ledger', 'create_study', 'add_expense', 'add_refund', 'add_study', 'edit_record', 'delete_record', 'undo_last',
  'set_budget', 'set_study_goal', 'configure_reading_plan', 'configure_ledger_plan', 'configure_generic_plan', 'add_generic_record', 'edit_generic_record', 'rename_plan', 'archive_plan', 'restore_plan', 'hide_component', 'show_component', 'reorder_components', 'day_total_claim',
];

const genericFieldsSchema={ type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['field_id', 'value', 'unit', 'unit_size', 'unit_size_unit'], properties: {
  field_id: str, value: { anyOf: [str, { type: 'number' }, { type: 'boolean' }, { type: 'array', items: str }, { type: 'null' }] },
  unit: nullable(str), unit_size: nullable({ type: 'number' }), unit_size_unit: nullable(str),
} } };
const writeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['op', 'is_fact', 'amount_text', 'currency', 'duration_value', 'duration_unit', 'category', 'date_kind', 'days_ago', 'date', 'note', 'plan_id', 'plan_name', 'activity', 'days_per_week', 'min_minutes', 'scope', 'record_id', 'component', 'component_order', 'goal_period', 'reading_book', 'reading_position', 'reading_reflection', 'clear_current_book', 'complete_setup', 'generic_fields', 'clear_budget','record_defaults','apply_template_defaults'],
  properties: {
    op: enumOf(WRITE_OPS),
    is_fact: { type: 'boolean' },
    amount_text: nullable(str),
    currency: nullable(enumOf(['CNY', 'other'])),
    duration_value: nullable({ type: 'number' }),
    duration_unit: nullable(enumOf(['minute', 'hour'])),
    category: nullable(enumOf(CATEGORIES)),
    date_kind: enumOf(['today', 'yesterday', 'day_before_yesterday', 'days_ago', 'absolute', 'unknown', 'future']),
    days_ago: nullable(int),
    date: nullable(str),
    note: nullable(str),
    plan_id: nullable(str),
    plan_name: nullable(str),
    activity: nullable(str),
    days_per_week: nullable(int),
    goal_period: nullable(enumOf(['this_week', 'weekly'])),
    reading_book: nullable({ type: 'string', maxLength: 80 }),
    reading_position: nullable({ type: 'string', maxLength: 40 }),
    reading_reflection: nullable({ type: 'string', maxLength: 40 }),
    clear_current_book: { type: 'boolean' },
    complete_setup: { type: 'boolean' },
    clear_budget: { type: 'boolean' },
    generic_fields: genericFieldsSchema,
    record_defaults:nullable(genericFieldsSchema),apply_template_defaults:nullable({type:'boolean'}),
    min_minutes: nullable(int),
    scope: enumOf(['current_only', 'current_and_future', 'next_and_future', 'unspecified']),
    record_id: nullable(str),
    component: nullable(enumOf(['trend', 'categories', 'minutes'])),
    component_order: nullable({ type: 'array', items: enumOf(['trend', 'categories', 'minutes', 'records']), maxItems: 3 }),
  },
};

const querySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'plan_id', 'period', 'from', 'to', 'category', 'keywords', 'compare'],
  properties: {
    kind: enumOf(['ledger_summary', 'ledger_category', 'budget', 'study_progress', 'generic_summary', 'overview']),
    plan_id: nullable(str),
    period: enumOf(QUERY_PERIODS),
    from: nullable(str),
    to: nullable(str),
    category: nullable(enumOf(CATEGORIES)),
    keywords: nullable({ type: 'array', items: str, maxItems: 5 }),
    compare: nullable({
      type: 'object', additionalProperties: false,
      required: ['metric', 'period', 'from', 'to'],
      properties: { metric: enumOf(COMPARISON_METRICS), period: enumOf(QUERY_PERIODS), from: nullable(str), to: nullable(str) },
    }),
  },
};

export const TURN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'writes', 'query', 'missing', 'question', 'unsupported_kind', 'reply'],
  properties: {
    intent: enumOf(['write', 'query', 'write_and_query', 'smalltalk', 'unsupported', 'answer_pending', 'cancel_pending']),
    writes: { type: 'array', items: writeSchema },
    query: nullable(querySchema),
    missing: { type: 'array', items: enumOf(['amount', 'minutes', 'date', 'plan', 'currency', 'target', 'activity', 'field', 'unit']) },
    question: nullable(str),
    unsupported_kind: enumOf(['income', 'transfer', 'reminder', 'sync', 'ability', 'multi_currency', 'page_progress', 'pause', 'other', 'none']),
    reply: str,
  },
};

function sanitizeKeywords(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = [...new Set(v.filter((k): k is string => typeof k === 'string').map((k) => k.trim().slice(0, 10)).filter(Boolean))].slice(0, 5);
  return out.length ? out : null;
}

/** 模型输出不可信：逐字段收紧成合法结构，非法值一律降级为 null 或丢弃。 */
export function sanitizeTurn(raw: unknown): Turn | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
  const s = (v: unknown, max = 60) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const i = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : null);
  const intents: Turn['intent'][] = ['write', 'query', 'write_and_query', 'smalltalk', 'unsupported', 'answer_pending', 'cancel_pending'];
  const writes = Array.isArray(r.writes) ? r.writes.slice(0, 12) : [];
  if (writes.some(write => write && typeof write === 'object' && Array.isArray((write as Record<string, unknown>).generic_fields) && ((write as Record<string, unknown>).generic_fields as unknown[]).length > 20)) return null;
  // Never turn malformed generic payloads into null: null can intentionally clear a goal.
  for (const rawWrite of writes) {
    if (!rawWrite || typeof rawWrite !== 'object') continue;
    const write = rawWrite as Record<string, unknown>;
    if (write.op === 'configure_ledger_plan' && write.currency !== undefined && write.currency !== null && !['CNY', 'other'].includes(write.currency as string)) return null;
    if (write.op === 'add_generic_record' && typeof write.is_fact !== 'boolean') return null;
    if(write.apply_template_defaults!==undefined&&write.apply_template_defaults!==null&&typeof write.apply_template_defaults!=='boolean')return null;
    if(write.op!=='configure_generic_plan'&&(write.record_defaults!=null||write.apply_template_defaults===true))return null;
    for(const key of ['generic_fields','record_defaults'] as const){
    if (write[key] === undefined||key==='record_defaults'&&write[key]===null) continue;
    if (!Array.isArray(write[key])||write[key].length>20) return null;
    for (const rawField of write[key]) {
      if (!rawField || typeof rawField !== 'object' || Array.isArray(rawField)) return null;
      const field = rawField as Record<string, unknown>;
      if (typeof field.field_id !== 'string' || !Object.hasOwn(field, 'value')) return null;
      const value = field.value;
      if (!(value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (Array.isArray(value) && value.every(item => typeof item === 'string')))) return null;
      for (const key of ['unit', 'unit_size_unit']) if (field[key] !== undefined && field[key] !== null && typeof field[key] !== 'string') return null;
      if (field.unit_size !== undefined && field.unit_size !== null && (typeof field.unit_size !== 'number' || !Number.isFinite(field.unit_size))) return null;
    }
    }
  }
  const q = r.query as Record<string, unknown> | null | undefined;
  if (q?.kind === 'generic_summary') {
    if (!QUERY_PERIODS.includes(q.period as TurnQuery['period'])) return null;
    if (q.category !== undefined && q.category !== null && !(CATEGORIES as readonly unknown[]).includes(q.category)) return null;
    if (q.keywords !== undefined && q.keywords !== null && (!Array.isArray(q.keywords) || !q.keywords.every(keyword => typeof keyword === 'string' && keyword.trim().length > 0))) return null;
    for (const key of ['plan_id', 'from', 'to']) if (q[key] !== undefined && q[key] !== null && (typeof q[key] !== 'string' || !(q[key] as string).trim())) return null;
  }
  let compare: TurnComparison | null = null;
  if (q?.compare !== undefined && q.compare !== null) {
    const c = q.compare as Record<string, unknown>;
    // 错误的比较口径不能静默降级成单周期查询或另一个指标。
    if (typeof c !== 'object' || Array.isArray(c) || !COMPARISON_METRICS.includes(c.metric as TurnComparison['metric']) || !QUERY_PERIODS.includes(c.period as TurnComparison['period'])) return null;
    compare = { metric: c.metric as TurnComparison['metric'], period: c.period as TurnComparison['period'], from: s(c.from, 10), to: s(c.to, 10) };
  }
  return {
    intent: pick(r.intent, intents, 'smalltalk'),
    writes: writes
      .filter((w): w is Record<string, unknown> => typeof w === 'object' && w !== null && WRITE_OPS.includes((w as { op?: TurnWrite['op'] }).op as TurnWrite['op']))
      .map((w) => ({
        op: w.op as TurnWrite['op'],
        is_fact: w.is_fact !== false,
        amount_text: s(w.amount_text, 20),
        currency: pick(w.currency, ['CNY', 'other'] as const, 'CNY'),
        duration_value: n(w.duration_value),
        duration_unit: w.duration_unit === 'hour' || w.duration_unit === 'minute' ? w.duration_unit : null,
        category: (CATEGORIES as readonly string[]).includes(w.category as string) ? (w.category as TurnWrite['category']) : null,
        date_kind: pick(w.date_kind, ['today', 'yesterday', 'day_before_yesterday', 'days_ago', 'absolute', 'unknown', 'future'] as const, 'today'),
        days_ago: i(w.days_ago),
        date: s(w.date, 10),
        note: s(w.note, 40),
        plan_id: s(w.plan_id, 40),
        plan_name: s(w.plan_name, 20),
        activity: s(w.activity, 20),
        days_per_week: i(w.days_per_week),
        goal_period: w.goal_period === 'this_week' || w.goal_period === 'weekly' ? w.goal_period : null,
        min_minutes: i(w.min_minutes),
        reading_book: s(w.reading_book, 80),
        reading_position: s(w.reading_position, 40),
        reading_reflection: s(w.reading_reflection, 40),
        clear_current_book: w.clear_current_book === true,
        complete_setup: w.complete_setup === true,
        clear_budget: w.clear_budget === true,
        apply_template_defaults:typeof w.apply_template_defaults==='boolean'?w.apply_template_defaults:undefined,
        record_defaults:Array.isArray(w.record_defaults)?w.record_defaults.map(raw=>{const field=raw as Record<string,unknown>;return {field_id:field.field_id as string,value:field.value as TurnGenericField['value'],unit:s(field.unit,40),unit_size:n(field.unit_size),unit_size_unit:s(field.unit_size_unit,40)};}):null,
        generic_fields: Array.isArray(w.generic_fields) ? w.generic_fields.map(raw => {
          const field = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
          const value = typeof field.value === 'number' ? n(field.value) : typeof field.value === 'string' || typeof field.value === 'boolean' ? field.value : Array.isArray(field.value) && field.value.every(item => typeof item === 'string') ? field.value as string[] : null;
          return { field_id: typeof field.field_id === 'string' ? field.field_id : '', value, unit: s(field.unit, 40), unit_size: n(field.unit_size), unit_size_unit: s(field.unit_size_unit, 40) };
        }) : [],
        scope: pick(w.scope, ['current_only', 'current_and_future', 'next_and_future', 'unspecified'] as const, 'unspecified'),
        record_id: s(w.record_id, 40),
        component: w.component === 'trend' || w.component === 'categories' || w.component === 'minutes' ? w.component : null,
        component_order: Array.isArray(w.component_order) && w.component_order.length > 0 && w.component_order.length <= 3 && w.component_order.every((v) => ['trend', 'categories', 'minutes', 'records'].includes(v as string)) && new Set(w.component_order).size === w.component_order.length ? w.component_order as string[] : null,
      })),
    query:
      q && typeof q === 'object'
        ? {
            kind: pick(q.kind, ['ledger_summary', 'ledger_category', 'budget', 'study_progress', 'generic_summary', 'overview'] as const, 'overview'),
            plan_id: s(q.plan_id, 40),
            period: pick(q.period, ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'recent_7_days', 'custom'] as const, 'this_month'),
            from: s(q.from, 10),
            to: s(q.to, 10),
            category: (CATEGORIES as readonly string[]).includes(q.category as string) ? (q.category as TurnQuery['category']) : null,
            keywords: sanitizeKeywords(q.keywords),
            compare,
          }
        : null,
    missing: Array.isArray(r.missing) ? (r.missing.filter((m) => ['amount', 'minutes', 'date', 'plan', 'currency', 'target', 'activity', 'field', 'unit'].includes(m as string)) as Turn['missing']) : [],
    question: s(r.question, 120),
    unsupported_kind: pick(r.unsupported_kind, ['income', 'transfer', 'reminder', 'sync', 'ability', 'multi_currency', 'page_progress', 'pause', 'other', 'none'] as const, 'none'),
    reply: s(r.reply, 300) ?? '',
  };
}
