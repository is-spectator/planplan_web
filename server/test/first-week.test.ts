import { describe, expect, it } from 'vitest';
import { FakeLlm } from '../src/ai/llm.js';
import { sanitizeTurn, type TurnWrite } from '../src/ai/turn.js';
import { Chat, type Card } from '../src/services/chat.js';
import { studyView } from '../src/services/views.js';
import { undo } from '../src/services/engine.js';
import { setup } from './helpers.js';
import { CASES } from '../evals/cases.js';
import { FIRST_WEEK_EXPECTATIONS, judgeFirstWeek } from '../evals/first-week-expectations.js';
import { makeFixture } from '../evals/fixtures.js';
import { runCase } from '../evals/runner.js';

const SAT = new Date('2026-10-31T10:00:00+08:00');
const MON = new Date('2026-11-02T10:00:00+08:00');
const w = (f: Partial<TurnWrite> = {}): TurnWrite => ({ op: 'create_study', is_fact: true, amount_text: null, currency: 'CNY', duration_value: null, duration_unit: null, category: null, date_kind: 'today', days_ago: null, date: null, note: null, plan_id: null, plan_name: null, activity: '阅读', days_per_week: 4, min_minutes: 20, scope: 'unspecified', record_id: null, component: null, ...f });
let seq = 0;
const send = (chat: Chat, userId: string, text = '本周读书4天，每天20分钟', extra: Partial<Parameters<Chat['send']>[1]> = {}) => chat.send(userId, { clientMsgId: `first-${++seq}`, text, inputAt: SAT, ...extra });
function clarify(cards: Card[]) {
  const c = cards.find((c) => c.type === 'clarify');
  if (!c || c.type !== 'clarify') throw new Error('expected clarification');
  return c;
}
function receipt(cards: Card[]) {
  const c = cards.find((c) => c.type === 'receipt');
  if (!c || c.type !== 'receipt') throw new Error('expected receipt');
  return c;
}
async function noPlans(c: Awaited<ReturnType<typeof setup>>) { expect((await c.db.query<{ n: number }>('SELECT count(*)::int n FROM plans'))[0]!.n).toBe(0); }
const choose = (chat: Chat, userId: string, c: ReturnType<typeof clarify>, label: string, extra: Partial<Parameters<Chat['send']>[1]> = {}) => send(chat, userId, label, { inputAt: MON, pendingId: c.pendingId, choice: c.options.find((o) => o.label === label)!.id, ...extra });

