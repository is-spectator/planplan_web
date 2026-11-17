import { getPlanTemplate } from './templates.js';
import { prepareGenericRecordValues } from './generic.js';
import { shanghaiDate } from '../domain/time.js';
import { createHash } from 'node:crypto';
import type { Queryable } from '../db/db.js';
import type { Action } from './engine.js';
import { NEW_STUDY_PLAN } from './engine.js';
import { getLedger, getRecord } from './repo.js';

export function actionKey(action: Action): string {
  return JSON.stringify(Object.fromEntries(Object.entries(action).sort(([a], [b]) => a.localeCompare(b))));
}

/** No record details leave this check; each query is bound to the authenticated user. */
export async function hasDuplicate(q: Queryable, userId: string, a: Action, inputAt: Date): Promise<boolean> {
  if(a.type==='add_generic_record'){
    const state=await getPlanTemplate(q,userId,a.planId,shanghaiDate(inputAt));
    const values=prepareGenericRecordValues(state.definition,a.values,a.units,shanghaiDate(inputAt),state.config.recordDefaults??{}).values;
    const rows=await q.query(`SELECT id FROM records WHERE user_id=$1 AND plan_id=$2 AND kind='generic' AND NOT deleted AND fields=$3::jsonb AND input_at BETWEEN $4 AND $5 LIMIT 1`,[userId,a.planId,JSON.stringify(values),new Date(inputAt.getTime()-120000),new Date(inputAt.getTime()+120000)]);
    return rows.length>0;
  }
  if (a.type !== 'add_expense' && a.type !== 'add_study' && a.type !== 'add_refund') return false;
  const kind = a.type.slice(4);
  const planId = a.type === 'add_study' ? a.planId : (await getLedger(q, userId))?.id;
  if (!planId || planId === NEW_STUDY_PLAN) return false;
  const expense = a.type === 'add_refund' ? await getRecord(q, userId, a.expenseId) : null;
  const note = (a.note ?? expense?.note ?? '').slice(0, 200).trim();
  const from = new Date(inputAt.getTime() - 120_000);
  const to = new Date(inputAt.getTime() + 120_000);
  const rows = await q.query<{ id: string }>(
    `SELECT id FROM records WHERE user_id=$1 AND plan_id=$2 AND kind=$3 AND NOT deleted
       AND occurred_on=$4 AND input_at BETWEEN $5 AND $6
       AND amount_cents IS NOT DISTINCT FROM $7::bigint AND minutes IS NOT DISTINCT FROM $8::int
       AND category IS NOT DISTINCT FROM $9::text AND refund_of IS NOT DISTINCT FROM $10::uuid
       AND btrim(note)=$11 ORDER BY input_at DESC, id DESC LIMIT 1`,
    [userId, planId, kind, a.date, from, to, a.type === 'add_study' ? null : a.amountCents,
      a.type === 'add_study' ? a.minutes : null, a.type === 'add_expense' ? a.category : expense?.category ?? null,
      a.type === 'add_refund' ? a.expenseId : null, note],
  );
  return rows.length > 0;
}

export function intentHash(inputAt: Date, actions: Action[]): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
  return createHash('sha256').update(JSON.stringify({ inputAt: inputAt.toISOString(), actions: canonical(actions) })).digest('hex');
}
