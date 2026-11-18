import { describe, expect, it } from 'vitest';
import { FakeLlm, LlmError } from '../src/ai/llm.js';
import { aiFailureMessage } from '../src/ai/user-feedback.js';
import type { Turn, TurnWrite } from '../src/ai/turn.js';
import { Chat, type Card } from '../src/services/chat.js';
import { ledgerView } from '../src/services/views.js';
import { setup } from './helpers.js';

const T = new Date('2026-10-26T12:41:00+08:00');

function w(op: TurnWrite['op'], f: Partial<TurnWrite> = {}): TurnWrite {
  return {
    op, is_fact: true, amount_text: null, currency: 'CNY', duration_value: null, duration_unit: null, category: null,
    date_kind: 'today', days_ago: null, date: null, note: null, plan_id: null, plan_name: null, activity: null,
    days_per_week: null, min_minutes: null, scope: 'unspecified', record_id: null, component: null, ...f,
  };
}

/** 按用户原话返回预设的模型输出。 */
function script(map: Record<string, Partial<Turn> | Error>) {
  return new FakeLlm((user) => {
    const t = map[user];
    if (!t) throw new Error(`no script for: ${user}`);
    return t;
  });
}

let n = 0;
const send = (chat: Chat, userId: string, text: string, extra: Partial<Parameters<Chat['send']>[1]> = {}) =>
  chat.send(userId, { clientMsgId: `m${++n}`, text, inputAt: T, ...extra });
const card = <K extends Card['type']>(cards: Card[], type: K) => cards.find((c) => c.type === type) as Extract<Card, { type: K }> | undefined;

async function withLedgerAndTwoReadingPlans() {
  const c = await setup();
  const p = await c.run('2026-10-05T10:00:00+08:00', { type: 'create_ledger', budgetCents: 300000 });
  const ledgerId = (p.items[0] as { plan: { id: string } }).plan.id;
  await c.run('2026-10-05T10:00:00+08:00', { type: 'add_expense', amountCents: 127000, category: '其他', date: '2026-10-05' });
  const a = await c.run('2026-10-05T10:00:00+08:00', { type: 'create_study', name: '课外阅读', activity: '阅读' });
  const b = await c.run('2026-10-05T10:00:00+08:00', { type: 'create_study', name: '英语学习', activity: '英语学习' });
  return { ...c, ledgerId, readId: (a.items[0] as { plan: { id: string } }).plan.id, engId: (b.items[0] as { plan: { id: string } }).plan.id };
}

