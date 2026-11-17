import type { Db, Queryable } from '../db/db.js';
import { requireActiveUser } from './deletion.js';
import { hasDuplicate, intentHash } from './duplicates.js';
import { executeInTransaction, findOperation, validateActionCapabilities, validateReplayCapabilities, type Action, type ExecContext } from './engine.js';
import { DomainError } from './errors.js';
import { usageOperation } from './usage.js';
import { verifyTemplateRequest } from './templates.js';

export async function pruneOperationConfirmations(db: Queryable, now = new Date()) {
  await db.query('DELETE FROM operation_confirmations WHERE expires_at <= $1', [now]);
}

type Confirmation = { confirmation_id: string; intent_hash: string; input_at: Date; duplicate_count: number };

/** Check and write under one account lock. A pending nonce commits before returning 409. */
export async function executeForm(db: Db, ctx: ExecContext, clientOpId: string, actions: Action[], options: { confirmationId?: string; inputAtProvided: boolean }) {
  ctx = { ...ctx, inputAtProvided: options.inputAtProvided };
  await verifyTemplateRequest(db, ctx, clientOpId, actions);
  const original = await findOperation(db, ctx.userId, clientOpId);
  if (original) { await validateReplayCapabilities(db,ctx,original); return original; }
  await validateActionCapabilities(db,ctx,actions);
  const started = Date.now();
  const gate = await db.tx(async (q) => {
    await requireActiveUser(q, ctx.userId);
    await verifyTemplateRequest(q, ctx, clientOpId, actions);
    const existing = await findOperation(q, ctx.userId, clientOpId);
    if (existing) { await validateReplayCapabilities(q,ctx,existing); return { result: existing }; }
    await validateActionCapabilities(q,ctx,actions);
    await pruneOperationConfirmations(q);
    const [pending] = await q.query<Confirmation>('SELECT * FROM operation_confirmations WHERE user_id=$1 AND client_op_id=$2 FOR UPDATE', [ctx.userId, clientOpId]);
    const inputAt = !options.inputAtProvided && pending ? new Date(pending.input_at) : ctx.inputAt;
    const digest = intentHash(inputAt, actions);
    if (pending) {
      if (pending.intent_hash !== digest) throw new DomainError('operation_changed', '原操作正在等待核对，请先取消原操作，再修改内容。');
      if (pending.confirmation_id === options.confirmationId) {
        return { result: await executeInTransaction(q, { ...ctx, inputAt, clarificationRounds: 1 }, clientOpId, actions) };
      }
      return { pending };
    }
    // A supplied nonce must be a live nonce of this account and original operation.
    if (options.confirmationId) throw new DomainError('confirmation_expired', '核对凭据已失效，本次没有保存。请重新核对这条原操作。');
    let count = 0;
    for (const action of actions) if (await hasDuplicate(q, ctx.userId, action, inputAt)) count++;
    if (!count) return { result: await executeInTransaction(q, { ...ctx, inputAt, clarificationRounds: undefined }, clientOpId, actions) };
    const [saved] = await q.query<Confirmation>(`INSERT INTO operation_confirmations (user_id,client_op_id,intent_hash,input_at,duplicate_count) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [ctx.userId, clientOpId, digest, inputAt, count]);
    return { pending: saved! };
  }, ctx.userId);
  if ('pending' in gate) throw new DomainError('duplicate_confirmation_required', `这次有 ${gate.pending!.duplicate_count} 条内容与输入前后 2 分钟内的记录相同。这是又发生了一次吗？确认前整批都没有保存。`, { confirmationId: gate.pending!.confirmation_id });
  // Telemetry is best-effort after commit, as for chat execution; a failed event
  // must never roll back the saved records or poison their transaction.
  await usageOperation(db, ctx, gate.result, actions, Date.now() - started).catch(() => {});
  return gate.result;
}
