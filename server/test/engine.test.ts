import { describe, expect, it } from 'vitest';
import { execute, undo } from '../src/services/engine.js';
import { ledgerView, studyView, planCards } from '../src/services/views.js';
import { opId, setup } from './helpers.js';

const T = '2026-10-26T12:41:00+08:00';

async function ledgerWith1270(c: Awaited<ReturnType<typeof setup>>) {
  const r = await c.run('2026-10-05T12:00:00+08:00', { type: 'create_ledger', budgetCents: 300000 });
  const planId = (r.items[0] as { plan: { id: string } }).plan.id;
  await c.run('2026-10-05T12:00:00+08:00', { type: 'add_expense', amountCents: 127000, category: '其他', date: '2026-10-05' });
  return planId;
}

describe('记账', () => {
  it('AC01/AC02 只有一个账本', async () => {
    const c = await setup();
    const r = await c.run(T, { type: 'create_ledger' });
    expect(r.items[0]).toMatchObject({ type: 'plan_created', budgetCents: null });
    await expect(c.run(T, { type: 'create_ledger' })).rejects.toMatchObject({ code: 'ledger_exists' });
  });

  it('AC03-AC05 记录、修改保留同一 ID、撤销恢复', async () => {
    const c = await setup();
    const planId = await ledgerWith1270(c);
    const add = await c.run(T, { type: 'add_expense', amountCents: 2000, category: '餐饮', date: '2026-10-26', note: '午饭' });
    const item = add.items[0] as { record: { id: string; version: number }; ledger: { netCents: number; remainingCents: number; usagePct: number } };
    expect([item.ledger.netCents, item.ledger.remainingCents, item.ledger.usagePct]).toEqual([129000, 171000, 43]);

    const edit = await c.run(T, { type: 'edit_record', recordId: item.record.id, patch: { amountCents: 2500 } });
    const e = edit.items[0] as { record: { id: string; version: number }; ledger: { netCents: number; remainingCents: number } };
    expect(e.record.id).toBe(item.record.id);
    expect(e.record.version).toBe(2);
    expect([e.ledger.netCents, e.ledger.remainingCents]).toEqual([129500, 170500]);

    const u = await undo(c.db, c.at(T), edit.operationId, opId());
    expect((u.items[0] as { ledger: { netCents: number } }).ledger.netCents).toBe(129000);
    const view = await ledgerView(c.db, c.userId, planId, '2026-10');
    expect(view.records.filter((r) => r.kind === 'expense').length).toBe(2);
    expect(view.records.find((r) => r.id === item.record.id)?.amountCents).toBe(2000);
  });

  it('AC13 技术重试返回原结果，不重复落账；AC14 用户再发一次是新事实', async () => {
    const c = await setup();
    await c.run(T, { type: 'create_ledger' });
    const id = opId();
    const a = { type: 'add_expense' as const, amountCents: 2000, category: '餐饮' as const, date: '2026-10-26' };
    const r1 = await execute(c.db, c.at(T), id, [a]);
    const r2 = await execute(c.db, c.at(T), id, [a]);
    expect(r2.operationId).toBe(r1.operationId);
    expect(r2.replayed).toBe(true);
    await execute(c.db, c.at(T), opId(), [a]);
    const [n] = await c.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM records WHERE kind = 'expense'`);
    expect(n!.n).toBe(2);
  });

  it('AC16 整批里任一条失败则全部不保存', async () => {
    const c = await setup();
    await c.run(T, { type: 'create_ledger' });
    await expect(
      c.run(T, { type: 'add_expense', amountCents: 2000, category: '餐饮', date: '2026-10-26' }, { type: 'add_study', planId: '00000000-0000-0000-0000-000000000000', minutes: 30, date: '2026-10-26' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const [n] = await c.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM records`);
    expect(n!.n).toBe(0);
  });

  it('不接受未来日期的已发生事实', async () => {
    const c = await setup();
    await c.run(T, { type: 'create_ledger' });
    await expect(c.run(T, { type: 'add_expense', amountCents: 2000, category: '餐饮', date: '2026-10-27' })).rejects.toMatchObject({ code: 'future_date' });
  });

  it('AC07-AC10、AC43 退款规则与整组删除撤销', async () => {
    const c = await setup();
    const p = await c.run('2026-10-30T10:00:00+08:00', { type: 'create_ledger' });
    const planId = (p.items[0] as { plan: { id: string } }).plan.id;
    const e = await c.run('2026-10-30T10:00:00+08:00', { type: 'add_expense', amountCents: 20000, category: '购物', date: '2026-10-30' });
    const expId = (e.items[0] as { record: { id: string } }).record.id;
    const N = '2026-11-02T10:00:00+08:00';
    await c.run(N, { type: 'set_goal', planId, param: 'budget_cents', value: 100000, scope: 'current_and_future' });
    await c.run(N, { type: 'add_refund', expenseId: expId, amountCents: 5000, date: '2026-11-02' });
    const nov = await ledgerView(c.db, c.userId, planId, '2026-11');
    expect([nov.stats.netCents, nov.stats.remainingCents]).toEqual([-5000, 105000]);
    expect((await ledgerView(c.db, c.userId, planId, '2026-10')).stats.netCents).toBe(20000);

    await expect(c.run(N, { type: 'add_refund', expenseId: expId, amountCents: 16000, date: '2026-11-02' })).rejects.toMatchObject({ code: 'refund_exceeds_expense' });
    await expect(c.run(N, { type: 'edit_record', recordId: expId, patch: { amountCents: 4000 } })).rejects.toMatchObject({ code: 'expense_below_refunds' });
    await expect(c.run('2026-11-06T10:00:00+08:00', { type: 'edit_record', recordId: expId, patch: { date: '2026-11-05' } })).rejects.toMatchObject({ code: 'refund_before_expense' });

    await expect(c.run(N, { type: 'delete_record', recordId: expId })).rejects.toMatchObject({ code: 'has_refunds' });
    const { recordWithRefundSnapshot } = await import('../src/services/refund-snapshot.js');
    const snapshot = (await recordWithRefundSnapshot(c.db, c.userId, expId)).refundSnapshot!;
    const del = await c.run(N, { type: 'delete_record', recordId: expId, includeRefunds: true, expectedRefundSnapshot: snapshot.token });
    expect((del.items[0] as { records: unknown[] }).records.length).toBe(2);
    expect((await ledgerView(c.db, c.userId, planId, '2026-11')).stats.netCents).toBe(0);
    await undo(c.db, c.at(N), del.operationId, opId());
    expect((await ledgerView(c.db, c.userId, planId, '2026-11')).stats.netCents).toBe(-5000);
  });

  it('撤销遇到后续修改时拒绝覆盖', async () => {
    const c = await setup();
    await c.run(T, { type: 'create_ledger' });
    const add = await c.run(T, { type: 'add_expense', amountCents: 2000, category: '餐饮', date: '2026-10-26' });
    const id = (add.items[0] as { record: { id: string } }).record.id;
    await c.run(T, { type: 'edit_record', recordId: id, patch: { amountCents: 3000 } });
    await expect(undo(c.db, c.at(T), add.operationId, opId())).rejects.toMatchObject({ code: 'undo_conflict' });
  });

  it('AC27/AC42 预算生效范围', async () => {
    const c = await setup();
    const planId = await ledgerWith1270(c);
    await c.run(T, { type: 'set_goal', planId, param: 'budget_cents', value: 350000, scope: 'next_and_future' });
    expect((await ledgerView(c.db, c.userId, planId, '2026-10')).stats.budgetCents).toBe(300000);
    expect((await ledgerView(c.db, c.userId, planId, '2026-11')).stats.budgetCents).toBe(350000);
    const r = await c.run(T, { type: 'set_goal', planId, param: 'budget_cents', value: 280000, scope: 'current_and_future' });
    expect((r.items[0] as { replacedFuture: unknown[] }).replacedFuture).toEqual([{ fromPeriod: '2026-11', value: 350000 }]);
    expect((await ledgerView(c.db, c.userId, planId, '2026-11')).stats.budgetCents).toBe(280000);
  });
});

