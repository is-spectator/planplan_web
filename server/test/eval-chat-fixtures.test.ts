import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeLlm } from '../src/ai/llm.js';
import { sanitizeTurn } from '../src/ai/turn.js';
import { Chat } from '../src/services/chat.js';
import { execute } from '../src/services/engine.js';
import { runQuery } from '../src/services/query.js';
import { CASES } from '../evals/cases.js';
import { INPUT_AT, TODAY, makeFixture, type Fixture, type FixtureName } from '../evals/fixtures.js';
import { judgeQuery } from '../evals/query-expectations.js';
import { DATASET_REVIEW, isReviewed } from '../evals/review.js';
import { runCase } from '../evals/runner.js';

const opened: Fixture[] = [];
async function fixture(name: FixtureName) { const fx = await makeFixture(name); opened.push(fx); return fx; }
afterEach(async () => { for (const fx of opened.splice(0)) await fx.db.close(); });
const undoModel = () => new FakeLlm(() => sanitizeTurn({ intent: 'write', writes: [{ op: 'undo_last', is_fact: true }] })!);
const records = (fx: Fixture) => fx.db.query<{ id: string; source: string; source_message_id: string | null; deleted: boolean; note: string; version: number }>('SELECT id, source, source_message_id, deleted, note, version FROM records WHERE user_id=$1 ORDER BY id', [fx.userId]);

