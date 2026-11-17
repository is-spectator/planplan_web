import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeLlm } from '../src/ai/llm.js';
import type { TurnWrite } from '../src/ai/turn.js';
import { createApp } from '../src/api/app.js';
import { issueToken } from '../src/api/auth.js';
import type { Queryable } from '../src/db/db.js';
import { Chat, type Card } from '../src/services/chat.js';
import { execute, executeInTransaction, undo, type Action, type OperationResult } from '../src/services/engine.js';
import { recordWithRefundSnapshot } from '../src/services/refund-snapshot.js';
import { setup } from './helpers.js';

const T = new Date('2026-11-16T12:00:00+08:00'), today = '2026-11-16';
const recordId = (result: OperationResult) => { const item = result.items[0]!; if (!('record' in item)) throw new Error('fixture'); return item.record.id; };
const card = <K extends Card['type']>(cards: Card[], type: K) => cards.find(c => c.type === type) as Extract<Card, { type: K }> | undefined;
async function fixture(withRefund = true) {
  const c = await setup();
  await c.run(T.toISOString(), { type: 'create_ledger' });
  const expenseId = recordId(await c.run(T.toISOString(), { type: 'add_expense', amountCents: 5000, category: '购物', date: '2026-11-01', note: '耳机' }));
  const refundOperation = withRefund ? await c.run(T.toISOString(), { type: 'add_refund', expenseId, amountCents: 1000, date: today }) : null;
  const refundId = refundOperation ? recordId(refundOperation) : null;
  const detail = () => recordWithRefundSnapshot(c.db, c.userId, expenseId);
  const business = async () => ({ records: await c.db.query('SELECT id,kind,version,deleted,amount_cents,occurred_on,note FROM records ORDER BY id'), users: await c.db.query('SELECT data_version FROM users ORDER BY id') });
  const deletion = async (): Promise<Extract<Action, { type: 'delete_record' }>> => {
    const d = await detail(); return { type: 'delete_record', recordId: expenseId, expectedVersion: d.record.version, expectedRefundSnapshot: d.refundSnapshot!.token, includeRefunds: true };
  };
  return { ...c, expenseId, refundId, refundOperation, detail, business, deletion };
}