describe('学习', () => {
  it('AC24 周六创建每周4天，首周目标2天', async () => {
    const c = await setup();
    const r = await c.run('2026-10-31T09:00:00+08:00', { type: 'create_study', activity: '阅读', daysPerWeek: 4, minMinutes: 20 });
    const item = r.items[0] as { plan: { id: string }; firstWeekTarget: number };
    expect(item.firstWeekTarget).toBe(2);
    const sun = await studyView(c.db, c.userId, item.plan.id, '2026-10-26', '2026-11-01');
    expect(sun.stats.targetDays).toBe(2);
    const next = await studyView(c.db, c.userId, item.plan.id, '2026-11-02', '2026-11-02');
    expect(next.stats.targetDays).toBe(4);
  });

  it('AC18/AC19 多时段累计，删除后撤回达标', async () => {
    const c = await setup();
    const p = await c.run('2026-10-19T09:00:00+08:00', { type: 'create_study', activity: '阅读', daysPerWeek: 5, minMinutes: 20 });
    const planId = (p.items[0] as { plan: { id: string } }).plan.id;
    const a = await c.run(T, { type: 'add_study', planId, minutes: 10, date: '2026-10-26' });
    const b = await c.run(T, { type: 'add_study', planId, minutes: 10, date: '2026-10-26' });
    expect((b.items[0] as { study: { dayMinutes: number; dayStatus: string; metDays: number } }).study).toMatchObject({ dayMinutes: 20, dayStatus: 'met', metDays: 1 });
    const del = await c.run(T, { type: 'delete_record', recordId: (a.items[0] as { record: { id: string } }).record.id });
    expect((del.items[0] as { study: { dayStatus: string; metDays: number } }).study).toMatchObject({ dayStatus: 'below', metDays: 0 });
  });

  it('一天最多 1440 分钟', async () => {
    const c = await setup();
    const p = await c.run(T, { type: 'create_study', activity: '阅读' });
    const planId = (p.items[0] as { plan: { id: string } }).plan.id;
    await c.run(T, { type: 'add_study', planId, minutes: 1400, date: '2026-10-26' });
    await expect(c.run(T, { type: 'add_study', planId, minutes: 60, date: '2026-10-26' })).rejects.toMatchObject({ code: 'day_minutes_exceeded' });
  });

  it('AC21 目标不完整时显示待补全；AC26 改门槛后本周重算、上周保留', async () => {
    const c = await setup();
    const p = await c.run('2026-10-19T09:00:00+08:00', { type: 'create_study', activity: '阅读', daysPerWeek: 5 });
    const item = p.items[0] as { plan: { id: string }; goalPending: boolean };
    expect(item.goalPending).toBe(true);
    const planId = item.plan.id;
    await c.run('2026-10-19T20:00:00+08:00', { type: 'add_study', planId, minutes: 25, date: '2026-10-19' });
    let last = await studyView(c.db, c.userId, planId, '2026-10-19', '2026-10-19');
    expect([last.stats.goalComplete, last.stats.metDays]).toEqual([false, null]);

    await c.run('2026-10-20T09:00:00+08:00', { type: 'set_goal', planId, param: 'min_minutes', value: 20, scope: 'current_and_future' });
    last = await studyView(c.db, c.userId, planId, '2026-10-19', '2026-10-20');
    expect(last.stats.metDays).toBe(1);

    await c.run(T, { type: 'add_study', planId, minutes: 25, date: '2026-10-26' });
    await c.run(T, { type: 'set_goal', planId, param: 'min_minutes', value: 30, scope: 'current_and_future' });
    const thisWeek = await studyView(c.db, c.userId, planId, '2026-10-26', '2026-10-26');
    expect([thisWeek.stats.minMinutes, thisWeek.stats.metDays]).toEqual([30, 0]);
    last = await studyView(c.db, c.userId, planId, '2026-10-19', '2026-10-26');
    expect([last.stats.minMinutes, last.stats.metDays]).toEqual([20, 1]);
  });

  it('AC30/AC31 归档后拦截新记录，归档和恢复所在周不判达标', async () => {
    const c = await setup();
    const p = await c.run('2026-10-12T09:00:00+08:00', { type: 'create_study', activity: '阅读', daysPerWeek: 3, minMinutes: 20 });
    const planId = (p.items[0] as { plan: { id: string } }).plan.id;
    await c.run('2026-10-20T09:00:00+08:00', { type: 'add_study', planId, minutes: 30, date: '2026-10-20' });
    await c.run('2026-10-21T09:00:00+08:00', { type: 'archive_plan', planId });
    await expect(c.run('2026-10-22T09:00:00+08:00', { type: 'add_study', planId, minutes: 30, date: '2026-10-22' })).rejects.toMatchObject({ code: 'plan_archived' });
    const v = await studyView(c.db, c.userId, planId, '2026-10-19', '2026-10-22');
    expect([v.stats.interrupted, v.stats.metDays, v.stats.totalMinutes]).toEqual([true, null, 30]);
    const archived = await planCards(c.db, c.userId, '2026-10-22', 'archived');
    expect(archived.plans.length).toBe(1);
    await c.run('2026-10-28T09:00:00+08:00', { type: 'restore_plan', planId });
    expect((await studyView(c.db, c.userId, planId, '2026-10-26', '2026-10-28')).stats.interrupted).toBe(true);
    expect((await studyView(c.db, c.userId, planId, '2026-11-02', '2026-11-02')).stats.interrupted).toBe(false);
  });

  it('AC32 隐藏组件不影响数据，关键组件不能隐藏', async () => {
    const c = await setup();
    const p = await c.run(T, { type: 'create_ledger' });
    const planId = (p.items[0] as { plan: { id: string } }).plan.id;
    const r = await c.run(T, { type: 'set_view', planId, hidden: ['trend', 'records', 'summary'] });
    expect((r.items[0] as { plan: { hidden: string[] } }).plan.hidden).toEqual(['trend']);
  });
});
