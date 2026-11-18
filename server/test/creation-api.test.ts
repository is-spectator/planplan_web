import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { openTestDb } from './database.js';
import type { Db } from '../src/db/db.js';
import { createApp } from '../src/api/app.js';
import { issueToken, upsertUser, type AuthConfig } from '../src/api/auth.js';
import { csrfTokenFor } from '../src/api/web-session.js';
import { FakeLlm, LlmError } from '../src/ai/llm.js';
import { aiFailureMessage } from '../src/ai/user-feedback.js';
import { FakeCreationLlm, definitionBody, type CreationLlm, type CreationProposal } from '../src/ai/creation.js';
import { CreationRequests, type CreationRequest } from '../src/services/creation-requests.js';
import { requestAccountDeletion } from '../src/services/deletion.js';
import { getAvailableTemplate } from '../src/services/templates.js';
import { shanghaiDate } from '../src/domain/time.js';

const origin = 'https://creation.planplan.test';
const auth: AuthConfig = { jwtSecret: new TextEncoder().encode('synthetic-creation-api-secret-no-deploy'), appleAudience: null, devLogin: false, webAllowedOrigins: [origin], cookieSecure: true };
const capabilities = 'reading-template-v1,ledger-template-v1,generic-record-v1,chat-recovery-v1,private-template-v1';
const today = shanghaiDate(new Date());
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