describe('关联退款快照', () => {
  it('详情由一个SQL读取原记录与退款集合，金额/笔数一致且不暴露成员ID', async () => {
    const c = await fixture(); const statements: string[] = [];
    const query: Queryable = { query: async <R>(sql: string, values?: unknown[]) => { statements.push(sql); return c.db.query<R>(sql, values); } };
    const result = await recordWithRefundSnapshot(query, c.userId, c.expenseId);
    expect(statements).toHaveLength(1);
    expect(result.refundSnapshot).toEqual({ token: expect.stringMatching(/^refunds-v1:[a-f0-9]{64}$/), count: 1, totalCents: 1000 });
    expect(JSON.stringify(result)).not.toContain(c.refundId);
    expect((await c.detail()).refundSnapshot).toEqual(result.refundSnapshot);
    await expect(recordWithRefundSnapshot(c.db, randomUUID(), c.expenseId)).rejects.toMatchObject({ code: 'not_found' });
  });

  it.each(['add', 'amount', 'date', 'note', 'delete', 'undo-delete', 'undo-add', 'same-amount-replacement'])('确认后%s变化拒绝旧集合，整批业务零写入，不提升父记录版本', async change => {
    const c = await fixture(); const stale = await c.deletion(); const before = (await c.detail()).refundSnapshot!;
    if (change === 'add') await c.run(T.toISOString(), { type: 'add_refund', expenseId: c.expenseId, amountCents: 500, date: today });
    if (change === 'amount') await c.run(T.toISOString(), { type: 'edit_record', recordId: c.refundId!, patch: { amountCents: 1200 } });
    if (change === 'date') await c.run(T.toISOString(), { type: 'edit_record', recordId: c.refundId!, patch: { date: '2026-11-15' } });
    if (change === 'note') await c.run(T.toISOString(), { type: 'edit_record', recordId: c.refundId!, patch: { note: '另一个说明' } });
    if (['delete', 'undo-delete', 'same-amount-replacement'].includes(change)) {
      const removed = await c.run(T.toISOString(), { type: 'delete_record', recordId: c.refundId! });
      if (change === 'undo-delete') await undo(c.db, c.at(T.toISOString()), removed.operationId, randomUUID());
      if (change === 'same-amount-replacement') await c.run(T.toISOString(), { type: 'add_refund', expenseId: c.expenseId, amountCents: 1000, date: today });
    }
    if (change === 'undo-add') await undo(c.db, c.at(T.toISOString()), c.refundOperation!.operationId, randomUUID());
    const current = await c.detail(); expect(current.record.version).toBe(stale.expectedVersion);
    expect(current.refundSnapshot!.token).not.toBe(before.token);
    if (['undo-delete', 'same-amount-replacement', 'date', 'note'].includes(change)) expect(current.refundSnapshot).toMatchObject({ count: before.count, totalCents: before.totalCents });
    const saved = await c.business();
    await expect(c.run(T.toISOString(), { type: 'add_expense', amountCents: 100, category: '其他', date: today }, stale)).rejects.toMatchObject({ code: 'version_conflict', details: { refundSnapshot: current.refundSnapshot } });
    expect(await c.business()).toEqual(saved);
  });

  it('零退款快照也会阻止随后新增退款；旧普通删除继续受has_refunds保护', async () => {
    const c = await fixture(false); const initial = await c.detail(); expect(initial.refundSnapshot).toMatchObject({ count: 0, totalCents: 0 });
    const action = { ...(await c.deletion()), includeRefunds: false };
    await c.run(T.toISOString(), { type: 'add_refund', expenseId: c.expenseId, amountCents: 500, date: today });
    await expect(c.run(T.toISOString(), action)).rejects.toMatchObject({ code: 'version_conflict' });
    await expect(c.run(T.toISOString(), { type: 'delete_record', recordId: c.expenseId })).rejects.toMatchObject({ code: 'has_refunds' });
    expect((await c.detail()).record.deleted).toBe(false);
  });

  it('旧无快照级联安全拒绝；无关联退款的普通删除保持兼容', async () => {
    const c = await fixture(); const before = await c.business();
    await expect(c.run(T.toISOString(), { type: 'delete_record', recordId: c.expenseId, includeRefunds: true })).rejects.toMatchObject({ code: 'refund_confirmation_required' });
    expect(await c.business()).toEqual(before);
    await c.run(T.toISOString(), { type: 'delete_record', recordId: c.refundId! });
    await c.run(T.toISOString(), { type: 'delete_record', recordId: c.expenseId });
    expect((await c.detail()).record.deleted).toBe(true);
  });

  it('新快照允许整组删除和整次撤销；原成功请求在之后集合变化后只恢复原回执', async () => {
    const c = await fixture(); const action = await c.deletion(), id = randomUUID(), ctx = c.at(T.toISOString());
    const saved = await execute(c.db, ctx, id, [action]);
    expect(saved.items[0]).toMatchObject({ type: 'record_deleted', records: expect.arrayContaining([expect.objectContaining({ id: c.expenseId, deleted: true }), expect.objectContaining({ id: c.refundId, deleted: true })]) });
    await undo(c.db, ctx, saved.operationId, randomUUID());
    await c.run(T.toISOString(), { type: 'add_refund', expenseId: c.expenseId, amountCents: 500, date: today });
    const current = await c.business();
    expect(await execute(c.db, ctx, id, [action])).toMatchObject({ operationId: saved.operationId, replayed: true });
    // An old stored receipt has no request hash; adding the optional precondition
    // must not stop its original legacy body from recovering that same receipt.
    expect(await execute(c.db, ctx, id, [{ type: 'delete_record', recordId: c.expenseId, includeRefunds: true }])).toMatchObject({ operationId: saved.operationId, replayed: true });
    expect(await c.business()).toEqual(current);
  });

  it('HTTP详情与409包含可重新核对的数据；无权账户得不到原记录或快照', async () => {
    const c = await fixture();
    const config = { jwtSecret: new TextEncoder().encode('snapshot-local-test-secret-not-live'), appleAudience: null, devLogin: false };
    const app = createApp(c.db, new FakeLlm(() => ({ intent: 'smalltalk', reply: '' })), config);
    const headers = { authorization: `Bearer ${await issueToken(config, c.userId, 0)}`, 'content-type': 'application/json', 'x-planplan-capabilities': 'generic-record-v1' };
    const get = () => app.request(`/v1/records/${c.expenseId}`, { headers });
    const initial = await (await get()).json(); expect(initial.record.refundedCents).toBe(initial.refundSnapshot.totalCents);
    const [other] = await c.db.query<{ id: string }>('INSERT INTO users(dev_name) VALUES($1) RETURNING id', [`snapshot-other-${randomUUID()}`]);
    const forbidden = await app.request(`/v1/records/${c.expenseId}`, { headers: { authorization: `Bearer ${await issueToken(config, other!.id, 0)}` } });
    expect(forbidden.status).toBe(404); expect(JSON.stringify(await forbidden.json())).not.toContain(initial.refundSnapshot.token);
    const stale = await c.deletion(); await c.run(T.toISOString(), { type: 'add_refund', expenseId: c.expenseId, amountCents: 500, date: today });
    const post = (id: string, actions: Action[]) => app.request('/v1/operations', { method: 'POST', headers, body: JSON.stringify({ clientOpId: id, inputAt: T.toISOString(), actions }) });
    const conflict = await post(randomUUID(), [stale]); expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'version_conflict', details: { record: { refundedCents: 1500 }, refundSnapshot: { count: 2, totalCents: 1500 } } } });
    const legacy = await post(randomUUID(), [{ type: 'delete_record', recordId: c.expenseId, includeRefunds: true }]); expect(legacy.status).toBe(409);
    expect(await legacy.json()).toMatchObject({ error: { code: 'refund_confirmation_required' } });
    const current = await c.deletion(), id = randomUUID(); const saved = await post(id, [current]); expect(saved.status).toBe(200);
    const result = await saved.json(); const replay = await post(id, [current]); expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ operationId: result.operationId, replayed: true });
  });

  it('HTTP可恢复历史无请求hash的旧成功级联回执，但旧未执行队列不能自动补快照', async () => {
    const c = await fixture(); const ctx = c.at(T.toISOString()), oldId = randomUUID();
    // The persisted operation shape predates request hashes and does not store
    // action bodies. Seed it through the protected engine, then replay the old body.
    const saved = await execute(c.db, ctx, oldId, [await c.deletion()]);
    expect(await c.db.query('SELECT * FROM template_operation_requests WHERE client_op_id=$1', [oldId])).toHaveLength(0);
    await undo(c.db, ctx, saved.operationId, randomUUID());
    await c.run(T.toISOString(), { type: 'add_refund', expenseId: c.expenseId, amountCents: 500, date: today });
    const before = await c.business();
    const config = { jwtSecret: new TextEncoder().encode('legacy-snapshot-local-secret-only'), appleAudience: null, devLogin: false };
    const app = createApp(c.db, new FakeLlm(() => ({ intent: 'smalltalk', reply: '' })), config);
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${await issueToken(config, c.userId, 0)}`, 'x-planplan-capabilities': 'generic-record-v1' };
    const post = (id: string) => app.request('/v1/operations', { method: 'POST', headers, body: JSON.stringify({ clientOpId: id, actions: [{ type: 'delete_record', recordId: c.expenseId, includeRefunds: true }] }) });
    const old = await post(oldId); expect(old.status).toBe(200); expect(await old.json()).toMatchObject({ operationId: saved.operationId, replayed: true });
    const queued = await post(randomUUID()); expect(queued.status).toBe(409);
    expect(await queued.json()).toMatchObject({ error: { code: 'refund_confirmation_required', message: expect.stringContaining('逐笔删除退款') } });
    expect(await c.business()).toEqual(before);
  });

  it.runIf(!!process.env.TEST_DATABASE_URL)('PostgreSQL用户锁覆盖比较到删除；先提交的新退款使排队的旧确认失效', async () => {
    const c = await fixture(); const stale = await c.deletion(); let entered!: () => void, release!: () => void, writerPid = 0;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const writer = c.db.tx(async q => {
      writerPid = (await q.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]!.pid;
      await executeInTransaction(q, c.at(T.toISOString()), randomUUID(), [{ type: 'add_refund', expenseId: c.expenseId, amountCents: 500, date: today }]);
      entered(); await gate;
    }, c.userId);
    await started;
    const queued = execute(c.db, c.at(T.toISOString()), randomUUID(), [stale]).then(() => 'unexpected-success', error => (error as { code: string }).code);
    try {
      // Prove the second transaction actually waits for this user's lock before
      // releasing the writer; a serial execution alone would miss a missing lock.
      await expect.poll(async () => (await c.db.query<{ waiting: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND $1=ANY(pg_blocking_pids(pid))) AS waiting`, [writerPid],
      ))[0]!.waiting, { timeout: 3000, interval: 20 }).toBe(true);
    } finally { release(); await writer; }
    expect(await queued).toBe('version_conflict');
    expect((await c.detail()).refundSnapshot).toMatchObject({ count: 2, totalCents: 1500 }); expect((await c.detail()).record.deleted).toBe(false);
  });
});

