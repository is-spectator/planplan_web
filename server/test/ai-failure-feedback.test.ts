import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OpenAICompatibleLlm, FakeLlm, LlmError, type LlmErrorKind } from '../src/ai/llm.js';
import { aiFailureMessage, type AiFeedbackScene } from '../src/ai/user-feedback.js';
import { definitionBody, type CreationLlm, type CreationResult } from '../src/ai/creation.js';
import { getAvailableTemplate } from '../src/services/templates.js';
import { createApp } from '../src/api/app.js';
import { issueToken } from '../src/api/auth.js';
import { Chat, type Card } from '../src/services/chat.js';
import { CreationRequests, type CreationRequest } from '../src/services/creation-requests.js';
import { DomainError } from '../src/services/errors.js';
import { setup } from './helpers.js';
import { openTestDb } from './database.js';

const T = new Date('2026-11-17T03:30:00Z');
const auth = { jwtSecret: new TextEncoder().encode('failure-feedback-test-secret-at-least-32'), appleAudience: null, devLogin: false };
const kinds: Record<LlmErrorKind, true> = {
  unavailable: true, invalid_output: true, timeout: true, billing: true, unauthorized: true, rate_limited: true, invalid_request: true, accounting_unavailable: true,
};
const serviceKinds: LlmErrorKind[] = ['billing', 'unauthorized', 'invalid_request', 'accounting_unavailable'];
const secret = 'sk-secret-provider-body fixture-model-id-should-not-leak';

function errorCard(cards: Card[]) {
  const card = cards.find((item): item is Extract<Card, { type: 'error' }> => item.type === 'error');
  if (!card) throw new Error('missing error card');
  return card;
}

async function business(db: Awaited<ReturnType<typeof setup>>['db'], userId: string) {
  const plans = await db.query('SELECT id, kind, name, status, start_date, view_config FROM plans WHERE user_id=$1 ORDER BY id', [userId]);
  const goals = await db.query('SELECT g.plan_id, g.param, g.value, g.from_period, g.to_period, g.revoked FROM goal_segments g JOIN plans p ON p.id = g.plan_id WHERE p.user_id=$1 ORDER BY g.seq', [userId]);
  const records = await db.query('SELECT id, plan_id, kind, amount_cents, minutes, category, occurred_on, note, deleted, version FROM records WHERE user_id=$1 ORDER BY id', [userId]);
  const operations = await db.query('SELECT id, client_op_id, kind, undone FROM operations WHERE user_id=$1 ORDER BY created_at, id', [userId]);
  return { plans, goals, records, operations };
}