describe('对话', () => {
  it('AC15/AC16 两条里一条归属不明，整批待补充；选定后一次保存', async () => {
    const c = await withLedgerAndTwoReadingPlans();
    const llm = script({ '午饭20元，读书30分钟': { intent: 'write', writes: [w('add_expense', { amount_text: '20', category: '餐饮', note: '午饭' }), w('add_study', { duration_value: 30, duration_unit: 'minute' })] } });
    const chat = new Chat(c.db, llm);
    const r = await send(chat, c.userId, '午饭20元，读书30分钟');
    const cl = card(r.assistant.cards, 'clarify')!;
    expect(cl.items.map((i) => i.ready)).toEqual([true, false]);
    expect(r.assistant.text).toContain('这 2 条还没有保存');
    const [cnt] = await c.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM records WHERE note = '午饭'`);
    expect(cnt!.n).toBe(0);

    const pick = cl.options.find((o) => o.label === '课外阅读')!;
    const r2 = await send(chat, c.userId, '课外阅读', { pendingId: cl.pendingId, choice: pick.id });
    const receipt = card(r2.assistant.cards, 'receipt')!;
    expect(receipt.items.map((i) => i.type)).toEqual(['expense_added', 'study_added']);
    const hist = await chat.history(c.userId);
    const original = hist.find((m) => m.cards.some((x) => x.type === 'clarify'))!;
    expect((original.cards.find((x) => x.type === 'clarify') as { status: string }).status).toBe('resolved');
  });

  it('AC41 待补充时查询仍返回原数据并说明未计入', async () => {
    const c = await withLedgerAndTwoReadingPlans();
    const llm = script({
      q: { intent: 'write_and_query', writes: [w('add_expense', { amount_text: '20', category: '餐饮', note: '午饭' }), w('add_study', { duration_value: 30, duration_unit: 'minute' })], query: { kind: 'ledger_summary', plan_id: null, period: 'this_month', from: null, to: null, category: null } },
    });
    const r = await send(new Chat(c.db, llm), c.userId, 'q');
    const q = card(r.assistant.cards, 'query') as Extract<Card, { kind: 'ledger_month' }>;
    expect(q.netCents).toBe(127000);
    expect(r.assistant.text).toContain('还没有计入');
  });

  it('AC44 页面范围用于省略表达，明确指定时以指定为准；午饭仍进账本', async () => {
    const c = await withLedgerAndTwoReadingPlans();
    const llm = script({
      读了30分钟: { intent: 'write', writes: [w('add_study', { duration_value: 30, duration_unit: 'minute' })] },
      记到课外阅读: { intent: 'write', writes: [w('add_study', { duration_value: 30, duration_unit: 'minute', plan_id: c.readId })] },
      午饭20元: { intent: 'write', writes: [w('add_expense', { amount_text: '20', category: '餐饮', note: '午饭' })] },
    });
    const chat = new Chat(c.db, llm);
    const a = await send(chat, c.userId, '读了30分钟', { scopePlanId: c.engId });
    expect((card(a.assistant.cards, 'receipt')!.items[0] as { record: { planId: string } }).record.planId).toBe(c.engId);
    const b = await send(chat, c.userId, '记到课外阅读', { scopePlanId: c.engId });
    expect((card(b.assistant.cards, 'receipt')!.items[0] as { record: { planId: string } }).record.planId).toBe(c.readId);
    const d = await send(chat, c.userId, '午饭20元', { scopePlanId: c.engId });
    expect((card(d.assistant.cards, 'receipt')!.items[0] as { record: { planId: string } }).record.planId).toBe(c.ledgerId);
  });

  it('AC22 只说读了书时追问时长，不自动填目标分钟', async () => {
    const c = await setup();
    await c.run('2026-10-20T10:00:00+08:00', { type: 'create_study', activity: '阅读', daysPerWeek: 5, minMinutes: 20 });
    const r = await send(new Chat(c.db, script({ 今天读书了: { intent: 'write', writes: [w('add_study')] } })), c.userId, '今天读书了');
    const cl = card(r.assistant.cards, 'clarify')!;
    expect(cl.question).toContain('多长时间');
    expect(cl.options.map((o) => o.label)).toContain('30 分钟');
  });

  it('AC23 当日总量不直接新增，展示已有并提供补记', async () => {
    const c = await setup();
    const p = await c.run('2026-10-20T10:00:00+08:00', { type: 'create_study', activity: '阅读' });
    const planId = (p.items[0] as { plan: { id: string } }).plan.id;
    await c.run(T.toISOString(), { type: 'add_study', planId, minutes: 20, date: '2026-10-26' });
    const chat = new Chat(c.db, script({ 今天总共读了60分钟: { intent: 'write', writes: [w('day_total_claim', { duration_value: 60, duration_unit: 'minute' })] } }));
    const r = await send(chat, c.userId, '今天总共读了60分钟');
    const cl = card(r.assistant.cards, 'clarify')!;
    expect(cl.question).toContain('已经记了 20 分钟');
    const add = cl.options.find((o) => o.label === '补记 40 分钟')!;
    const r2 = await send(chat, c.userId, '补记 40 分钟', { pendingId: cl.pendingId, choice: add.id });
    expect((card(r2.assistant.cards, 'receipt')!.items[0] as { study: { dayMinutes: number } }).study.dayMinutes).toBe(60);
  });

  it('AC28/AC29 意向、假设和提醒不记成事实', async () => {
    const c = await setup();
    await c.run(T.toISOString(), { type: 'create_ledger' });
    const chat = new Chat(c.db, script({
      我准备买20元咖啡: { intent: 'write', writes: [w('add_expense', { is_fact: false, amount_text: '20', note: '咖啡' })] },
      每天21点提醒我: { intent: 'unsupported', unsupported_kind: 'reminder', reply: '' },
    }));
    const a = await send(chat, c.userId, '我准备买20元咖啡');
    expect(a.assistant.text).toContain('不会记成');
    const b = await send(chat, c.userId, '每天21点提醒我');
    expect(b.assistant.text).toContain('没有设置任何提醒');
    const [cnt] = await c.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM records`);
    expect(cnt!.n).toBe(0);
  });

  it('AC30 归档计划不自动写入，提供恢复并记录', async () => {
    const c = await setup();
    const p = await c.run('2026-10-20T10:00:00+08:00', { type: 'create_study', activity: '阅读' });
    const planId = (p.items[0] as { plan: { id: string } }).plan.id;
    await c.run('2026-10-21T10:00:00+08:00', { type: 'archive_plan', planId });
    const chat = new Chat(c.db, script({ 读书30分钟: { intent: 'write', writes: [w('add_study', { duration_value: 30, duration_unit: 'minute', plan_id: planId })] } }));
    const r = await send(chat, c.userId, '读书30分钟');
    const cl = card(r.assistant.cards, 'clarify')!;
    expect(cl.question).toContain('已归档');
    const r2 = await send(chat, c.userId, '恢复并记录', { pendingId: cl.pendingId, choice: cl.options[0]!.id });
    expect(card(r2.assistant.cards, 'receipt')!.items.map((i) => i.type)).toEqual(['plan_updated', 'study_added']);
  });

  it('未建计划时发事实，提供创建并记录，创建与首条整批提交', async () => {
    const c = await setup();
    const chat = new Chat(c.db, script({ 午饭20元: { intent: 'write', writes: [w('add_expense', { amount_text: '20', category: '餐饮', note: '午饭' })] } }));
    const r = await send(chat, c.userId, '午饭20元');
    const cl = card(r.assistant.cards, 'clarify')!;
    const r2 = await send(chat, c.userId, '创建日常记账并记录', { pendingId: cl.pendingId, choice: cl.options[0]!.id });
    expect(card(r2.assistant.cards, 'receipt')!.items.map((i) => i.type)).toEqual(['plan_created', 'expense_added']);
  });

  it('AC35 模型不可用时不宣称保存，同一条消息可以重试', async () => {
    const c = await setup();
    await c.run(T.toISOString(), { type: 'create_ledger' });
    let fail = true;
    const llm = new FakeLlm(() => (fail ? new LlmError('unavailable', 'down') : { intent: 'write', writes: [w('add_expense', { amount_text: '20', category: '餐饮', note: '午饭' })] }));
    const chat = new Chat(c.db, llm);
    const first = await chat.send(c.userId, { clientMsgId: 'retry-1', text: '午饭20元', inputAt: T });
    expect(first.transient).toBe(true);
    expect(card(first.assistant.cards, 'error')).toMatchObject({ code: 'model_unavailable', retryable: true, message: aiFailureMessage('unavailable', 'chat') });
    expect(first.assistant.cards[0]).not.toHaveProperty('kind');
    fail = false;
    const second = await chat.send(c.userId, { clientMsgId: 'retry-1', text: '午饭20元', inputAt: T });
    expect(card(second.assistant.cards, 'receipt')).toBeTruthy();
    const third = await chat.send(c.userId, { clientMsgId: 'retry-1', text: '午饭20元', inputAt: T });
    expect(third.assistant.id).toBe(second.assistant.id);
    const [cnt] = await c.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM records`);
    expect(cnt!.n).toBe(1);
  });

  it('AC04/AC36 “刚才不是20是25”修改同一条，旧回执标出已修改', async () => {
    const c = await setup();
    const p = await c.run('2026-10-05T10:00:00+08:00', { type: 'create_ledger', budgetCents: 300000 });
    const planId = (p.items[0] as { plan: { id: string } }).plan.id;
    const chat = new Chat(c.db, script({
      午饭20元: { intent: 'write', writes: [w('add_expense', { amount_text: '20', category: '餐饮', note: '午饭' })] },
      '刚才不是20元，是25元': { intent: 'write', writes: [w('edit_record', { amount_text: '25' })] },
      撤销刚才: { intent: 'write', writes: [w('undo_last')] },
    }));
    await send(chat, c.userId, '午饭20元');
    const r = await send(chat, c.userId, '刚才不是20元，是25元');
    expect(r.assistant.text).toContain('从 ¥20 改为 ¥25');
    const hist = await chat.history(c.userId);
    const firstReceipt = hist.flatMap((m) => m.cards).find((x) => x.type === 'receipt') as Extract<Card, { type: 'receipt' }>;
    expect(Object.values(firstReceipt.current ?? {})).toEqual(['modified']);
    const u = await send(chat, c.userId, '撤销刚才');
    expect(u.assistant.text).toContain('已撤销');
    expect((await ledgerView(c.db, c.userId, planId, '2026-10')).stats.netCents).toBe(2000);
  });

  it('AC45 未授权 AI 时不调用模型', async () => {
    const c = await setup();
    await c.db.query(`UPDATE users SET ai_consent = false WHERE id = $1`, [c.userId]);
    const llm = script({});
    await expect(send(new Chat(c.db, llm), c.userId, '午饭20元')).rejects.toMatchObject({ code: 'ai_consent_required' });
    expect(llm.calls.length).toBe(0);
  });

  it('AC02 已有账本时再说要记账，展示已有账本', async () => {
    const c = await setup();
    await c.run(T.toISOString(), { type: 'create_ledger' });
    const r = await send(new Chat(c.db, script({ 帮我建记账计划: { intent: 'write', writes: [w('create_ledger')] } })), c.userId, '帮我建记账计划');
    expect(card(r.assistant.cards, 'plan')).toBeTruthy();
    const [cnt] = await c.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM plans`);
    expect(cnt!.n).toBe(1);
  });
});
