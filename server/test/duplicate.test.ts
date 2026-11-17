import { describe, expect, it } from 'vitest';
import { FakeLlm } from '../src/ai/llm.js';
import type { TurnWrite } from '../src/ai/turn.js';
import { Chat, type Card, type ChatInput } from '../src/services/chat.js';
import { execute, undo } from '../src/services/engine.js';
import { setup } from './helpers.js';
import { CASES } from '../evals/cases.js';
import { runCase } from '../evals/runner.js';

const AT = new Date('2026-10-26T12:41:00+08:00');
const w = (fields: Partial<TurnWrite> = {}): TurnWrite => ({ op: 'add_expense', is_fact: true, amount_text: '20', currency: 'CNY', category: '餐饮', date_kind: 'today', note: '午饭', duration_value: null, duration_unit: null, days_ago: null, date: null, plan_id: null, plan_name: null, activity: null, days_per_week: null, min_minutes: null, scope: 'unspecified', record_id: null, component: null, ...fields });
let n = 0;
const input = (text = '午饭20元', extra: Partial<ChatInput> = {}): ChatInput => ({ clientMsgId: `duplicate-${++n}`, text, inputAt: AT, ...extra });
const clarify = (cards: Card[]) => cards.find((c) => c.type === 'clarify')!;
const receipt = (cards: Card[]) => cards.find((c) => c.type === 'receipt');
async function ledger() {
  const c = await setup();
  await c.run(AT.toISOString(), { type: 'create_ledger' });
  return c;
}
const count = async (c: Awaited<ReturnType<typeof setup>>) => (await c.db.query<{ n: number }>('SELECT count(*)::int n FROM records WHERE user_id=$1 AND NOT deleted', [c.userId]))[0]!.n;
async function choose(chat: Chat, userId: string, cl: Extract<Card, { type: 'clarify' }>, label = '又发生了一次，仍要保存', extra: Partial<ChatInput> = {}) {
  return chat.send(userId, input(label, { pendingId: cl.pendingId, choice: cl.options.find((o) => o.label === label)!.id, ...extra }));
}

