import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { openTestDb } from './database.js';
import type { Db } from '../src/db/db.js';
import { createApp } from '../src/api/app.js';
import { issueToken, upsertUser, type AuthConfig } from '../src/api/auth.js';
import { csrfTokenFor } from '../src/api/web-session.js';
import { FakeLlm } from '../src/ai/llm.js';
import type { Turn, TurnWrite } from '../src/ai/turn.js';
import { addDays, shanghaiDate } from '../src/domain/time.js';

const origin = 'https://ledger-water.planplan.test';
const auth: AuthConfig = { jwtSecret: new TextEncoder().encode('synthetic-ledger-water-http-test-only-key'), appleAudience: null, devLogin: false, webAllowedOrigins: [origin], cookieSecure: true };
const capability = 'reading-template-v1,ledger-template-v1,generic-record-v1';
const today = shanghaiDate(new Date());
const w = (op: TurnWrite['op'], patch: Partial<TurnWrite> = {}): TurnWrite => ({ op, is_fact: true, amount_text: null, currency: 'CNY', duration_value: null, duration_unit: null, category: null, date_kind: 'today', days_ago: null, date: null, note: null, plan_id: null, plan_name: null, activity: null, days_per_week: null, min_minutes: null, scope: 'unspecified', record_id: null, component: null, ...patch });

