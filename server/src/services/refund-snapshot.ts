import { createHash } from 'node:crypto';
import type { Queryable } from '../db/db.js';
import { fail } from './errors.js';
import type { RecordRow } from './repo.js';

export interface RefundSnapshot { token: string; count: number; totalCents: number }
export const REFUND_SNAPSHOT_PATTERN = /^refunds-v1:[a-f0-9]{64}$/;
type RefundMember = Pick<RecordRow, 'id' | 'version' | 'amount_cents'>;

/** An equality precondition, not an authorization credential. Ownership is checked separately. */
export function refundSnapshot(record: Pick<RecordRow, 'id' | 'version'>, refunds: readonly RefundMember[]): RefundSnapshot {
  const members = [...refunds].sort((a, b) => a.id.localeCompare(b.id));
  return {
    token: `refunds-v1:${createHash('sha256').update(JSON.stringify([record.id, record.version, members.map(refund => [refund.id, refund.version, refund.amount_cents])])).digest('hex')}`,
    count: members.length,
    totalCents: members.reduce((total, refund) => total + (refund.amount_cents ?? 0), 0),
  };
}

/** One SQL statement gives the displayed record, amount and exact linked set the same MVCC snapshot. */
export async function recordWithRefundSnapshot(q: Queryable, userId: string, recordId: string): Promise<{ record: RecordRow; refundSnapshot: RefundSnapshot | null }> {
  const [row] = await q.query<RecordRow & { refund_members: RefundMember[] | null }>(`
    SELECT r.*, CASE WHEN r.kind='expense' THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id',f.id,'version',f.version,'amount_cents',f.amount_cents) ORDER BY f.id)
      FROM records f WHERE f.refund_of=r.id AND f.user_id=r.user_id AND NOT f.deleted
    ),'[]'::jsonb) ELSE NULL END AS refund_members
    FROM records r WHERE r.id=$1 AND r.user_id=$2`, [recordId, userId]);
  if (!row) fail('not_found', '没有找到这条记录。');
  const { refund_members, ...record } = row!;
  return { record, refundSnapshot: record.kind === 'expense' ? refundSnapshot(record, refund_members ?? []) : null };
}
