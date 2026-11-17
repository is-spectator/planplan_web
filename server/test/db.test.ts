import { expect, it } from 'vitest';
import { openTestDb } from './database.js';

it('数据库能迁移并执行事务，失败后不保留部分写入', async () => {
  const db = await openTestDb();
  const [u] = await db.query<{ id: string }>(`INSERT INTO users (dev_name) VALUES ('t') RETURNING id`);
  await expect(
    db.tx(async (q) => {
      await q.query(`INSERT INTO plans (user_id, kind, name, start_date) VALUES ($1, 'ledger', '日常记账', '2026-10-26')`, [u!.id]);
      await q.query(`INSERT INTO plans (user_id, kind, name, start_date) VALUES ($1, 'ledger', '第二个', '2026-10-26')`, [u!.id]);
    }),
  ).rejects.toThrow();
  const rows = await db.query(`SELECT * FROM plans`);
  expect(rows.length).toBe(0);
  await db.close();
});
