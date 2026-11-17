import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.js';

type DeletionEntry = { userId: string; requestedAt: string; backupDeadline: string };
export type DeletionLedger = { version: 1; generatedAt: string; entries: DeletionEntry[]; signature: string };

function sign(value: Omit<DeletionLedger, 'signature'>, key: string) {
  if (Buffer.byteLength(key) < 32) throw new Error('BACKUP_LEDGER_KEY must contain at least 32 bytes');
  return createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
}

/** 导出到独立存储，不能使用待恢复数据库内的旧清单作为恢复依据。 */
export async function exportDeletionLedger(db: Db, key: string): Promise<DeletionLedger> {
  return db.tx(async (q) => {
    const [clock] = await q.query<{ at: Date }>('SELECT clock_timestamp() AS at');
    const rows = await q.query<{ user_id: string; requested_at: Date; backup_deadline: Date }>('SELECT user_id, requested_at, backup_deadline FROM deletion_jobs ORDER BY user_id');
    const value = { version: 1 as const, generatedAt: clock!.at.toISOString(), entries: rows.map((r) => ({ userId: r.user_id, requestedAt: r.requested_at.toISOString(), backupDeadline: r.backup_deadline.toISOString() })) };
    return { ...value, signature: sign(value, key) };
  }, 'planplan:deletion-ledger');
}

export function verifyDeletionLedger(value: unknown, key: string, requiredThrough: Date): DeletionLedger {
  if (!value || typeof value !== 'object') throw new Error('Invalid deletion ledger');
  const ledger = value as DeletionLedger;
  if (ledger.version !== 1 || !Array.isArray(ledger.entries) || typeof ledger.signature !== 'string' || !Number.isFinite(requiredThrough.getTime())) throw new Error('Invalid deletion ledger');
  const generatedAt = new Date(ledger.generatedAt).getTime();
  if (!Number.isFinite(generatedAt) || generatedAt < requiredThrough.getTime() || generatedAt > Date.now() + 60_000) throw new Error('Deletion ledger does not cover the recovery cutoff; keep the restored database isolated');
  const seen = new Set<string>();
  for (const e of ledger.entries) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(e.userId) || seen.has(e.userId) || !Number.isFinite(Date.parse(e.requestedAt)) || !Number.isFinite(Date.parse(e.backupDeadline))) throw new Error('Invalid deletion ledger entry');
    seen.add(e.userId);
  }
  const actual = Buffer.from(ledger.signature, 'hex');
  const expected = Buffer.from(sign({ version: ledger.version, generatedAt: ledger.generatedAt, entries: ledger.entries }, key), 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Deletion ledger signature mismatch');
  return ledger;
}

/** 仅用于无应用连接的隔离恢复库；所有删除请求和清除操作一次提交。 */
export async function applyDeletionLedger(db: Db, ledger: DeletionLedger): Promise<number> {
  return db.tx(async (q) => {
    const current = await q.query<{ user_id: string }>('SELECT user_id FROM deletion_jobs');
    const included = new Set(ledger.entries.map((e) => e.userId));
    if (current.some((e) => !included.has(e.user_id))) throw new Error('Deletion ledger omits a deletion already present in the backup');
    let removed = 0;
    for (const e of ledger.entries) {
      const rows = await q.query('DELETE FROM users WHERE id = $1 RETURNING id', [e.userId]);
      removed += rows.length;
      await q.query(`INSERT INTO deletion_jobs (user_id, status, requested_at, backup_deadline, completed_at)
        VALUES ($1, 'completed', $2, $3, now()) ON CONFLICT (user_id) DO UPDATE
        SET status = 'completed', completed_at = now(), last_error_code = NULL`, [e.userId, e.requestedAt, e.backupDeadline]);
    }
    return removed;
  }, 'planplan:deletion-ledger');
}
