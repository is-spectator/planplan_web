import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { FakeLlm } from '../src/ai/llm.js';
import type { TurnWrite } from '../src/ai/turn.js';
import { createApp } from '../src/api/app.js';
import { issueToken } from '../src/api/auth.js';
import { Chat, type Card } from '../src/services/chat.js';
import { execute, type OperationResult } from '../src/services/engine.js';
import { setup } from './helpers.js';

const T = new Date('2026-10-26T12:41:00+08:00');
const write = (patch: Partial<TurnWrite> = {}): TurnWrite => ({
  op: 'add_refund', is_fact: true, amount_text: '199', currency: 'CNY', duration_value: null, duration_unit: null,
  category: null, date_kind: 'today', days_ago: null, date: null, note: '耳机退款199元到账了', plan_id: null,
  plan_name: null, activity: null, days_per_week: null, min_minutes: null, scope: 'unspecified', record_id: null,
  component: null, ...patch,
});
const card = <K extends Card['type']>(cards: Card[], type: K) => cards.find(c => c.type === type) as Extract<Card, { type: K }> | undefined;
const recordId = (result: OperationResult) => {
  const item = result.items[0]!;
  if (!('record' in item)) throw new Error('fixture must create a record');
  return item.record.id;
};
async function fixture(note = '耳机') {
  const c = await setup();
  await c.run('2026-10-01T09:00:00+08:00', { type: 'create_ledger' });
  const expenseId = recordId(await c.run('2026-10-18T20:00:00+08:00', { type: 'add_expense', amountCents: 19900, category: '购物', date: '2026-10-18', note }));
  return { ...c, expenseId };
}
const send = (chat: Chat, userId: string, text = '耳机退款199元到账了', extra: Partial<Parameters<Chat['send']>[1]> = {}) => chat.send(userId, { clientMsgId: randomUUID(), text, inputAt: T, ...extra });

