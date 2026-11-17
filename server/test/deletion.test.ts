import { describe, expect, it } from 'vitest';
import { openTestDb } from './database.js';
import { pruneCompletedDeletions, requestAccountDeletion, retryPendingDeletions } from '../src/services/deletion.js';
import { execute } from '../src/services/engine.js';
import { authenticate, issueToken } from '../src/api/auth.js';

const auth = { jwtSecret: new TextEncoder().encode('deletion-test-secret-deletion-test'), appleAudience: null, devLogin: true };

describe('账户清除任务', () => {
  it('清除业务数据且保留独立审计任务，旧会话及在途写入被拒绝', async () => {
    const db = await openTestDb();
    const [user] = await db.query<{ id: string }>(`INSERT INTO users (dev_name) VALUES ('deletion') RETURNING id`);
    const ctx = { userId: user!.id, inputAt: new Date(), source: 'form' as const };
    const token = await issueToken(auth, user!.id, 0);
    await execute(db, ctx, 'create', [{ type: 'create_ledger' }]);
    const job = await requestAccountDeletion(db, user!.id);
    expect(job.status).toBe('completed');
    expect(job.attempts).toBe(1);
    expect((job.backup_deadline.getTime() - job.requested_at.getTime()) / 86400e3).toBeCloseTo(30, 4);
    expect(await db.query('SELECT id FROM users')).toEqual([]);
    expect(await db.query('SELECT id FROM plans')).toEqual([]);
    expect(await db.query('SELECT id FROM operations')).toEqual([]);
    await expect(authenticate(auth, db, `Bearer ${token}`)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(execute(db, ctx, 'after-delete', [{ type: 'create_ledger' }])).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await requestAccountDeletion(db, user!.id)).id).toBe(job.id);
  });

  it('清除失败仍立即封锁账户，任务重试能完成', async () => {
    const db = await openTestDb();
    const [user] = await db.query<{ id: string }>(`INSERT INTO users (dev_name) VALUES ('retry') RETURNING id`);
    await db.exec(`CREATE TABLE artificial_dependency (user_id uuid REFERENCES users(id));`);
    await db.query('INSERT INTO artificial_dependency VALUES ($1)', [user!.id]);
    const job = await requestAccountDeletion(db, user!.id);
    expect(job.status).toBe('pending');
    await expect(db.query(`INSERT INTO messages (user_id, role) VALUES ($1, 'user')`, [user!.id])).rejects.toThrow('no longer accepts writes');
    await expect(db.query('UPDATE users SET ai_consent = true WHERE id = $1', [user!.id])).rejects.toThrow('cannot be reactivated');
    expect((await db.query<{ deleted_at: Date }>('SELECT deleted_at FROM users'))[0]!.deleted_at).toBeTruthy();
    await db.exec('DROP TABLE artificial_dependency');
    expect(await retryPendingDeletions(db)).toEqual({ completed: 1, pending: 0 });
    expect(await db.query('SELECT id FROM users')).toEqual([]);
  });

  it('最小删除清单只有完成、已满28天且旧备份清理验证覆盖时才到期删除', async () => {
    const db = await openTestDb();
    await db.query(`INSERT INTO deletion_jobs (user_id, status, requested_at) VALUES
      (gen_random_uuid(), 'completed', now() - interval '29 days'),
      (gen_random_uuid(), 'pending', now() - interval '29 days'),
      (gen_random_uuid(), 'completed', now() - interval '1 day')`);
    expect(await pruneCompletedDeletions(db, new Date(Date.now() - 30 * 86400_000))).toBe(0);
    expect(await pruneCompletedDeletions(db, new Date(Date.now() - 28 * 86400_000))).toBe(1);
    expect((await db.query('SELECT id FROM deletion_jobs')).length).toBe(2);
  });
});