describe('私人创作 HTTP、请求恢复与账户边界', () => {
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let proposal: CreationProposal;
  let model: FakeCreationLlm;
  let recordModel: FakeLlm;
  beforeAll(async () => {
    db = await openTestDb();
    const body = definitionBody(await getAvailableTemplate(db, 'official.water'));
    body.name = '私人饮水'; body.description = '记录每天的饮水与目标。';
    body.example.config.startDate = today; body.example.record.date = today;
    proposal = { kind: 'proposal', reply: '已整理饮水的记录项目，可以预览后保存模板。', definition: body };
    model = new FakeCreationLlm(() => proposal);
    recordModel = new FakeLlm(() => ({ intent: 'smalltalk', reply: '合成测试' }));
    app = createApp(db, recordModel, auth, undefined, { creationLlm: model });
  });
  afterAll(async () => { await db.close(); });
  async function account(consent = false) {
    const user = await upsertUser(db, { devName: `creation-${randomUUID()}` });
    if (consent) await db.query('UPDATE users SET ai_consent=true WHERE id=$1', [user.id]);
    const token = await issueToken(auth, user.id, user.token_version);
    return { id: user.id, headers: { cookie: `__Host-planplan-session=${token}`, origin, 'X-CSRF-Token': csrfTokenFor(auth, token), 'X-PlanPlan-Expected-User': user.id, 'X-PlanPlan-Capabilities': capabilities } };
  }
  const read = (path: string, headers: Record<string, string>, target = app) => target.request(path, { headers });
  const post = (path: string, body: unknown, headers: Record<string, string>, target = app) => target.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const send = (body: Record<string, unknown>, headers: Record<string, string>, target = app) => post('/v1/creation/requests', { clientOpId: randomUUID(), ...body }, headers, target);
  const saved = async (request: Promise<Response> | Response) => { const response = await request; const result = await response.json(); expect(response.status, JSON.stringify(result)).toBe(200); return result; };
  async function manual(headers: Record<string, string>) {
    const created = await saved(send({ action: 'create' }, headers));
    const updated = await saved(send({ action: 'update', draftId: created.draft.id, expectedVersion: created.draft.version, definition: proposal.definition }, headers));
    return saved(send({ action: 'save', draftId: updated.draft.id, expectedVersion: updated.draft.version }, headers));
  }
  async function adopt(result: Awaited<ReturnType<typeof manual>>, headers: Record<string, string>) {
    const version = result.draft.savedTemplate;
    return saved(post('/v1/operations', { clientOpId: randomUUID(), actions: [{ type: 'adopt_template', templateId: version.id, templateVersion: version.version }] }, headers));
  }

  it('无AI授权仍可手动创建、保存和采用；浏览及保存都不产生事实', async () => {
    const a = await account();
    const initialCalls = model.calls.length;
    const result = await manual(a.headers);
    expect(result.draft.savedTemplate.version).toBe(1);
    expect(result.draft.definition.source).toBe('private');
    expect(await db.query('SELECT id FROM plans WHERE user_id=$1', [a.id])).toHaveLength(0);
    expect(await db.query('SELECT id FROM records WHERE user_id=$1', [a.id])).toHaveLength(0);
    expect((await saved(read('/v1/creation/templates', a.headers))).templates).toHaveLength(1);
    expect((await saved(read('/v1/templates', {}))).templates).toHaveLength(3);
    const adopted = await adopt(result, a.headers);
    expect(adopted.templatePlan).toMatchObject({ source: 'private', engine: 'generic' });
    const planId = adopted.templatePlan.planId;
    await saved(post('/v1/operations', { clientOpId: randomUUID(), actions: [{ type: 'add_generic_record', planId, values: { date: today, amountMl: 500 } }] }, a.headers));
    const view = await saved(read(`/v1/plans/${planId}/generic`, a.headers));
    expect(view.summary.metrics[0].value).toBe(500);
    expect(view.records[0].definitionTemplateId).toBe(result.draft.savedTemplate.id);
    const zip = unzipSync(new Uint8Array(await (await read('/v1/export', a.headers)).arrayBuffer()));
    expect(Object.keys(zip)).toContain('creation-drafts.json');
    expect(Object.keys(zip)).toContain('private-templates.json');
    expect(strFromU8(zip['private-templates.json']!)).toContain('私人饮水');
    expect(model.calls.length).toBe(initialCalls);
  });

  it('创作端点保留CSRF、Origin、预期账户、能力和严格请求校验', async () => {
    const a = await account(), b = await account();
    expect((await send({ action: 'create' }, {})).status).toBe(401);
    expect((await send({ action: 'create' }, { ...a.headers, 'X-CSRF-Token': '' })).status).toBe(403);
    expect((await send({ action: 'create' }, { ...a.headers, origin: 'https://unrelated.test' })).status).toBe(403);
    expect((await send({ action: 'create' }, { ...a.headers, 'X-PlanPlan-Expected-User': b.id })).status).toBe(409);
    expect((await send({ action: 'create' }, { ...a.headers, 'X-PlanPlan-Capabilities': 'generic-record-v1' })).status).toBe(422);
    expect((await send({ action: 'create', owner: b.id }, a.headers)).status).toBe(400);
    expect((await send({ action: 'fork', sourcePlanId: randomUUID(), sourceTemplateId: 'official.water', sourceTemplateVersion: 1 }, a.headers)).status).toBe(400);
    expect((await read('/v1/creation/drafts?limit=101', a.headers)).status).toBe(400);
    expect(await db.query('SELECT id FROM creation_drafts WHERE user_id=$1', [a.id])).toHaveLength(0);
  });

  it('私人草稿、版本、来源、请求结果与采用均不可跨账户读取', async () => {
    const a = await account(), b = await account();
    const result = await manual(a.headers), version = result.draft.savedTemplate;
    const adopted = await adopt(result, a.headers);
    for (const path of [`/v1/creation/drafts/${result.draft.id}`, `/v1/creation/templates/${version.id}?version=1`, `/v1/templates/${version.id}`]) expect((await read(path, b.headers)).status).toBe(404);
    expect((await saved(read('/v1/creation/drafts', b.headers))).drafts).toEqual([]);
    expect((await saved(read('/v1/creation/templates', b.headers))).templates).toEqual([]);
    expect((await saved(read(`/v1/creation/requests/${result.clientOpId}`, b.headers))).status).toBe('not_found');
    expect((await send({ action: 'fork', sourcePlanId: adopted.templatePlan.planId }, b.headers)).status).toBe(404);
    expect((await send({ action: 'fork', sourceTemplateId: version.id, sourceTemplateVersion: 1 }, b.headers)).status).toBe(404);
    expect((await post('/v1/operations', { clientOpId: randomUUID(), actions: [{ type: 'adopt_template', templateId: version.id, templateVersion: 1 }] }, b.headers)).status).toBe(404);
    expect((await read(`/v1/creation/templates/${version.id}`, {})).status).toBe(401);
  });

  it('新建、保存同ID重放只返回同一结果，同ID异体拒绝；另一进程可以核对结果', async () => {
    const a = await account();
    const clientOpId = randomUUID();
    const created = await saved(send({ clientOpId, action: 'create' }, a.headers));
    expect(await saved(send({ clientOpId, action: 'create' }, a.headers))).toEqual(created);
    expect((await send({ clientOpId, action: 'fork', sourceTemplateId: 'official.water', sourceTemplateVersion: 1 }, a.headers)).status).toBe(409);
    const updated = await saved(send({ action: 'update', draftId: created.draft.id, expectedVersion: created.draft.version, definition: proposal.definition }, a.headers));
    const body = { clientOpId: randomUUID(), action: 'save', draftId: updated.draft.id, expectedVersion: updated.draft.version };
    const savedVersion = await saved(send(body, a.headers));
    expect(await saved(send(body, a.headers))).toEqual(savedVersion);
    const restarted = createApp(db, recordModel, auth, undefined, { creationLlm: model });
    expect((await saved(read(`/v1/creation/requests/${body.clientOpId}`, a.headers, restarted))).result).toEqual(savedVersion);
    expect(await db.query('SELECT template_id FROM template_versions WHERE owner_user_id=$1', [a.id])).toHaveLength(1);
  });

  it('模型在途可核对processing，并发同请求不会二次生成；事务不跨模型等待', async () => {
    const a = await account(true), started = deferred<void>(), output = deferred<CreationProposal>();
    let calls = 0;
    const delayed: CreationLlm = { async generate() { calls++; started.resolve(); return { ...await output.promise, latencyMs: 1 }; } };
    const target = createApp(db, recordModel, auth, undefined, { creationLlm: delayed });
    const created = await saved(send({ action: 'create' }, a.headers, target));
    const body = { clientOpId: randomUUID(), action: 'message', draftId: created.draft.id, expectedVersion: created.draft.version, text: '每天记录喝水量，目标两千毫升。' };
    const first = send(body, a.headers, target);
    await started.promise;
    expect((await saved(read(`/v1/creation/requests/${body.clientOpId}`, a.headers, target))).status).toBe('processing');
    expect((await send(body, a.headers, target)).status).toBe(202);
    await db.tx(async q => { await q.query('SELECT id FROM users WHERE id=$1', [a.id]); }, a.id);
    output.resolve(proposal);
    const result = await saved(first);
    expect(result.draft.messages).toHaveLength(2);
    expect((await saved(send(body, a.headers, target))).draft).toEqual(result.draft);
    expect(calls).toBe(1);
    expect(await db.query('SELECT id FROM plans WHERE user_id=$1', [a.id])).toHaveLength(0);
  });

  it('模型失败保持原草稿，可用原ID重试；异体不能借失败替换请求', async () => {
    const a = await account(true); let calls = 0;
    const failing: CreationLlm = { async generate() { if (++calls === 1) throw new LlmError('timeout', 'untrusted provider response'); return { ...proposal, latencyMs: 1 }; } };
    const target = createApp(db, recordModel, auth, undefined, { creationLlm: failing });
    const created = await saved(send({ action: 'create' }, a.headers, target));
    const body = { clientOpId: randomUUID(), action: 'message', draftId: created.draft.id, expectedVersion: 1, text: '设计每日饮水模板' };
    const failed = await saved(send(body, a.headers, target));
    expect(failed).toMatchObject({ transient: true, message: aiFailureMessage('timeout', 'creation'), draft: { version: 1, definition: null, messages: [] } });
    expect(JSON.stringify(failed)).not.toContain('untrusted provider');
    expect(failed.message).not.toContain('什么都没有保存');
    expect((await saved(read(`/v1/creation/requests/${body.clientOpId}`, a.headers, target))).status).toBe('not_found');
    expect((await send({ ...body, text: '不同要求' }, a.headers, target)).status).toBe(409);
    const result = await saved(send(body, a.headers, target));
    expect(result.transient).toBe(false); expect(result.draft.messages).toHaveLength(2); expect(calls).toBe(2);
  });

  it('生成期间另一端编辑时拒绝晚到结果，保留新草稿和原请求错误', async () => {
    const a = await account(true), started = deferred<void>(), output = deferred<CreationProposal>();
    const delayed: CreationLlm = { async generate() { started.resolve(); return { ...await output.promise, latencyMs: 1 }; } };
    const target = createApp(db, recordModel, auth, undefined, { creationLlm: delayed });
    const created = await saved(send({ action: 'create' }, a.headers, target));
    const body = { clientOpId: randomUUID(), action: 'message', draftId: created.draft.id, expectedVersion: 1, text: '生成饮水模板' };
    const first = send(body, a.headers, target); await started.promise;
    const edited = await saved(send({ action: 'update', draftId: created.draft.id, expectedVersion: 1, definition: { ...proposal.definition!, name: '另一页编辑' } }, a.headers, target));
    output.resolve(proposal);
    expect((await first).status).toBe(409);
    expect((await saved(read(`/v1/creation/drafts/${created.draft.id}`, a.headers, target))).name).toBe('另一页编辑');
    expect((await send(body, a.headers, target)).status).toBe(409);
    expect((await send({ action: 'save', draftId: created.draft.id, expectedVersion: 1 }, a.headers, target)).status).toBe(409);
    expect((await saved(read(`/v1/creation/drafts/${created.draft.id}`, a.headers, target))).version).toBe(edited.draft.version);
  });

  it('生成前后都检查当前授权版本，撤销授权不会保存提案', async () => {
    const a = await account(true), started = deferred<void>(), output = deferred<CreationProposal>();
    const created = await saved(send({ action: 'create' }, a.headers));
    const delayed: CreationLlm = { async generate() { started.resolve(); return { ...await output.promise, latencyMs: 1 }; } };
    const requests = new CreationRequests(db, delayed, 'current-consent');
    const body: CreationRequest = { clientOpId: randomUUID(), action: 'message', draftId: created.draft.id, expectedVersion: 1, text: '创建饮水模板' };
    await expect(requests.submit(a.id, body)).rejects.toMatchObject({ code: 'ai_consent_required' });
    await db.query('UPDATE users SET ai_consent_version=$2 WHERE id=$1', [a.id, 'current-consent']);
    const first = requests.submit(a.id, body); await started.promise;
    await db.query('UPDATE users SET ai_consent=false WHERE id=$1', [a.id]); output.resolve(proposal);
    await expect(first).rejects.toMatchObject({ code: 'ai_consent_required' });
    expect((await saved(read(`/v1/creation/drafts/${created.draft.id}`, a.headers))).definition).toBeNull();
  });

  it('过期请求显式恢复获得新租约，原调用晚到不会覆盖新结果', async () => {
    const a = await account(true), started = deferred<void>(), output = deferred<CreationProposal>();
    let time = new Date();
    const now = () => time;
    const created = await saved(send({ action: 'create' }, a.headers));
    const firstCoordinator = new CreationRequests(db, { async generate() { started.resolve(); return { ...await output.promise, latencyMs: 1 }; } }, null, now, 1000);
    const body: CreationRequest = { clientOpId: randomUUID(), action: 'message', draftId: created.draft.id, expectedVersion: 1, text: '设计饮水模板' };
    const first = firstCoordinator.submit(a.id, body); await started.promise;
    time = new Date(time.getTime() + 1001);
    expect((await firstCoordinator.lookup(a.id, body.clientOpId)).status).toBe('not_found');
    const secondCoordinator = new CreationRequests(db, new FakeCreationLlm(() => ({ ...proposal, definition: { ...proposal.definition!, name: '恢复后的模板' } })), null, now, 1000);
    const second = await secondCoordinator.submit(a.id, body);
    output.resolve(proposal); expect(await first).toEqual(second);
    const current = await saved(read(`/v1/creation/drafts/${created.draft.id}`, a.headers));
    expect(current.name).toBe('恢复后的模板'); expect(current.messages).toHaveLength(2);
  });

  it('生成在途退出或删除账户时，不会复活会话或重建草稿', async () => {
    for (const action of ['logout', 'delete']) {
      const a = await account(true), started = deferred<void>(), output = deferred<CreationProposal>();
      const created = await saved(send({ action: 'create' }, a.headers));
      const requests = new CreationRequests(db, { async generate() { started.resolve(); return { ...await output.promise, latencyMs: 1 }; } }, null);
      const first = requests.submit(a.id, { clientOpId: randomUUID(), action: 'message', draftId: created.draft.id, expectedVersion: 1, text: '设计饮水模板' }); await started.promise;
      if (action === 'logout') await saved(post('/v1/logout', {}, a.headers)); else expect((await requestAccountDeletion(db, a.id)).status).toBe('completed');
      output.resolve(proposal); await expect(first).rejects.toMatchObject({ code: 'unauthorized' });
      const remaining = await db.query<{ definition: unknown }>('SELECT definition FROM creation_drafts WHERE user_id=$1', [a.id]);
      expect(remaining).toEqual(action === 'logout' ? [{ definition: null }] : []);
    }
  });

  it('旧generic端不读写私人来源，但核对仍保留成功状态和原ID', async () => {
    const a = await account(true), result = await manual(a.headers), adopted = await adopt(result, a.headers);
    const planId = adopted.templatePlan.planId;
    const clientOpId = randomUUID();
    const added = await saved(post('/v1/operations', { clientOpId, actions: [{ type: 'add_generic_record', planId, values: { date: today, amountMl: 500 } }] }, a.headers));
    const old = { ...a.headers, 'X-PlanPlan-Capabilities': 'generic-record-v1' };
    expect((await saved(read('/v1/plans', old))).plans).toEqual([]);
    for (const path of [`/v1/plans/${planId}/template`, `/v1/plans/${planId}/generic`, `/v1/records/${added.items[0].record.id}`]) expect((await read(path, old)).status).toBe(422);
    expect((await post('/v1/operations', { clientOpId: randomUUID(), actions: [{ type: 'archive_plan', planId }] }, old)).status).toBe(422);
    const lookup = await saved(read(`/v1/operations/${clientOpId}`, old));
    expect(lookup.status).toBe('succeeded'); expect(lookup.result.operationId).toBe(added.operationId); expect(lookup.result.items).toEqual([]);
    expect(lookup.result.compatibility.message).toContain('无需重复提交');
    const before = recordModel.calls.length;
    const reply = await saved(post('/v1/chat', { clientMsgId: randomUUID(), text: '今天喝了300毫升', scopePlanId: planId }, old));
    expect(reply.transient).toBe(false); expect(reply.assistant.text).toContain('新版网页'); expect(recordModel.calls.length).toBe(before);
    expect((await saved(read(`/v1/plans/${planId}/generic`, a.headers))).totalRecords).toBe(1);
  });

  it('旧端的无指定计划查询和总览在生成文字之前排除私人统计', async () => {
    const a = await account(true), result = await manual(a.headers), adopted = await adopt(result, a.headers);
    await saved(post('/v1/operations', { clientOpId: randomUUID(), actions: [{ type: 'add_generic_record', planId: adopted.templatePlan.planId, values: { date: today, amountMl: 827 } }] }, a.headers));
    const old = { ...a.headers, 'X-PlanPlan-Capabilities': 'generic-record-v1' };
    for (const kind of ['generic_summary', 'overview'] as const) {
      const target = createApp(db, new FakeLlm(() => ({ intent: 'query', query: { kind, plan_id: null, period: 'today', from: null, to: null, category: null } })), auth);
      const reply = await saved(post('/v1/chat', { clientMsgId: randomUUID(), text: '今天合计多少？' }, old, target));
      expect(reply.transient).toBe(false);
      expect(JSON.stringify(reply.assistant)).not.toContain('827');
      expect(JSON.stringify(reply.assistant)).not.toContain('私人饮水');
      expect(reply.assistant.cards.find((card: { type: string }) => card.type === 'query')?.kind).toBe('none');
    }
  });

  it('明确取消只追加创作回复，不调用模型也不改当前定义', async () => {
    const a = await account();
    const result = await manual(a.headers);
    const before = model.calls.length;
    const cancelled = await saved(send({ action: 'message', draftId: result.draft.id, expectedVersion: result.draft.version, text: '取消这次修改。' }, a.headers));
    expect(cancelled.draft.definition).toEqual(result.draft.definition);
    expect(cancelled.draft.messages.at(-1).text).toContain('已取消');
    expect(cancelled.draft.version).toBeGreaterThan(result.draft.version);
    expect(model.calls.length).toBe(before);
  });
});
