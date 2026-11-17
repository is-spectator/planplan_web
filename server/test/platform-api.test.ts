import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { openTestDb } from './database.js';
import type { Db } from '../src/db/db.js';
import { createApp } from '../src/api/app.js';
import { issueToken, upsertUser, type AuthConfig } from '../src/api/auth.js';
import { csrfTokenFor } from '../src/api/web-session.js';
import { FakeLlm } from '../src/ai/llm.js';
import type { TurnWrite } from '../src/ai/turn.js';
import type { CreationDefinitionBody } from '../src/services/creation-drafts.js';
import { shanghaiDate } from '../src/domain/time.js';

const origin = 'https://platform.planplan.test';
const auth: AuthConfig = { jwtSecret: new TextEncoder().encode('synthetic-platform-api-secret-no-deploy'), appleAudience: null, devLogin: false, webAllowedOrigins: [origin], cookieSecure: true };
const capabilities = 'reading-template-v1,ledger-template-v1,generic-record-v1,chat-recovery-v1,private-template-v1,generic-template-v2,community-template-v1';
const today = shanghaiDate(new Date());
type Account = { id: string; headers: Record<string, string> };
const definition = (): CreationDefinitionBody => ({
  name: '阅读时长', description: '记录阅读时长，查看周目标和分类趋势。',
  configurationFields: [
    { id: 'name', label: '名称', type: 'text', required: true, maxLength: 20 },
    { id: 'startDate', label: '开始日期', type: 'date', required: true },
    { id: 'weeklyMinutes', label: '每周分钟', type: 'duration', unit: 'minute', required: false, min: 1 },
  ],
  recordFields: [
    { id: 'date', label: '日期', type: 'date', required: true },
    { id: 'minutes', label: '时长', type: 'duration', unit: 'minute', required: false, min: 0 },
    { id: 'category', label: '分类', type: 'single_select', required: false, options: ['纸书', '电子书'] },
    { id: 'finished', label: '读完', type: 'boolean', required: false },
    { id: 'note', label: '备注', type: 'text', required: false, maxLength: 100 },
  ],
  metrics: [
    { id: 'weekly', label: '周进度', operation: 'goal_progress', fieldId: 'minutes', goalFieldId: 'weeklyMinutes', period: 'week' },
    { id: 'mean', label: '每次平均时长', operation: 'mean', fieldId: 'minutes', period: 'week', groupByFieldId: 'category' },
  ],
  components: ['summary', 'goal', 'categories', 'trend', 'records'],
  configurationDefaults: { weeklyMinutes: 5197 }, recordDefaults: { note: '私人默认备注' },
  example: { config: { name: '私人阅读', startDate: today, weeklyMinutes: 5197 }, record: { date: today, minutes: 20, note: '私人示例绝不公开' } },
});

