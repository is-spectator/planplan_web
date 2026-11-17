import { describe, expect, it, vi } from 'vitest';
import { webFixtureLegal } from '../scripts/web-fixture-legal.js';
import { createApp } from '../src/api/app.js';
import { loadLegalConfig } from '../src/api/legal.js';
import { FakeLlm } from '../src/ai/llm.js';
import { openTestDb } from './database.js';

describe('隔离本机开发告知', () => {
  it('真实模型说明接收方与文本范围，但绝不冒充发布审核或iOS功能承诺', async () => {
    const disclosure = webFixtureLegal(true, { QWEN_MODEL: 'qwen3.8-max', QWEN_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' });
    const response = await disclosure.routes.request('/metadata');
    const metadata = await response.json();
    expect(metadata).toMatchObject({ developmentOnly: true, reviewed: false, contactEmail: 'dev@planplan.test', consentVersion: disclosure.consentVersion });
    expect(metadata.aiRecipient).toContain('阿里云百炼');
    expect(metadata.aiService).toContain('qwen3.8-max');
    expect(metadata.aiService).toContain('dashscope.aliyuncs.com');
    expect(metadata.aiProcessingDisclosure).toContain('云端文本');
    for (const path of ['/privacy', '/terms']) {
      const content = await (await disclosure.routes.request(path)).text();
      expect(content).toContain('未完成正式发布审核');
      expect(content).not.toContain('语音');
      expect(content).not.toContain('TestFlight');
      expect(content).not.toContain('成长小屋');
    }
    expect(() => webFixtureLegal(true, { QWEN_BASE_URL: 'https://unverified-provider.test/v1' })).toThrow();
  });

  it('stub 和真实模式的告知及授权版本不同，模型配置改变也需要重新授权', async () => {
    const stub = webFixtureLegal(false);
    expect((await (await stub.routes.request('/metadata')).json()).aiProcessingDisclosure).toContain('不向云端');
    const real = webFixtureLegal(true);
    expect(stub.consentVersion).not.toBe(real.consentVersion);
    expect(webFixtureLegal(true, { QWEN_MODEL: 'another-model' }).consentVersion).not.toBe(real.consentVersion);
  });

  it('注入的本机告知沿用实际AI授权版本门槛，不能绕过正式配置要求', async () => {
    const db = await openTestDb();
    const llm = new FakeLlm(() => ({ intent: 'smalltalk', reply: '测试' }));
    const auth = { jwtSecret: new TextEncoder().encode('local-legal-test-key-at-least-32-bytes'), appleAudience: null, devLogin: true, cookieSecure: false, webAllowedOrigins: ['http://127.0.0.1:5173'] };
    const localLegal = webFixtureLegal(false);
    const app = createApp(db, llm, auth, undefined, { localLegal });
    const login = await app.request('/v1/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'local-legal' }) });
    const { token } = await login.json();
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    const send = () => app.request('/v1/chat', { method: 'POST', headers, body: JSON.stringify({ clientMsgId: crypto.randomUUID(), text: '你好' }) });
    expect((await send()).status).toBe(403);
    expect(llm.calls).toHaveLength(0);
    const wrong = await app.request('/v1/me/ai-consent', { method: 'PUT', headers, body: JSON.stringify({ granted: true, consentVersion: 'old' }) });
    expect(wrong.status).toBe(403);
    const granted = await app.request('/v1/me/ai-consent', { method: 'PUT', headers, body: JSON.stringify({ granted: true, consentVersion: localLegal.consentVersion }) });
    expect(granted.status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(llm.calls).toHaveLength(1);
    for (const deployment of ['beta', 'production']) expect(() => loadLegalConfig({ DEPLOYMENT_ENV: deployment })).toThrow('LEGAL_CONFIG_PATH');
    try {
      vi.stubEnv('NODE_ENV', 'production');
      expect(() => createApp(db, llm, auth, undefined, { localLegal })).toThrow('forbidden');
    } finally { vi.unstubAllEnvs(); await db.close(); }
  });
});