describe('记账与饮水 HTTP、完整写入、兼容投影', () => {
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let modelReply: Partial<Turn> = { intent: 'smalltalk', reply: '合成测试' };
  beforeAll(async () => { db = await openTestDb(); app = createApp(db, new FakeLlm(() => modelReply), auth); });
  afterAll(async () => { await db.close(); });
  async function account() {
    const user = await upsertUser(db, { devName: `generic-http-${randomUUID()}` });
    const token = await issueToken(auth, user.id, user.token_version);
    return { id: user.id, legacy: { authorization: `Bearer ${token}` }, headers: { cookie: `__Host-planplan-session=${token}`, origin, 'X-CSRF-Token': csrfTokenFor(auth, token), 'X-PlanPlan-Expected-User': user.id, 'X-PlanPlan-Capabilities': capability } };
  }
  const read = (path: string, headers: Record<string, string>) => app.request(path, { headers });
  const post = (path: string, body: unknown, headers: Record<string, string>) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const operate = (actions: unknown[], headers: Record<string, string>, clientOpId = randomUUID(), inputAt = new Date().toISOString()) => post('/v1/operations', { clientOpId, inputAt, actions }, headers);
  const saved = async (response: Promise<Response> | Response) => { const res = await response; const result = await res.json(); expect(res.status, JSON.stringify(result)).toBe(200); return result; };
  async function adopt(headers: Record<string, string>, templateId = 'official.water') {
    return (await saved(operate([{ type: 'adopt_template', templateId, templateVersion: 1 }], headers))).templatePlan.planId as string;
  }
  async function water(headers: Record<string, string>) {
    const id = await adopt(headers);
    await saved(operate([{ type: 'configure_generic_plan', planId: id, expectedVersion: 1, patch: { values: { dailyGoalMl: 2000 } }, completeSetup: true }], headers));
    return id;
  }
  const addWater = (planId: string, amountMl: number) => ({ type: 'add_generic_record', planId, values: { date: today, amountMl } });
  const recordId = (result: { items: { record?: { id: string } }[] }) => result.items.find(item => item.record)?.record!.id;

  it('三模板可用；手动配置不需要AI授权，也不把目标保存成饮水', async () => {
    const a = await account();
    const catalog = await (await read('/v1/templates', {})).json();
    expect(catalog.templates.map((d: { id: string }) => d.id).sort()).toEqual(['official.ledger', 'official.reading', 'official.water']);
    const id = await water(a.headers);
    const view = await saved(read(`/v1/plans/${id}/generic`, a.headers));
    expect(view).toMatchObject({ plan: { kind: 'generic' }, totalRecords: 0, templatePlan: { config: { values: { dailyGoalMl: 2000 }, setupStatus: 'ready' } } });
    expect(view.summary.metrics.find((m: { id: string }) => m.id === 'progress')).toMatchObject({ value: 0, target: 2000, progressPct: 0 });
    expect((await db.query<{ ai_consent: boolean }>('SELECT ai_consent FROM users WHERE id=$1', [a.id]))[0]?.ai_consent).toBe(false);
    const old = await saved(read('/v1/plans', a.legacy));
    expect(old.plans).toEqual([]);
    expect(old.compatibility).toMatchObject({ unsupportedCount: 1, webPath: '/plans' });
    expect(old.compatibility.message).toContain('无需重复提交');
    expect((await saved(read('/v1/plans', a.headers))).plans[0].plan.template.id).toBe('official.water');
  });

  it('HTTP数值、精确单位、版本、编辑删除撤销及非法范围一致', async () => {
    const a = await account(), id = await water(a.headers);
    const first = await saved(operate([{ ...addWater(id, 0.5), units: { amountMl: 'L' } }], a.headers));
    const second = await saved(operate([addWater(id, 300)], a.headers));
    const view = () => saved(read(`/v1/plans/${id}/generic?date=${today}`, a.headers));
    expect((await view()).summary.metrics.find((m: { id: string }) => m.id === 'progress')).toMatchObject({ value: 800, progressPct: 40 });
    expect((await saved(read(`/v1/records/${recordId(first)}`, a.headers))).record).toMatchObject({ fields: { amountMl: 500 }, kind: 'generic' });
    await saved(operate([{ type: 'edit_generic_record', recordId: recordId(second), expectedVersion: 1, values: { date: today, amountMl: 200 } }], a.headers));
    expect((await view()).summary.metrics[0].value).toBe(700);
    const stale = await operate([{ type: 'edit_generic_record', recordId: recordId(second), expectedVersion: 1, values: { date: today, amountMl: 250 } }], a.headers);
    expect(stale.status).toBe(409);
    const removed = await saved(operate([{ type: 'delete_record', recordId: recordId(second), expectedVersion: 2 }], a.headers));
    expect((await view()).summary.metrics[0].value).toBe(500);
    await saved(post(`/v1/operations/${removed.operationId}/undo`, { clientOpId: randomUUID() }, a.headers));
    expect((await view()).summary.metrics[0].value).toBe(700);
    for (const action of [addWater(id, 0), addWater(id, -1), addWater(id, 100001), { ...addWater(id, 0.0001), units: { amountMl: 'L' } }, { ...addWater(id, 2), units: { amountMl: 'cup' } }, { type: 'add_generic_record', planId: id, values: { amountMl: 1, date: addDays(today, 1) } }]) expect((await operate([action], a.headers)).status).toBe(422);
    for (const query of ['date=2026-02-30', 'offset=-1', 'limit=0', `date=${today}&from=${today}`, `from=${today}`, `from=${today}&to=2020-01-01`]) expect((await read(`/v1/plans/${id}/generic?${query}`, a.headers)).status).toBeGreaterThanOrEqual(400);
    expect((await view()).totalRecords).toBe(2);
  });

  it('写入前校验能力、CSRF和账户，旧视图不泄漏generic枚举', async () => {
    const a = await account(), b = await account(), id = await water(a.headers);
    const added = await saved(operate([addWater(id, 500)], a.headers));
    const rid = recordId(added);
    for (const actions of [[addWater(id, 300)], [{ type: 'archive_plan', planId: id }], [{ type: 'delete_record', recordId: rid, expectedVersion: 1 }], [{ type: 'rename_plan', planId: id, name: '不应改名' }], [{ type: 'set_view', planId: id, hidden: [] }]]) expect((await operate(actions, a.legacy)).status).toBe(422);
    expect((await post(`/v1/operations/${added.operationId}/undo`, { clientOpId: randomUUID() }, a.legacy)).status).toBe(422);
    expect((await operate([addWater(id, 10)], { ...a.headers, 'X-CSRF-Token': '' })).status).toBe(403);
    expect((await operate([addWater(id, 10)], { ...b.headers, 'X-PlanPlan-Expected-User': a.id })).status).toBe(409);
    expect((await read(`/v1/plans/${id}/generic`, b.headers)).status).toBe(404);
    for (const path of [`/v1/plans/${id}/generic`, `/v1/plans/${id}/template`, `/v1/plans/${id}/study`, `/v1/plans/${id}/ledger`, `/v1/records/${rid}`]) {
      const response = await read(path, a.legacy);
      expect(response.status).toBe(422);
      expect(await response.text()).not.toContain('"kind":"generic"');
    }
    expect((await saved(read(`/v1/plans/${id}/generic`, a.headers))).summary.metrics[0].value).toBe(500);
  });

  it('已有账本必须明确复用，归档必须明确恢复，预算与原记录保持', async () => {
    const a = await account();
    const created = await saved(operate([{ type: 'create_ledger', budgetCents: 100000 }], a.legacy));
    const id = created.items[0].plan.id;
    await saved(operate([{ type: 'add_expense', amountCents: 2000, category: '餐饮', date: today }], a.legacy));
    const action = { type: 'adopt_template', templateId: 'official.ledger', templateVersion: 1 };
    expect((await operate([action], a.headers)).status).toBe(409);
    await saved(operate([{ ...action, existingPlanId: id, existingLedgerAction: 'reuse' }], a.headers));
    const ledger = await saved(read(`/v1/plans/${id}/ledger`, a.headers));
    expect(ledger.stats).toMatchObject({ budgetCents: 100000, spendCents: 2000 });
    await saved(operate([{ type: 'archive_plan', planId: id }], a.legacy));
    expect((await operate([{ ...action, existingPlanId: id, existingLedgerAction: 'reuse' }], a.headers)).status).toBe(409);
    await saved(operate([{ ...action, existingPlanId: id, existingLedgerAction: 'restore' }], a.headers));
    expect((await saved(read('/v1/plans', a.headers))).plans).toHaveLength(1);
    expect((await saved(read(`/v1/plans/${id}/ledger`, a.headers))).stats).toMatchObject({ budgetCents: 100000, spendCents: 2000 });
  });

  it('三类混合操作丢响应核对仍成功；旧端投影不改原回执或引导重写', async () => {
    const a = await account(), b = await account(), id = await water(a.headers);
    await adopt(a.headers, 'official.ledger');
    const reading = await adopt(a.headers, 'official.reading');
    const key = randomUUID(), at = new Date().toISOString();
    const actions = [{ type: 'add_expense', amountCents: 2000, category: '餐饮', date: today }, { type: 'add_study', planId: reading, minutes: 20, date: today }, addWater(id, 500)];
    const original = await saved(operate(actions, a.headers, key, at));
    const replay = await saved(operate(actions, a.headers, key, at));
    expect(replay.operationId).toBe(original.operationId);
    expect(replay.items).toHaveLength(3);
    const old = await saved(read(`/v1/operations/${key}`, a.legacy));
    expect(old.status).toBe('succeeded');
    expect(old.result.items.map((i: { type: string }) => i.type)).toEqual(['expense_added', 'study_added']);
    expect(old.result.undoable).toBe(false);
    expect(old.result.compatibility.message).toContain('无需重复提交');
    expect(JSON.stringify(old)).not.toMatch(/"kind":"generic"|"type":"generic_added"/);
    expect((await saved(read(`/v1/operations/${key}`, a.headers))).result.items).toHaveLength(3);
    expect((await read(`/v1/operations/${key}`, b.headers)).status).toBe(404);
    expect((await operate([...actions.slice(0, 2), addWater(id, 600)], a.headers, key, at)).status).toBe(409);
    expect((await db.query('SELECT id FROM records WHERE user_id=$1 AND NOT deleted', [a.id]))).toHaveLength(3);
    const zip = unzipSync(new Uint8Array(await (await read('/v1/export', a.legacy)).arrayBuffer()));
    expect(Object.keys(zip)).toContain('generic-records.json');
    expect(strFromU8(zip['generic-records.json']!)).toContain('500');
  });

  it('对话历史和核对保留混合事实，旧客户端只收到认识的卡片', async () => {
    const a = await account(), id = await water(a.headers);
    const reading = await adopt(a.headers, 'official.reading');
    await adopt(a.headers, 'official.ledger');
    await db.query('UPDATE users SET ai_consent=true WHERE id=$1', [a.id]);
    modelReply = { intent: 'write', writes: [w('add_expense', { amount_text: '20', category: '餐饮' }), w('add_study', { plan_id: reading, duration_value: 20, duration_unit: 'minute', activity: '阅读' }), w('add_generic_record', { plan_id: id, generic_fields: [{ field_id: 'amountMl', value: 500, unit: 'ml', unit_size: null, unit_size_unit: null }] })] };
    const key = randomUUID();
    const reply = await saved(post('/v1/chat', { clientMsgId: key, inputAt: new Date().toISOString(), text: '午饭20元，读书20分钟，喝水500毫升' }, a.headers));
    expect(reply.assistant.cards.find((c: { type: string }) => c.type === 'receipt').items).toHaveLength(3);
    const old = await saved(read(`/v1/chat/${key}`, a.legacy));
    expect(old.status).toBe('succeeded');
    expect(old.result.assistant.cards.find((c: { type: string }) => c.type === 'receipt')).toMatchObject({ undoable: false });
    expect(old.result.assistant.cards.find((c: { type: string }) => c.type === 'notice').text).toContain('无需重复提交');
    expect(JSON.stringify(old)).not.toContain('"kind":"generic"');
    const history = await saved(read('/v1/messages', a.legacy));
    const oldHistoryCards = history.messages.find((m: { id: string }) => m.id === reply.assistant.id).cards;
    expect(oldHistoryCards.find((c: { type: string }) => c.type === 'receipt').items).toEqual(old.result.assistant.cards.find((c: { type: string }) => c.type === 'receipt').items);
    expect(oldHistoryCards.find((c: { type: string }) => c.type === 'notice')).toEqual(old.result.assistant.cards.find((c: { type: string }) => c.type === 'notice'));
    expect(JSON.stringify(history)).not.toContain('"kind":"generic"');
    expect((await saved(read(`/v1/chat/${key}`, a.headers))).result.assistant.cards[0].items).toHaveLength(3);
  });

  it('通用查询在旧端投影为已知提示，完整数值仍保留在新端', async () => {
    const a = await account(), id = await water(a.headers);
    await saved(operate([addWater(id, 500)], a.headers));
    await db.query('UPDATE users SET ai_consent=true WHERE id=$1', [a.id]);
    modelReply = { intent: 'query', query: { kind: 'generic_summary', plan_id: id, period: 'today', from: null, to: null, category: null } };
    const key = randomUUID();
    const reply = await saved(post('/v1/chat', { clientMsgId: key, text: '今天饮水多少？', inputAt: new Date().toISOString(), scopePlanId: id }, a.headers));
    expect(reply.assistant.cards.find((c: { type: string }) => c.type === 'query')).toMatchObject({ kind: 'generic_period', summary: { recordCount: 1 } });
    const legacy = await saved(read(`/v1/chat/${key}`, a.legacy));
    expect(legacy.status).toBe('succeeded');
    expect(legacy.result.assistant.cards).toContainEqual(expect.objectContaining({ type: 'notice' }));
    expect(JSON.stringify(legacy)).not.toMatch(/"kind":"generic(?:_period)?"/);
    expect((await saved(read(`/v1/chat/${key}`, a.headers))).result.assistant.cards).toEqual(reply.assistant.cards);
  });

  it('新端撤销混合批次后，旧核对过滤通用项且后来独立事实保留', async () => {
    const a = await account(), id = await water(a.headers);
    const reading = await adopt(a.headers, 'official.reading');
    await adopt(a.headers, 'official.ledger');
    const batch = await saved(operate([{ type: 'add_expense', amountCents: 2000, category: '餐饮', date: today }, { type: 'add_study', planId: reading, minutes: 20, date: today }, addWater(id, 500)], a.headers));
    await saved(operate([addWater(id, 50)], a.headers));
    const key = randomUUID();
    const undone = await saved(post(`/v1/operations/${batch.operationId}/undo`, { clientOpId: key }, a.headers));
    expect(undone.items[0].records).toHaveLength(3);
    const old = await saved(read(`/v1/operations/${key}`, a.legacy));
    expect(old.status).toBe('succeeded');
    expect(old.result.items[0]).toMatchObject({ type: 'undone' });
    expect(old.result.items[0].records).toHaveLength(2);
    expect(old.result.undoable).toBe(false);
    expect(JSON.stringify(old)).not.toContain('"kind":"generic"');
    expect((await saved(read(`/v1/plans/${id}/generic`, a.headers))).summary.metrics[0].value).toBe(50);
  });
});
