import type { Db, Queryable } from '../db/db.js';
import { DomainError } from './errors.js';

export type DeletionJob = {
  id: string;
  user_id: string;
  status: 'pending' | 'completed';
  requested_at: Date;
  backup_deadline: Date;
  completed_at: Date | null;
  attempts: number;
};

export type DeletionGuard = (q: Queryable) => Promise<void>;

export async function requireActiveUser(q: Queryable, userId: string): Promise<void> {
  const [u] = await q.query(`SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL FOR SHARE`, [userId]);
  if (!u) throw new DomainError('unauthorized', '账户已失效，请重新登录。');
}

/** 与业务写入共用账户锁。任务不随 users 级联删除，可重试并用于恢复后的删除重放。 */
export async function requestAccountDeletion(db: Db, userId: string, guard?: DeletionGuard): Promise<DeletionJob> {
  const job = await db.tx(async (q) => {
    const [existing] = await q.query<DeletionJob>('SELECT * FROM deletion_jobs WHERE user_id = $1', [userId]);
    if (existing) return existing;
    await requireActiveUser(q, userId);
    // Password verification can be expensive; recheck its version under the shared user lock.
    if (guard) await guard(q);
    // 与删除清单导出串行，导出水位只覆盖已提交的删除请求。
    await q.query(`SELECT pg_advisory_xact_lock(hashtext('planplan:deletion-ledger'))`);
    await q.query('UPDATE users SET deleted_at = now(), token_version = token_version + 1, ai_consent = false WHERE id = $1', [userId]);
    const [created] = await q.query<DeletionJob>('INSERT INTO deletion_jobs (user_id) VALUES ($1) RETURNING *', [userId]);
    return created!;
  }, userId);
  if (job.status === 'completed') return job;
  return finishAccountDeletion(db, job.id);
}

export async function finishAccountDeletion(db: Db, jobId: string): Promise<DeletionJob> {
  const [job] = await db.query<DeletionJob>('SELECT * FROM deletion_jobs WHERE id = $1', [jobId]);
  if (!job) throw new DomainError('not_found', '没有找到删除任务。');
  try {
    return await db.tx(async (q) => {
      const [current] = await q.query<DeletionJob>('SELECT * FROM deletion_jobs WHERE id = $1 FOR UPDATE', [jobId]);
      if (current!.status === 'completed') return current!;
      // 外键级联清除计划、记录、对话和凭据；最小删除清单独立保留。
      await q.query('DELETE FROM users WHERE id = $1', [job.user_id]);
      const [done] = await q.query<DeletionJob>(`UPDATE deletion_jobs SET status = 'completed', completed_at = now(), attempts = attempts + 1, last_error_code = NULL WHERE id = $1 RETURNING *`, [jobId]);
      return done!;
    }, job.user_id);
  } catch {
    // 不保存原始 SQL 错误，避免参数中的个人信息进入任务日志。
    const [pending] = await db.query<DeletionJob>(`UPDATE deletion_jobs SET attempts = attempts + 1, last_error_code = 'cleanup_failed' WHERE id = $1 RETURNING *`, [jobId]);
    return pending!;
  }
}

export async function retryPendingDeletions(db: Db): Promise<{ completed: number; pending: number }> {
  const jobs = await db.query<{ id: string }>(`SELECT id FROM deletion_jobs WHERE status = 'pending' ORDER BY requested_at LIMIT 100`);
  let completed = 0;
  for (const job of jobs) if ((await finishAccountDeletion(db, job.id)).status === 'completed') completed++;
  const [remaining] = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM deletion_jobs WHERE status = 'pending'`);
  return { completed, pending: remaining!.count };
}

/** 只有受控备份库存确认早于水位的全部副本已清理，才可移除最小删除清单。 */
export async function pruneCompletedDeletions(db: Db, verifiedBackupCutoff: Date): Promise<number> {
  if (!Number.isFinite(verifiedBackupCutoff.getTime()) || verifiedBackupCutoff.getTime() > Date.now()) throw new Error('Invalid verified backup cleanup cutoff');
  return db.tx(async (q) => {
    const removed = await q.query(`DELETE FROM deletion_jobs WHERE status = 'completed'
      AND requested_at <= now() - interval '28 days' AND requested_at <= $1 RETURNING id`, [verifiedBackupCutoff]);
    return removed.length;
  }, 'planplan:deletion-ledger');
}
