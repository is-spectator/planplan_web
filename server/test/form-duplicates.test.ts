import { pruneOperationConfirmations } from '../src/services/form-operations.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { FakeLlm } from '../src/ai/llm.js';
import { shanghaiDate } from '../src/domain/time.js';
import { openTestDb } from './database.js';

async function setup(seedRecord = true) {
  const db = await openTestDb();
  const app = createApp(db, new FakeLlm(() => ({ intent: 'smalltalk', reply: 'fixture' })), { jwtSecret: new TextEncoder().encode('test-secret-test-secret-test-secret'), devLogin: true, appleAudience: 'com.test' });
  const call = async (method: string, path: string, body?: unknown, token?: string, confirmation?: string) => {
    const r = await app.request(path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(confirmation ? { 'X-PlanPlan-Confirmation': confirmation } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() as any };
  };
  const login = async (name: string) => (await call('POST', '/v1/auth/dev', { name })).json;
  const auth = await login('form-duplicate');
  const now = new Date();
  const input = (actions: any[]) => ({ clientOpId: randomUUID(), inputAt: now.toISOString(), actions });
  const expense = { type: 'add_expense', amountCents: 2000, category: '餐饮', date: shanghaiDate(now), note: '午饭' };
  const post = (body: unknown, confirmation?: string) => call('POST', '/v1/operations', body, auth.token, confirmation);
  await post(input([{ type: 'create_ledger' }]));
  if (seedRecord) await post(input([expense]));
  const count = async () => (await db.query<{ n: number }>('SELECT count(*)::int n FROM records WHERE user_id=$1 AND NOT deleted', [auth.userId]))[0]!.n;
  return { db, call, login, auth, input, expense, post, count };
}

describe('表单疑似重复确认契约', () => {
  it('不同opId并发提交相同记录，后一个必须等待重复确认，不能穿过检查与写入之间的窗口', async () => {
    const c = await setup(false);
    const a = c.input([c.expense]), b = c.input([c.expense]);
    const transaction = c.db.tx.bind(c.db);
    let committed!: () => void, release!: () => void;
    const firstCommitted = new Promise<void>(resolve => { committed = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    let pauseNext = true;
    // Keep the real database transactions and account locks. Pause only their
    // first completed response, so a second request deterministically enters
    // the old preflight/write gap on both PostgreSQL and PGlite.
    c.db.tx = async (fn, lockKey) => {
      const pause = lockKey === c.auth.userId && pauseNext;
      if (pause) pauseNext = false;
      const result = await transaction(fn, lockKey);
      if (pause) { committed(); await released; }
      return result;
    };
    const first = c.post(a);
    let second: Awaited<ReturnType<typeof c.post>>;
    try {
      await Promise.race([firstCommitted, first.then(() => { throw new Error('First request did not enter an account transaction'); })]);
      second = await c.post(b);
    } finally {
      release();
      c.db.tx = transaction;
    }
    const saved = await first;
    expect(saved.status).toBe(200);
    expect(second!.status).toBe(409);
    expect(second!.json.error.code).toBe('duplicate_confirmation_required');
    expect(await c.count()).toBe(1);
    expect(await c.db.query('SELECT * FROM growth_points')).toHaveLength(1);
    expect(await c.db.query('SELECT * FROM operation_confirmations')).toHaveLength(1);
    const confirmed = await c.post(b, second!.json.error.details.confirmationId);
    expect(confirmed.status).toBe(200);
    expect(confirmed.json).toMatchObject({ clarificationRounds: 1, growth: { earned: 1, total: 2 } });
    expect((await c.post(a)).json.operationId).toBe(saved.json.operationId);
    expect((await c.post(b)).json.operationId).toBe(confirmed.json.operationId);
    expect(await c.count()).toBe(2);
    expect(await c.db.query('SELECT * FROM growth_points')).toHaveLength(2);
  });
  it('同opId并发首次提交只保存一次并返回同一回执，不要求重复确认', async () => {
    const c = await setup(false), body = c.input([c.expense]);
    const [a, b] = await Promise.all([c.post(body), c.post(body)]);
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    expect(a.json.operationId).toBe(b.json.operationId);
    expect(await c.count()).toBe(1);
    expect(await c.db.query('SELECT * FROM growth_points')).toHaveLength(1);
    expect(await c.db.query('SELECT * FROM operation_confirmations')).toHaveLength(0);
  });
  it('新提交和已确认提交的整批失败都回滚记录与行动力，原确认凭据仍可核对', async () => {
    const c = await setup(false);
    const body = c.input([c.expense, { type: 'add_study', planId: randomUUID(), minutes: 10, date: c.expense.date }]);
    expect((await c.post(body)).status).toBe(404);
    expect(await c.count()).toBe(0);
    expect(await c.db.query('SELECT * FROM growth_points')).toHaveLength(0);
    await c.post(c.input([c.expense]));
    const waiting = await c.post(body);
    expect(waiting.status).toBe(409);
    const nonce = waiting.json.error.details.confirmationId;
    expect((await c.post(body, nonce)).status).toBe(404);
    expect(await c.count()).toBe(1);
    expect(await c.db.query('SELECT * FROM growth_points')).toHaveLength(1);
    expect((await c.call('GET', `/v1/operations/${body.clientOpId}`, undefined, c.auth.token)).status).toBe(404);
    expect((await c.post(body)).json.error.details.confirmationId).toBe(nonce);
  });
  it('409先持久化核对凭据，不落账；原opId/原输入确认后保存，重放只返回一次结果', async () => {
    const c = await setup(); const body = c.input([c.expense]);
    const waiting = await c.post(body);
    expect(waiting.status).toBe(409);
    expect(waiting.json.error.code).toBe('duplicate_confirmation_required');
    const nonce = waiting.json.error.details.confirmationId;
    expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(await c.count()).toBe(1);
    expect((await c.call('GET', `/v1/operations/${body.clientOpId}`, undefined, c.auth.token)).status).toBe(404);
    expect((await c.post(body)).json.error.details.confirmationId).toBe(nonce);
    const saved = await c.post(body, nonce);
    expect(saved.status).toBe(200); expect(saved.json.clientOpId).toBe(body.clientOpId);
    expect(saved.json.clarificationRounds).toBe(1);
    const successful = await c.db.query<{ props: { clarificationRounds: number } }>("SELECT props FROM usage_events WHERE name='request' AND props->>'status'='succeeded' ORDER BY seq DESC LIMIT 1");
    expect(successful[0]!.props.clarificationRounds).toBe(1);
    expect((await c.post(body, nonce)).json.operationId).toBe(saved.json.operationId);
    expect(await c.count()).toBe(2);
    const rows = await c.db.query<{ input_at: Date }>('SELECT input_at FROM records WHERE user_id=$1', [c.auth.userId]);
    expect(rows.every(r => new Date(r.input_at).toISOString() === body.inputAt)).toBe(true);
  });
  it('确认绑定原操作内容及inputAt；凭据不能批准修改后的金额', async () => {
    const c = await setup(); const body = c.input([c.expense]);
    const nonce = (await c.post(body)).json.error.details.confirmationId;
    for (const changed of [{ ...body, actions: [{ ...c.expense, amountCents: 2100 }] }, { ...body, inputAt: new Date(Date.parse(body.inputAt) - 1000).toISOString() }]) {
      const r = await c.post(changed, nonce);
      expect(r.status).toBe(409); expect(r.json.error.code).toBe('operation_changed');
    }
    expect(await c.count()).toBe(1);
    expect((await c.post(body, nonce)).status).toBe(200);
  });
  it('其他账户或其他opId不能使用凭据；未知nonce不能跳过核对', async () => {
    const c = await setup(); const body = c.input([c.expense]);
    const nonce = (await c.post(body)).json.error.details.confirmationId;
    const other = await c.login('another');
    const foreign = await c.call('POST', '/v1/operations', body, other.token, nonce);
    expect(foreign.status).toBe(409); expect(foreign.json.error.code).toBe('confirmation_expired');
    expect(JSON.stringify(foreign.json)).not.toContain('午饭');
    expect((await c.post({ ...body, clientOpId: randomUUID() }, nonce)).json.error.code).toBe('confirmation_expired');
    expect((await c.post(body, randomUUID())).json.error.code).toBe('duplicate_confirmation_required');
    expect(await c.count()).toBe(1);
  });
  it('过期确认不能自动保存；重试原操作生成新卡并要求再次确认', async () => {
    const c = await setup(); const body = c.input([c.expense]);
    const nonce = (await c.post(body)).json.error.details.confirmationId;
    await c.db.query("UPDATE operation_confirmations SET expires_at=now()-interval '1 second' WHERE client_op_id=$1", [body.clientOpId]);
    expect((await c.post(body, nonce)).json.error.code).toBe('confirmation_expired');
    expect(await c.count()).toBe(1);
    const next = (await c.post(body)).json.error.details.confirmationId;
    expect(next).not.toBe(nonce);
    expect((await c.post(body, next)).status).toBe(200);
  });
  it('一批含疑似重复时其余操作也不落账；确认后整批一次提交', async () => {
    const c = await setup(); const body = c.input([c.expense, { ...c.expense, amountCents: 600, category: '交通', note: '地铁' }]);
    const waiting = await c.post(body);
    expect(await c.count()).toBe(1);
    const r = await c.post(body, waiting.json.error.details.confirmationId);
    expect(r.json.items).toHaveLength(2); expect(await c.count()).toBe(3);
    expect((await c.post(body)).json.operationId).toBe(r.json.operationId);
  });
  it('并发确认仍只提交原操作一次', async () => {
    const c = await setup(); const body = c.input([c.expense]);
    const nonce = (await c.post(body)).json.error.details.confirmationId;
    const [a, b] = await Promise.all([c.post(body, nonce), c.post(body, nonce)]);
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    expect(a.json.operationId).toBe(b.json.operationId); expect(await c.count()).toBe(2);
  });
  it('省略inputAt的兼容客户端也以第一次请求的时间核对，不产生漂移', async () => {
    const c = await setup(); const { inputAt: _, ...body } = c.input([c.expense]);
    const nonce = (await c.post(body)).json.error.details.confirmationId;
    expect((await c.post(body)).json.error.details.confirmationId).toBe(nonce);
    expect((await c.post(body, nonce)).status).toBe(200);
  });
  it('定期清理无需新的表单操作，过期nonce删除而有效nonce保留', async () => {
    const c = await setup(); const old = c.input([c.expense]); const fresh = c.input([c.expense]);
    await c.post(old); await c.post(fresh);
    await c.db.query("UPDATE operation_confirmations SET expires_at=now()-interval '1 second' WHERE client_op_id=$1", [old.clientOpId]);
    await pruneOperationConfirmations(c.db);
    const rows = await c.db.query<{ client_op_id: string }>('SELECT client_op_id FROM operation_confirmations');
    expect(rows.map(r => r.client_op_id)).toEqual([fresh.clientOpId]);
  });
  it('核对不是工具失败，指标只计待确认；不存金额备注，删除账户级联删除凭据', async () => {
    const c = await setup(); const body = c.input([c.expense]);
    await c.post(body);
    const rows = await c.db.query<Record<string, unknown>>('SELECT * FROM operation_confirmations WHERE user_id=$1', [c.auth.userId]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('午饭');
    expect(Object.keys(rows[0]!)).not.toContain('actions');
    const events = await c.db.query<{ name: string; props: { status?: string } }>('SELECT name,props FROM usage_events');
    expect(events.some(e => e.name === 'request' && e.props.status === 'clarification')).toBe(true);
    expect(events.filter(e => e.name === 'failure')).toHaveLength(0);
    await c.db.query('DELETE FROM users WHERE id=$1', [c.auth.userId]);
    expect(await c.db.query('SELECT * FROM operation_confirmations')).toHaveLength(0);
  });
});
