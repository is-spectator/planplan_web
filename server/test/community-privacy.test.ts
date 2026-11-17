import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDb } from './database.js';
import type { Db } from '../src/db/db.js';
import { createApp } from '../src/api/app.js';
import { issueToken, upsertUser, type AuthConfig } from '../src/api/auth.js';
import { csrfTokenFor } from '../src/api/web-session.js';
import { FakeLlm } from '../src/ai/llm.js';
import { createCreationDraft, updateCreationDraft, saveCreationDraft } from '../src/services/creation-drafts.js';
import { getAvailableTemplate } from '../src/services/templates.js';
import { communityHash } from '../src/services/community.js';
import type { CommunityResult, PublicCommunityPayload } from '../src/services/community-contracts.js';

const origin = 'https://community-privacy.planplan.test';
const auth: AuthConfig = { jwtSecret: new TextEncoder().encode('synthetic-community-privacy-test-no-deploy'), appleAudience: null, devLogin: false, webAllowedOrigins: [origin], cookieSecure: true };
const phoneShapedId = '12345678-1234-4234-8234-138001380000';
const publicText = { title: '每日饮水', description: '记录饮水并查看目标。', category: 'health', authorName: '合成创作者' };
type Account = { id: string; headers: Record<string, string> };

describe('社区公开内容检查与服务器生成身份', () => {
  let db: Db, app: ReturnType<typeof createApp>, reviewer: Account;
  beforeAll(async () => {
    db = await openTestDb();
    reviewer = await account();
    app = createApp(db, new FakeLlm(() => { throw new Error('This test must never call a model'); }), auth, undefined, { reviewerUserIds: new Set([reviewer.id]) });
  });
  afterAll(async () => { await db.close(); });
  async function account(): Promise<Account> {
    const user = await upsertUser(db, { devName: `community-privacy-${randomUUID()}` });
    const token = await issueToken(auth, user.id, user.token_version);
    return { id: user.id, headers: { cookie: `__Host-planplan-session=${token}`, origin, 'X-CSRF-Token': csrfTokenFor(auth, token), 'X-PlanPlan-Expected-User': user.id, 'X-PlanPlan-Capabilities': 'generic-record-v1,private-template-v1,generic-template-v2,community-template-v1' } };
  }
  const request = (who: Account, body: Record<string, unknown>) => app.request('/v1/community/requests', { method: 'POST', headers: { 'content-type': 'application/json', ...who.headers }, body: JSON.stringify({ clientOpId: randomUUID(), ...body }) });
  async function ok(response: Promise<Response> | Response): Promise<CommunityResult> {
    const received = await response, body = await received.json();
    expect(received.status, JSON.stringify(body)).toBe(200);
    return body as CommunityResult;
  }
  async function source(who: Account) {
    return db.tx(async q => {
      const draft = await createCreationDraft(q, who.id);
      const { name, description, configurationFields, recordFields, metrics, components, example } = await getAvailableTemplate(q, 'official.water');
      const changed = await updateCreationDraft(q, who.id, draft.id, draft.version, { name, description, configurationFields, recordFields, metrics, components, example });
      return saveCreationDraft(q, who.id, draft.id, changed.version);
    }, who.id);
  }
  async function preview(who: Account, id = randomUUID()) {
    const saved = await source(who);
    await db.query('INSERT INTO community_listings(id,owner_user_id,source_template_id,title,description,category,author_name) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, who.id, saved.savedTemplate!.id, publicText.title, publicText.description, publicText.category, publicText.authorName]);
    const body = { action: 'preview', sourceTemplateId: saved.savedTemplate!.id, sourceTemplateVersion: saved.savedTemplate!.version, listingId: id, expectedVersion: 1, ...publicText };
    return { result: await ok(request(who, body)), body };
  }
  const submit = (who: Account, result: CommunityResult) => request(who, { action: 'submit', previewId: result.preview!.id, publicHash: result.preview!.publicHash, confirmPublic: true });
  async function expectPrivateContentRejected(response: Promise<Response> | Response) {
    const received = await response;
    expect(received.status).toBe(422);
    expect(await received.json()).toMatchObject({ error: { code: 'invalid_input', message: '公开内容中可能包含邮箱、地址、密钥或外部链接，请清除私人信息后重新预览。' } });
  }
  async function replaceStoredPreview(result: CommunityResult, change: (payload: PublicCommunityPayload) => void) {
    const payload = structuredClone(result.preview!.payload);
    change(payload);
    const publicHash = communityHash(payload);
    await db.query('UPDATE community_previews SET public_payload=$2,public_hash=$3 WHERE id=$1', [result.preview!.id, JSON.stringify(payload), publicHash]);
    return { ...result, preview: { ...result.preview!, payload, publicHash } };
  }

  it('HTTP：生成ID含连续手机号数字时预览、提审、审核、上架使用同一公开内容检查', async () => {
    const author = await account();
    const { result: p } = await preview(author, phoneShapedId);
    expect(p.preview!.payload.definition.id).toBe(`community.${phoneShapedId}`);
    expect(communityHash(p.preview!.payload)).toBe(p.preview!.publicHash);
    const submitted = await ok(submit(author, p));
    const approved = await ok(request(reviewer, { action: 'review', submissionId: submitted.submission!.id, expectedVersion: submitted.submission!.version, decision: 'approve' }));
    const published = await ok(request(author, { action: 'publish', listingId: approved.listing!.id, expectedVersion: approved.listing!.version, submissionId: approved.submission!.id, confirmPublic: true }));
    expect(published.listing).toMatchObject({ status: 'listed', templateId: `community.${phoneShapedId}`, templateVersion: 1 });
    const response = await app.request(`/v1/market/templates/community.${phoneShapedId}`);
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain(`community.${phoneShapedId}`);
    expect(await db.query('SELECT id FROM plans WHERE user_id=$1', [author.id])).toHaveLength(0);
    expect(await db.query('SELECT id FROM records WHERE user_id=$1', [author.id])).toHaveLength(0);
  });

  it.each([
    ['邮箱', 'person@example.test'],
    ['电话', '13800138000'],
    ['地址', '北京市朝阳区示例路88号'],
    ['密钥', 'sk-or-v1-synthetic-secret'],
    ['链接', 'https://external.test'],
    ['相同UUID作为用户文字', `community.${phoneShapedId}`],
  ])('预览仍拒绝用户文字中的%s', async (_kind, text) => {
    const author = await account(), { result, body } = await preview(author);
    await expectPrivateContentRejected(request(author, { ...body, description: text }));
    expect(await db.query('SELECT id FROM community_previews WHERE listing_id=$1', [result.listing!.id])).toHaveLength(1);
  });

  const privateLocations: Array<[string, (payload: PublicCommunityPayload) => void]> = [
    ['title', p => { p.title = '13800138000'; }],
    ['description', p => { p.description = 'person@example.test'; }],
    ['authorName', p => { p.authorName = '北京市朝阳区示例路88号'; }],
    ['definition.name', p => { p.definition.name = 'https://external.test'; }],
    ['definition.description', p => { p.definition.description = 'sk-or-v1-synthetic-secret'; }],
    ['configurationFields.label', p => { p.definition.configurationFields[0]!.label = '13800138000'; }],
    ['recordFields.id', p => { p.definition.recordFields[0]!.id = 'field13800138000'; }],
    ['recordFields.options', p => { p.definition.recordFields.push({ id: 'contact', label: '联系', type: 'single_select', required: false, options: ['person@example.test'] }); }],
    ['metrics.label', p => { p.definition.metrics[0]!.label = 'https://external.test'; }],
    ['configurationDefaults', p => { p.definition.configurationDefaults = { name: '13800138000' }; }],
    ['recordDefaults', p => { p.definition.recordDefaults = { note: 'person@example.test' }; }],
    ['example', p => { p.definition.example.record.note = '北京市朝阳区示例路88号'; }],
  ];
  it.each(privateLocations)('提审重新检查持久公开快照中的%s，不忽略任何用户可控值', async (_path, change) => {
    const author = await account(), { result } = await preview(author);
    // Simulate a persisted older preview and recompute its exact confirmation hash.
    // This exercises the submit-time defence separately from preview validation.
    const changed = await replaceStoredPreview(result, change);
    await expectPrivateContentRejected(submit(author, changed));
    expect(await db.query('SELECT id FROM community_submissions WHERE preview_id=$1', [result.preview!.id])).toHaveLength(0);
  });

  it('服务器身份与作品不一致即拒绝，不能通过排除扫描放行另一模板身份', async () => {
    const author = await account(), { result } = await preview(author);
    const changed = await replaceStoredPreview(result, p => { p.definition.id = 'community.12345678-1234-4234-8234-000000000000'; });
    const response = await submit(author, changed);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_input', message: '公开模板身份不正确。' } });
    expect(await db.query('SELECT id FROM community_submissions WHERE preview_id=$1', [result.preview!.id])).toHaveLength(0);
  });

  it('生成ID仍包含在确认hash中，客户端不能用另一内容的hash提审', async () => {
    const author = await account(), { result } = await preview(author);
    const payload = structuredClone(result.preview!.payload);
    payload.definition.id = `community.${phoneShapedId}`;
    const response = await request(author, { action: 'submit', previewId: result.preview!.id, publicHash: communityHash(payload), confirmPublic: true });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'operation_changed' } });
    expect(await db.query('SELECT id FROM community_submissions WHERE preview_id=$1', [result.preview!.id])).toHaveLength(0);
  });
});
