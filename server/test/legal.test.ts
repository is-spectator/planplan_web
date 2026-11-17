import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { legalConfigSchema, legalConsentVersion, legalRoutes, loadLegalConfig, MODEL_USAGE_DISCLOSURE, type LegalConfig } from '../src/api/legal.js';
import { openTestDb } from './database.js';
import { createApp } from '../src/api/app.js';
import { FakeLlm } from '../src/ai/llm.js';

// 仅用于测试渲染/校验，不是可部署的服务主体或法律意见。
export const fixtureLegal: LegalConfig = {
  reviewed: true, policyVersion: 'test-1', termsVersion: 'test-1', effectiveDate: '2026-10-27',
  operatorName: '测试主体 & 合作方', contactEmail: 'test@planplan.test', serviceRegion: '测试区域',
  aiRecipient: '测试 AI 接收方', aiService: '测试服务', aiPrivacyURL: 'https://provider.test/privacy',
  aiProcessingDisclosure: '测试合同的数据保留说明。', mailRecipient: '测试邮件接收方', mailService: '测试邮件',
  retentionDisclosure: '测试删除与备份保留说明。',
};

describe('法律告知公开入口', () => {
  it('未配置时不公开占位政策；beta/production 缺配置拒绝启动', async () => {
    expect(loadLegalConfig({ DEPLOYMENT_ENV: 'test' })).toBeUndefined();
    for (const tier of ['beta', 'production']) expect(() => loadLegalConfig({ DEPLOYMENT_ENV: tier })).toThrow('LEGAL_CONFIG_PATH');
    for (const path of ['/privacy', '/terms', '/metadata']) {
      const r = await legalRoutes().request(path);
      expect(r.status).toBe(503);
      expect(await r.text()).not.toContain('YOUR_');
    }
  });

  it('拒绝未审定、空值和占位 URL', () => {
    for (const patch of [{ reviewed: false }, { accessMode: 'unknown' }, { accessMode: 'protected_test', reviewed: false }, { operatorName: '' }, { contactEmail: 'owner@planplan.example' }, { aiPrivacyURL: 'https://api.planplan.example/privacy' }, { aiPrivacyURL: 'http://provider.test/privacy' }]) {
      expect(legalConfigSchema.safeParse({ ...fixtureLegal, ...patch }).success).toBe(false);
    }
  });

  it('匿名可读，元数据只返回客户端告知所需的公开字段', async () => {
    const r = await legalRoutes(fixtureLegal).request('/metadata');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ accessMode: 'email_beta', policyVersion: 'test-1', termsVersion: 'test-1', consentVersion: legalConsentVersion(fixtureLegal), aiRecipient: fixtureLegal.aiRecipient, aiService: fixtureLegal.aiService, aiProcessingDisclosure: fixtureLegal.aiProcessingDisclosure, serviceRegion: fixtureLegal.serviceRegion, modelUsageDisclosure: MODEL_USAGE_DISCLOSURE });
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('受保护测试文案明确不开放邮箱注册、发信或TestFlight分发', async () => {
    const config = legalConfigSchema.parse({ ...fixtureLegal, accessMode: 'protected_test' });
    const app = legalRoutes(config);
    const privacy = await (await app.request('/privacy')).text();
    const terms = await (await app.request('/terms')).text();
    expect(privacy).toContain('受保护测试账号和测试口令');
    expect(privacy).toContain('不开放邮箱注册');
    expect(privacy).toContain('不发送邮箱验证、密码重置或营销邮件');
    expect(privacy).not.toContain('我们处理邮箱地址、密码的单向安全哈希');
    expect(privacy).not.toContain(fixtureLegal.mailRecipient);
    expect(privacy).not.toContain(fixtureLegal.mailService);
    expect(privacy).toContain('登录前流失');
    expect(terms).toContain('尚未通过 TestFlight 分发');
    expect(terms).toContain('不开放邮箱注册或邮件发送');
    expect(terms).not.toContain('当前版本为邀请制 TestFlight 测试');
    expect(terms).not.toContain('使用邮箱和密码注册');
    const metadata = await (await app.request('/metadata')).json();
    expect(metadata.accessMode).toBe('protected_test');
    expect(metadata.consentVersion).toBe(legalConsentVersion(fixtureLegal));
  });

  it('缺省模式保留邮箱内测文案，显式email_beta与缺省输出一致', async () => {
    const legacy = legalRoutes(fixtureLegal);
    const explicit = legalRoutes(legalConfigSchema.parse({ ...fixtureLegal, accessMode: 'email_beta' }));
    for (const path of ['/privacy', '/terms', '/metadata']) {
      expect(await (await legacy.request(path)).text()).toBe(await (await explicit.request(path)).text());
    }
    const privacy = await (await legacy.request('/privacy')).text();
    expect(privacy).toContain('我们处理邮箱地址、密码的单向安全哈希');
    expect(privacy).toContain(`邮箱地址与验证码邮件内容会发送至 ${fixtureLegal.mailRecipient}`);
    const terms = await (await legacy.request('/terms')).text();
    expect(terms).toContain('当前版本为邀请制 TestFlight 测试');
    expect(terms).toContain('使用邮箱和密码注册，并完成邮箱验证');
  });

  it('网页内测按实际功能告知创作、公开快照与本机待核对内容', async () => {
    const config = legalConfigSchema.parse({ ...fixtureLegal, accessMode: 'web_beta' });
    const app = legalRoutes(config);
    const privacy = await (await app.request('/privacy')).text();
    const terms = await (await app.request('/terms')).text();
    expect(terms).toContain('邀请制网页内测');
    expect(terms).not.toContain('TestFlight');
    expect(privacy).toContain('私人记录和创作对话不会随提交公开');
    expect(privacy).toContain('其必要的模板快照会继续保留');
    expect(privacy).toContain('待核对请求');
    expect(privacy).not.toContain('先显示用途说明，再请求麦克风');
    expect(privacy).not.toContain('成长小屋');
    expect(legalConsentVersion(config)).not.toBe(legalConsentVersion(fixtureLegal));
  });

  it('政策和协议包含版本、联系与处理说明，并转义内容', async () => {
    const app = legalRoutes({ ...fixtureLegal, operatorName: '<script>alert(1)</script>' });
    for (const path of ['/privacy', '/terms']) {
      const r = await app.request(path);
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('<script>');
      expect(html).toContain('test@planplan.test');
      expect(html).toContain('test-1');
      expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    }
    expect(await (await app.request('/privacy')).text()).toContain(fixtureLegal.retentionDisclosure);
    expect(await (await app.request('/privacy')).text()).toContain(MODEL_USAGE_DISCLOSURE);
    const oldVersion = createHash('sha256').update(JSON.stringify([fixtureLegal.policyVersion, fixtureLegal.aiRecipient, fixtureLegal.aiService, fixtureLegal.aiPrivacyURL, fixtureLegal.aiProcessingDisclosure, fixtureLegal.serviceRegion])).digest('hex');
    expect(legalConsentVersion(fixtureLegal)).not.toBe(oldVersion);
  });

  it.each([undefined, 'protected_test', 'email_beta', 'web_beta'] as const)('模式%s下接收方变化仍使旧授权失效，未授权不调用模型', async accessMode => {
    const legal = { ...fixtureLegal, accessMode };
    const db = await openTestDb();
    const llm = new FakeLlm(() => ({ intent: 'smalltalk', reply: '你好' }));
    const auth = { jwtSecret: new TextEncoder().encode('test-only-secret-test-only-secret'), appleAudience: null, devLogin: true };
    let app = createApp(db, llm, auth, legal);
    const login = await app.request('/v1/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'privacy-test' }) });
    const { token } = await login.json() as { token: string };
    const request = (path: string, method = 'GET', body?: unknown) => app.request(path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const send = () => request('/v1/chat', 'POST', { clientMsgId: crypto.randomUUID(), text: '你好', inputAt: new Date().toISOString() });
    expect((await send()).status).toBe(403);
    expect(llm.calls).toHaveLength(0);
    expect((await request('/v1/me/ai-consent', 'PUT', { granted: true, consentVersion: legalConsentVersion(legal) })).status).toBe(200);
    expect((await send()).status).toBe(200);
    const changed = { ...legal, aiRecipient: '新的测试接收方' };
    app = createApp(db, llm, auth, changed);
    expect((await (await request('/v1/me')).json()).aiConsent).toBe(false);
    expect((await send()).status).toBe(403);
    expect(llm.calls).toHaveLength(1);
    expect((await request('/v1/me/ai-consent', 'PUT', { granted: true, consentVersion: legalConsentVersion(legal) })).status).toBe(403);
    expect((await request('/v1/me/ai-consent', 'PUT', { granted: true, consentVersion: legalConsentVersion(changed) })).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(llm.calls).toHaveLength(2);
    expect((await request('/v1/me/ai-consent', 'PUT', { granted: false })).status).toBe(200);
    expect((await send()).status).toBe(403);
    await db.close();
  });
});
