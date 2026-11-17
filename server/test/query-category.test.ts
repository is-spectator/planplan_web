import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/api/app.js';
import { issueToken } from '../src/api/auth.js';
import { FakeLlm } from '../src/ai/llm.js';
import type { TurnQuery } from '../src/ai/turn.js';
import type { ChatReply, MessageView } from '../src/services/chat.js';
import { queryText } from '../src/services/describe.js';
import { runQuery } from '../src/services/query.js';
import { INPUT_AT, TODAY, makeFixture, type Fixture, type FixtureName } from '../evals/fixtures.js';
import { judgeQuery } from '../evals/query-expectations.js';

const opened: Fixture[] = [];
async function fixture(name: FixtureName = 'default') {
  const fx = await makeFixture(name);
  opened.push(fx);
  return fx;
}
afterEach(async () => {
  vi.useRealTimers();
  for (const fx of opened.splice(0)) await fx.db.close();
});

const query = (patch: Partial<TurnQuery> = {}): TurnQuery => ({ kind: 'ledger_summary', plan_id: null, period: 'this_month', from: null, to: null, category: null, keywords: null, compare: null, ...patch });
const failures = [
  { id: 'Q011', text: '本月购物支出多少', category: '购物' as const, cents: 19900, answer: '购物净支出 ¥199' },
  { id: 'Q025', text: '这个月吃饭花了多少', category: '餐饮' as const, cents: 14800, answer: '餐饮净支出 ¥148' },
];

describe('分类条件不因模型选择汇总 kind 而丢失', () => {
  it.each(failures)('$id 汇总分类与分类查询一致，仍满足原独立 oracle', async ({ id, category, cents, answer }) => {
    const fx = await fixture();
    const card = await runQuery(fx.db, fx.userId, query({ category }), TODAY, null);
    expect(card).toEqual(await runQuery(fx.db, fx.userId, query({ kind: 'ledger_category', category }), TODAY, null));
    expect(card).toMatchObject({ kind: 'ledger_month', focus: 'category', category,
      // The existing DTO keeps whole-month totals; category consumers select its line.
      spendCents: 35300, netCents: 35300, budgetCents: 300000, remainingCents: 264700,
      byCategory: expect.arrayContaining([{ category, spendCents: cents, refundCents: 0, netCents: cents }]) });
    expect(judgeQuery(id, fx, [card])).toEqual({ pass: true, reason: '' });
    expect(queryText(card)).toBe(`10 月（10月1日–10月26日）${answer}，基于已记录数据。`);
    expect(queryText(card)).not.toMatch(/353|2,647|预算/);
  });

  it('没有该分类记录时说明空结果，不以整月预算代替', async () => {
    const fx = await fixture();
    const card = await runQuery(fx.db, fx.userId, query({ category: '娱乐' }), TODAY, null);
    expect(card).toMatchObject({ kind: 'ledger_month', focus: 'category', category: '娱乐' });
    expect(queryText(card)).toBe('10 月（10月1日–10月26日）还没有娱乐的记录。');
    expect(judgeQuery('Q026', fx, [card]).pass).toBe(true);
  });

  it('跨月退款按退款日和原支出分类计入，回答保留支出/退款/净额口径', async () => {
    const fx = await fixture('comparison');
    const current = await runQuery(fx.db, fx.userId, query({ category: '购物' }), TODAY, null);
    expect(current).toMatchObject({ focus: 'category', byCategory: expect.arrayContaining([{ category: '购物', spendCents: 19900, refundCents: 3000, netCents: 16900 }]) });
    expect(queryText(current)).toBe('10 月（10月1日–10月26日）购物净支出 ¥169（支出 ¥199，退款 ¥30），基于已记录数据。');
    const previous = await runQuery(fx.db, fx.userId, query({ category: '购物', period: 'last_month' }), TODAY, null);
    expect(queryText(previous)).toBe('9 月（9月1日–9月30日）购物净支出 ¥80（支出 ¥100，退款 ¥20），基于已记录数据。');
  });

  it.each([
    { period: 'today' as const, from: null, to: null, cents: 2000 },
    { period: 'this_week' as const, from: null, to: null, cents: 2000 },
    { period: 'custom' as const, from: '2026-10-20', to: '2026-10-24', cents: 12800 },
  ])('$period 分类区间仍按该范围回答，不变成月汇总', async ({ period, from, to, cents }) => {
    const fx = await fixture();
    const card = await runQuery(fx.db, fx.userId, query({ category: '餐饮', period, from, to }), TODAY, null);
    expect(card).toEqual(await runQuery(fx.db, fx.userId, query({ kind: 'ledger_category', category: '餐饮', period, from, to }), TODAY, null));
    expect(card).toMatchObject({ kind: 'ledger_range', category: '餐饮', byCategory: expect.arrayContaining([{ category: '餐饮', spendCents: cents, refundCents: 0, netCents: cents }]) });
    expect(queryText(card)).toContain(`餐饮净支出 ¥${cents / 100}`);
    expect(queryText(card)).not.toContain('预算');
  });

  it('分类与关键词同时存在时仍求交集，零命中不回退整类或整月', async () => {
    const fx = await fixture();
    const matching = await runQuery(fx.db, fx.userId, query({ category: '购物', keywords: ['耳机'] }), TODAY, null);
    expect(matching).toMatchObject({ kind: 'ledger_range', category: null, keywords: ['耳机'], spendCents: 19900, refundCents: 0, netCents: 19900, count: 1 });
    expect(queryText(matching)).toBe('本月（10月1日–10月26日）「耳机」相关支出 ¥199，共 1 笔。');
    const excluded = await runQuery(fx.db, fx.userId, query({ category: '餐饮', keywords: ['耳机'] }), TODAY, null);
    expect(excluded).toMatchObject({ spendCents: 0, refundCents: 0, netCents: 0, count: 0 });
    expect(queryText(excluded)).toBe('本月（10月1日–10月26日）没有找到备注含「耳机」的支出记录。');
  });

  it('显式预算保持整月语义，分类与关键词均不制造分类预算卡', async () => {
    const fx = await fixture();
    const budget = await runQuery(fx.db, fx.userId, query({ kind: 'budget', category: '购物', keywords: ['耳机'] }), TODAY, null);
    expect(budget).toEqual(await runQuery(fx.db, fx.userId, query({ kind: 'budget' }), TODAY, null));
    expect(budget).toMatchObject({ kind: 'ledger_month', focus: 'budget', category: null, budgetCents: 300000, remainingCents: 264700, netCents: 35300 });
    expect(queryText(budget)).toBe('10 月（10月1日–10月26日）预算还剩 ¥2,647，已记录净支出 ¥353，已用 12%。');
    const previous = await runQuery(fx.db, fx.userId, query({ kind: 'budget', category: '购物', period: 'last_month' }), TODAY, null);
    expect(previous).toMatchObject({ focus: 'budget', category: null, budgetCents: null, remainingCents: null });
    expect(queryText(previous)).toBe('9 月（9月1日–9月30日）还没有设置预算。已记录净支出 ¥0。');
    const unfiltered = await runQuery(fx.db, fx.userId, query(), TODAY, null);
    expect(unfiltered).toMatchObject({ focus: 'summary', category: null, spendCents: 35300 });
    expect(judgeQuery('Q002', fx, [unfiltered]).pass).toBe(true);
  });
});