describe('撤销评测的聊天回执前提独立于普通表单夹具', () => {
  it('默认夹具仍只有表单事实，聊天撤销不得改变它们', async () => {
    const fx = await fixture('default'), before = await records(fx);
    expect(before).toHaveLength(6);
    expect(before.every(record => record.source === 'form' && record.source_message_id === null)).toBe(true);
    expect(await fx.db.query('SELECT id FROM messages WHERE user_id=$1', [fx.userId])).toEqual([]);
    const chat = new Chat(fx.db, undoModel());
    const reply = await chat.send(fx.userId, { clientMsgId: randomUUID(), text: '撤销刚才', inputAt: INPUT_AT });
    expect(reply.assistant.text).toContain('没有找到可撤销的保存回执');
    expect(reply.assistant.cards.some(card => card.type === 'receipt')).toBe(false);
    expect(await records(fx)).toEqual(before);
  });

  it('新夹具通过 Chat 真实保存同批两条及可见回执，既有金额/分钟事实不变', async () => {
    const fx = await fixture('chat_receipt'), rows = await records(fx);
    const chatRecords = rows.filter(record => record.source === 'chat');
    expect(rows).toHaveLength(6);
    expect(chatRecords.map(record => record.id).sort()).toEqual([fx.records.lunch, fx.records.read25].sort());
    expect(new Set(chatRecords.map(record => record.source_message_id)).size).toBe(1);
    expect(chatRecords.every(record => record.source_message_id !== null)).toBe(true);
    expect(rows.filter(record => record.source === 'form')).toHaveLength(4);
    const receipts = await fx.db.query<{ id: string }>(`SELECT o.id FROM messages u JOIN operations o ON o.user_id=u.user_id AND o.client_op_id=u.client_msg_id JOIN messages a ON a.user_id=u.user_id AND a.reply_to=u.id WHERE u.user_id=$1 AND u.role='user' AND a.role='assistant' AND o.kind='batch'`, [fx.userId]);
    expect(receipts).toHaveLength(1);
    const history = await new Chat(fx.db, undoModel()).history(fx.userId);
    expect(history).toHaveLength(2);
    const receipt = history.find(message => message.role === 'assistant')!.cards.find(card => card.type === 'receipt');
    expect(receipt).toMatchObject({ operationId: receipts[0]!.id, kind: 'batch', undoable: true });
    expect(receipt?.items).toHaveLength(2);
    const budget = await runQuery(fx.db, fx.userId, { kind: 'budget', period: 'this_month', plan_id: null, from: null, to: null, category: null }, TODAY, null);
    expect(judgeQuery('Q001', fx, [budget])).toEqual({ pass: true, reason: '' });
    const study = await fx.db.query<{ total: number }>('SELECT sum(minutes)::int AS total FROM records WHERE user_id=$1 AND plan_id=$2 AND NOT deleted', [fx.userId, fx.plans.read]);
    expect(study).toEqual([{ total: 45 }]);
  });

  it.each(['C008', 'C026', 'C032'])('%s 保留原 lunch/read25 预期，真实撤销夹具通过且旧表单夹具仍失败', async id => {
    const c = CASES.find(item => item.id === id)!;
    expect(c.fixture).toBe('chat_receipt');
    expect(c.expect).toEqual({ kind: 'undo', targets: ['lunch', 'read25'] });
    const old = await runCase({ ...c, fixture: 'default' }, 0, undoModel());
    expect(old.pass).toBe(false);
    expect(old.reply).toContain('没有找到可撤销的保存回执');
    expect(old.wrongFactWrites).toBe(0);
    const corrected = await runCase(c, 0, undoModel());
    expect(corrected.pass, corrected.reason).toBe(true);
    expect(corrected.cards).toContain('receipt');
  });

  it('C039 裸撤销先严格澄清且零写，再选服务器唯一回执执行原最终目标', async () => {
    const c = CASES.find(item => item.id === 'C039')!;
    expect(c.fixture).toBe('chat_receipt');
    expect(c.expect).toEqual({ kind: 'clarify', issue: '需要选保存回执' });
    expect(c.followUps).toEqual([{ text: '确认撤销这次保存', chooseOnlyOption: true, expect: { kind: 'undo', targets: ['lunch', 'read25'] } }]);
    const llm = undoModel();
    const result = await runCase(c, 0, llm);
    expect(result.pass, result.reason).toBe(true);
    expect(result.wrongFactWrites).toBe(0);
    expect(result.cards).toContain('receipt');
    expect(llm.calls).toHaveLength(1); // The follow-up submits the stored server choice, not a model decision.
  });

  it.each([
    { label: '多个', issue: '需要选计划', duration: 30 },
    { label: '零个', issue: '时长不是整分钟', duration: 0.5 },
  ])('$label非取消选项时不猜测、不发第二轮', async ({ issue, duration }) => {
    const base = CASES.find(item => item.id === 'C039')!;
    const llm = new FakeLlm(() => sanitizeTurn({ intent: 'write', writes: [{ op: 'add_study', is_fact: true, duration_value: duration, duration_unit: 'minute', date_kind: 'today' }] })!);
    const result = await runCase({ ...base, fixture: 'default', text: `学习了${duration}分钟`, expect: { kind: 'clarify', issue } }, 0, llm);
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('第 2 轮没有可唯一选择的已验收澄清选项');
    expect(result.wrongFactWrites).toBe(0);
    expect(llm.calls).toHaveLength(1);
  });

  it('首轮应澄清却实际写入时立即失败，不跳过零写断言继续选择', async () => {
    const c = CASES.find(item => item.id === 'C039')!;
    const llm = new FakeLlm(() => sanitizeTurn({ intent: 'write', writes: [{ op: 'add_expense', is_fact: true, amount_text: '37', currency: 'CNY', category: '餐饮', note: '错误事实', date_kind: 'today' }] })!);
    const result = await runCase(c, 0, llm);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('第 1 轮：期望追问且不保存');
    expect(result.wrongFactWrites).toBe(1);
    expect(llm.calls).toHaveLength(1);
  });

  it('后来的表单记录不改变撤销目标，只撤对应的原聊天两条', async () => {
    const fx = await fixture('chat_receipt'), before = await records(fx);
    const [original] = await fx.db.query<{ id: string }>('SELECT o.id FROM operations o JOIN messages m ON m.user_id=o.user_id AND m.client_msg_id=o.client_op_id WHERE o.user_id=$1 AND m.role=\'user\' AND o.kind=\'batch\'', [fx.userId]);
    const later = await execute(fx.db, { userId: fx.userId, source: 'form', inputAt: new Date('2026-10-26T12:40:00+08:00') }, randomUUID(), [{ type: 'add_expense', amountCents: 900, category: '交通', date: TODAY, note: '后来手动公交' }]);
    const laterRecord = later.items.find(item => item.type === 'expense_added');
    if (!laterRecord || !('record' in laterRecord)) throw new Error('Later form fixture did not save');
    const reply = await new Chat(fx.db, undoModel()).send(fx.userId, { clientMsgId: randomUUID(), text: '撤销刚才', inputAt: INPUT_AT });
    const receipt = reply.assistant.cards.find(card => card.type === 'receipt');
    expect(receipt?.items[0]).toMatchObject({ type: 'undone', of: original!.id });
    const after = await records(fx);
    expect(after.filter(record => record.deleted).map(record => record.id).sort()).toEqual([fx.records.lunch, fx.records.read25].sort());
    expect(after.find(record => record.id === laterRecord.record.id)).toMatchObject({ source: 'form', deleted: false, version: 1, note: '后来手动公交' });
    for (const record of before.filter(record => record.source === 'form')) expect(after.find(item => item.id === record.id)).toEqual(record);
  });

  it('只标记已确认的撤销案例，评测仍未人工审定', () => {
    expect(CASES.filter(c => c.fixture === 'chat_receipt').map(c => c.id)).toEqual(['C008', 'C026', 'C032', 'C039']);
    expect(CASES).toHaveLength(330);
    expect(DATASET_REVIEW.version).toBe('v1.2-chat-undo-fixture');
    expect(isReviewed(DATASET_REVIEW)).toBe(false);
    expect(DATASET_REVIEW).toMatchObject({ status: 'draft', productReviewer: null, testReviewer: null, reviewedAt: null });
  });
});
