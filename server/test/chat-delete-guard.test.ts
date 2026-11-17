import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeLlm } from '../src/ai/llm.js';
import type { TurnWrite } from '../src/ai/turn.js';
import { Chat, type Card } from '../src/services/chat.js';
import { execute, executeInTransaction, undo, type Action, type OperationResult } from '../src/services/engine.js';
import { recordWithRefundSnapshot } from '../src/services/refund-snapshot.js';
import { setup } from './helpers.js';

const T = new Date('2026-11-17T12:00:00+08:00'), today = '2026-11-17';
const w = (op: TurnWrite['op'], patch: Partial<TurnWrite> = {}): TurnWrite => ({ op, is_fact: true, amount_text: null, currency: 'CNY', duration_value: null, duration_unit: null, category: null, date_kind: 'today', days_ago: null, date: null, note: null, plan_id: null, plan_name: null, activity: null, days_per_week: null, min_minutes: null, scope: 'unspecified', record_id: null, component: null, ...patch });
const deleted = (id: string | null) => w('delete_record', { record_id: id });
const added = () => w('add_expense', { amount_text: '7', category: '餐饮', note: '不应部分新增' });
const card = <K extends Card['type']>(cards: Card[], type: K) => cards.find(c => c.type === type) as Extract<Card, { type: K }> | undefined;
const recordId = (result: OperationResult) => { const item = result.items[0]!; if (!('record' in item)) throw new Error('fixture'); return item.record.id; };
async function fixture() {
  const c = await setup(); const ledger = await c.run(T.toISOString(), { type: 'create_ledger' });
  const ledgerId = (ledger.items[0] as { plan: { id: string } }).plan.id;
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) ids.push(recordId(await c.run(T.toISOString(), { type: 'add_expense', amountCents: 1000 + i * 100, category: '餐饮', date: today, note: `明确记录${i + 1}` })));
  const business = async () => {
    const out: Record<string, unknown> = { users: await c.db.query('SELECT id,data_version FROM users ORDER BY id') };
    for (const table of ['records', 'plans', 'goal_segments', 'plan_lifecycle', 'operations', 'growth_points', 'house_items']) out[table] = await c.db.query(`SELECT row_to_json(t)::text row FROM ${table} t ORDER BY row_to_json(t)::text`);
    return out;
  };
  const send = (chat: Chat, text: string, extra: Partial<Parameters<Chat['send']>[1]> = {}) => chat.send(c.userId, { clientMsgId: randomUUID(), text, inputAt: T, ...extra });
  const pending = async (writes: TurnWrite[], originalText: string, patches: unknown[], restore = false) => {
    const messageId = randomUUID(), id = randomUUID();
    await c.db.query("INSERT INTO messages(id,user_id,role,text,client_msg_id) VALUES($1,$2,'user',$3,$4)", [messageId, c.userId, originalText, randomUUID()]);
    const draft = { writes, query: null, scopePlanId: null, originalText, pre: { createLedger: false, createStudy: null, restore: restore ? [ledgerId] : [] }, options: [{ id: 'old-choice', label: '只保存其余', style: 'primary', patches }, { id: 'cancel', label: '取消', style: 'cancel', patches: [{ k: 'cancel' }] }], messageId };
    await c.db.query('INSERT INTO pending_actions(id,user_id,message_id,draft,input_at) VALUES($1,$2,$3,$4,$5)', [id, c.userId, messageId, JSON.stringify(draft), T]);
    return id;
  };
  return { ...c, ids, ledgerId, business, send, pending };
}
const blocked = (out: Awaited<ReturnType<Chat['send']>>) => { expect(card(out.assistant.cards, 'receipt')).toBeUndefined(); expect(card(out.assistant.cards, 'clarify')).toBeUndefined(); expect(out.assistant.text).toContain('逐条'); expect(out.assistant.text).toContain('没有'); expect(out.transient).toBe(false); };