describe('短时疑似重复仍可经明确选择保存', () => {
  it('技术重放返回同一回执；主动重发先确认，确认仍保存且可单独撤销', async () => {
    const c = await ledger();
    const chat = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [w()] })));
    const firstInput = input();
    const first = await chat.send(c.userId, firstInput);
    const replay = await chat.send(c.userId, firstInput);
    expect(replay.assistant.id).toBe(first.assistant.id);
    const secondInput = input();
    const second = await chat.send(c.userId, secondInput);
    const cl = clarify(second.assistant.cards);
    expect(cl.items[0]?.issue).toBe('疑似重复记录');
    expect(cl.options.map((o) => o.label)).toEqual(['又发生了一次，仍要保存', '取消']);
    expect(await count(c)).toBe(1);
    const confirmed = await choose(chat, c.userId, cl);
    expect(receipt(confirmed.assistant.cards)?.items).toHaveLength(1);
    expect(await count(c)).toBe(2);
    await chat.send(c.userId, secondInput);
    await choose(chat, c.userId, cl);
    expect(await count(c)).toBe(2);
    await undo(c.db, c.at(AT.toISOString()), receipt(confirmed.assistant.cards)!.operationId, 'undo-duplicate');
    expect(await count(c)).toBe(1);
  });
  it('取消疑似重复时不影响已保存事实', async () => {
    const c = await ledger();
    const chat = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [w()] })));
    await chat.send(c.userId, input());
    const cl = clarify((await chat.send(c.userId, input())).assistant.cards);
    await choose(chat, c.userId, cl, '取消');
    await choose(chat, c.userId, cl);
    expect(await count(c)).toBe(1);
  });
  it('按钮并发与同一确认技术重放只增加一条', async () => {
    const c = await ledger();
    const chat = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [w()] })));
    await chat.send(c.userId, input());
    const cl = clarify((await chat.send(c.userId, input())).assistant.cards);
    const [a, b] = await Promise.all([choose(chat, c.userId, cl), choose(chat, c.userId, cl)]);
    expect([a, b].filter((r) => receipt(r.assistant.cards))).toHaveLength(1);
    expect(await count(c)).toBe(2);
  });
  it('跨天确认保留原输入时间与原业务日期；直接完整选项不经过模型', async () => {
    const c = await ledger(); let calls = 0;
    const chat = new Chat(c.db, new FakeLlm(() => { calls++; return { intent: 'write', writes: [w()] }; }));
    await chat.send(c.userId, input());
    await chat.send(c.userId, input());
    const r = await chat.send(c.userId, input('又发生了一次，仍要保存', { inputAt: new Date('2026-10-28T10:00:00+08:00') }));
    expect(receipt(r.assistant.cards)).toBeTruthy();
    expect(calls).toBe(2);
    const rows = await c.db.query<{ input_at: Date; occurred_on: string }>('SELECT input_at,occurred_on FROM records WHERE user_id=$1', [c.userId]);
    expect(rows).toHaveLength(2);
    for (const row of rows) { expect(new Date(row.input_at).toISOString()).toBe(AT.toISOString()); expect(row.occurred_on).toBe('2026-10-26'); }
  });
  it.each(['answer_pending', 'write'] as const)('模型 %s 不能替用户确认或改掉待确认金额', async (intent) => {
    const c = await ledger(); let call = 0;
    const chat = new Chat(c.db, new FakeLlm(() => ({ intent: ++call <= 2 ? 'write' : intent, writes: [w({ amount_text: call <= 2 ? '20' : '21' })] })));
    await chat.send(c.userId, input());
    const cl = clarify((await chat.send(c.userId, input())).assistant.cards);
    const attempt = await chat.send(c.userId, input(intent === 'answer_pending' ? '上面那笔确实又发生了' : '再记一次'));
    expect(clarify(attempt.assistant.cards).pendingId).toBe(cl.pendingId);
    expect(await count(c)).toBe(1);
    const confirmed = await choose(chat, c.userId, cl);
    expect(receipt(confirmed.assistant.cards)?.items[0]).toMatchObject({ record: { amountCents: 2000 } });
  });
  it('待核对时可以保存无关的新事实，原待核对内容不会自动获准', async () => {
    const c = await ledger();
    const chat = new Chat(c.db, new FakeLlm((text) => ({ intent: 'write', writes: [w(text === '地铁6元' ? { amount_text: '6', category: '交通', note: '地铁' } : {})] })));
    await chat.send(c.userId, input());
    const cl = clarify((await chat.send(c.userId, input())).assistant.cards);
    expect(receipt((await chat.send(c.userId, input('地铁6元'))).assistant.cards)?.items[0]).toMatchObject({ record: { amountCents: 600 } });
    expect(await count(c)).toBe(2);
    await choose(chat, c.userId, cl);
    expect(await count(c)).toBe(3);
  });
  it('一批中有疑似重复整批待保存；可只保存其余事实', async () => {
    const c = await ledger();
    await c.run(AT.toISOString(), { type: 'add_expense', amountCents: 2000, category: '餐饮', date: '2026-10-26', note: '午饭' });
    const chat = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [w(), w({ amount_text: '6', category: '交通', note: '地铁' })] })));
    const cl = clarify((await chat.send(c.userId, input('午饭20元，地铁6元'))).assistant.cards);
    expect(cl.items.map((i) => i.ready)).toEqual([false, true]);
    expect(await count(c)).toBe(1);
    const r = await choose(chat, c.userId, cl, '只保存其余 1 条');
    expect(receipt(r.assistant.cards)?.items).toHaveLength(1);
    expect(receipt(r.assistant.cards)?.items[0]).toMatchObject({ record: { amountCents: 600 } });
    expect(await count(c)).toBe(2);
  });
  it('批次确认后一起保存，确认批准不会丢失于JSONB字段排序', async () => {
    const c = await ledger();
    await c.run(AT.toISOString(), { type: 'add_expense', amountCents: 2000, category: '餐饮', date: '2026-10-26', note: '午饭' });
    const chat = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [w(), w({ amount_text: '6', category: '交通', note: '地铁' })] })));
    const cl = clarify((await chat.send(c.userId, input())).assistant.cards);
    const r = await choose(chat, c.userId, cl);
    expect(receipt(r.assistant.cards)?.items).toHaveLength(2);
    expect(await count(c)).toBe(3);
  });
  it.each([120_001, -120_001])('超出输入时间窗口 %i 毫秒的相同事实仍直接保存', async (offset) => {
    const c = await ledger();
    await c.run(new Date(AT.getTime() + offset).toISOString(), { type: 'add_expense', amountCents: 2000, category: '餐饮', date: '2026-10-26', note: '午饭' });
    const chat = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [w()] })));
    expect(receipt((await chat.send(c.userId, input())).assistant.cards)).toBeTruthy();
  });
  it('按原输入时间匹配离线上传，而不是按服务器刚写入的时间误报旧事实', async () => {
    const c = await ledger();
    await c.run('2026-10-26T08:00:00+08:00', { type: 'add_expense', amountCents: 2000, category: '餐饮', date: '2026-10-26', note: '午饭' });
    const chat = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [w()] })));
    expect(receipt((await chat.send(c.userId, input())).assistant.cards)).toBeTruthy();
    expect(clarify((await chat.send(c.userId, input('午饭20元', { inputAt: new Date(AT.getTime() + 120_000) }))).assistant.cards)).toBeTruthy();
  });
  it.each([{ category: '娱乐' }, { note: '晚饭' }, { amount_text: '21' }, { date_kind: 'yesterday' }] as Partial<TurnWrite>[])('不同事实不被金额相同误拦：%j', async (change) => {
    const c = await ledger();
    await c.run(AT.toISOString(), { type: 'add_expense', amountCents: 2000, category: '餐饮', date: '2026-10-26', note: '午饭' });
    expect(receipt((await new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [w(change)] }))).send(c.userId, input())).assistant.cards)).toBeTruthy();
  });
  it('其他账户的相同事实和确认选项不泄露、不能使用', async () => {
    const c = await ledger();
    const [other] = await c.db.query<{ id: string }>("INSERT INTO users (dev_name, ai_consent) VALUES ('other',true) RETURNING id");
    const chat = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [w()] })));
    await chat.send(c.userId, input());
    const cl = clarify((await chat.send(c.userId, input())).assistant.cards);
    await execute(c.db, { userId: other!.id, inputAt: AT, source: 'form' }, 'other-ledger', [{ type: 'create_ledger' }]);
    const foreign = await choose(chat, other!.id, cl);
    expect(receipt(foreign.assistant.cards)).toBeUndefined();
    expect(foreign.assistant.text).not.toContain('午饭');
    expect(receipt((await chat.send(other!.id, input())).assistant.cards)).toBeTruthy();
    expect(await count(c)).toBe(1);
  });
  it('撤销后的旧事实不再触发疑似重复', async () => {
    const c = await ledger();
    const old = await c.run(AT.toISOString(), { type: 'add_expense', amountCents: 2000, category: '餐饮', date: '2026-10-26', note: '午饭' });
    await undo(c.db, c.at(AT.toISOString()), old.operationId, 'undo-old');
    expect(receipt((await new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [w()] }))).send(c.userId, input())).assistant.cards)).toBeTruthy();
  });
  it('学习必须同计划同分钟；退款必须同一原支出', async () => {
    const c = await ledger();
    const p = (await c.run(AT.toISOString(), { type: 'create_study', activity: '阅读' })).items[0]!;
    if (p.type !== 'plan_created') throw new Error('fixture');
    await c.run(AT.toISOString(), { type: 'add_study', planId: p.plan.id, minutes: 30, date: '2026-10-26' });
    const read = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [w({ op: 'add_study', amount_text: null, category: null, note: null, duration_value: 30, duration_unit: 'minute', plan_id: p.plan.id })] })));
    const cl = clarify((await read.send(c.userId, input('阅读30分钟'))).assistant.cards);
    expect(receipt((await choose(read, c.userId, cl)).assistant.cards)?.items[0]).toMatchObject({ type: 'study_added' });
    const ex = (await c.run(AT.toISOString(), { type: 'add_expense', amountCents: 10000, category: '购物', date: '2026-10-26', note: '耳机' })).items[0]!;
    if (ex.type !== 'expense_added') throw new Error('fixture');
    await c.run(AT.toISOString(), { type: 'add_refund', expenseId: ex.record.id, amountCents: 2000, date: '2026-10-26' });
    const refund = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [w({ op: 'add_refund', note: null, record_id: ex.record.id })] })));
    const rc = clarify((await refund.send(c.userId, input('耳机退款20元'))).assistant.cards);
    expect(receipt((await choose(refund, c.userId, rc)).assistant.cards)?.items[0]).toMatchObject({ type: 'refund_added' });
  });
});

// These cases run real Chat + database using scripted extraction; paid-model review remains external.
describe('疑似重复多轮评测', () => {
  it.each(CASES.filter((c) => c.id.startsWith('D')))('$id', async (c) => {
    const result = await runCase(c, 0, new FakeLlm(() => ({ intent: 'write', writes: [w(c.id === 'D004' ? { op: 'add_study', amount_text: null, category: null, note: null, duration_value: 25, duration_unit: 'minute', activity: '阅读' } : {})] })));
    expect(result.pass, result.reason).toBe(true);
    expect(result.wrongFactWrites).toBe(0);
  });
});