const deleteWrite = (id: string, note: string | null = null): TurnWrite => ({ op: 'delete_record', is_fact: true, amount_text: null, currency: 'CNY', duration_value: null, duration_unit: null, category: null, date_kind: 'today', days_ago: null, date: null, note, plan_id: null, plan_name: null, activity: null, days_per_week: null, min_minutes: null, scope: 'unspecified', record_id: id, component: null });
describe('对话退款删除确认', () => {
  it('选择发问时快照后若集合改变，重新列出金额确认；新确认保存且同ID恢复不重复', async () => {
    const c = await fixture(); const llm = new FakeLlm(() => ({ intent: 'write', writes: [deleteWrite(c.expenseId)] })); const chat = new Chat(c.db, llm);
    const send = (text: string, extra: Partial<Parameters<Chat['send']>[1]> = {}) => chat.send(c.userId, { clientMsgId: randomUUID(), text, inputAt: T, ...extra });
    const first = card((await send('删除耳机那笔支出')).assistant.cards, 'clarify')!;
    expect(first.question).toContain('1 笔退款'); expect(first.question).toContain('10');
    expect(JSON.stringify(first)).not.toContain('refunds-v1');
    await c.run(T.toISOString(), { type: 'add_refund', expenseId: c.expenseId, amountCents: 500, date: today });
    const oldChoice = first.options.find(option => option.style === 'primary')!;
    const changed = card((await send(oldChoice.label, { pendingId: first.pendingId, choice: oldChoice.id })).assistant.cards, 'clarify')!;
    expect(changed.question).toContain('重新核对'); expect(changed.question).toContain('2 笔退款'); expect(changed.question).toContain('15');
    expect((await c.detail()).record.deleted).toBe(false);
    const choice = changed.options.find(option => option.style === 'primary')!, input = { clientMsgId: randomUUID(), pendingId: changed.pendingId, choice: choice.id };
    const saved = await send(choice.label, input); expect(card(saved.assistant.cards, 'receipt')?.items[0]).toMatchObject({ type: 'record_deleted', records: expect.any(Array) });
    expect((await send(choice.label, input)).assistant.id).toBe(saved.assistant.id); expect(llm.calls).toHaveLength(1);
    expect(await c.db.query('SELECT id FROM records WHERE NOT deleted')).toHaveLength(0);
  });

  it('旧pending只有__with_refunds__时不补当前快照执行，而是重新确认', async () => {
    const c = await fixture(); const chat = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [deleteWrite(c.expenseId)] })));
    const first = await chat.send(c.userId, { clientMsgId: randomUUID(), text: '删除耳机支出', inputAt: T }); const pending = card(first.assistant.cards, 'clarify')!;
    const [stored] = await c.db.query<{ draft: { options: { id: string; patches: unknown[] }[] } }>('SELECT draft FROM pending_actions WHERE id=$1', [pending.pendingId]);
    const option = pending.options.find(option => option.style === 'primary')!;
    stored!.draft.options.find(value => value.id === option.id)!.patches = [{ k: 'set', idx: 0, field: 'record_id', value: c.expenseId }, { k: 'set', idx: 0, field: 'note', value: '__with_refunds__' }];
    await c.db.query('UPDATE pending_actions SET draft=$2 WHERE id=$1', [pending.pendingId, JSON.stringify(stored!.draft)]);
    const out = await chat.send(c.userId, { clientMsgId: randomUUID(), text: option.label, inputAt: T, pendingId: pending.pendingId, choice: option.id });
    expect(card(out.assistant.cards, 'clarify')?.question).toContain('重新核对'); expect(card(out.assistant.cards, 'receipt')).toBeUndefined();
    expect((await c.detail()).record.deleted).toBe(false);
  });

  it('模型自行输出旧确认标记不能绕过用户选择', async () => {
    const c = await fixture(); const chat = new Chat(c.db, new FakeLlm(() => ({ intent: 'write', writes: [deleteWrite(c.expenseId, '__with_refunds__')] })));
    const out = await chat.send(c.userId, { clientMsgId: randomUUID(), text: '删除耳机支出和退款', inputAt: T });
    expect(card(out.assistant.cards, 'clarify')).toBeDefined(); expect((await c.detail()).record.deleted).toBe(false);
  });
});