describe('聊天删除必须逐条明确核对', () => {
  it('A039真实失败形状：模型枚举六个合法ID，所有记录和业务版本保持不变', async () => {
    const c = await fixture(), llm = new FakeLlm(() => ({ intent: 'write', writes: c.ids.map(deleted) })), chat = new Chat(c.db, llm), before = await c.business();
    const input = { clientMsgId: randomUUID() }, out = await c.send(chat, '帮我删掉所有记录', input); blocked(out); expect(await c.business()).toEqual(before);
    expect((await c.send(chat, '帮我删掉所有记录', input)).assistant.id).toBe(out.assistant.id); expect((await chat.lookup(c.userId, input.clientMsgId))!.assistant.id).toBe(out.assistant.id); expect(llm.calls).toHaveLength(1);
  });
  it.each(['帮我删掉所有记录', '把这个计划的记录全部删除', '清空这个计划', '把这些记录都删掉', '删除今天的全部记录', '删除所有退款', '全删了', '记录都清理掉'])('宽泛请求“%s”即使模型只输出一个合法ID也零写入', async text => {
    const c = await fixture(), before = await c.business();
    blocked(await c.send(new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [deleted(c.ids[0]!)] }))), text)); expect(await c.business()).toEqual(before);
  });
  it('宽泛请求只有一个最近候选且模型未填ID也不能缩成单条删除', async () => {
    const c = await fixture(), before = await c.business();
    blocked(await c.send(new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [deleted(null)] }))), '全部删掉')); expect(await c.business()).toEqual(before);
  });
  it.each(['所有记录，删掉', '删掉，所有记录', '把全部记录\n删除', '全部记录;删除', '所有记录.删除', '全部记录:删除', 'Delete, all records', 'all records\ndelete'])('跨分句广范围“%s”不能执行模型缩成的一个合法ID', async text => {
    const c = await fixture(), before = await c.business();
    blocked(await c.send(new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [deleted(c.ids[0]!)] }))), text)); expect(await c.business()).toEqual(before);
  });
  it.each(['删除明确记录1那笔，其他所有保留', '其余所有记录保留;删除明确记录1那笔'])('明确单条加保留其余“%s”仍只删除指定记录', async text => {
    const c = await fixture(), out = await c.send(new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [deleted(c.ids[0]!)] }))), text);
    expect(card(out.assistant.cards, 'receipt')!.items[0]).toMatchObject({ type: 'record_deleted', records: [expect.objectContaining({ id: c.ids[0] })] });
    expect(await c.db.query('SELECT id FROM records WHERE deleted')).toEqual([{ id: c.ids[0] }]); expect(await c.db.query('SELECT id FROM records WHERE NOT deleted')).toHaveLength(5);
  });
  it('单父关联退款例外不能豁免同一请求另一分句的全记录删除', async () => {
    const c = await fixture(); await c.run(T.toISOString(), { type: 'add_refund', expenseId: c.ids[0]!, amountCents: 100, date: today }); const before = await c.business();
    blocked(await c.send(new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [deleted(c.ids[0]!)] }))), '删除这笔支出和它的全部关联退款，所有记录也删除')); expect(await c.business()).toEqual(before);
  });
  it('模型没有执行动作也不能把宽泛删除回答为已经成功', async () => {
    const c = await fixture(), before = await c.business();
    blocked(await c.send(new Chat(c.db, new FakeLlm(() => ({ intent: 'smalltalk', reply: '已经删除所有记录。' }))), '把所有记录删除')); expect(await c.business()).toEqual(before);
  });
  it('点击旧单条选项时的新文字不能将宽泛全删伪装成原单条确认', async () => {
    const c = await fixture(), id = await c.pending([deleted(c.ids[0]!)], '删除明确记录1', []), before = await c.business();
    blocked(await c.send(new Chat(c.db, new FakeLlm(() => { throw Error('Choice must not call model'); })), '把所有记录删除', { pendingId: id, choice: 'old-choice' })); expect(await c.business()).toEqual(before);
  });
  it.each(['two', 'duplicate', 'mixed', 'single-mixed'] as const)('%s批次在缺项追问和任何ready/pre动作之前整批拒绝', async kind => {
    const c = await fixture(), before = await c.business();
    const writes = kind === 'single-mixed' ? [added(), deleted(c.ids[0]!)] : [deleted(c.ids[0]!), deleted(kind === 'duplicate' ? c.ids[0]! : c.ids[1]!), ...(kind === 'mixed' ? [added(), w('create_study', { activity: '跑步' })] : [])];
    blocked(await c.send(new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes }))), '处理这几项')); expect(await c.business()).toEqual(before);
    expect(await c.db.query('SELECT id FROM pending_actions WHERE user_id=$1', [c.userId])).toHaveLength(0);
  });
  it('多条delete即使其中一条要确认关联退款也不提供“只保存其余”', async () => {
    const c = await fixture(); await c.run(T.toISOString(), { type: 'add_refund', expenseId: c.ids[0]!, amountCents: 100, date: today }); const before = await c.business();
    blocked(await c.send(new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [deleted(c.ids[0]!), deleted(c.ids[1]!)] }))), '删除这两笔')); expect(await c.business()).toEqual(before);
  });
  it('旧pending的移除选项不能把不安全批次缩成1条，并且不提前恢复归档计划', async () => {
    const c = await fixture(); await c.run(T.toISOString(), { type: 'archive_plan', planId: c.ledgerId });
    const id = await c.pending([deleted(c.ids[0]!), deleted(c.ids[1]!)], '删除这两笔', [{ k: 'remove', idx: 1 }], true), before = await c.business(), llm = new FakeLlm(() => { throw Error('Choice must not call model'); });
    blocked(await c.send(new Chat(c.db, llm), '只保存其余', { pendingId: id, choice: 'old-choice' })); expect(await c.business()).toEqual(before); expect(llm.calls).toHaveLength(0);
  });
  it('旧pending宽泛原文不能被下一轮单条模型输出或按钮文字覆盖', async () => {
    const c = await fixture(), id = await c.pending([deleted(c.ids[0]!)], '把所有记录删掉', []), before = await c.business();
    blocked(await c.send(new Chat(c.db, new FakeLlm(() => ({ intent: 'answer_pending', writes: [deleted(c.ids[0]!)] }))), '确认')); expect(await c.business()).toEqual(before);
    const second = await c.pending([deleted(c.ids[0]!)], '把所有记录删掉', []);
    blocked(await c.send(new Chat(c.db, new FakeLlm(() => { throw Error('Choice must not call model'); })), '只保存其余', { pendingId: second, choice: 'old-choice' })); expect(await c.business()).toEqual(before);
    expect(id).not.toBe(second);
  });
  it('旧pending原有两条删除不能由自然语言回答换成一条绕过', async () => {
    const c = await fixture(); await c.pending([deleted(c.ids[0]!), deleted(c.ids[1]!)], '处理这两项', []); const before = await c.business();
    blocked(await c.send(new Chat(c.db, new FakeLlm(() => ({ intent: 'answer_pending', writes: [deleted(c.ids[0]!)] }))), '先处理第一条')); expect(await c.business()).toEqual(before);
  });
  it('旧批量pending仍能取消，不改变任何业务数据', async () => {
    const c = await fixture(), id = await c.pending(c.ids.map(deleted), '全部删除', []), before = await c.business();
    const out = await c.send(new Chat(c.db, new FakeLlm(() => { throw Error('Choice must not call model'); })), '取消', { pendingId: id, choice: 'cancel' });
    expect(card(out.assistant.cards, 'receipt')).toBeUndefined(); expect(await c.business()).toEqual(before); expect(await c.db.query('SELECT status FROM pending_actions WHERE id=$1', [id])).toEqual([{ status: 'cancelled' }]);
  });
  it('明确单条删除、同ID恢复和整次撤销继续工作', async () => {
    const c = await fixture(), chat = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [deleted(c.ids[0]!)] }))), input = { clientMsgId: randomUUID() };
    const out = await c.send(chat, '删除明确记录1那笔支出', input), receipt = card(out.assistant.cards, 'receipt')!; expect(receipt.items[0]).toMatchObject({ type: 'record_deleted', records: [expect.objectContaining({ id: c.ids[0] })] });
    const beforeReplay = await c.business(); expect((await c.send(chat, '删除明确记录1那笔支出', input)).assistant.id).toBe(out.assistant.id); expect(await c.business()).toEqual(beforeReplay);
    await undo(c.db, c.at(T.toISOString()), receipt.operationId, randomUUID()); expect(await c.db.query('SELECT id FROM records WHERE deleted')).toHaveLength(0);
  });
  it('明确删除归档计划中的一条记录，不擅自恢复计划', async () => {
    const c = await fixture(); await c.run(T.toISOString(), { type: 'archive_plan', planId: c.ledgerId });
    const out = await c.send(new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [deleted(c.ids[0]!)] }))), '删除明确记录1那笔支出');
    expect(card(out.assistant.cards, 'receipt')!.items[0]).toMatchObject({ type: 'record_deleted', records: [expect.objectContaining({ id: c.ids[0] })] });
    expect(await c.db.query('SELECT status FROM plans WHERE id=$1', [c.ledgerId])).toEqual([{ status: 'archived' }]);
    expect(await c.db.query('SELECT id FROM records WHERE deleted')).toEqual([{ id: c.ids[0] }]);
  });
  it('旧服务器恢复确认包含单条明确删除时仍只恢复并删除该目标', async () => {
    const c = await fixture(); await c.run(T.toISOString(), { type: 'archive_plan', planId: c.ledgerId });
    const id = await c.pending([deleted(c.ids[0]!)], '恢复计划并删除明确记录1那笔支出', [], true), llm = new FakeLlm(() => { throw Error('Choice must not call model'); });
    const out = await c.send(new Chat(c.db, llm), '确认恢复并删除这条记录', { pendingId: id, choice: 'old-choice' }), receipt = card(out.assistant.cards, 'receipt')!;
    expect(receipt.items.map(item => item.type)).toEqual(['plan_updated', 'record_deleted']);
    expect(await c.db.query('SELECT status FROM plans WHERE id=$1', [c.ledgerId])).toEqual([{ status: 'active' }]);
    expect(await c.db.query('SELECT id FROM records WHERE deleted')).toEqual([{ id: c.ids[0] }]); expect(llm.calls).toHaveLength(0);
  });
  it('一条支出与其全部关联退款仍必须选服务器快照，选择后只删该组且可恢复', async () => {
    const c = await fixture(); for (const amountCents of [100, 200]) await c.run(T.toISOString(), { type: 'add_refund', expenseId: c.ids[0]!, amountCents, date: today });
    const chat = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [deleted(c.ids[0]!)] }))), before = await c.business();
    const out = await c.send(chat, '删除这笔支出和它的全部关联退款'), pending = card(out.assistant.cards, 'clarify')!; expect(pending.question).toContain('2 笔退款'); expect(await c.business()).toEqual(before);
    const option = pending.options.find(o => o.style === 'primary')!, input = { pendingId: pending.pendingId, choice: option.id, clientMsgId: randomUUID() };
    const saved = await c.send(chat, option.label, input); expect(card(saved.assistant.cards, 'receipt')!.items[0]).toMatchObject({ type: 'record_deleted', records: expect.any(Array) });
    expect(await c.db.query('SELECT id FROM records WHERE deleted')).toHaveLength(3); const after = await c.business(); expect((await c.send(chat, option.label, input)).assistant.id).toBe(saved.assistant.id); expect(await c.business()).toEqual(after);
  });
});

