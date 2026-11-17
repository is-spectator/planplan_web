import type { Queryable } from '../db/db.js';
import { z } from 'zod';

const count = z.number().int().min(0).max(1_000_000_000);
const latency = z.number().int().min(0).max(3_600_000);
const eventSchemas = {
  login: z.object({ method: z.enum(['apple', 'email', 'dev']) }).strict(),
  ai_consent: z.object({ granted: z.boolean() }).strict(),
  account_deleted: z.object({}).strict(),
  export: z.object({}).strict(),
  house_item_chosen: z.object({ slot: z.enum(['desk', 'plant', 'theme']), variant: z.enum(['cat', 'cup', 'flower', 'monstera', 'succulent', 'pothos', 'warm', 'dusk', 'night']) }).strict(),
  circle_joined: z.object({}).strict(),
  circle_created: z.object({}).strict(),
  circle_left: z.object({}).strict(),
  model_failure: z.object({ kind: z.enum(['unavailable', 'invalid_output', 'timeout', 'billing', 'unauthorized', 'rate_limited', 'invalid_request', 'accounting_unavailable']), latencyMs: latency }).strict(),
  turn_understood: z.object({
    intent: z.enum(['write', 'query', 'write_and_query', 'smalltalk', 'unsupported', 'answer_pending', 'cancel_pending']),
    writes: count, hasQuery: z.boolean(), latencyMs: latency,
    promptTokens: count.nullable(), completionTokens: count.nullable(),
  }).strict(),
  clarification: z.object({ category: z.enum(['amount', 'duration', 'date', 'target', 'other']), items: count }).strict(),
  write_succeeded: z.object({ items: count, types: z.array(z.enum(['plan_created', 'expense_added', 'refund_added', 'study_added', 'generic_added', 'record_edited', 'record_deleted', 'goal_set', 'plan_updated', 'undone'])).max(100) }).strict(),
  write_rejected: z.object({ code: z.enum(['duplicate_confirmation_required', 'confirmation_expired', 'operation_changed', 'invalid_input', 'not_found', 'future_date', 'plan_archived', 'no_ledger', 'no_study_plan', 'ledger_exists', 'duplicate_name', 'kind_mismatch', 'refund_exceeds_expense', 'refund_before_expense', 'expense_below_refunds', 'has_refunds', 'refund_confirmation_required', 'day_minutes_exceeded', 'version_conflict', 'undo_conflict', 'already_undone', 'unauthorized', 'forbidden', 'ai_consent_required', 'rate_limited', 'circle_conflict', 'internal']) }).strict(),
} as const;

export type EventName = keyof typeof eventSchemas;
export type EventProps<N extends EventName> = z.input<(typeof eventSchemas)[N]>;

/** 用户可见的追问说明可能含金额、时长、名称；事件仅保留封闭类别。 */
export function clarificationCategory(issue: string): EventProps<'clarification'>['category'] {
  if (issue === '缺少金额') return 'amount';
  if (issue === '缺少时长') return 'duration';
  if (issue === '日期不确定') return 'date';
  if (['需要选计划', '需要选记录', '需要选原支出'].includes(issue)) return 'target';
  return 'other';
}

/** 编译时约束并在运行时拒绝额外字段。验证失败不记录输入或错误原文。 */
export async function logEvent<N extends EventName>(q: Queryable, name: N, props: EventProps<N>) {
  if (!Object.hasOwn(eventSchemas, name)) return;
  const parsed = eventSchemas[name].safeParse(props);
  if (!parsed.success) return;
  try {
    await q.query(`INSERT INTO events (name, props) VALUES ($1, $2)`, [name, JSON.stringify(parsed.data)]);
  } catch {
    // 埋点失败不影响业务。
  }
}