describe('真实失败结构经 HTTP 保存回复与只读恢复', () => {
  it.each(failures)('$id 文字/卡片/历史一致，查询不改变计划事实或版本', async ({ id, text, category, answer }) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(INPUT_AT);
    const fx = await fixture();
    // Same provider query shape as the recorded real failure; only the per-fixture ID differs.
    const llm = new FakeLlm(() => ({ intent: 'query', writes: [], query: query({ plan_id: fx.plans.ledger!, category }), missing: [], question: null, unsupported_kind: 'none', reply: '模型给出的999999元不能用作统计。' }));
    const cfg = { jwtSecret: new TextEncoder().encode('query-category-isolated-http-test-secret'), appleAudience: null, devLogin: false };
    const token = await issueToken(cfg, fx.userId, 0);
    const app = createApp(fx.db, llm, cfg);
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    const facts = () => fx.db.query('SELECT id, plan_id, kind, amount_cents, minutes, category, occurred_on, version, deleted, refund_of FROM records WHERE user_id=$1 ORDER BY id', [fx.userId]);
    const plans = () => fx.db.query('SELECT * FROM plans WHERE user_id=$1 ORDER BY id', [fx.userId]);
    const beforeFacts = await facts(), beforePlans = await plans();
    const before = await (await app.request('/v1/me', { headers })).json() as { dataVersion: number };
    const clientMsgId = randomUUID();
    const response = await app.request('/v1/chat', { method: 'POST', headers, body: JSON.stringify({ clientMsgId, text, inputAt: INPUT_AT.toISOString() }) });
    expect(response.status).toBe(200);
    const result = await response.json() as ChatReply;
    expect(result.assistant.text).toContain(answer);
    expect(result.assistant.text).not.toMatch(/353|2,647|预算|999999/);
    expect(result.assistant.cards).toHaveLength(1);
    expect(result.assistant.cards[0]).toMatchObject({ type: 'query', kind: 'ledger_month', focus: 'category', category });
    expect(judgeQuery(id, fx, result.assistant.cards)).toEqual({ pass: true, reason: '' });
    expect(result.dataVersion).toBe(before.dataVersion);
    const lookupResponse = await app.request(`/v1/chat/${clientMsgId}`, { headers });
    expect(lookupResponse.status).toBe(200);
    const lookup = await lookupResponse.json() as { status: string; result: ChatReply };
    expect(lookup.status).toBe('succeeded');
    expect(lookup.result.assistant).toEqual(result.assistant);
    const historyResponse = await app.request('/v1/messages', { headers });
    expect(historyResponse.status).toBe(200);
    const history = await historyResponse.json() as { messages: MessageView[] };
    expect(history.messages.find(message => message.id === result.assistant.id)).toEqual(result.assistant);
    expect(llm.calls).toHaveLength(1);
    expect(await facts()).toEqual(beforeFacts);
    expect(await plans()).toEqual(beforePlans);
    expect((await (await app.request('/v1/me', { headers })).json() as { dataVersion: number }).dataVersion).toBe(before.dataVersion);
    expect(await fx.db.query('SELECT id FROM operations WHERE user_id=$1 AND client_op_id=$2', [fx.userId, clientMsgId])).toEqual([]);
  });
});
