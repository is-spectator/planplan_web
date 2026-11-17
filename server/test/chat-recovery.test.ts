import { describe, expect, it, vi } from 'vitest';
import { Chat, type Card } from '../src/services/chat.js';
import { FakeLlm, type Llm } from '../src/ai/llm.js';
import type { TurnWrite } from '../src/ai/turn.js';
import { setup } from './helpers.js';
import { createApp } from '../src/api/app.js';
import { issueToken } from '../src/api/auth.js';

const T = new Date('2026-10-26T23:59:00+08:00');
const expense: TurnWrite = {
  op: 'add_expense', is_fact: true, amount_text: '20', currency: 'CNY', duration_value: null, duration_unit: null, category: '餐饮',
  date_kind: 'today', days_ago: null, date: null, note: '午饭', plan_id: null, plan_name: null, activity: null,
  days_per_week: null, min_minutes: null, scope: 'unspecified', record_id: null, component: null,
};
const auth = { jwtSecret: new TextEncoder().encode('recovery-test-only-secret-at-least-32-bytes'), appleAudience: null, devLogin: false };

describe('对话结果只读恢复', () => {
  it('回执丢失后返回原操作，读取及同标识重试不再调用模型或写入', async () => {
    const c = await setup();
    try {
      const created = await c.run(T.toISOString(), { type: 'create_ledger' });
      const planId = (created.items[0] as { plan: { id: string } }).plan.id;
      const llm = new FakeLlm(() => ({ intent: 'write', writes: [expense] }));
      const chat = new Chat(c.db, llm);
      const input = { clientMsgId: 'lost-response-original', text: '午饭20元', inputAt: T, scopePlanId: planId };
      const first = await chat.send(c.userId, input);
      const receipt = first.assistant.cards.find((x): x is Extract<Card, { type: 'receipt' }> => x.type === 'receipt')!;
      await c.db.query('DELETE FROM messages WHERE id=$1', [first.assistant.id]);
      const before = await c.db.query('SELECT id FROM messages');
      const recovered = await chat.lookup(c.userId, input.clientMsgId);
      expect(recovered!.assistant.id).toBe(`recovered:${receipt.operationId}`);
      expect(recovered!.assistant.scopePlanId).toBe(planId);
      expect(recovered!.assistant.text).toContain('原操作回执');
      expect(recovered!.assistant.cards[0]).toMatchObject({ operationId: receipt.operationId, items: receipt.items, growth: receipt.growth });
      expect(receipt.growth).toMatchObject({ earned: 1, total: 1 });
      expect((await c.db.query<{ result: { createdAt: string } }>('SELECT result FROM operations WHERE id=$1', [receipt.operationId]))[0]!.result.createdAt).toBe(recovered!.assistant.createdAt);
      expect(await c.db.query('SELECT id FROM messages')).toEqual(before);
      expect((await chat.send(c.userId, input)).assistant.id).toBe(recovered!.assistant.id);
      expect(llm.calls).toHaveLength(1);
      expect(await c.db.query('SELECT id FROM records')).toHaveLength(1);
      expect((await chat.history(c.userId)).some((m) => m.id === recovered!.assistant.id)).toBe(true);
      const app = createApp(c.db, llm, auth);
      const token = await issueToken(auth, c.userId, 0);
      const result = await app.request(`/v1/chat/${input.clientMsgId}`, { headers: { authorization: `Bearer ${token}` } });
      expect(result.status).toBe(200);
      expect(result.headers.get('cache-control')).toBe('private, no-store');
      expect((await result.json()).result.assistant.id).toBe(recovered!.assistant.id);
      const [other] = await c.db.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id');
      const otherToken = await issueToken(auth, other!.id, 0);
      const isolated = await app.request(`/v1/chat/${input.clientMsgId}`, { headers: { authorization: `Bearer ${otherToken}` } });
      expect(await isolated.json()).toEqual({ status: 'not_found' });
      expect((await app.request(`/v1/chat/${input.clientMsgId}`)).status).toBe(401);
    } finally { await c.db.close(); }
  });

  it('同进程多实例同时提交同一消息共用进行中请求，查询不触发模型', async () => {
    const c = await setup();
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let started = false;
      const fake = new FakeLlm(() => ({ intent: 'smalltalk', reply: '你好' }));
      const llm: Llm = { async plan(system, user) { started = true; await gate; return fake.plan(system, user); } };
      const a = new Chat(c.db, llm), b = new Chat(c.db, llm);
      const input = { clientMsgId: 'concurrent-original', text: '你好', inputAt: T };
      const first = a.send(c.userId, input);
      await vi.waitFor(() => expect(started).toBe(true));
      const second = b.send(c.userId, input);
      expect(await b.lookup(c.userId, input.clientMsgId)).toBeNull();
      expect(b.processing(c.userId, input.clientMsgId)).toBe(true);
      const app = createApp(c.db, llm, auth);
      const token = await issueToken(auth, c.userId, 0);
      expect(await (await app.request(`/v1/chat/${input.clientMsgId}`, { headers: { authorization: `Bearer ${token}` } })).json()).toEqual({ status: 'processing' });
      release();
      const results = await Promise.all([first, second]);
      expect(results[0].assistant.id).toBe(results[1].assistant.id);
      expect(fake.calls).toHaveLength(1);
      expect(await c.db.query('SELECT id FROM messages')).toHaveLength(2);
      expect(a.processing(c.userId, input.clientMsgId)).toBe(false);
    } finally { await c.db.close(); }
  });

  it('澄清选择保存后回执丢失，仍恢复原回执而非再次执行选择', async () => {
    const c = await setup();
    try {
      const llm = new FakeLlm(() => ({ intent: 'write', writes: [expense] }));
      const chat = new Chat(c.db, llm);
      const initial = await chat.send(c.userId, { clientMsgId: 'pending-original-message', text: '午饭20元', inputAt: T });
      const clarify = initial.assistant.cards.find((x): x is Extract<Card, { type: 'clarify' }> => x.type === 'clarify')!;
      const choice = clarify.options.find((o) => o.style === 'primary')!;
      const input = { clientMsgId: 'pending-original-choice', text: choice.label, inputAt: new Date(T.getTime() + 86400_000), pendingId: clarify.pendingId, choice: choice.id };
      const saved = await chat.send(c.userId, input);
      await c.db.query('DELETE FROM messages WHERE id=$1', [saved.assistant.id]);
      const recovered = await chat.send(c.userId, input);
      expect(recovered.assistant.cards[0]).toMatchObject(saved.assistant.cards[0]!);
      expect(await c.db.query('SELECT id FROM records')).toHaveLength(1);
      expect((await c.db.query<{ occurred_on: string }>('SELECT occurred_on FROM records'))[0]!.occurred_on).toBe('2026-10-26');
      expect(llm.calls).toHaveLength(1);
    } finally { await c.db.close(); }
  });
});
