import { describe, expect, it } from 'vitest';
import { CASES } from '../evals/cases.js';
import { makeFixture } from '../evals/fixtures.js';
import { judgeQuery, QUERY_EXPECTATIONS } from '../evals/query-expectations.js';
import { assessGates } from '../evals/gates.js';
import { runCase, type Result } from '../evals/runner.js';
import { FakeLlm, LlmError } from '../src/ai/llm.js';
import { runQuery } from '../src/services/query.js';
import type { TurnWrite } from '../src/ai/turn.js';

const write = (amount: string): TurnWrite => ({ op: 'add_expense', is_fact: true, amount_text: amount, currency: 'CNY', category: '餐饮', date_kind: 'today', note: '午饭', duration_value: null, duration_unit: null, days_ago: null, date: null, plan_id: null, plan_name: null, activity: null, days_per_week: null, min_minutes: null, scope: 'unspecified', record_id: null, component: null });
const result = (id: string, pass = true): Result => ({ c: CASES.find((c) => c.id === id)!, pass, reason: '', latencyMs: 1, executedOneTurn: pass, wrongFactWrites: 0, reply: '', cards: [] });

describe('AI 评测不是仅检查卡片种类', () => {
  it('每一条查询都有独立的 oracle', () => {
    const ids = CASES.flatMap((c) => [
      ...(c.expect.kind === 'query' ? [c.id] : []),
      ...(c.followUps ?? []).flatMap((f, i) => (f.expect.kind === 'query' ? [`${c.id}.${i + 1}`] : [])),
    ]);
    expect(Object.keys(QUERY_EXPECTATIONS).sort()).toEqual(ids.sort());
  });
  it('正确预算通过；错误金额、范围、归属与多余卡片均失败', async () => {
    const fx = await makeFixture('default');
    try {
      const card = await runQuery(fx.db, fx.userId, { kind: 'budget', period: 'this_month', plan_id: null, from: null, to: null, category: null }, '2026-10-26', null);
      expect(judgeQuery('Q001', fx, [card]).pass).toBe(true);
      if (card.kind !== 'ledger_month') throw new Error('wrong fixture card');
      expect(judgeQuery('Q001', fx, [{ ...card, remainingCents: 1 }]).pass).toBe(false);
      expect(judgeQuery('Q001', fx, [{ ...card, from: '2026-10-20' }]).pass).toBe(false);
      expect(judgeQuery('Q001', fx, [{ ...card, plan: { ...card.plan, id: fx.plans.read! } }]).pass).toBe(false);
      expect(judgeQuery('Q001', fx, [card, card]).pass).toBe(false);
      expect(judgeQuery('unknown', fx, [card]).pass).toBe(false);
    } finally { await fx.db.close(); }
  });
  it('昨日问题必须返回昨日汇总，假周卡仍被 oracle 拒绝', async () => {
    const fx = await makeFixture('default');
    try {
      const card = await runQuery(fx.db, fx.userId, { kind: 'study_progress', period: 'yesterday', plan_id: fx.plans.read!, from: null, to: null, category: null }, '2026-10-26', null);
      expect(judgeQuery('Q028', fx, [card]).pass).toBe(true);
      const wrong = await runQuery(fx.db, fx.userId, { kind: 'study_progress', period: 'this_week', plan_id: fx.plans.read!, from: null, to: null, category: null }, '2026-10-26', null);
      expect(judgeQuery('Q028', fx, [wrong]).pass).toBe(false);
      const today = await runQuery(fx.db, fx.userId, { kind: 'study_progress', period: 'today', plan_id: fx.plans.read!, from: null, to: null, category: null }, '2026-10-26', null);
      expect(judgeQuery('Q018', fx, [today]).pass).toBe(true);
      expect(judgeQuery('Q018', fx, [wrong]).pass).toBe(false);
    } finally { await fx.db.close(); }
  });
  it('分类查询必须显示分类金额，不能用相同数据的预算或汇总卡蒙混通过', async () => {
    const fx = await makeFixture('default');
    try {
      const card = await runQuery(fx.db, fx.userId, { kind: 'ledger_category', period: 'this_month', plan_id: null, from: null, to: null, category: '餐饮' }, '2026-10-26', null);
      expect(judgeQuery('Q009', fx, [card]).pass).toBe(true);
      if (card.kind !== 'ledger_month') throw new Error('wrong fixture card');
      for (const focus of ['summary', 'budget'] as const) expect(judgeQuery('Q009', fx, [{ ...card, focus }]).pass).toBe(false);
    } finally { await fx.db.close(); }
  });
  it('金额错的写入不计一轮完成；正确写入才计数', async () => {
    const c = CASES.find((c) => c.id === 'F001')!;
    const bad = await runCase(c, 0, new FakeLlm(() => ({ intent: 'write', writes: [write('21')] })));
    expect(bad.pass).toBe(false); expect(bad.executedOneTurn).toBe(false);
    const good = await runCase(c, 1, new FakeLlm(() => ({ intent: 'write', writes: [write('20')] })));
    expect(good.pass).toBe(true); expect(good.executedOneTurn).toBe(true);
  });
  it('服务商失败不能从分母移除或当成无写入通过', async () => {
    const llm = new FakeLlm(() => new LlmError('unavailable', 'fixture'));
    const failed = await runCase(CASES.find((c) => c.id === 'A014')!, 2, llm);
    expect(failed.pass).toBe(false);
    expect(llm.calls).toHaveLength(1);
    expect(assessGates([result('F001'), result('Q001'), failed]).passed).toBe(false);
  });
  it('首轮失败不会隐式再调用模型并把第二次结果伪装成一次通过', async () => {
    let calls = 0;
    const llm = new FakeLlm(() => ++calls === 1 ? new LlmError('timeout') : { intent: 'write', writes: [write('20')] });
    const first = await runCase(CASES.find(c => c.id === 'F001')!, 0, llm);
    expect(first.pass).toBe(false); expect(first.executedOneTurn).toBe(false); expect(calls).toBe(1);
    const explicitRetry = await runCase(CASES.find(c => c.id === 'F001')!, 1, llm);
    expect(explicitRetry.pass).toBe(true); expect(calls).toBe(2);
  });
  it('空集、缺失场景或失败查询均不能作为通过的发布门槛', () => {
    expect(assessGates([]).passed).toBe(false);
    expect(assessGates([result('F001')]).passed).toBe(false);
    expect(assessGates([result('F001'), result('Q001'), result('A001')]).passed).toBe(true);
    expect(assessGates([result('F001'), result('Q001', false), result('A001')]).passed).toBe(false);
    const wrong = result('A001'); wrong.wrongFactWrites = 1;
    expect(assessGates([result('F001'), result('Q001'), wrong]).passed).toBe(false);
  });
  it('追问后的选项回复在同一场景中执行，前一轮不保存', async () => {
    const c = CASES.find((c) => c.id === 'M001')!;
    const llm = new FakeLlm(() => ({ intent: 'write', writes: [{ ...write('20'), op: 'add_study', amount_text: null, category: null, note: null, duration_value: 30, duration_unit: 'minute' }] }));
    const r = await runCase(c, 3, llm);
    expect(r.pass, r.reason).toBe(true); expect(r.executedOneTurn).toBe(false); expect(r.wrongFactWrites).toBe(0);
  });
});
