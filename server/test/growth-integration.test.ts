import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { openTestDb } from './database.js';
import { opId, setup } from './helpers.js';
import { checkMigrations, migrate, MIGRATIONS } from '../src/db/migrations.js';
import { requestAccountDeletion } from '../src/services/deletion.js';
import { applyDeletionLedger, exportDeletionLedger } from '../src/db/recovery.js';
import { awardForRecord, circleBoard, createCircle, growthView, joinCircle, saveCaption } from '../src/services/growth.js';
import { executeForm } from '../src/services/form-operations.js';
import type { RecordRow } from '../src/services/repo.js';

const time = '2026-10-26T23:59:00+08:00';
const expense = { type: 'add_expense' as const, amountCents: 2000, category: '餐饮' as const, date: '2026-10-26', note: '午饭' };

it('009升级010保留旧迁移校验和和账户，重复迁移不重复建表', async () => {
  const db = await openTestDb({ migrations: 'none' });
  await migrate(db, MIGRATIONS.slice(0, 9));
  const before = await db.query('SELECT version,checksum FROM schema_migrations ORDER BY version');
  const [user] = await db.query<{ id: string }>("INSERT INTO users(dev_name) VALUES('growth-upgrade') RETURNING id");
  await migrate(db); await migrate(db); await checkMigrations(db);
  expect(await db.query('SELECT version,checksum FROM schema_migrations WHERE version<=9 ORDER BY version')).toEqual(before);
  expect(await db.query('SELECT id FROM users')).toEqual([user]);
  expect((await growthView(db, user!.id, '2026-10-26')).total).toBe(0);
  expect(await db.query('SELECT version FROM schema_migrations WHERE version=10')).toHaveLength(1);
});

it('疑似重复未确认不发行动力，跨天确认保留原输入日，原操作重放不多发', async () => {
  const c = await setup();
  await c.run(time, { type: 'create_ledger' });
  await c.run(time, expense);
  const id = opId(), ctx = c.at(time);
  await expect(executeForm(c.db, ctx, id, [expense], { inputAtProvided: true })).rejects.toMatchObject({ code: 'duplicate_confirmation_required' });
  expect((await growthView(c.db, c.userId, '2026-10-26')).total).toBe(1);
  const [pending] = await c.db.query<{ confirmation_id: string }>('SELECT confirmation_id FROM operation_confirmations WHERE client_op_id=$1', [id]);
  // The original timestamp remains in the offline operation; only the nonce is added later.
  const confirmed = await executeForm(c.db, ctx, id, [expense], { inputAtProvided: true, confirmationId: pending!.confirmation_id });
  expect(confirmed).toMatchObject({ clarificationRounds: 1, growth: { earned: 1, total: 2 } });
  const replay = await executeForm(c.db, ctx, id, [expense], { inputAtProvided: true, confirmationId: pending!.confirmation_id });
  expect(replay.growth).toEqual(confirmed.growth);
  expect(replay.operationId).toBe(confirmed.operationId);
  expect((await growthView(c.db, c.userId, '2026-10-27'))).toMatchObject({ total: 2, todayEarned: 0 });
  expect(await c.db.query('SELECT record_id FROM growth_points WHERE earned_on=$1', ['2026-10-26'])).toHaveLength(2);
});

it('整批回滚不留下行动力，并发独立操作仍遵守每日5点且单记录重复发放安全', async () => {
  const c = await setup();
  await c.run(time, { type: 'create_ledger' });
  await expect(c.run(time, expense, { type: 'add_study', planId: randomUUID(), minutes: 10, date: expense.date })).rejects.toMatchObject({ code: 'not_found' });
  expect(await c.db.query('SELECT * FROM growth_points')).toHaveLength(0);
  expect(await c.db.query('SELECT * FROM house_items')).toHaveLength(0);
  await Promise.all(Array.from({ length: 8 }, () => c.run(time, expense)));
  expect((await growthView(c.db, c.userId, expense.date))).toMatchObject({ total: 5, todayEarned: 5 });
  expect(await c.db.query('SELECT * FROM growth_points')).toHaveLength(8);
  const [record] = await c.db.query<RecordRow>('SELECT * FROM records WHERE user_id=$1 LIMIT 1', [c.userId]);
  expect(await c.db.tx(q => awardForRecord(q, record!, '日常记账', expense.date), c.userId)).toEqual({ earned: 0, unlocked: [] });
});

it('删除账户清成长资料但保留其他成员，恢复删除重放清最后空圈及邀请码', async () => {
  const c = await setup();
  await c.run(time, { type: 'create_ledger' }); await c.run(time, expense);
  await saveCaption(c.db, c.userId, '2026-10-26', '我的周记');
  await c.db.tx(q => createCircle(q, c.userId, '私人小组', '我', '2026-10-26'), c.userId);
  const code = (await circleBoard(c.db, c.userId, '2026-10-26'))!.code;
  const [other] = await c.db.query<{ id: string }>("INSERT INTO users(dev_name) VALUES('growth-other') RETURNING id");
  await c.db.tx(q => joinCircle(q, other!.id, code, '朋友', '2026-10-26'), other!.id);
  expect((await requestAccountDeletion(c.db, c.userId)).status).toBe('completed');
  for (const table of ['growth_points', 'house_items', 'weekly_captions', 'circle_members']) {
    expect(await c.db.query(`SELECT * FROM ${table} WHERE user_id=$1`, [c.userId])).toHaveLength(0);
  }
  expect((await circleBoard(c.db, other!.id, '2026-10-26'))!.members.map(m => m.nickname)).toEqual(['朋友']);
  const ledger = await exportDeletionLedger(c.db, 'growth-test-only-ledger-key-at-least-32-bytes');
  ledger.entries.push({ userId: other!.id, requestedAt: new Date().toISOString(), backupDeadline: new Date(Date.now() + 30 * 86400_000).toISOString() });
  await applyDeletionLedger(c.db, ledger);
  expect(await c.db.query('SELECT * FROM circles')).toHaveLength(0);
  expect(await c.db.query('SELECT * FROM circle_members')).toHaveLength(0);
});

it('待清除账户不能重新写入成长资料或加入同行榜', async () => {
  const c = await setup();
  await c.db.query('UPDATE users SET deleted_at=now() WHERE id=$1', [c.userId]);
  await expect(saveCaption(c.db, c.userId, '2026-10-26', '不应保存')).rejects.toMatchObject({ code: '42501' });
  await expect(c.db.tx(q => createCircle(q, c.userId, '不应留下', '我', '2026-10-26'), c.userId)).rejects.toMatchObject({ code: '42501' });
  expect(await c.db.query('SELECT * FROM circles')).toHaveLength(0);
  expect(await c.db.query('SELECT * FROM weekly_captions')).toHaveLength(0);
});
