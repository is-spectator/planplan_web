import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { openTestDb } from './database.js';
import type { Db } from '../src/db/db.js';
import { createApp } from '../src/api/app.js';
import { issueToken, upsertUser, type AuthConfig } from '../src/api/auth.js';
import { csrfTokenFor } from '../src/api/web-session.js';
import { FakeLlm } from '../src/ai/llm.js';
import { shanghaiDate } from '../src/domain/time.js';

const origin = 'https://templates.planplan.test';
const auth: AuthConfig = {
  jwtSecret: new TextEncoder().encode('synthetic-reading-template-api-test-key'),
  appleAudience: null, devLogin: false, webAllowedOrigins: [origin], cookieSecure: true,
};
const adopt = { type: 'adopt_template', templateId: 'official.reading', templateVersion: 1 };

describe('阅读模板 HTTP、Cookie 与旧协议兼容', () => {
  let db: Db;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    db = await openTestDb();
    app = createApp(db, new FakeLlm(() => ({ intent: 'smalltalk', reply: '测试回复' })), auth);
  });

  async function account() {
    const user = await upsertUser(db, { devName: `reading-${randomUUID()}` });
    const token = await issueToken(auth, user.id, user.token_version);
    return { id: user.id, token, headers: {
      cookie: `__Host-planplan-session=${token}`, origin,
      'X-CSRF-Token': csrfTokenFor(auth, token),
      'X-PlanPlan-Expected-User': user.id,
      'X-PlanPlan-Capabilities': 'reading-template-v1',
    } };
  }
  const read = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });
  const post = (actions: unknown[], headers: Record<string, string>, clientOpId = randomUUID(), inputAt = new Date().toISOString()) => app.request('/v1/operations', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ clientOpId, inputAt, actions }),
  });

  it('公开目录仅含可运行官方定义，私人计划仍要求登录，所有响应不共享缓存', async () => {
    const list = await read('/v1/templates');
    expect(list.status).toBe(200);
    expect(list.headers.get('cache-control')).toContain('no-store');
    const { templates } = await list.json();
    expect(templates).toHaveLength(3);
    const reading = templates.find((template: { id: string }) => template.id === 'official.reading');
    expect(reading).toMatchObject({ id: 'official.reading', version: 1, engine: 'study', source: 'official' });
    const detail = await read('/v1/templates/official.reading');
    expect(await detail.json()).toEqual(reading);
    for (const id of ['official.water', 'official.ledger']) expect((await read(`/v1/templates/${id}`)).status).toBe(200);
    expect((await read('/v1/templates/unknown')).status).toBe(404);
    const privatePlan = await read(`/v1/plans/${randomUUID()}/template`);
    expect(privatePlan.status).toBe(401);
    expect(privatePlan.headers.get('cache-control')).toContain('no-store');
    expect(JSON.stringify(templates)).not.toMatch(/csrfToken|userId|clientOpId|apiKey|sk-or-/);
  });

  it('采用前校验能力、CSRF 和预期账户；拒绝请求不会创建计划', async () => {
    const a = await account();
    const b = await account();
    const noCapability = await post([adopt], { ...a.headers, 'X-PlanPlan-Capabilities': '' });
    expect(noCapability.status).toBe(422);
    const noCsrf = await post([adopt], { ...a.headers, 'X-CSRF-Token': '' });
    expect(noCsrf.status).toBe(403);
    expect((await noCsrf.json()).error.code).toBe('csrf_invalid');
    const switched = await post([adopt], { ...b.headers, 'X-PlanPlan-Expected-User': a.id });
    expect(switched.status).toBe(409);
    expect((await switched.json()).error.code).toBe('account_mismatch');
    expect(await db.query('SELECT id FROM plans WHERE user_id IN ($1,$2)', [a.id, b.id])).toEqual([]);
    const saved = await post([adopt], a.headers);
    expect(saved.status).toBe(200);
    expect((await saved.json()).items[0].type).toBe('plan_created');
  });

  it('同身份采用与丢响应核对只创建一次；异体拒绝，明确再次选用创建第二实例', async () => {
    const a = await account();
    const b = await account();
    const id = randomUUID();
    const inputAt = new Date().toISOString();
    const responses = await Promise.all([post([adopt], a.headers, id, inputAt), post([adopt], a.headers, id, inputAt)]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    const results = await Promise.all(responses.map(response => response.json()));
    expect(results[0].items[0].plan.id).toBe(results[1].items[0].plan.id);
    const lookup = await read(`/v1/operations/${id}`, a.headers);
    expect((await lookup.json()).result.items[0].plan.id).toBe(results[0].items[0].plan.id);
    expect((await read(`/v1/operations/${id}`, b.headers)).status).toBe(404);
    const changed = await post([{ ...adopt, templateVersion: 2 }], a.headers, id, inputAt);
    expect(changed.status).toBe(409);
    expect((await changed.json()).error.code).toBe('operation_changed');
    expect((await db.query('SELECT id FROM plans WHERE user_id=$1', [a.id]))).toHaveLength(1);
    expect((await post([adopt], a.headers)).status).toBe(200);
    expect((await db.query('SELECT id FROM plans WHERE user_id=$1', [a.id]))).toHaveLength(2);
    expect(await db.query('SELECT id FROM records WHERE user_id=$1', [a.id])).toEqual([]);
  });

  it('旧 Bearer 客户端能读取采用后的 study 与历史，但不能执行新模板动作', async () => {
    const a = await account();
    const created = await (await post([adopt], a.headers)).json();
    const planId = created.items[0].plan.id;
    const legacy = { authorization: `Bearer ${a.token}` };
    const list = await read('/v1/plans', legacy);
    expect(list.status).toBe(200);
    expect((await list.json()).plans[0].plan).toMatchObject({ id: planId, kind: 'study', status: 'active' });
    expect((await read(`/v1/plans/${planId}/study`, legacy)).status).toBe(200);
    expect((await read('/v1/messages', legacy)).status).toBe(200);
    expect((await post([adopt], legacy)).status).toBe(422);
    const added = await post([{ type: 'add_study', planId, minutes: 10, date: shanghaiDate(new Date()) }], legacy);
    expect(added.status).toBe(200);
    expect((await added.json()).items[0].type).toBe('study_added');
  });

  it('设置目标不造事实，配置冲突与非法设置保留原版本，可跳过全部可选项', async () => {
    const a = await account();
    const created = await (await post([adopt], a.headers)).json();
    const planId = created.items[0].plan.id;
    const initial = await (await read(`/v1/plans/${planId}/template`, a.headers)).json();
    expect(initial.config).toMatchObject({ setupStatus: 'pending', daysPerWeek: null, minMinutes: null, currentBook: null });
    const listed = await (await read('/v1/plans', a.headers)).json();
    expect(listed.plans.find((card: { plan: { id: string } }) => card.plan.id === planId).plan.template).toMatchObject({ id: 'official.reading', version: 1, setupStatus: 'pending' });
    const action = { type: 'configure_reading_plan', planId, expectedVersion: initial.config.version,
      patch: { name: '接口阅读', daysPerWeek: 5, minMinutes: 20, currentBook: '合成测试书' }, completeSetup: true };
    const saved = await post([action], a.headers);
    expect(saved.status).toBe(200);
    const configured = (await saved.json()).templatePlan;
    expect(configured.config).toMatchObject({ setupStatus: 'ready', name: '接口阅读', daysPerWeek: 5, minMinutes: 20, currentBook: '合成测试书' });
    const stats = (await (await read(`/v1/plans/${planId}/study`, a.headers)).json()).stats;
    expect(stats).toMatchObject({ totalMinutes: 0, recordDays: 0, metDays: 0 });
    const conflict = await post([{ ...action, patch: { name: '过期页面的名字' } }], a.headers);
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe('version_conflict');
    const invalid = await post([{ ...action, expectedVersion: configured.config.version, patch: { minMinutes: 1441 } }], a.headers);
    expect(invalid.status).toBe(400);
    expect((await (await read(`/v1/plans/${planId}/template`, a.headers)).json()).config).toEqual(configured.config);
    const another = await (await post([adopt], a.headers)).json();
    const otherId = another.items[0].plan.id;
    const otherState = await (await read(`/v1/plans/${otherId}/template`, a.headers)).json();
    const skipped = await post([{ type: 'configure_reading_plan', planId: otherId, expectedVersion: otherState.config.version, patch: {}, completeSetup: true }], a.headers);
    expect(skipped.status).toBe(200);
    expect((await skipped.json()).templatePlan.config).toMatchObject({ setupStatus: 'ready', minMinutes: null, daysPerWeek: null });
    const updatedList = await (await read('/v1/plans', a.headers)).json();
    expect(updatedList.plans.find((card: { plan: { id: string } }) => card.plan.id === otherId).plan.template.setupStatus).toBe('ready');
    expect(await db.query('SELECT id FROM records WHERE user_id=$1', [a.id])).toEqual([]);
  });

  it('旧页面改名及归档也使配置版本过期，归档恢复保留同一实例与设置', async () => {
    const a = await account();
    const created = await (await post([adopt], a.headers)).json();
    const planId = created.items[0].plan.id;
    const initial = await (await read(`/v1/plans/${planId}/template`, a.headers)).json();
    expect((await post([{ type: 'rename_plan', planId, name: '另一个页面的新名字' }], a.headers)).status).toBe(200);
    const stale = await post([{ type: 'configure_reading_plan', planId, expectedVersion: initial.config.version, patch: { name: '覆盖名字' } }], a.headers);
    expect(stale.status).toBe(409);
    const current = await (await read(`/v1/plans/${planId}/template`, a.headers)).json();
    expect(current.config.name).toBe('另一个页面的新名字');
    expect((await post([{ type: 'archive_plan', planId }], a.headers)).status).toBe(200);
    expect((await post([{ type: 'restore_plan', planId }], a.headers)).status).toBe(200);
    const restored = await (await read(`/v1/plans/${planId}/template`, a.headers)).json();
    expect(restored).toMatchObject({ planId, templateId: 'official.reading', templateVersion: 1 });
    expect(restored.config).toMatchObject({ name: current.config.name, setupStatus: 'pending' });
    expect(restored.config.version).toBeGreaterThan(current.config.version);
    expect((await db.query('SELECT id FROM plans WHERE user_id=$1', [a.id]))).toHaveLength(1);
  });

  it('私人来源、配置与恢复结果不能跨账户读取；清理账户级联移除私人状态', async () => {
    const a = await account();
    const b = await account();
    const created = await (await post([adopt], a.headers)).json();
    const planId = created.items[0].plan.id;
    expect((await read(`/v1/plans/${planId}/template`, a.headers)).status).toBe(200);
    expect((await read(`/v1/plans/${planId}/template`, b.headers)).status).toBe(404);
    expect((await read(`/v1/messages?scopePlanId=${planId}`, b.headers)).status).toBe(404);
    expect((await read('/v1/messages?scopePlanId=not-a-uuid', a.headers)).status).toBe(400);
    const deleted = await app.request('/v1/me', {
      method: 'DELETE', headers: { ...a.headers, 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'DELETE' }),
    });
    expect(deleted.status).toBe(200);
    expect((await read(`/v1/plans/${planId}/template`, a.headers)).status).toBe(401);
    expect(await db.query('SELECT id FROM plans WHERE user_id=$1', [a.id])).toEqual([]);
    // Shared official definitions remain available to other users.
    expect((await read('/v1/templates/official.reading')).status).toBe(200);
  });

  it('真实导出保留阅读来源与同一条35分钟记录，且不含示例事实', async () => {
    const a = await account();
    const created = await (await post([adopt], a.headers)).json();
    const planId = created.items[0].plan.id;
    const added = await (await post([{ type: 'add_study', planId, minutes: 25, date: shanghaiDate(new Date()), note: '书名：《合成测试书》\n阅读位置：第35页' }], a.headers)).json();
    const record = added.items[0].record;
    const edited = await post([{ type: 'edit_record', recordId: record.id, expectedVersion: record.version, patch: { minutes: 35 } }], a.headers);
    expect(edited.status).toBe(200);
    const response = await read('/v1/export', a.headers);
    expect(response.status).toBe(200);
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const plans = JSON.parse(strFromU8(files['plans.json']!));
    expect(plans.plans.some((plan: { id: string }) => plan.id === planId)).toBe(true);
    const templates = JSON.parse(strFromU8(files['templates.json']!));
    expect(JSON.stringify(templates)).toContain('official.reading');
    const csv = strFromU8(files['study.csv']!);
    expect(csv).toContain(record.id);
    expect(csv).toContain(',35,');
    expect(csv).toContain('第35页');
    expect((csv.match(new RegExp(record.id, 'g')) ?? [])).toHaveLength(1);
    expect(await db.query('SELECT minutes FROM records WHERE user_id=$1 AND NOT deleted', [a.id])).toEqual([{ minutes: 35 }]);
  });
});
