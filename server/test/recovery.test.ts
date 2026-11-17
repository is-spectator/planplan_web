import { describe, expect, it } from 'vitest';
import { openTestDb } from './database.js';
import { requestAccountDeletion } from '../src/services/deletion.js';
import { applyDeletionLedger, exportDeletionLedger, verifyDeletionLedger } from '../src/db/recovery.js';

const key = 'test-only-ledger-signing-key-32-bytes';

describe('恢复时重放独立删除清单', () => {
  it('旧备份中的用户被新清单清除，重复重放安全且保留其他用户', async () => {
    const db = await openTestDb();
    const [deleted] = await db.query<{ id: string }>(`INSERT INTO users (dev_name) VALUES ('deleted') RETURNING id`);
    const [kept] = await db.query<{ id: string }>(`INSERT INTO users (dev_name) VALUES ('kept') RETURNING id`);
    const cutoff = new Date();
    await requestAccountDeletion(db, deleted!.id);
    const ledger = verifyDeletionLedger(await exportDeletionLedger(db, key), key, cutoff);
    // 模拟恢复删除请求之前的备份：旧用户复活、备份内尚无此删除请求。
    await db.query('DELETE FROM deletion_jobs');
    await db.query(`INSERT INTO users (id, dev_name) VALUES ($1, 'deleted')`, [deleted!.id]);
    expect(await applyDeletionLedger(db, ledger)).toBe(1);
    expect(await applyDeletionLedger(db, ledger)).toBe(0);
    expect(await db.query('SELECT id FROM users')).toEqual([{ id: kept!.id }]);
    expect((await db.query<{ status: string }>('SELECT status FROM deletion_jobs'))[0]!.status).toBe('completed');
  });

  it('过期水位、签名篡改、遗漏备份已有清除任务都拒绝恢复', async () => {
    const db = await openTestDb();
    const empty = await exportDeletionLedger(db, key);
    expect(() => verifyDeletionLedger(empty, key, new Date(Date.parse(empty.generatedAt) + 1))).toThrow('does not cover');
    expect(() => verifyDeletionLedger({ ...empty, signature: '00'.repeat(32) }, key, new Date(0))).toThrow('signature mismatch');
    await db.query('INSERT INTO deletion_jobs (user_id) VALUES (gen_random_uuid())');
    await expect(applyDeletionLedger(db, empty)).rejects.toThrow('omits');
  });
});
