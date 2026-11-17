import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { openTestDb } from './database.js';
import { createApp } from '../src/api/app.js';
import { FakeLlm } from '../src/ai/llm.js';

async function boot() {
  const db = await openTestDb();
  const llm = new FakeLlm(() => ({ intent: 'smalltalk', reply: '你好' }));
  const app = createApp(db, llm, { jwtSecret: new TextEncoder().encode('test-secret-test-secret-test-secret'), appleAudience: 'com.test', devLogin: true });
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const ct = res.headers.get('content-type') ?? '';
    return { status: res.status, json: ct.includes('json') ? await res.json() : null, raw: res };
  };
  const login = async (name: string) => (await call('POST', '/v1/auth/dev', { name })).json.token as string;
  return { db, call, login };
}

let k = 0;
const op = () => `client-op-${++k}-xxxx`;

describe('API', () => {
  it('未登录拒绝访问', async () => {
    const { call } = await boot();
    expect((await call('GET', '/v1/plans')).status).toBe(401);
  });

  it('表单记账、查询详情、按客户端标识查结果', async () => {
    const { call, login } = await boot();
    const t = await login('alice');
    const created = await call('POST', '/v1/operations', { clientOpId: op(), actions: [{ type: 'create_ledger', budgetCents: 300000 }] }, t);
    expect(created.status).toBe(200);
    const planId = created.json.items[0].plan.id;
    const id = op();
    const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const r = await call('POST', '/v1/operations', { clientOpId: id, actions: [{ type: 'add_expense', amountCents: 2000, category: '餐饮', date: today, note: '午饭' }] }, t);
    expect(r.json.items[0].ledger.netCents).toBe(2000);
    const looked = await call('GET', `/v1/operations/${id}`, undefined, t);
    expect(looked.json.status).toBe('succeeded');
    const plans = await call('GET', '/v1/plans', undefined, t);
    expect(plans.json.plans[0].ledger.remainingCents).toBe(298000);
    const detail = await call('GET', `/v1/plans/${planId}/ledger`, undefined, t);
    expect(detail.json.records.length).toBe(1);
  });

  it('AC34 不能访问其他账户的数据', async () => {
    const { call, login } = await boot();
    const a = await login('alice');
    const b = await login('bob');
    const created = await call('POST', '/v1/operations', { clientOpId: op(), actions: [{ type: 'create_ledger' }] }, a);
    const planId = created.json.items[0].plan.id;
    expect((await call('GET', `/v1/plans/${planId}/ledger`, undefined, b)).status).toBe(404);
    expect((await call('POST', '/v1/operations', { clientOpId: op(), actions: [{ type: 'archive_plan', planId }] }, b)).status).toBe(404);
  });

  it('非法动作被拒绝', async () => {
    const { call, login } = await boot();
    const t = await login('alice');
    const r = await call('POST', '/v1/operations', { clientOpId: op(), actions: [{ type: 'drop_tables' }] }, t);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('invalid_input');
  });

  it('AC37 导出包含有效记录、不含已删除记录', async () => {
    const { call, login } = await boot();
    const t = await login('alice');
    await call('POST', '/v1/operations', { clientOpId: op(), actions: [{ type: 'create_ledger' }] }, t);
    const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const a = await call('POST', '/v1/operations', { clientOpId: op(), actions: [{ type: 'add_expense', amountCents: 2000, category: '餐饮', date: today, note: '午饭' }, { type: 'add_expense', amountCents: 600, category: '交通', date: today, note: '地铁' }] }, t);
    await call('POST', '/v1/operations', { clientOpId: op(), actions: [{ type: 'delete_record', recordId: a.json.items[1].record.id }] }, t);
    const res = await call('GET', '/v1/export', undefined, t);
    const files = unzipSync(new Uint8Array(await res.raw.arrayBuffer()));
    const money = strFromU8(files['expenses_refunds.csv']!);
    expect(money).toContain('午饭');
    expect(money).not.toContain('地铁');
    expect(Object.keys(files).sort()).toEqual(['README.txt', 'community.json', 'creation-drafts.json', 'expenses_refunds.csv', 'feedback.json', 'generic-records.json', 'growth.json', 'plans.json', 'private-templates.json', 'study.csv', 'templates.json']);
  });

  it('AC38/AC40 退出后旧令牌失效；删除账户后数据清除', async () => {
    const { call, login, db } = await boot();
    const t = await login('alice');
    await call('POST', '/v1/operations', { clientOpId: op(), actions: [{ type: 'create_ledger' }] }, t);
    await call('POST', '/v1/logout', undefined, t);
    expect((await call('GET', '/v1/me', undefined, t)).status).toBe(401);
    const t2 = await login('alice');
    expect((await call('GET', '/v1/plans', undefined, t2)).json.plans.length).toBe(1);
    expect((await call('DELETE', '/v1/me', {}, t2)).status).toBe(422);
    expect((await call('DELETE', '/v1/me', { confirm: 'DELETE' }, t2)).json.deleted).toBe(true);
    expect((await call('GET', '/v1/me', undefined, t2)).status).toBe(401);
    const [n] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM plans`);
    expect(n!.n).toBe(0);
  });

  it('AC39 撤销 AI 授权后对话被拒绝，表单仍可用', async () => {
    const { call, login } = await boot();
    const t = await login('alice');
    const r = await call('POST', '/v1/chat', { clientMsgId: 'chat-msg-0001', text: '你好' }, t);
    expect(r.status).toBe(403);
    await call('PUT', '/v1/me/ai-consent', { granted: true }, t);
    expect((await call('POST', '/v1/chat', { clientMsgId: 'chat-msg-0002', text: '你好' }, t)).json.assistant.text).toBe('你好');
    await call('PUT', '/v1/me/ai-consent', { granted: false }, t);
    expect((await call('POST', '/v1/chat', { clientMsgId: 'chat-msg-0003', text: '你好' }, t)).status).toBe(403);
    expect((await call('POST', '/v1/operations', { clientOpId: op(), actions: [{ type: 'create_ledger' }] }, t)).status).toBe(200);
  });
  it('成长小屋：记录回执带行动力，小屋、周卡、同行榜接口', async () => {
    const { call, login } = await boot();
    const t = await login('grow');
    const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    await call('POST', '/v1/operations', { clientOpId: op(), actions: [{ type: 'create_ledger' }] }, t);
    const r = await call('POST', '/v1/operations', { clientOpId: op(), actions: [{ type: 'add_expense', amountCents: 2000, category: '餐饮', date: today, note: '午饭' }] }, t);
    expect(r.json.growth).toMatchObject({ earned: 1, total: 1, unlocked: [{ key: 'lamp' }] });
    const g = await call('GET', '/v1/growth', undefined, t);
    expect(g.json).toMatchObject({ total: 1, todayEarned: 1, dailyCap: 5, next: { key: 'desk', need: 4 }, circle: null });
    expect((await call('PUT', '/v1/growth/items/desk', { variant: 'cat' }, t)).status).toBe(404);
    const w = await call('GET', '/v1/growth/weekly', undefined, t);
    expect(w.json).toMatchObject({ available: true, recordDays: 1 });
    expect((await call('PUT', `/v1/growth/weekly/${w.json.week}`, { caption: '慢慢来' }, t)).json.caption).toBe('慢慢来');
    expect((await call('GET', '/v1/growth/weekly?week=2099-01-05', undefined, t)).status).toBe(422);
    const made = await call('POST', '/v1/growth/circle', { name: '读书小组', nickname: '小明' }, t);
    expect(made.json.board).toMatchObject({ name: '读书小组', members: [{ nickname: '小明', me: true, recordDays: 1 }] });
    const t2 = await login('friend');
    const joined = await call('POST', '/v1/growth/circle', { code: made.json.board.code, nickname: '阿七' }, t2);
    expect(joined.json.board.members).toHaveLength(2);
    expect(JSON.stringify(joined.json)).not.toContain('午饭');
    expect((await call('POST', '/v1/growth/circle', { name: '又一个', nickname: '小明' }, t)).status).toBe(409);
    expect((await call('DELETE', '/v1/growth/circle', undefined, t2)).json.board).toBeNull();
    // 最后一人删除账户后，榜单和邀请码一起消失。
    expect((await call('DELETE', '/v1/me', { confirm: 'DELETE' }, t)).status).toBe(200);
    expect((await call('POST', '/v1/growth/circle', { code: made.json.board.code, nickname: '阿七' }, t2)).status).toBe(404);
  });
});