describe('首周目标需由用户决定', () => {
  it('普通每周4天仍按固定首周2天计算，周日不缩成1天', async () => {
    const c = await setup();
    const chat = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [w({ goal_period: 'weekly' })] })));
    const r = await send(chat, c.userId, '每周读书4天，每天20分钟');
    const item = receipt(r.assistant.cards).items[0]!;
    expect(item).toMatchObject({ type: 'plan_created', firstWeekTarget: 2, daysPerWeek: 4 });
    if (item.type !== 'plan_created') throw new Error('wrong item');
    expect((await studyView(c.db, c.userId, item.plan.id, '2026-10-26', '2026-11-01')).stats.targetDays).toBe(2);
    expect((await studyView(c.db, c.userId, item.plan.id, '2026-11-02', '2026-11-02')).stats.targetDays).toBe(4);
  });
  it('原文兜底识别本周，不接受模型错误的next scope或确认标志', async () => {
    const c = await setup();
    const turn = sanitizeTurn({ intent: 'write', writes: [{ ...w({ scope: 'next_and_future' }), first_week_confirmed: true, startNextWeek: true }] })!;
    expect(turn.writes[0]).not.toHaveProperty('first_week_confirmed');
    const r = await send(new Chat(c.db, new FakeLlm(() => turn)), c.userId);
    const cl = clarify(r.assistant.cards);
    expect(cl.question).toContain('2026-10-31 到 2026-11-01');
    expect(cl.question).toContain('可用 2 天');
    expect(cl.options.map((o) => o.label)).toEqual(['本周按 2 天', '从下周开始', '取消']);
    await noPlans(c);
  });
  it('周一确认仍保留周六输入日期；重复选择/重放只保存一次，撤销整批', async () => {
    const c = await setup();
    const chat = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [w({ goal_period: 'this_week' }), w({ op: 'add_study', days_per_week: null, min_minutes: null, duration_value: 25, duration_unit: 'minute' })] })));
    const cl = clarify((await send(chat, c.userId)).assistant.cards);
    await noPlans(c);
    const r = await choose(chat, c.userId, cl, '本周按 2 天', { clientMsgId: 'chosen' });
    const rec = receipt(r.assistant.cards);
    expect(rec.items).toHaveLength(2);
    expect(rec.items[0]).toMatchObject({ type: 'plan_created', plan: { startDate: '2026-10-31' }, firstWeekTarget: 2, daysPerWeek: 4 });
    expect(rec.items[1]).toMatchObject({ type: 'study_added', record: { date: '2026-10-31', minutes: 25 } });
    const replay = await choose(chat, c.userId, cl, '本周按 2 天', { clientMsgId: 'chosen' });
    expect(receipt(replay.assistant.cards).operationId).toBe(rec.operationId);
    expect((await choose(chat, c.userId, cl, '本周按 2 天')).assistant.cards).toEqual([]);
    expect((await c.db.query<{ n: number }>('SELECT count(*)::int n FROM records WHERE NOT deleted'))[0]!.n).toBe(1);
    await undo(c.db, c.at('2026-11-02T10:00:00+08:00'), rec.operationId, 'undo-created');
    await noPlans(c);
  });
  it('选择下周开始：本周仅历史记录，周一目标4天且生效日期不随确认日后移', async () => {
    const c = await setup();
    const chat = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [w({ goal_period: 'this_week' }), w({ op: 'add_study', days_per_week: null, min_minutes: null, duration_value: 25, duration_unit: 'minute' })] })));
    const cl = clarify((await send(chat, c.userId)).assistant.cards);
    const r = await choose(chat, c.userId, cl, '从下周开始');
    const item = receipt(r.assistant.cards).items[0]!;
    expect(item).toMatchObject({ type: 'plan_created', plan: { startDate: '2026-11-02' }, firstWeekTarget: 4, goalStartsOn: '2026-11-02' });
    expect(r.assistant.text).toContain('本周只记录时长，不评价达标');
    if (item.type !== 'plan_created') throw new Error('wrong item');
    const current = await studyView(c.db, c.userId, item.plan.id, '2026-10-26', '2026-11-01');
    expect(current.stats).toMatchObject({ targetDays: null, metDays: null, goalComplete: false, totalMinutes: 25, recordDays: 1 });
    expect((await studyView(c.db, c.userId, item.plan.id, '2026-11-02', '2026-11-02')).stats).toMatchObject({ targetDays: 4, metDays: 0, goalComplete: true });
  });
  it.each(['answer_pending', 'write'] as const)('模型 %s 改写目标不能冒充用户选择；直接输入完整选项可确认', async (intent) => {
    const c = await setup();
    let calls = 0;
    const chat = new Chat(c.db, new FakeLlm(() => { calls++; return { intent: calls === 1 ? 'write' : intent, writes: [w({ days_per_week: calls === 1 ? 4 : 2, goal_period: calls === 1 ? 'this_week' : 'weekly' })] }; }));
    const first = clarify((await send(chat, c.userId)).assistant.cards);
    const second = clarify((await send(chat, c.userId, '好的')).assistant.cards);
    expect(second.pendingId).toBe(first.pendingId);
    await noPlans(c);
    const r = await send(chat, c.userId, '本周按 2 天', { inputAt: MON });
    expect(receipt(r.assistant.cards).items[0]).toMatchObject({ daysPerWeek: 4, firstWeekTarget: 2 });
    expect(calls).toBe(2);
  });
  it('先补同批金额时，模型不得顺便缩减首周目标；两轮仍以原周六为准', async () => {
    const c = await setup();
    await c.run(SAT.toISOString(), { type: 'create_ledger' });
    let calls = 0;
    const chat = new Chat(c.db, new FakeLlm(() => {
      calls++;
      return { intent: calls === 1 ? 'write' : 'answer_pending', writes: [
        w({ op: 'add_expense', activity: null, days_per_week: null, min_minutes: null, amount_text: calls === 1 ? null : '20', category: '餐饮' }),
        w({ days_per_week: calls === 1 ? 4 : 2, goal_period: calls === 1 ? 'this_week' : 'weekly' }),
      ] };
    }));
    const first = clarify((await send(chat, c.userId, '午饭花了钱，本周读书4天，每天20分钟')).assistant.cards);
    expect(first.question).not.toContain('首周');
    const next = clarify((await send(chat, c.userId, '午饭20元', { inputAt: MON })).assistant.cards);
    expect(next.question).toContain('2026-10-31 到 2026-11-01');
    expect(next.question).toContain('本周完成 4 天');
    expect((await c.db.query<{ n: number }>('SELECT count(*)::int n FROM records'))[0]!.n).toBe(0);
    const saved = receipt((await choose(chat, c.userId, next, '本周按 2 天')).assistant.cards);
    expect(saved.items).toHaveLength(2);
    expect(saved.items[0]).toMatchObject({ type: 'plan_created', daysPerWeek: 4, firstWeekTarget: 2 });
    expect(saved.items[1]).toMatchObject({ type: 'expense_added', record: { date: '2026-10-31', amountCents: 2000 } });
  });
  it('取消整批不保存', async () => {
    const c = await setup();
    const chat = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [w({ goal_period: 'this_week' })] })));
    const cl = clarify((await send(chat, c.userId)).assistant.cards);
    await choose(chat, c.userId, cl, '取消');
    await noPlans(c);
    expect((await c.db.query<{ status: string }>('SELECT status FROM pending_actions'))[0]!.status).toBe('cancelled');
  });
  it.each(['current_only', 'current_and_future', 'next_and_future'] as const)('已有首周目标模型scope=%s时，用户选择本周2天只改本周且可撤销', async scope => {
    const c = await setup();
    const p = (await c.run(SAT.toISOString(), { type: 'create_study', activity: '阅读', daysPerWeek: 3, minMinutes: 20 })).items[0]!;
    if (p.type !== 'plan_created') throw new Error('wrong item');
    const chat = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [w({ op: 'set_study_goal', plan_id: p.plan.id, days_per_week: 5, min_minutes: null, scope, goal_period: 'this_week' })] })));
    const cl = clarify((await send(chat, c.userId, '本周改5天', { inputAt: new Date('2026-11-01T10:00:00+08:00') })).assistant.cards);
    expect(cl.question).toContain('可用 2 天');
    const r = await choose(chat, c.userId, cl, '本周按 2 天');
    const rec = receipt(r.assistant.cards);
    expect(rec.items[0]).toMatchObject({ type: 'goal_set', value: 2, scope: 'current_only', effectiveFrom: '2026-10-26' });
    expect((await studyView(c.db, c.userId, p.plan.id, '2026-11-02', '2026-11-02')).stats.daysPerWeek).toBe(3);
    await undo(c.db, c.at('2026-11-02T10:00:00+08:00'), rec.operationId, 'undo-goal');
    expect((await studyView(c.db, c.userId, p.plan.id, '2026-10-26', '2026-11-01')).stats.daysPerWeek).toBe(3);
  });
  it('已有计划从下周调整，当前目标和门槛均保留', async () => {
    const c = await setup();
    const p = (await c.run(SAT.toISOString(), { type: 'create_study', activity: '阅读', daysPerWeek: 3, minMinutes: 20 })).items[0]!;
    if (p.type !== 'plan_created') throw new Error('wrong item');
    const chat = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [w({ op: 'set_study_goal', plan_id: p.plan.id, days_per_week: 5, min_minutes: 30, scope: 'current_only', goal_period: 'this_week' })] })));
    const cl = clarify((await send(chat, c.userId)).assistant.cards);
    await choose(chat, c.userId, cl, '从下周开始');
    expect((await studyView(c.db, c.userId, p.plan.id, '2026-10-26', '2026-11-01')).stats).toMatchObject({ daysPerWeek: 3, minMinutes: 20, targetDays: 2 });
    expect((await studyView(c.db, c.userId, p.plan.id, '2026-11-02', '2026-11-02')).stats).toMatchObject({ daysPerWeek: 5, minMinutes: 30, targetDays: 5 });
  });
  it('下周开始前修改目标，不提前激活本周；更新可撤销，未开始周不能设仅本周目标', async () => {
    const c = await setup();
    const p = (await c.run(SAT.toISOString(), { type: 'create_study', activity: '阅读', daysPerWeek: 4, minMinutes: 20, startNextWeek: true })).items[0]!;
    if (p.type !== 'plan_created') throw new Error('wrong item');
    const change = await c.run(SAT.toISOString(), { type: 'set_goal', planId: p.plan.id, param: 'min_minutes', value: 30, scope: 'current_and_future' });
    expect(change.items[0]).toMatchObject({ type: 'goal_set', scope: 'next_and_future', effectiveFrom: '2026-11-02' });
    expect((await studyView(c.db, c.userId, p.plan.id, '2026-10-26', '2026-11-01')).stats).toMatchObject({ goalComplete: false, metDays: null, targetDays: null });
    expect((await studyView(c.db, c.userId, p.plan.id, '2026-11-02', '2026-11-02')).stats.minMinutes).toBe(30);
    await undo(c.db, c.at(SAT.toISOString()), change.operationId, 'undo-future-goal');
    expect((await studyView(c.db, c.userId, p.plan.id, '2026-11-02', '2026-11-02')).stats.minMinutes).toBe(20);
    await expect(c.run(SAT.toISOString(), { type: 'set_goal', planId: p.plan.id, param: 'days_per_week', value: 2, scope: 'current_only' })).rejects.toMatchObject({ code: 'invalid_input' });
  });
  it('普通首周更新仍使用原始可用天数；超过首周的常规周不提示', async () => {
    const c = await setup();
    const p = (await c.run(SAT.toISOString(), { type: 'create_study', activity: '阅读', daysPerWeek: 3, minMinutes: 20 })).items[0]!;
    if (p.type !== 'plan_created') throw new Error('wrong item');
    const chat = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [w({ op: 'set_study_goal', plan_id: p.plan.id, days_per_week: 5, goal_period: 'weekly' })] })));
    const r = await send(chat, c.userId, '每周改5天', { inputAt: new Date('2026-11-01T10:00:00+08:00') });
    expect(receipt(r.assistant.cards).items[0]).toMatchObject({ type: 'goal_set' });
    expect((await studyView(c.db, c.userId, p.plan.id, '2026-10-26', '2026-11-01')).stats.targetDays).toBe(2);
    expect(receipt((await send(chat, c.userId, '本周5天', { inputAt: MON })).assistant.cards).items[0]).toMatchObject({ type: 'goal_set' });
  });
});

