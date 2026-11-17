import { describe, expect, it } from 'vitest';
import { FakeLlm } from '../src/ai/llm.js';
import type { TurnWrite } from '../src/ai/turn.js';
import { Chat, type Card } from '../src/services/chat.js';
import { undo } from '../src/services/engine.js';
import { studyView } from '../src/services/views.js';
import { isInterruptedWeek } from '../src/domain/study.js';
import { getPlan } from '../src/services/repo.js';
import { opId, setup } from './helpers.js';

const T = '2026-10-26T12:41:00+08:00';
const w = (op: TurnWrite['op'], f: Partial<TurnWrite> = {}): TurnWrite => ({
  op, is_fact: true, amount_text: null, currency: 'CNY', duration_value: null, duration_unit: null, category: null, date_kind: 'today', days_ago: null, date: null,
  note: null, plan_id: null, plan_name: null, activity: null, days_per_week: null, min_minutes: null, scope: 'unspecified', record_id: null, component: null, ...f,
});
const planIdOf = (r: { items: unknown[] }) => (r.items[0] as { plan: { id: string } }).plan.id;

describe('审查修复', () => {
  it('同一个澄清选项并发点两次，只保存一次', async () => {
    const c = await setup();
    const chat = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [w('add_expense', { amount_text: '20', category: '餐饮', note: '午饭' })] })));
    const r = await chat.send(c.userId, { clientMsgId: 'clar-0001', text: '午饭20元', inputAt: new Date(T) });
    const cl = r.assistant.cards.find((x): x is Extract<Card, { type: 'clarify' }> => x.type === 'clarify')!;
    const choice = cl.options[0]!;
    const results = await Promise.all([
      chat.send(c.userId, { clientMsgId: 'clar-0002', text: choice.label, inputAt: new Date(T), pendingId: cl.pendingId, choice: choice.id }),
      chat.send(c.userId, { clientMsgId: 'clar-0003', text: choice.label, inputAt: new Date(T), pendingId: cl.pendingId, choice: choice.id }),
    ]);
    expect(results.filter((x) => x.assistant.cards.some((k) => k.type === 'receipt')).length).toBe(1);
    const [n] = await c.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM records`);
    expect(n!.n).toBe(1);
  });

  it('撤销“建计划并记录”的同一批操作', async () => {
    const c = await setup();
    const r = await c.run(T, { type: 'create_ledger', budgetCents: 300000 }, { type: 'add_expense', amountCents: 2000, category: '餐饮', date: '2026-10-26' });
    const planId = planIdOf(r);
    const u = await undo(c.db, c.at(T), r.operationId, opId());
    expect(u.items[0]).toMatchObject({ type: 'undone' });
    await expect(getPlan(c.db, c.userId, planId)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('计划后来有了其他记录（即使又删掉了），不能撤销创建', async () => {
    const c = await setup();
    const r = await c.run(T, { type: 'create_ledger' });
    const e = await c.run(T, { type: 'add_expense', amountCents: 2000, category: '餐饮', date: '2026-10-26' });
    await c.run(T, { type: 'delete_record', recordId: (e.items[0] as { record: { id: string } }).record.id });
    await expect(undo(c.db, c.at(T), r.operationId, opId())).rejects.toMatchObject({ code: 'undo_conflict' });
  });

  it('撤销删除时重新校验单日 1440 分钟上限', async () => {
    const c = await setup();
    const planId = planIdOf(await c.run(T, { type: 'create_study', activity: '阅读' }));
    const a = await c.run(T, { type: 'add_study', planId, minutes: 1000, date: '2026-10-26' });
    const del = await c.run(T, { type: 'delete_record', recordId: (a.items[0] as { record: { id: string } }).record.id });
    await c.run(T, { type: 'add_study', planId, minutes: 1000, date: '2026-10-26' });
    await expect(undo(c.db, c.at(T), del.operationId, opId())).rejects.toMatchObject({ code: 'undo_conflict' });
  });

  it('撤销较早的改名只恢复名称，不动后来的归档', async () => {
    const c = await setup();
    const planId = planIdOf(await c.run(T, { type: 'create_study', name: '阅读', activity: '阅读' }));
    const rename = await c.run(T, { type: 'rename_plan', planId, name: '课外阅读' });
    await c.run(T, { type: 'archive_plan', planId });
    await undo(c.db, c.at(T), rename.operationId, opId());
    const p = await getPlan(c.db, c.userId, planId);
    expect([p.name, p.status]).toEqual(['阅读', 'archived']);
  });

  it('同一字段后来又改过，拒绝撤销较早的修改', async () => {
    const c = await setup();
    const planId = planIdOf(await c.run(T, { type: 'create_study', name: '阅读', activity: '阅读' }));
    const first = await c.run(T, { type: 'rename_plan', planId, name: '课外阅读' });
    await c.run(T, { type: 'rename_plan', planId, name: '睡前阅读' });
    await expect(undo(c.db, c.at(T), first.operationId, opId())).rejects.toMatchObject({ code: 'undo_conflict' });
  });

  it('归档到恢复之间的整周都不判达标', async () => {
    const ev = [{ event: 'archived' as const, on_date: '2026-10-07' }, { event: 'restored' as const, on_date: '2026-10-28' }];
    expect(isInterruptedWeek('2026-10-12', ev)).toBe(true);
    expect(isInterruptedWeek('2026-10-19', ev)).toBe(true);
    expect(isInterruptedWeek('2026-11-02', ev)).toBe(false);
    expect(isInterruptedWeek('2026-09-28', ev)).toBe(false);

    const c = await setup();
    const planId = planIdOf(await c.run('2026-09-28T09:00:00+08:00', { type: 'create_study', activity: '阅读', daysPerWeek: 3, minMinutes: 20 }));
    await c.run('2026-10-07T09:00:00+08:00', { type: 'archive_plan', planId });
    await c.run('2026-10-28T09:00:00+08:00', { type: 'restore_plan', planId });
    const mid = await studyView(c.db, c.userId, planId, '2026-10-12', '2026-10-28');
    expect([mid.stats.interrupted, mid.stats.metDays]).toEqual([true, null]);
  });
});

describe('逐条撤销', () => {
  it('只撤销选中的记录，之后整次撤销跳过它', async () => {
    const c = await setup();
    await c.run(T, { type: 'create_ledger' });
    const planId = planIdOf(await c.run(T, { type: 'create_study', activity: '阅读' }));
    const batch = await c.run(T, { type: 'add_expense', amountCents: 2000, category: '餐饮', date: '2026-10-26' }, { type: 'add_study', planId, minutes: 25, date: '2026-10-26' });
    const lunch = (batch.items[0] as { record: { id: string } }).record.id;
    const read = (batch.items[1] as { record: { id: string } }).record.id;

    await undo(c.db, c.at(T), batch.operationId, opId(), lunch);
    const live = async () => (await c.db.query<{ id: string }>(`SELECT id FROM records WHERE NOT deleted`)).map((r) => r.id);
    expect(await live()).toEqual([read]);
    await expect(undo(c.db, c.at(T), batch.operationId, opId(), lunch)).rejects.toMatchObject({ code: 'already_undone' });

    await undo(c.db, c.at(T), batch.operationId, opId());
    expect(await live()).toEqual([]);
    await expect(undo(c.db, c.at(T), batch.operationId, opId())).rejects.toMatchObject({ code: 'already_undone' });
  });

  it('逐条撤销完所有记录后，整次操作标记为已撤销', async () => {
    const c = await setup();
    await c.run(T, { type: 'create_ledger' });
    const batch = await c.run(T, { type: 'add_expense', amountCents: 2000, category: '餐饮', date: '2026-10-26' });
    await undo(c.db, c.at(T), batch.operationId, opId(), (batch.items[0] as { record: { id: string } }).record.id);
    const [op] = await c.db.query<{ undone: boolean }>(`SELECT undone FROM operations WHERE id = $1`, [batch.operationId]);
    expect(op!.undone).toBe(true);
  });

  it('不属于这次操作的记录不能逐条撤销', async () => {
    const c = await setup();
    await c.run(T, { type: 'create_ledger' });
    const a = await c.run(T, { type: 'add_expense', amountCents: 2000, category: '餐饮', date: '2026-10-26' });
    const b = await c.run(T, { type: 'add_expense', amountCents: 600, category: '交通', date: '2026-10-26' });
    await expect(undo(c.db, c.at(T), a.operationId, opId(), (b.items[0] as { record: { id: string } }).record.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('评测发现的拦截', () => {
  const w2 = w;
  it('超过 10 条在调用模型前就拒绝，什么都不保存', async () => {
    const c = await setup();
    await c.run(T, { type: 'create_ledger' });
    const llm = new FakeLlm(() => ({ intent: 'write', writes: Array.from({ length: 10 }, () => w2('add_expense', { amount_text: '5', category: '餐饮' })) }));
    const r = await new Chat(c.db, llm).send(c.userId, { clientMsgId: 'many-0001', text: '早餐5，午饭20，晚饭30，地铁4，公交2，奶茶15，咖啡20，水果10，零食8，报纸3，纸巾5', inputAt: new Date(T) });
    expect(r.assistant.text).toContain('一次最多记 10 条');
    expect(llm.calls.length).toBe(0);
    const [n] = await c.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM records`);
    expect(n!.n).toBe(0);
  });

  it('负数金额不保存，即使模型把它当成正数', async () => {
    const c = await setup();
    await c.run(T, { type: 'create_ledger' });
    const llm = new FakeLlm(() => ({ intent: 'write', writes: [w2('add_expense', { amount_text: '20', category: '餐饮', note: '午饭' })] }));
    const r = await new Chat(c.db, llm).send(c.userId, { clientMsgId: 'neg-0001', text: '午饭-20元', inputAt: new Date(T) });
    expect(r.assistant.text).toContain('大于 0');
    const [n] = await c.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM records`);
    expect(n!.n).toBe(0);
  });

  it('修改成和原来一样的值时追问，而不是假装修改', async () => {
    const c = await setup();
    await c.run(T, { type: 'create_ledger' });
    await c.run(T, { type: 'add_expense', amountCents: 2000, category: '餐饮', date: '2026-10-26', note: '午饭' });
    const llm = new FakeLlm(() => ({ intent: 'write', writes: [w2('edit_record', { amount_text: '20' })] }));
    const r = await new Chat(c.db, llm).send(c.userId, { clientMsgId: 'noop-0001', text: '午饭是20', inputAt: new Date(T) });
    expect(r.assistant.cards.some((x) => x.type === 'clarify')).toBe(true);
    const [v] = await c.db.query<{ version: number }>(`SELECT version FROM records`);
    expect(v!.version).toBe(1);
  });
});

describe('PR #3 审查修复', () => {
  it('逐条撤销过一条后，仍能整次撤销“建计划并记录”', async () => {
    const c = await setup();
    const r = await c.run(T, { type: 'create_ledger' }, { type: 'add_expense', amountCents: 2000, category: '餐饮', date: '2026-10-26' }, { type: 'add_expense', amountCents: 600, category: '交通', date: '2026-10-26' });
    const first = (r.items[1] as { record: { id: string } }).record.id;
    await undo(c.db, c.at(T), r.operationId, opId(), first);
    await undo(c.db, c.at(T), r.operationId, opId());
    await expect(getPlan(c.db, c.userId, planIdOf(r))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('并发请求的查询各自按自己的原话匹配计划', async () => {
    const c = await setup();
    await c.run('2026-10-20T09:00:00+08:00', { type: 'create_study', name: '阅读', activity: '阅读' });
    await c.run('2026-10-20T09:00:00+08:00', { type: 'create_study', name: '英语学习', activity: '英语学习' });
    const q = { kind: 'study_progress' as const, plan_id: null, period: 'this_week' as const, from: null, to: null, category: null };
    // 让第一个请求在模型阶段等第二个请求先完成，模拟交错。
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const llm = new FakeLlm(() => ({ intent: 'query', query: q }));
    const slow = { plan: async (sys: string, user: string) => { if (user.includes('读书')) await gate; return llm.plan(sys, user); } };
    const chat = new Chat(c.db, slow);
    const a = chat.send(c.userId, { clientMsgId: 'race-read-1', text: '本周读书几天', inputAt: new Date(T) });
    const b = await chat.send(c.userId, { clientMsgId: 'race-eng-1', text: '这周英语学了多久', inputAt: new Date(T) });
    release();
    const ra = await a;
    const name = (cards: Card[]) => (cards.find((x) => x.type === 'query') as { plan?: { name: string } }).plan?.name;
    expect(name(b.assistant.cards)).toBe('英语学习');
    expect(name(ra.assistant.cards)).toBe('阅读');
  });
});


describe('PR #2 remaining review guards', () => {
  it('an orphan choice never bypasses AI consent', async () => {
    const c = await setup();
    await c.db.query('UPDATE users SET ai_consent = false WHERE id = $1', [c.userId]);
    const llm = new FakeLlm(() => ({ intent: 'smalltalk', reply: 'hello' }));
    await expect(new Chat(c.db, llm).send(c.userId, {
      clientMsgId: 'orphan-choice', text: 'hello', inputAt: new Date(T), choice: 'anything',
    })).rejects.toMatchObject({ code: 'ai_consent_required' });
    expect(llm.calls).toHaveLength(0);
  });

  it('consent revoked during context loading prevents the model call', async () => {
    const c = await setup();
    const query = c.db.query.bind(c.db);
    c.db.query = async <Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<Row[]> => {
      const result = await query<Row>(sql, params);
      if (/SELECT role, text(?:, cards, scope_plan_id(?:, id, reply_to)?)? FROM messages/.test(sql)) {
        await query('UPDATE users SET ai_consent = false WHERE id = $1', [c.userId]);
      }
      return result;
    };
    const llm = new FakeLlm(() => ({ intent: 'smalltalk', reply: 'hello' }));
    const chat = new Chat(c.db, llm);
    const input = { clientMsgId: 'revoked-during-context', text: 'hello', inputAt: new Date(T) };
    await expect(chat.send(c.userId, input)).rejects.toMatchObject({ code: 'ai_consent_required' });
    expect(llm.calls).toHaveLength(0);
    expect(await chat.lookup(c.userId, input.clientMsgId)).toBeNull();
    c.db.query = query;
    await query('UPDATE users SET ai_consent = true WHERE id = $1', [c.userId]);
    const retried = await chat.send(c.userId, input);
    expect(retried.assistant.text).toBe('hello');
    expect(llm.calls).toHaveLength(1);
    expect((await chat.lookup(c.userId, input.clientMsgId))?.assistant.id).toBe(retried.assistant.id);
    const rows = await query('SELECT id FROM messages WHERE user_id = $1 AND client_msg_id = $2', [c.userId, input.clientMsgId]);
    expect(rows).toHaveLength(1);
  });

  it.each(['ledger', 'study'] as const)('archived %s records allow historical correction but reject new entries', async kind => {
    const c = await setup();
    const plan = await c.run(T, kind === 'ledger' ? { type: 'create_ledger' } : { type: 'create_study', activity: '阅读' });
    const planId = planIdOf(plan);
    const add: import('../src/services/engine.js').Action = kind === 'ledger'
      ? { type: 'add_expense' as const, amountCents: 2000, category: '餐饮', date: '2026-10-26' }
      : { type: 'add_study' as const, planId, minutes: 25, date: '2026-10-26' };
    const result = await c.run(T, add);
    const recordId = (result.items[0] as { record: { id: string } }).record.id;
    await c.run(T, { type: 'archive_plan', planId });
    const patch = kind === 'ledger' ? { amountCents: 3000, note: '历史修正' } : { minutes: 35, note: '历史修正' };
    const edited = await c.run(T, { type: 'edit_record', recordId, patch });
    expect(edited.items[0]).toMatchObject({ type: 'record_edited', record: { id: recordId, note: '历史修正', ...(kind === 'ledger' ? { amountCents: 3000 } : { minutes: 35 }) } });
    expect((await getPlan(c.db, c.userId, planId)).status).toBe('archived');
    await expect(c.run(T, add)).rejects.toMatchObject({ code: 'plan_archived' });
  });
});