describe('退款关联与保存', () => {
  it.each(['耳机退款', '耳机退款199元到账了', '耳机退款已到账', '耳机退货退款了'])('消费备注附带状态“%s”仍关联唯一原消费，金额和日期独立保存', async note => {
    const c = await fixture();
    const chat = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [write({ note })] })));
    const out = await send(chat, c.userId);
    expect(card(out.assistant.cards, 'receipt')?.items[0]).toMatchObject({ type: 'refund_added', record: { refundOf: c.expenseId, amountCents: 19900, date: '2026-10-26', note: '耳机' } });
    expect(await c.db.query('SELECT refund_of, amount_cents, occurred_on FROM records WHERE kind=\'refund\'')).toEqual([{ refund_of: c.expenseId, amount_cents: 19900, occurred_on: '2026-10-26' }]);
  });

  it('描述未匹配时即使只有一笔候选也必须选择；选择与重放只保存一条', async () => {
    const c = await fixture(); let calls = 0;
    const chat = new Chat(c.db, new FakeLlm(() => { calls++; return { intent: 'write', writes: [write({ note: '蓝牙配件' })] }; }));
    const first = await send(chat, c.userId, '蓝牙配件退款199');
    const clarify = card(first.assistant.cards, 'clarify')!;
    expect(clarify.question).toContain('还不能确定');
    expect(clarify.options.some(option => option.label.includes('耳机'))).toBe(true);
    expect(await c.db.query('SELECT id FROM records WHERE kind=\'refund\'')).toHaveLength(0);
    const choice = clarify.options.find(option => option.label.includes('耳机'))!;
    const input = { clientMsgId: randomUUID(), pendingId: clarify.pendingId, choice: choice.id };
    const saved = await send(chat, c.userId, choice.label, input);
    expect(card(saved.assistant.cards, 'receipt')?.items[0]).toMatchObject({ type: 'refund_added', record: { refundOf: c.expenseId } });
    await send(chat, c.userId, choice.label, input);
    expect(await c.db.query('SELECT id FROM records WHERE kind=\'refund\'')).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it('两个同名原支出不按退款金额或最近一条擅自选择', async () => {
    const c = await fixture();
    const secondId = recordId(await c.run('2026-10-20T20:00:00+08:00', { type: 'add_expense', amountCents: 29900, category: '购物', date: '2026-10-20', note: '耳机' }));
    const chat = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [write()] })));
    const first = await send(chat, c.userId);
    const clarify = card(first.assistant.cards, 'clarify')!;
    expect(clarify.options.filter(option => option.label.includes('耳机'))).toHaveLength(2);
    expect(await c.db.query('SELECT id FROM records WHERE kind=\'refund\'')).toHaveLength(0);
    const choice = clarify.options.find(option => option.label.includes('299'))!;
    const saved = await send(chat, c.userId, choice.label, { pendingId: clarify.pendingId, choice: choice.id });
    expect(card(saved.assistant.cards, 'receipt')?.items[0]).toMatchObject({ type: 'refund_added', record: { refundOf: secondId, amountCents: 19900 } });
  });

  it('搜索符号按备注字面值匹配，不能把百分号当通配符自动关联', async () => {
    const c = await fixture();
    const out = await send(new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [write({ note: '%' })] }))), c.userId, '%退款199');
    expect(card(out.assistant.cards, 'clarify')?.question).toContain('还不能确定');
    expect(await c.db.query('SELECT id FROM records WHERE kind=\'refund\'')).toHaveLength(0);
  });

  it('他人的原记录ID不可关联，候选只包含当前用户的支出且仍须确认', async () => {
    const c = await fixture();
    const [other] = await c.db.query<{ id: string }>('INSERT INTO users(dev_name) VALUES($1) RETURNING id', [`other-${randomUUID()}`]);
    const ctx = { userId: other!.id, inputAt: T, source: 'form' as const };
    await execute(c.db, ctx, randomUUID(), [{ type: 'create_ledger' }]);
    const foreignId = recordId(await execute(c.db, ctx, randomUUID(), [{ type: 'add_expense', amountCents: 19900, category: '购物', date: '2026-10-18', note: '不应显示的私人备注' }]));
    const out = await send(new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [write({ record_id: foreignId, note: '耳机' })] }))), c.userId);
    expect(card(out.assistant.cards, 'clarify')?.question).toContain('还不能确定');
    expect(JSON.stringify(out.assistant)).not.toContain('不应显示的私人备注');
    expect(JSON.stringify(out.assistant)).not.toContain(foreignId);
    expect(await c.db.query('SELECT id FROM records WHERE kind=\'refund\'')).toHaveLength(0);
  });

  it.each([
    ['申请退款还没到账', { is_fact: false }, '还没有到账'],
    ['预计明天退款199', { date_kind: 'future' }, '还没有到账'],
    ['耳机退款199美元到账', { currency: 'other' }, '人民币'],
  ] as const)('%s不会新增退款', async (text, patch, message) => {
    const c = await fixture();
    const out = await send(new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [write({ record_id: c.expenseId, ...patch })] }))), c.userId, text);
    expect(out.assistant.text).toContain(message);
    expect(await c.db.query('SELECT id FROM records WHERE kind=\'refund\'')).toHaveLength(0);
  });

  it('改进匹配不放松退款上限，也不会改写原支出', async () => {
    const c = await fixture();
    const out = await send(new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [write({ amount_text: '200' })] }))), c.userId, '耳机退款200到账');
    expect(card(out.assistant.cards, 'error')).toMatchObject({ code: 'refund_exceeds_expense', message: expect.stringContaining('不能超过') });
    expect(await c.db.query('SELECT kind,amount_cents FROM records')).toEqual([{ kind: 'expense', amount_cents: 19900 }]);
  });

  it('没有原支出仍不新增退款', async () => {
    const c = await setup(); await c.run(T.toISOString(), { type: 'create_ledger' });
    const out = await send(new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [write()] }))), c.userId);
    expect(out.assistant.text).toContain('没有找到对应的原支出');
    expect(await c.db.query('SELECT id FROM records')).toHaveLength(0);
  });

  it('HTTP：退款保存、同消息恢复及计划查询返回同一条关联记录与准确净支出', async () => {
    const c = await fixture();
    const cfg = { jwtSecret: new TextEncoder().encode('refund-test-only-secret-32-bytes-xx'), appleAudience: null, devLogin: false };
    const token = await issueToken(cfg, c.userId, 0);
    const app = createApp(c.db, new FakeLlm(() => ({ intent: 'write', writes: [write()] })), cfg);
    const body = { clientMsgId: randomUUID(), text: '耳机退款199元到账了', inputAt: T.toISOString() };
    const request = () => app.request('/v1/chat', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const response = await request(); expect(response.status).toBe(200);
    const output = await response.json();
    expect(output.assistant.cards.find((c: Card) => c.type === 'receipt').items[0]).toMatchObject({ type: 'refund_added', record: { refundOf: c.expenseId, amountCents: 19900 } });
    expect((await request()).status).toBe(200);
    const [plan] = await c.db.query<{ id: string }>('SELECT id FROM plans');
    const view = await app.request(`/v1/plans/${plan!.id}/ledger?month=2026-10`, { headers: { authorization: `Bearer ${token}` } });
    expect(view.status).toBe(200);
    expect(await view.json()).toMatchObject({ stats: { spendCents: 19900, refundCents: 19900, netCents: 0 } });
    expect(await c.db.query('SELECT id FROM records WHERE kind=\'refund\'')).toHaveLength(1);
  });
});
