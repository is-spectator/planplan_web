import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { attemptRequestDigest } from '../ai/usage-store.js';
import { requireActiveUser } from './deletion.js';
import type { Db, Queryable } from '../db/db.js';
import type { Action, ExecContext, OperationResult } from './engine.js';

const count = z.number().int().min(0).max(1_000_000);
const latency = z.number().int().min(0).max(3_600_000);
const kind = z.enum(['ledger', 'study', 'generic']);
const recordKind = z.enum(['expense', 'refund', 'study', 'generic']);
const field = z.enum(['amount', 'duration', 'date', 'category', 'note', 'deleted']);
const schemas = {
  entry: z.object({ result: z.literal('signed_in') }).strict(),
  login: z.object({ method: z.enum(['email', 'apple', 'dev']), result: z.literal('success') }).strict(),
  plan_created: z.object({ kind, hasGoal: z.boolean(), latencyMs: latency }).strict(),
  record_saved: z.object({ recordId: z.uuid(), kind: recordKind, source: z.enum(['chat', 'form']), latencyMs: latency }).strict(),
  operation: z.object({ operationId: z.uuid(), rootHash: z.string().regex(/^[0-9a-f]{64}$/).optional(), requestHash: z.string().regex(/^[0-9a-f]{64}$/), source: z.enum(['chat', 'form']) }).strict(),
  request: z.object({ requestHash: z.string().regex(/^[0-9a-f]{64}$/), source: z.enum(['chat', 'form']), status: z.enum(['started', 'succeeded', 'clarification', 'rejected', 'model_failed', 'unknown']), intent: z.enum(['write', 'query', 'write_and_query', 'smalltalk', 'unsupported', 'answer_pending', 'cancel_pending', 'unknown']), records: count, clarificationRounds: count, latencyMs: latency }).strict(),
  query: z.object({ kind: z.enum(['generic_period', 'ledger_month', 'ledger_range', 'study_week', 'study_range', 'comparison', 'overview', 'none']), hasData: z.boolean(), valid: z.boolean(), latencyMs: latency }).strict(),
  correction: z.object({ recordId: z.uuid(), originalOperationId: z.uuid().nullable(), fields: z.array(field).max(6), reason: z.enum(['understanding_error', 'normal_adjustment', 'unspecified']) }).strict(),
  lifecycle: z.object({ kind, action: z.enum(['archived', 'restored']), result: z.literal('success') }).strict(),
  layout: z.object({ kind, components: z.array(z.enum(['summary', 'budget', 'categories', 'trend', 'records', 'goal', 'calendar', 'minutes'])).max(8), result: z.enum(['success', 'fallback']) }).strict(),
  failure: z.object({ requestHash: z.string().regex(/^[0-9a-f]{64}$/), category: z.enum(['model', 'tool']), code: z.enum(['unavailable', 'timeout', 'invalid_output', 'billing', 'unauthorized', 'rate_limited', 'invalid_request', 'accounting_unavailable', 'domain_rejected', 'internal']), retryResult: z.enum(['unknown', 'succeeded', 'failed']), latencyMs: latency }).strict(),
} as const;
export type UsageName = keyof typeof schemas;
export type UsageProps<N extends UsageName> = z.input<(typeof schemas)[N]>;