describe('engine聊天删除结构保护与旧回执', () => {
  it.each(['execute', 'transaction'] as const)('%s拒绝新chat批量删除，混合前置写入也零变更', async entry => {
    const c = await fixture(), before = await c.business(), ctx = { ...c.at(T.toISOString()), source: 'chat' as const }, actions: Action[] = [{ type: 'add_expense', amountCents: 700, category: '餐饮', date: today }, ...c.ids.slice(0, 2).map(recordId => ({ type: 'delete_record' as const, recordId }))];
    const op = randomUUID(); await expect(entry === 'execute' ? execute(c.db, ctx, op, actions) : c.db.tx(q => executeInTransaction(q, ctx, op, actions), c.userId)).rejects.toMatchObject({ code: 'invalid_input' }); expect(await c.business()).toEqual(before);
  });
  it('form批量保持原契约；已成功旧chat批量回执在保护前返回而不再执行', async () => {
    const c = await fixture(), op = randomUUID(), actions: Action[] = c.ids.slice(0, 2).map(recordId => ({ type: 'delete_record', recordId }));
    const saved = await execute(c.db, c.at(T.toISOString()), op, actions); expect(saved.items).toHaveLength(2); const after = await c.business(), ctx = { ...c.at(T.toISOString()), source: 'chat' as const };
    expect(await execute(c.db, ctx, op, actions)).toMatchObject({ operationId: saved.operationId, replayed: true }); expect(await c.db.tx(q => executeInTransaction(q, ctx, op, actions), c.userId)).toMatchObject({ operationId: saved.operationId, replayed: true }); expect(await c.business()).toEqual(after);
  });
  it('单个chat父删除动作可按明确快照删除多个关联退款', async () => {
    const c = await fixture(); for (const amountCents of [100, 200]) await c.run(T.toISOString(), { type: 'add_refund', expenseId: c.ids[0]!, amountCents, date: today });
    const detail = await recordWithRefundSnapshot(c.db, c.userId, c.ids[0]!); const out = await execute(c.db, { ...c.at(T.toISOString()), source: 'chat' }, randomUUID(), [{ type: 'delete_record', recordId: c.ids[0]!, expectedVersion: detail.record.version, expectedRefundSnapshot: detail.refundSnapshot!.token, includeRefunds: true }]);
    expect(out.items).toHaveLength(1); expect((out.items[0] as { records: unknown[] }).records).toHaveLength(3);
  });
});