// 真正走 Chat -> engine -> 数据库，再由固定期望检查，不用模型结果生成期望。

describe('首周独立评测', () => {
  it('每个首周场景都有完整步骤的独立期望', () => {
    const cases = CASES.filter((c) => c.id.startsWith('W'));
    expect(Object.keys(FIRST_WEEK_EXPECTATIONS).sort()).toEqual(cases.map((c) => c.id).sort());
    for (const c of cases) expect(FIRST_WEEK_EXPECTATIONS[c.id]).toHaveLength(1 + (c.followUps?.length ?? 0));
  });
  it.each(CASES.filter((c) => c.id.startsWith('W')))('$id $text', async (c) => {
    const result = await runCase(c, 0, new FakeLlm(() => ({ intent: 'write', writes: [w({
      op: c.id === 'W006' ? 'set_study_goal' : 'create_study',
      days_per_week: c.id === 'W006' ? 5 : c.id === 'W004' || c.id === 'W005' ? 2 : 4,
      min_minutes: c.id === 'W006' ? null : 20,
      scope: c.id === 'W006' ? 'current_only' : 'unspecified',
      goal_period: c.id === 'W001' ? 'weekly' : 'this_week',
    })] })));
    expect(result.reason).toBe('');
    expect(result.pass).toBe(true);
  });
  it('假追问、错误日期和虚假可用天数不能通过独立期望', async () => {
    const fx = await makeFixture('empty');
    try {
      const chat = new Chat(fx.db, new FakeLlm(() => ({ intent: 'write', writes: [w({ goal_period: 'this_week' })] })));
      const cl = clarify((await send(chat, fx.userId)).assistant.cards);
      expect((await judgeFirstWeek('W002', 0, fx, [cl])).pass).toBe(true);
      expect((await judgeFirstWeek('W002', 0, fx, [])).pass).toBe(false);
      expect((await judgeFirstWeek('W002', 0, fx, [{ ...cl, question: cl.question.replace('2026-10-31', '2026-10-30') }])).pass).toBe(false);
      expect((await judgeFirstWeek('W002', 0, fx, [{ ...cl, question: cl.question.replace('可用 2 天', '可用 4 天') }])).pass).toBe(false);
      expect((await judgeFirstWeek('W002', 0, fx, [{ ...cl, options: cl.options.slice(1) }])).pass).toBe(false);
    } finally { await fx.db.close(); }
  });
});