describe('聊天与创作的 AI 失败反馈', () => {
  it('八种分类都有场景文案，服务端原因对用户不可区分', () => {
    for (const scene of ['chat', 'creation'] as const satisfies readonly AiFeedbackScene[]) {
      const messages = new Map<LlmErrorKind, string>();
      for (const kind of Object.keys(kinds) as LlmErrorKind[]) {
        const message = aiFailureMessage(kind, scene);
        messages.set(kind, message);
        expect(message.length).toBeGreaterThan(12);
        expect(message).not.toMatch(/sk-|密码|付费|充值|配额|额度|供应商|http|\{|\}|\d{3}/i);
        expect(message).not.toContain('什么都没有保存');
        expect(message).not.toContain('明天');
        if (scene === 'chat') expect(message).toContain('这次没有更改计划或记录');
        else expect(message).toContain('原草稿已保留');
      }
      expect(messages.get('invalid_output')).toContain('AI这次没有生成可用结果。');
      expect(messages.get('rate_limited')).toContain('AI请求暂时受限，请稍后再试。');
      expect(messages.get('timeout')).toContain('AI处理超时。');
      expect(messages.get('unavailable')).toContain('AI暂时不可用，请稍后再试。');
      expect(messages.get('rate_limited')).not.toBe(messages.get('timeout'));
      const service = serviceKinds.map(kind => messages.get(kind));
      expect(new Set(service).size).toBe(1);
      expect(service[0]).not.toContain('请稍后再试');
      expect(service[0]).not.toContain('可以稍后重试');
    }
  });

  it('已分类模型失败不改计划、目标和记录，同ID成功只执行一次', async () => {
    const c = await setup();
    try {
      const created = await c.run(T.toISOString(), { type: 'create_ledger', budgetCents: 300000 });
      const planId = (created.items[0] as { plan: { id: string } }).plan.id;
      await c.run(T.toISOString(), { type: 'add_expense', amountCents: 1800, category: '餐饮', date: '2026-11-17' });
      const before = await business(c.db, c.userId);
      let calls = 0;
      let fail = true;
      const llm = new FakeLlm(() => {
        calls++;
        if (fail) throw new LlmError('invalid_output', secret, { prompt: 9, completion: 1 });
        return { intent: 'write', writes: [{ op: 'add_expense', is_fact: true, amount_text: '20', currency: 'CNY', duration_value: null, duration_unit: null, category: '餐饮', date_kind: 'today', days_ago: null, date: null, note: '午饭', plan_id: null, plan_name: null, activity: null, days_per_week: null, min_minutes: null, scope: 'unspecified', record_id: null, component: null }] };
      });
      const chat = new Chat(c.db, llm);
      const input = { clientMsgId: 'fixed-invalid-output', text: '午饭20元', inputAt: T, scopePlanId: planId };
      const first = await chat.send(c.userId, input);
      expect(first.transient).toBe(true);
      expect(errorCard(first.assistant.cards)).toEqual({ type: 'error', code: 'model_unavailable', message: aiFailureMessage('invalid_output', 'chat'), retryable: true });
      expect(JSON.stringify(first)).not.toContain('sk-secret');
      expect(JSON.stringify(first)).not.toContain('fixture-model');
      expect(calls).toBe(1);
      expect(await business(c.db, c.userId)).toEqual(before);
      expect(await c.db.query(`SELECT text FROM messages WHERE user_id=$1 AND role='user' AND client_msg_id=$2`, [c.userId, input.clientMsgId])).toEqual([{ text: '午饭20元' }]);
      expect(await c.db.query<{ props: { kind: string } }>(`SELECT props FROM events WHERE name='model_failure'`)).toEqual([{ props: { kind: 'invalid_output', latencyMs: expect.any(Number) } }]);
      const failures = await c.db.query<{ props: { code: string } }>(`SELECT props FROM usage_events WHERE name='failure'`);
      expect(failures.map(row => row.props.code)).toEqual(['invalid_output']);
      fail = false;
      const second = await chat.send(c.userId, input);
      expect(second.transient).toBe(false);
      expect(second.assistant.cards.some(card => card.type === 'receipt')).toBe(true);
      const third = await chat.send(c.userId, input);
      expect(third.assistant.id).toBe(second.assistant.id);
      expect(calls).toBe(2);
      expect((await business(c.db, c.userId)).records).toHaveLength(before.records.length + 1);
    } finally { await c.db.close(); }
  });

  it.each(Object.keys(kinds) as LlmErrorKind[])('聊天 %s 保留协议并记录内部分类', async (kind) => {
    const c = await setup();
    try {
      const before = await business(c.db, c.userId);
      let calls = 0;
      const chat = new Chat(c.db, new FakeLlm(() => { calls++; throw new LlmError(kind, secret); }));
      const reply = await chat.send(c.userId, { clientMsgId: `kind-${kind}`, text: '记一笔', inputAt: T });
      expect(calls).toBe(1);
      expect(reply.transient).toBe(true);
      expect(errorCard(reply.assistant.cards)).toMatchObject({ code: 'model_unavailable', retryable: true, message: aiFailureMessage(kind, 'chat') });
      expect(JSON.stringify(reply)).not.toContain(secret);
      expect(await business(c.db, c.userId)).toEqual(before);
      expect(await c.db.query(`SELECT props->>'kind' AS kind FROM events WHERE name='model_failure'`)).toEqual([{ kind }]);
    } finally { await c.db.close(); }
  });

  it.each([
    { name: 'empty-object', body: { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }, kind: 'invalid_output' as const },
    { name: 'bad-json', body: { choices: [{ message: { content: '{bad-json secret-body' }, finish_reason: 'stop' }] }, kind: 'invalid_output' as const },
    { name: 'truncated', body: { choices: [{ message: { content: '{"intent":"write"' }, finish_reason: 'length' }] }, kind: 'invalid_output' as const },
    { name: 'schema', body: { choices: [{ message: { content: JSON.stringify({ intent: 'nope', reply: secret }) }, finish_reason: 'stop' }] }, kind: 'invalid_output' as const },
    { name: 'limited', status: 429, body: { error: { message: secret, code: 429 } }, kind: 'rate_limited' as const },
  ])('HTTP $name 经聊天服务显示对应反馈且零业务写入', async (item) => {
    const c = await setup();
    try {
      const created = await c.run(T.toISOString(), { type: 'create_ledger' });
      const planId = (created.items[0] as { plan: { id: string } }).plan.id;
      const before = await business(c.db, c.userId);
      let calls = 0;
      const llm = new OpenAICompatibleLlm('synthetic-key', 'https://fixture.test/v1', 'fixture-model-id-should-not-leak', 'compact', 1000, {
        provider: 'openrouter', fetch: async () => { calls++; return new Response(JSON.stringify(item.body), { status: item.status ?? 200, headers: { 'content-type': 'application/json' } }); },
      });
      const app = createApp(c.db, llm, auth);
      const token = await issueToken(auth, c.userId, 0);
      const clientMsgId = `http-${item.name}`;
      const response = await app.request('/v1/chat', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ clientMsgId, text: '午饭20元', inputAt: T.toISOString(), scopePlanId: planId }) });
      expect(response.status).toBe(200);
      const reply = await response.json();
      expect(reply.transient).toBe(true);
      expect(reply.assistant.cards[0]).toMatchObject({ type: 'error', code: 'model_unavailable', retryable: true, message: aiFailureMessage(item.kind, 'chat') });
      expect(JSON.stringify(reply)).not.toContain(secret);
      expect(JSON.stringify(reply)).not.toContain('fixture-model');
      expect(calls).toBe(1);
      expect(await business(c.db, c.userId)).toEqual(before);
      const again = await app.request(`/v1/chat/${clientMsgId}`, { headers: { authorization: `Bearer ${token}` } });
      expect(await again.json()).toEqual({ status: 'not_found' });
    } finally { await c.db.close(); }
  }, 20000);

  it('未知异常、未同意和业务错误不改用新的确定失败文案', async () => {
    const c = await setup();
    try {
      const token = await issueToken(auth, c.userId, 0);
      const unknown = createApp(c.db, new FakeLlm(() => new Error(secret)), auth);
      const failed = await unknown.request('/v1/chat', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ clientMsgId: 'unknown-result', text: '午饭20元', inputAt: T.toISOString() }) });
      expect(failed.status).toBe(500);
      const body = await failed.json();
      expect(body).toEqual({ error: { code: 'internal', message: '服务出了点问题，这次没有保存，请重试。' } });
      expect(JSON.stringify(body)).not.toContain('没有更改计划或记录');
      const domain = await new Chat(c.db, new FakeLlm(() => new DomainError('not_found', '没有找到这份计划。'))).send(c.userId, { clientMsgId: 'domain-path', text: '午饭20元', inputAt: T });
      expect(domain.transient).toBe(false);
      expect(errorCard(domain.assistant.cards)).toMatchObject({ code: 'not_found', message: '没有找到这份计划。', retryable: false });
      await c.db.query('UPDATE users SET ai_consent=false WHERE id=$1', [c.userId]);
      const blocked = createApp(c.db, new FakeLlm(() => { throw new Error('should-not-call'); }), auth);
      const consent = await blocked.request('/v1/chat', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ clientMsgId: 'no-consent', text: '午饭20元', inputAt: T.toISOString() }) });
      expect(consent.status).toBe(403);
      expect((await consent.json()).error.code).toBe('ai_consent_required');
    } finally { await c.db.close(); }
  });

  it('创作模型失败保留期间修改的草稿，非法定义仍用原来的可恢复文案', async () => {
    const db = await openTestDb();
    try {
      const [user] = await db.query<{ id: string }>(`INSERT INTO users (dev_name, ai_consent) VALUES ('creation-feedback', true) RETURNING id`);
      const userId = user!.id;
      let mode: 'hang' | 'invalid' | 'limited' = 'hang';
      let release!: (error: Error) => void;
      let started!: () => void;
      const begun = () => new Promise<void>(resolve => { started = resolve; });
      let gate = begun();
      let calls = 0;
      const llm: CreationLlm = { async generate() {
        calls++;
        if (mode === 'hang') { started(); return new Promise<CreationResult>((_resolve, reject) => { release = reject; }); }
        if (mode === 'limited') throw new LlmError('rate_limited', secret);
        return { kind: 'proposal', reply: secret, definition: { name: '坏定义' }, latencyMs: 1, usage: null } as CreationResult;
      } };
      const requests = new CreationRequests(db, llm, null);
      const created = await requests.submit(userId, { clientOpId: randomUUID(), action: 'create' });
      if (!('draft' in created)) throw new Error('expected draft');
      const draftId = created.draft.id;
      const manual = definitionBody(await getAvailableTemplate(db, 'official.water'));
      manual.name = '另一页编辑';
      manual.description = '手动保留的定义。';
      manual.example.config.startDate = '2026-11-17';
      manual.example.record.date = '2026-11-17';
      const message: CreationRequest = { clientOpId: randomUUID(), action: 'message', draftId, expectedVersion: 1, text: '把饮水量改成备注' };
      const pending = requests.submit(userId, message);
      await gate;
      const edited = await requests.submit(userId, { clientOpId: randomUUID(), action: 'update', draftId, expectedVersion: 1, definition: manual });
      release(new LlmError('invalid_output', secret));
      const failed = await pending;
      if (!('draft' in failed) || !('draft' in edited)) throw new Error('expected drafts');
      expect(failed.transient).toBe(true);
      expect(failed.message).toBe(aiFailureMessage('invalid_output', 'creation'));
      expect(failed.draft.version).toBe(edited.draft.version);
      expect(failed.draft.name).toBe('另一页编辑');
      expect(failed.draft.messages).toEqual([]);
      expect(JSON.stringify(failed)).not.toContain(secret);
      expect(await db.query('SELECT id FROM plans WHERE user_id=$1', [userId])).toEqual([]);
      mode = 'invalid';
      const rejected = await requests.submit(userId, { ...message, clientOpId: randomUUID(), expectedVersion: edited.draft.version, text: '再生成一次' });
      if (!('message' in rejected)) throw new Error('expected transient result');
      expect(rejected.transient).toBe(true);
      expect(rejected.message).toBe('生成的模板暂时无法使用，原草稿已保留。可以重试或手动编辑。');
      expect(rejected.draft.definition).toEqual(edited.draft.definition);
      expect(JSON.stringify(rejected)).not.toContain(secret);
      mode = 'limited';
      const limited = await requests.submit(userId, { ...message, clientOpId: randomUUID(), expectedVersion: rejected.draft.version, text: '稍后重试' });
      if (!('message' in limited)) throw new Error('expected limited result');
      expect(limited.message).toBe(aiFailureMessage('rate_limited', 'creation'));
      expect(limited.draft.version).toBe(rejected.draft.version);
      expect(calls).toBe(3);
      await expect(requests.submit(userId, { clientOpId: randomUUID(), action: 'message', draftId, expectedVersion: 1, text: '版本已旧' })).rejects.toMatchObject({ code: 'version_conflict' });
      await db.query('UPDATE users SET ai_consent=false WHERE id=$1', [userId]);
      await expect(requests.submit(userId, { clientOpId: randomUUID(), action: 'message', draftId, expectedVersion: limited.draft.version, text: '未同意' })).rejects.toMatchObject({ code: 'ai_consent_required' });
    } finally { await db.close(); }
  });
});