describe('明确最近整批撤销不是宽泛删除', () => {
  it.each([false, true])('刚才记的都撤销：unknown=%s，后来form保持，未知名称不得猜最近', async unknown => {
    const c = await fixture(), chat = new Chat(c.db, new FakeLlm(text => text.includes('撤销') ? { intent: 'write', writes: [w('undo_last')] } : { intent: 'write', writes: [w('add_expense', { amount_text: '18', category: '餐饮', note: '午饭' }), w('add_expense', { amount_text: '12', category: '餐饮', note: '咖啡' })] }));
    const first = await c.send(chat, '午饭18元，咖啡12元'), receipt = card(first.assistant.cards, 'receipt')!;
    const laterId = recordId(await c.run(T.toISOString(), { type: 'add_expense', amountCents: 9900, category: '其他', date: today, note: '后来手动' })), before = await c.business();
    const out = await c.send(chat, unknown ? '把刚才记的买药都撤销' : '把刚才记的都撤销');
    if (unknown) { expect(card(out.assistant.cards, 'receipt')).toBeUndefined(); expect(card(out.assistant.cards, 'clarify')).toBeDefined(); expect(await c.business()).toEqual(before); }
    else { expect(card(out.assistant.cards, 'receipt')!.items[0]).toMatchObject({ type: 'undone', of: receipt.operationId }); expect(await c.db.query('SELECT id FROM records WHERE deleted')).toHaveLength(2); }
    expect(await c.db.query('SELECT deleted FROM records WHERE id=$1', [laterId])).toEqual([{ deleted: false }]);
  });
});