/** Called after business commits; event failure cannot poison a business transaction. */
export async function usage<N extends UsageName>(db: Db, userId: string, name: N, key: string, props: UsageProps<N>, at = new Date()): Promise<void> {
  if (!Object.hasOwn(schemas, name) || !z.uuid().safeParse(userId).success || !key || key.length > 500 || !Number.isFinite(at.getTime())) return;
  const checked = schemas[name].safeParse(props);
  if (!checked.success) return;
  try {
    await db.tx(async q => {
      await requireActiveUser(q, userId);
      await q.query(`INSERT INTO usage_actors(user_id) SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL ON CONFLICT DO NOTHING`, [userId]);
      if (name === 'entry') await q.query(`UPDATE usage_actors SET first_authenticated_at=coalesce(first_authenticated_at,$2) WHERE user_id=$1`, [userId, at]);
      await q.query(`INSERT INTO usage_events(actor_id,name,event_key,props,created_at)
        SELECT actor_id,$2,$3,$4,$5 FROM usage_actors WHERE user_id=$1 AND ($2 <> 'entry' OR first_authenticated_at=$5)
        ON CONFLICT(actor_id,name,event_key) DO NOTHING`, [userId, name, createHash('sha256').update(`${userId}\0${name}\0${key}`).digest('hex'), JSON.stringify(checked.data), at]);
    });
  } catch { /* No exception payload, user ID, request text or database values in logs. */ }
}

export async function usageLogin(db: Db, userId: string, method: UsageProps<'login'>['method']) {
  await usage(db, userId, 'entry', 'first-authenticated-entry', { result: 'signed_in' });
  await usage(db, userId, 'login', randomUUID(), { method, result: 'success' });
}

export async function usageOperation(db: Db, ctx: ExecContext, result: OperationResult, actions: Action[], latencyMs: number) {
  if (result.replayed) return;
  const at = new Date(result.createdAt);
  const elapsed = Math.max(0, Math.min(3_600_000, Math.round(latencyMs)));
  const [origin] = ctx.messageId ? await db.query<{client_msg_id:string}>("SELECT client_msg_id FROM messages WHERE id=$1 AND user_id=$2 AND role='user'",[ctx.messageId,ctx.userId]).catch(()=>[]) : [];
  await usage(db, ctx.userId, 'operation', result.operationId, { operationId: result.operationId, rootHash: attemptRequestDigest(ctx.userId, origin?.client_msg_id ?? result.clientOpId), requestHash: attemptRequestDigest(ctx.userId, result.clientOpId), source: ctx.source }, at);
  const layouts = actions.filter(a => a.type === 'set_view');
  const corrections = actions.filter(a => a.type === 'edit_record' || a.type === 'delete_record');
  for (const [index, item] of result.items.entries()) {
    const key = `${result.operationId}:${index}`;
    if (item.type === 'plan_created') await usage(db, ctx.userId, 'plan_created', key, { kind: item.plan.kind, hasGoal: item.plan.kind === 'ledger' ? item.budgetCents !== null : item.daysPerWeek !== null && item.minMinutes !== null, latencyMs: elapsed }, at);
    if (item.type === 'generic_added' || item.type === 'expense_added' || item.type === 'refund_added' || item.type === 'study_added') await usage(db, ctx.userId, 'record_saved', item.record.id, { recordId: item.record.id, kind: item.record.kind, source: ctx.source, latencyMs: elapsed }, at);
    if (item.type === 'plan_updated' && (item.change === 'archived' || item.change === 'restored')) await usage(db, ctx.userId, 'lifecycle', key, { kind: item.plan.kind, action: item.change, result: 'success' }, at);
    if (item.type === 'plan_updated' && item.change === 'view') {
      const match = layouts.findIndex(a => a.planId === item.plan.id);
      const requested = match < 0 ? undefined : layouts.splice(match, 1)[0];
      const fallback = requested?.type === 'set_view' && (
        requested.hidden?.some(c => !item.plan.hidden.includes(c)) ||
        requested.order?.some(c => !item.plan.order.includes(c))
      );
      await usage(db, ctx.userId, 'layout', key, { kind: item.plan.kind, components: item.plan.order as UsageProps<'layout'>['components'], result: fallback ? 'fallback' : 'success' }, at);
    }
    const changed = item.type === 'record_edited' ? [item.record] : item.type === 'record_deleted' ? item.records : [];
    const correctionIndex = corrections.findIndex(a =>
      (item.type === 'record_edited' && a.type === 'edit_record' && a.recordId === item.record.id) ||
      (item.type === 'record_deleted' && a.type === 'delete_record' && item.records.some(r => r.id === a.recordId)));
    // Consume the corresponding action once per result, including cascaded refunds.
    const action = correctionIndex < 0 ? undefined : corrections.splice(correctionIndex, 1)[0];
    for (const record of changed) {
      const fields: UsageProps<'correction'>['fields'] = [];
      if (item.type === 'record_deleted') fields.push('deleted');
      if (item.type === 'record_edited') {
        if (record.amountCents !== item.before.amountCents) fields.push('amount');
        if (record.minutes !== item.before.minutes) fields.push('duration');
        if (record.date !== item.before.date) fields.push('date');
        if (record.category !== item.before.category) fields.push('category');
        if (record.note !== item.before.note) fields.push('note');
      }
      const [original] = await db.query<{id:string}>(`SELECT id FROM operations WHERE user_id=$1 AND kind='batch' AND EXISTS(SELECT 1 FROM jsonb_array_elements(result->'items') i WHERE i->>'type' IN ('expense_added','refund_added','study_added') AND i->'record'->>'id'=$2) ORDER BY created_at LIMIT 1`, [ctx.userId, record.id]).catch(() => []);
      await usage(db, ctx.userId, 'correction', `${key}:${record.id}`, { recordId: record.id, originalOperationId: original?.id ?? null, fields, reason: action && 'correctionReason' in action ? action.correctionReason ?? 'unspecified' : 'unspecified' }, at);
    }
  }
}

