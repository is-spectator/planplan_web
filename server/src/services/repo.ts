import type { Queryable } from '../db/db.js';
import type { RuleSegment } from '../domain/rules.js';
import type { Category } from '../domain/ledger.js';
import { fail } from './errors.js';

export interface PlanRow {
  id: string;
  user_id: string;
  kind: 'ledger' | 'study' | 'generic';
  name: string;
  activity: string | null;
  status: 'active' | 'archived';
  start_date: string;
  view_config: ViewConfig;
  created_at: Date;
  last_activity_at: Date;
}

export interface ViewConfig {
  hidden?: string[];
  order?: string[];
}

export interface RecordRow {
  id: string;
  user_id: string;
  plan_id: string;
  kind: 'expense' | 'refund' | 'study' | 'generic';
  fields: import('../templates/contracts.js').GenericValues | null;
  definition_version: number | null;
  template_id: string | null;
  defaulted_fields?:string[];
  amount_cents: number | null;
  minutes: number | null;
  category: Category | null;
  occurred_on: string;
  note: string;
  refund_of: string | null;
  source: 'chat' | 'form';
  source_message_id: string | null;
  input_at: Date;
  version: number;
  deleted: boolean;
  created_at: Date;
  updated_at: Date;
}

export async function getPlan(q: Queryable, userId: string, planId: string): Promise<PlanRow> {
  const [p] = await q.query<PlanRow>(`SELECT * FROM plans WHERE id = $1 AND user_id = $2`, [planId, userId]);
  return p ?? fail('not_found', '没有找到这个计划。');
}

export async function listPlans(q: Queryable, userId: string): Promise<PlanRow[]> {
  return q.query<PlanRow>(`SELECT * FROM plans WHERE user_id = $1 ORDER BY last_activity_at DESC, created_at DESC`, [userId]);
}

export async function getLedger(q: Queryable, userId: string): Promise<PlanRow | null> {
  const [p] = await q.query<PlanRow>(`SELECT * FROM plans WHERE user_id = $1 AND kind = 'ledger'`, [userId]);
  return p ?? null;
}

export async function getRecord(q: Queryable, userId: string, recordId: string): Promise<RecordRow> {
  const [r] = await q.query<RecordRow>(`SELECT * FROM records WHERE id = $1 AND user_id = $2`, [recordId, userId]);
  return r ?? fail('not_found', '没有找到这条记录。');
}

export async function planRecords(q: Queryable, planId: string, opts: { from?: string; to?: string } = {}): Promise<RecordRow[]> {
  const params: unknown[] = [planId];
  let where = `plan_id = $1 AND NOT deleted`;
  if (opts.from) {
    params.push(opts.from);
    where += ` AND occurred_on >= $${params.length}`;
  }
  if (opts.to) {
    params.push(opts.to);
    where += ` AND occurred_on <= $${params.length}`;
  }
  return q.query<RecordRow>(`SELECT * FROM records WHERE ${where} ORDER BY occurred_on DESC, created_at DESC`, params);
}

export async function activeRefunds(q: Queryable, expenseId: string): Promise<RecordRow[]> {
  return q.query<RecordRow>(`SELECT * FROM records WHERE refund_of = $1 AND NOT deleted ORDER BY occurred_on, created_at`, [expenseId]);
}

export async function segments(q: Queryable, planId: string): Promise<RuleSegment[]> {
  return (await segmentsForPlans(q, [planId])).get(planId) ?? [];
}

export async function segmentsForPlans(q: Queryable, planIds: string[]): Promise<Map<string, RuleSegment[]>> {
  const grouped = new Map<string, RuleSegment[]>();
  if (!planIds.length) return grouped;
  const rows = await q.query<{ plan_id: string; seq: number; param: RuleSegment['param']; value: number; from_period: string; to_period: string | null; cleared: boolean }>(
    `SELECT plan_id, seq, param, value, from_period, to_period, cleared FROM goal_segments WHERE plan_id = ANY($1::uuid[]) AND NOT revoked ORDER BY seq`, [planIds]);
  for (const r of rows) {
    const list = grouped.get(r.plan_id) ?? [];
    list.push({ seq: Number(r.seq), param: r.param, value: r.value, fromPeriod: r.from_period, toPeriod: r.to_period, ...(r.cleared ? { cleared: true } : {}) });
    grouped.set(r.plan_id, list);
  }
  return grouped;
}

export async function lifecycleDates(q: Queryable, planId: string): Promise<{ event: 'archived' | 'restored'; on_date: string }[]> {
  return q.query(`SELECT event, on_date FROM plan_lifecycle WHERE plan_id = $1 ORDER BY seq`, [planId]);
}

export async function dataVersion(q: Queryable, userId: string): Promise<number> {
  const [r] = await q.query<{ data_version: number }>(`SELECT data_version FROM users WHERE id = $1`, [userId]);
  return r?.data_version ?? 0;
}