describe('网页平台 HTTP：创作、社区、通用运行与反馈闭环', () => {
  let db: Db, app: ReturnType<typeof createApp>, reviewer: Account;
  beforeAll(async () => {
    db = await openTestDb();
    reviewer = await account();
    const write: TurnWrite = { op: 'add_generic_record', is_fact: true, amount_text: null, currency: 'CNY', duration_value: null, duration_unit: null, category: null, date_kind: 'today', days_ago: null, date: null, note: null, plan_id: null, plan_name: null, activity: null, days_per_week: null, min_minutes: null, scope: 'unspecified', record_id: null, component: null, generic_fields: [{ field_id: 'amountMl', value: 300, unit: 'ml', unit_size: null, unit_size_unit: null }] };
    const field = (field_id: string, value: string | number | boolean | null, unit: string | null = null) => ({ field_id, value, unit, unit_size: null, unit_size_unit: null });
    const llm = new FakeLlm(text => {
      if (text === '今天喝了300毫升') return { intent: 'write', writes: [write] };
      if (text === '采用模板建议目标；以后默认没有读完，分类也默认填写') return { intent: 'write', writes: [{ ...write, op: 'configure_generic_plan', is_fact: false, generic_fields: [], complete_setup: true, apply_template_defaults: true, record_defaults: [field('finished', false), field('category', null)] }] };
      if (text === '纸书') return { intent: 'answer_pending', writes: [{ ...write, op: 'configure_generic_plan', is_fact: false, generic_fields: [], record_defaults: [field('category', '纸书')] }] };
      if (text === '今天读了20分钟') return { intent: 'write', writes: [{ ...write, generic_fields: [field('minutes', 20, 'minute')] }] };
      return { intent: 'smalltalk', reply: '合成测试。' };
    });
    app = createApp(db, llm, auth, undefined, { reviewerUserIds: new Set([reviewer.id]) });
  });
  afterAll(async () => { await db.close(); });
  async function account(consent = false): Promise<Account> {
    const user = await upsertUser(db, { devName: `platform-${randomUUID()}` });
    if (consent) await db.query('UPDATE users SET ai_consent=true WHERE id=$1', [user.id]);
    const token = await issueToken(auth, user.id, user.token_version);
    return { id: user.id, headers: { cookie: `__Host-planplan-session=${token}`, origin, 'X-CSRF-Token': csrfTokenFor(auth, token), 'X-PlanPlan-Expected-User': user.id, 'X-PlanPlan-Capabilities': capabilities } };
  }
  const get = (path: string, who?: Account) => app.request(path, { headers: who?.headers });
  const post = (path: string, body: unknown, who: Account) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...who.headers }, body: JSON.stringify(body) });
  const ok = async (request: Promise<Response> | Response) => { const response = await request, body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(200); return body; };
  const creation = (who: Account, body: Record<string, unknown>) => post('/v1/creation/requests', { clientOpId: randomUUID(), ...body }, who);
  const community = (who: Account, body: Record<string, unknown>) => post('/v1/community/requests', { clientOpId: randomUUID(), ...body }, who);
  const operation = (who: Account, actions: unknown[], clientOpId = randomUUID()) => post('/v1/operations', { clientOpId, actions }, who);
  const feedback = (who: Account, body: Record<string, unknown>) => post('/v1/feedback/requests', { clientOpId: randomUUID(), ...body }, who);
  async function manual(who: Account, body = definition()) {
    const created = await ok(creation(who, { action: 'create' }));
    const updated = await ok(creation(who, { action: 'update', draftId: created.draft.id, expectedVersion: created.draft.version, definition: body }));
    return (await ok(creation(who, { action: 'save', draftId: updated.draft.id, expectedVersion: updated.draft.version }))).draft;
  }
  async function preview(who: Account, saved: Awaited<ReturnType<typeof manual>>, extra: Record<string, unknown> = {}) {
    return ok(community(who, { action: 'preview', sourceTemplateId: saved.savedTemplate.id, sourceTemplateVersion: saved.savedTemplate.version, title: '阅读周目标', description: '按周查看阅读时长和分类趋势。', category: 'reading', authorName: '合成创作者', publicDefaults: { configuration: { weeklyMinutes: 150 }, record: { category: '纸书', finished: false } }, ...extra }));
  }
  async function publish(who: Account, p: Awaited<ReturnType<typeof preview>>) {
    const submitted = await ok(community(who, { action: 'submit', previewId: p.preview.id, publicHash: p.preview.publicHash, confirmPublic: true }));
    const approved = await ok(community(reviewer, { action: 'review', submissionId: submitted.submission.id, expectedVersion: submitted.submission.version, decision: 'approve' }));
    return ok(community(who, { action: 'publish', listingId: approved.listing.id, expectedVersion: approved.listing.version, submissionId: approved.submission.id, confirmPublic: true }));
  }

  it('原创经审核显式发布；市场采用、默认填写、编辑撤回、兼容升级和下架保持事实', async () => {
    const author = await account(), reader = await account();
    const saved = await manual(author);
    expect((await ok(get(`/v1/creation/templates/${saved.savedTemplate.id}/publication-eligibility`, author))).canPublish).toBe(true);
    const p = await preview(author, saved);
    expect(JSON.stringify(p.preview.payload)).not.toMatch(/私人示例|私人默认|5197/);
    expect(p.preview.payload.definition).toMatchObject({ source: 'community', configurationDefaults: { weeklyMinutes: 150 }, recordDefaults: { category: '纸书', finished: false } });
    expect((await get(`/v1/market/templates/${p.listing.templateId}`)).status).toBe(404);
    expect((await community(reader, { action: 'preview', sourceTemplateId: saved.savedTemplate.id, sourceTemplateVersion: 1, title: '无权限', description: '无权限', category: 'reading', authorName: '无权限' })).status).toBe(404);
    const submitted = await ok(community(author, { action: 'submit', previewId: p.preview.id, publicHash: p.preview.publicHash, confirmPublic: true }));
    expect((await get('/v1/community/review', reader)).status).toBe(403);
    expect((await ok(get('/v1/community/review?status=pending&limit=1&offset=0', reviewer))).submissions[0].id).toBe(submitted.submission.id);
    const approved = await ok(community(reviewer, { action: 'review', submissionId: submitted.submission.id, expectedVersion: submitted.submission.version, decision: 'approve' }));
    expect((await operation(reader, [{ type: 'adopt_template', templateId: approved.listing.templateId, templateVersion: 1 }])).status).toBe(404);
    const publishId = randomUUID();
    const published = await ok(community(author, { clientOpId: publishId, action: 'publish', listingId: approved.listing.id, expectedVersion: approved.listing.version, submissionId: approved.submission.id, confirmPublic: true }));
    expect(await ok(get(`/v1/community/requests/${publishId}`, author))).toEqual({ status: 'succeeded', result: published });
    expect(await ok(get(`/v1/community/requests/${publishId}`, reader))).toEqual({ status: 'not_found' });
    const templateId = published.listing.templateId;
    const market = await ok(get('/v1/market/templates?source=community&category=reading&q=阅读&limit=1&offset=0', reader));
    expect(market).toMatchObject({ total: 1, limit: 1, offset: 0, templates: [{ templateId, adoptionCount: 0 }] });
    expect((await ok(get('/v1/market/templates?source=community&category=reading&limit=1&offset=1'))).templates).toEqual([]);
    expect((await ok(get('/v1/market/templates?source=official'))).templates.every((t: { source: string }) => t.source === 'official')).toBe(true);
    expect((await get('/v1/market/templates?limit=101')).status).toBe(400);
    const old = { ...reader, headers: { ...reader.headers, 'X-PlanPlan-Capabilities': capabilities.replace(',generic-template-v2', '') } };
    expect((await operation(old, [{ type: 'adopt_template', templateId, templateVersion: 1 }])).status).toBe(422);
    const adoptId = randomUUID(), adoptActions = [{ type: 'adopt_template', templateId, templateVersion: 1 }];
    const adopted = await ok(operation(reader, adoptActions, adoptId)), planId = adopted.templatePlan.planId;
    expect(adopted.templatePlan).toMatchObject({ source: 'community', templateVersion: 1, config: { setupStatus: 'pending', values: { weeklyMinutes: null }, recordDefaults: {}, proposedDefaults: { weeklyMinutes: 150 } } });
    expect(await ok(operation(reader, adoptActions, adoptId))).toEqual({ ...adopted, replayed: true });
    expect((await ok(get(`/v1/market/templates/${templateId}`))).adoptionCount).toBe(1);
    expect((await ok(get(`/v1/plans/${planId}/generic`, reader))).records).toEqual([]);
    const setup = await ok(operation(reader, [{ type: 'configure_generic_plan', planId, expectedVersion: adopted.templatePlan.config.version, patch: {}, completeSetup: true, applyTemplateDefaults: true, recordDefaults: { category: '纸书', finished: false } }]));
    expect(setup.templatePlan.config).toMatchObject({ values: { weeklyMinutes: 150 }, recordDefaults: { category: '纸书', finished: false } });
    expect((await operation(old, [{ type: 'add_generic_record', planId, values: { date: today, minutes: 99 } }])).status).toBe(422);
    const added = await ok(operation(reader, [{ type: 'add_generic_record', planId, values: { date: today, minutes: 20 } }]));
    const recordId = added.items[0].record.id;
    expect(added.items[0]).toMatchObject({ type: 'generic_added', record: { definitionTemplateId: templateId, definitionVersion: 1, fields: { minutes: 20, category: '纸书', finished: false }, defaultedFields: ['category', 'finished'] } });
    const edited = await ok(operation(reader, [{ type: 'edit_generic_record', recordId, expectedVersion: 1, values: { date: today, minutes: 25, category: '电子书' } }]));
    const editRecord = (await ok(get(`/v1/records/${recordId}`, reader))).record;
    expect(editRecord.fields).not.toHaveProperty('finished'); expect(editRecord.defaultedFields ?? []).toEqual([]);
    await ok(post(`/v1/operations/${edited.operationId}/undo`, { clientOpId: randomUUID() }, reader));
    const restored = (await ok(get(`/v1/records/${recordId}`, reader))).record;
    expect(restored).toMatchObject({ fields: { minutes: 20, category: '纸书', finished: false }, defaultedFields: ['category', 'finished'] });
    const summary = (await ok(get(`/v1/plans/${planId}/generic`, reader))).summary;
    expect(summary.metrics[0]).toMatchObject({ period: 'week', value: 20, target: 150, sampleCount: 1 });
    expect(summary.metrics[1]).toMatchObject({ value: 20, groups: [{ key: '纸书', value: 20 }, { key: '电子书', value: null }] });
    expect(summary.metrics[1].series.at(-1)).toMatchObject({ date: today, value: 20 });

    const nextBody = definition(); nextBody.recordFields.push({ id: 'weather', label: '天气', type: 'text', required: false, maxLength: 20 });
    const changed = await ok(creation(author, { action: 'update', draftId: saved.id, expectedVersion: saved.version, definition: nextBody }));
    const savedNext = (await ok(creation(author, { action: 'save', draftId: saved.id, expectedVersion: changed.draft.version }))).draft;
    const v2 = await publish(author, await preview(author, savedNext, { listingId: published.listing.id, expectedVersion: published.listing.version }));
    expect(v2.listing.templateVersion).toBe(2);
    const upgrade = await ok(get(`/v1/plans/${planId}/community-upgrade?targetVersion=2`, reader));
    expect(upgrade.compatible).toBe(true); expect(upgrade.changes).toContain('新增可选项目「天气」');
    expect((await get(`/v1/plans/${planId}/community-upgrade?targetVersion=2`, author)).status).toBe(404);
    expect((await operation(reader, [{ type: 'upgrade_community_template', planId, targetVersion: 2, expectedVersion: upgrade.expectedVersion - 1 }])).status).toBe(409);
    const upgradeId = randomUUID(), upgradeActions = [{ type: 'upgrade_community_template', planId, targetVersion: 2, expectedVersion: upgrade.expectedVersion }];
    const upgraded = await ok(operation(reader, upgradeActions, upgradeId));
    expect(upgraded.templatePlan).toMatchObject({ templateVersion: 2, config: { values: { weeklyMinutes: 150 }, recordDefaults: { category: '纸书', finished: false } } });
    expect(await ok(operation(reader, upgradeActions, upgradeId))).toEqual({ ...upgraded, replayed: true });
    expect((await ok(get(`/v1/operations/${upgradeId}`, reader))).result).toEqual({ ...upgraded, replayed: true });
    expect((await ok(get(`/v1/records/${recordId}`, reader))).record.definitionVersion).toBe(1);
    expect((await ok(get(`/v1/market/templates/${templateId}`))).adoptionCount).toBe(1);
    await ok(community(author, { action: 'unlist', listingId: v2.listing.id, expectedVersion: v2.listing.version }));
    expect((await get(`/v1/market/templates/${templateId}`)).status).toBe(404);
    expect((await operation(reader, [{ type: 'adopt_template', templateId, templateVersion: 2 }])).status).toBe(404);
    expect(await ok(operation(reader, adoptActions, adoptId))).toEqual({ ...adopted, replayed: true });
    expect((await operation(old, adoptActions, adoptId)).status).toBe(422);
    await ok(operation(reader, [{ type: 'edit_generic_record', recordId, expectedVersion: restored.version, values: { date: today, minutes: 30, weather: '晴' } }]));
    const finalRecord = (await ok(get(`/v1/records/${recordId}`, reader))).record;
    expect(finalRecord.fields).toMatchObject({ minutes: 30, weather: '晴' });
    expect(finalRecord.definitionVersion).toBe(2);
    expect((await ok(get(`/v1/plans/${planId}/generic`, reader))).summary.recordCount).toBe(1);
  });

  it('原始聊天消息链接只允许所属账户读取，记录来源与真实消息相连', async () => {
    const owner = await account(true), other = await account();
    const adopted = await ok(operation(owner, [{ type: 'adopt_template', templateId: 'official.water', templateVersion: 1 }]));
    const planId = adopted.templatePlan.planId;
    await ok(post('/v1/chat', { clientMsgId: randomUUID(), text: '今天喝了300毫升', scopePlanId: planId }, owner));
    const view = await ok(get(`/v1/plans/${planId}/generic`, owner));
    expect(view.records).toHaveLength(1);
    const record = view.records[0]; expect(record.source).toBe('chat'); expect(record.sourceMessageId).toBeTruthy();
    expect((await ok(get(`/v1/records/${record.id}`, owner))).source.text).toBe('今天喝了300毫升');
    const message = (await ok(get(`/v1/messages/${record.sourceMessageId}`, owner))).message;
    expect(message).toMatchObject({ text: '今天喝了300毫升', role: 'user', scopePlanId: planId });
    expect((await get(`/v1/messages/${record.sourceMessageId}`, other)).status).toBe(404);
    expect((await get(`/v1/records/${record.id}`, other)).status).toBe(404);
    expect((await get(`/v1/messages/${record.sourceMessageId}`)).status).toBe(401);
  });

  it('聊天配置缺值先澄清，短答保留已确认项，启用默认填写不产生事实', async () => {
    const owner = await account(true), body = definition();
    body.configurationDefaults = { weeklyMinutes: 150 };
    body.recordFields.find(field => field.id === 'category')!.required = true;
    body.example.record.category = '纸书';
    const saved = await manual(owner, body);
    const adopted = await ok(operation(owner, [{ type: 'adopt_template', templateId: saved.savedTemplate.id, templateVersion: 1 }]));
    const planId = adopted.templatePlan.planId;
    const first = await ok(post('/v1/chat', { clientMsgId: randomUUID(), text: '采用模板建议目标；以后默认没有读完，分类也默认填写', scopePlanId: planId }, owner));
    expect(first.assistant.cards.some((card: { type: string }) => card.type === 'clarify')).toBe(true);
    expect((await ok(get(`/v1/plans/${planId}/template`, owner))).config).toMatchObject({ setupStatus: 'pending', values: { weeklyMinutes: null }, recordDefaults: {} });
    expect((await ok(get(`/v1/plans/${planId}/generic`, owner))).records).toEqual([]);
    const answerId = randomUUID();
    const answered = await ok(post('/v1/chat', { clientMsgId: answerId, text: '纸书', scopePlanId: planId }, owner));
    expect(answered.assistant.cards.some((card: { type: string }) => card.type === 'clarify'), JSON.stringify(answered.assistant)).toBe(false);
    const configured = await ok(get(`/v1/plans/${planId}/template`, owner));
    expect(configured.config, JSON.stringify(answered.assistant)).toMatchObject({ setupStatus: 'ready', values: { weeklyMinutes: 150 }, recordDefaults: { category: '纸书', finished: false } });
    expect((await ok(get(`/v1/plans/${planId}/generic`, owner))).records).toEqual([]);
    const recovered = await ok(get(`/v1/chat/${answerId}`, owner)); expect(recovered.status).toBe('succeeded');
    const added = await ok(post('/v1/chat', { clientMsgId: randomUUID(), text: '今天读了20分钟', scopePlanId: planId }, owner));
    const view = await ok(get(`/v1/plans/${planId}/generic`, owner)); expect(view.records, JSON.stringify(added.assistant)).toHaveLength(1);
    expect(view.records[0]).toMatchObject({ fields: { minutes: 20, category: '纸书', finished: false }, defaultedFields: expect.arrayContaining(['finished', 'category']) });
    expect(view.records[0].defaultedFields).toHaveLength(2);
  });

  it('旧客户端不能把 v2 私人改编应用到原来可见的 v1 计划', async () => {
    const owner = await account();
    const old = { ...owner, headers: { ...owner.headers, 'X-PlanPlan-Capabilities': capabilities.replace(',generic-template-v2', '') } };
    const original = (await ok(operation(old, [{ type: 'adopt_template', templateId: 'official.water', templateVersion: 1 }]))).templatePlan;
    const fork = (await ok(creation(owner, { action: 'fork', sourcePlanId: original.planId }))).draft;
    const { name, description, configurationFields, recordFields, metrics, components, example } = fork.definition;
    const updated = (await ok(creation(owner, { action: 'update', draftId: fork.id, expectedVersion: fork.version, definition: { name, description, configurationFields, recordFields, metrics, components, example, recordDefaults: { note: '晨间' } } }))).draft;
    const saved = (await ok(creation(owner, { action: 'save', draftId: updated.id, expectedVersion: updated.version }))).draft;
    const actions = [{ type: 'apply_private_template', planId: original.planId, templateId: saved.savedTemplate.id, templateVersion: saved.savedTemplate.version, expectedVersion: saved.sourcePlanVersion }];
    expect((await operation(old, actions)).status).toBe(422);
    expect((await ok(get(`/v1/plans/${original.planId}/template`, old))).templateId).toBe('official.water');
    const applied = await ok(operation(owner, actions));
    expect(applied.templatePlan.definition.requiredCapabilities).toContain('generic-template-v2');
    expect(applied.templatePlan.config.recordDefaults).toEqual({});
    expect((await get(`/v1/plans/${original.planId}/template`, old)).status).toBe(422);
  });

  it('反馈按角色处理，恢复请求不重复，显式诊断脱敏，导出与账户删除范围正确', async () => {
    const owner = await account(), other = await account();
    expect((await ok(get('/v1/me', reviewer))).roles).toContain('reviewer');
    expect((await ok(get('/v1/me', owner))).roles).toEqual([]);
    expect((await feedback({ ...owner, headers: { ...owner.headers, 'X-CSRF-Token': '' } }, { action: 'create', description: 'CSRF拒绝' })).status).toBe(403);
    expect((await feedback(owner, { action: 'create', description: '拒绝隐式内容', diagnostics: { route: '/plans?token=synthetic', version: 'local' } })).status).toBe(400);
    expect((await feedback(owner, { action: 'create', description: '拒绝额外内容', records: [{ minutes: 20 }] })).status).toBe(400);
    const requestId = randomUUID(), privateRouteId = randomUUID();
    const body = { clientOpId: requestId, action: 'create', description: '保存后没有反馈', diagnostics: { route: `/plans/${privateRouteId}`, version: 'v0.4.0' } };
    const created = await ok(feedback(owner, body));
    expect(created.ticket).toMatchObject({ status: 'open', version: 1, diagnostics: { route: '/plans/:id', version: 'v0.4.0' }, history: [] });
    expect(JSON.stringify(created)).not.toContain(privateRouteId);
    expect(await ok(feedback(owner, body))).toEqual(created);
    expect(await ok(get(`/v1/feedback/requests/${requestId}`, owner))).toEqual({ status: 'succeeded', result: created });
    expect(await ok(get(`/v1/feedback/requests/${requestId}`, other))).toEqual({ status: 'not_found' });
    expect((await feedback(owner, { ...body, description: '改了内容' })).status).toBe(409);
    expect((await get(`/v1/feedback/${created.ticket.id}`, other)).status).toBe(404);
    expect((await get('/v1/feedback/review', owner)).status).toBe(403);
    expect((await feedback(owner, { action: 'update', ticketId: created.ticket.id, expectedVersion: 1, status: 'resolved', response: '不能自我审核' })).status).toBe(403);
    expect((await ok(get('/v1/feedback/review?status=open&limit=1&offset=0', reviewer))).tickets[0].id).toBe(created.ticket.id);
    const updateId = randomUUID();
    const done = await ok(feedback(reviewer, { clientOpId: updateId, action: 'update', ticketId: created.ticket.id, expectedVersion: 1, status: 'resolved', response: '已核对并修复。' }));
    expect(done.ticket).toMatchObject({ version: 2, status: 'resolved', response: '已核对并修复。', history: [{ status: 'resolved', response: '已核对并修复。' }] });
    expect(JSON.stringify(done)).not.toContain(reviewer.id);
    expect((await feedback(reviewer, { action: 'update', ticketId: created.ticket.id, expectedVersion: 1, status: 'in_progress', response: '旧页面' })).status).toBe(409);
    expect((await ok(get(`/v1/feedback/${created.ticket.id}`, owner))).response).toBe('已核对并修复。');
    const untouched = await ok(feedback(other, { action: 'create', description: '另一账户保留反馈' }));
    const exported = await get('/v1/export', owner); expect(exported.status).toBe(200);
    const zip = unzipSync(new Uint8Array(await exported.arrayBuffer())), feedbackText = strFromU8(zip['feedback.json']!);
    expect(feedbackText).toContain('保存后没有反馈'); expect(feedbackText).toContain('已核对并修复。'); expect(feedbackText).not.toContain('另一账户保留反馈');
    const deleted = await app.request('/v1/me', { method: 'DELETE', headers: { 'content-type': 'application/json', ...owner.headers }, body: JSON.stringify({ confirm: 'DELETE' }) });
    expect(deleted.status).toBe(200);
    expect((await get('/v1/feedback', owner)).status).toBe(401);
    expect(await ok(get(`/v1/feedback/requests/${updateId}`, reviewer))).toEqual({ status: 'not_found' });
    expect((await get(`/v1/feedback/${created.ticket.id}`, reviewer)).status).toBe(404);
    expect((await ok(get(`/v1/feedback/${untouched.ticket.id}`, other))).description).toBe('另一账户保留反馈');
  });
});