export async function pruneUsage(db: Queryable): Promise<void> {
  await db.query("DELETE FROM usage_entries WHERE first_seen_at < now() - interval '30 days'");
  await db.query("DELETE FROM usage_request_links WHERE created_at < now() - interval '30 days'");
  await db.query(`DELETE FROM usage_events WHERE created_at < now() - interval '30 days'`);
  await db.query(`DELETE FROM events WHERE created_at < now() - interval '30 days'`);
}

/** Presence uses saved facts, not net values that can be zero after refunds. */
export async function usageQuery(db: Db, userId: string, key: string, card: import('./query.js').QueryCard, latencyMs: number) {
  let hasData = false;
  if(card.kind==='generic_period')hasData=card.summary.recordCount>0;
  if (card.kind === 'ledger_range' && card.keywords?.length) hasData = (card.count ?? 0) > 0 || card.refundCents > 0;
  else if (card.kind === 'ledger_month' || card.kind === 'ledger_range') {
    hasData = card.byCategory.some(c => (!card.category || card.category === c.category) && (c.spendCents > 0 || c.refundCents > 0));
  } else if (card.kind === 'study_week') hasData = card.stats.recordDays > 0;
  else if (card.kind === 'study_range') hasData = card.recordDays > 0;
  else if (card.kind === 'overview') hasData = card.plans.some(p => (p.ledger && (p.ledger.spendCents > 0 || p.ledger.refundCents > 0)) || (p.study && p.study.recordDays > 0) || (p.generic && p.generic.recordCount > 0));
  else if (card.kind === 'comparison') {
    const ranges = [card.current, card.previous].map(p => ({ start: p.from, end: p.to }));
    const [row] = await db.query<{present:boolean}>(`SELECT EXISTS(SELECT 1 FROM records r LEFT JOIN records original ON r.refund_of=original.id
      WHERE r.user_id=$1 AND r.plan_id=$2 AND NOT r.deleted
      AND ($4::text IS NULL OR coalesce(original.category,r.category)=$4)
      AND EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS span(start text, "end" text) WHERE r.occurred_on >= span.start AND r.occurred_on <= span."end")) AS present`, [userId, card.plan.id, JSON.stringify(ranges), card.category]);
    hasData = row?.present ?? false;
  }
  await usage(db, userId, 'query', key, { kind: card.kind, hasData, valid: card.kind !== 'none', latencyMs });
}
