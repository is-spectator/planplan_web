import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openTestDb } from './database.js';
import type { Db } from '../src/db/db.js';
import { createApp } from '../src/api/app.js';
import type { AuthConfig } from '../src/api/auth.js';
import { authConfigFromEnv } from '../src/auth/config.js';
import { FakeLlm } from '../src/ai/llm.js';
import type { EmailPurpose } from '../src/auth/mail.js';

const origin = 'https://planplan.test';
const password = 'synthetic-web-password-123';
const nextPassword = 'synthetic-web-password-456';
const sent: { email: string; code: string; purpose: EmailPurpose }[] = [];
const config: AuthConfig = {
  jwtSecret: new TextEncoder().encode('web-session-test-signing-key-32-bytes'), appleAudience: null, devLogin: false,
  webAllowedOrigins: [origin], cookieSecure: true,
  email: {
    secret: new TextEncoder().encode('web-session-test-email-secret-32-bytes'),
    allowedEmails: new Set(['alice@planplan.test', 'bob@planplan.test', 'reset@planplan.test', 'delete@planplan.test']),
    mailer: { async send(email, code, purpose) { sent.push({ email, code, purpose }); } },
  },
};
const llm = new FakeLlm(() => ({ intent: 'smalltalk', reply: 'synthetic fixture' }));

describe('Web Cookie 会话契约及原生 Bearer 兼容', () => {
  let db: Db;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => { db = await openTestDb(); app = createApp(db, llm, config); });
  beforeEach(async () => { await db.query('DELETE FROM email_auth_limits'); });
  afterAll(async () => { await db.close(); });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}, target = app) => target.request(path, {
    method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers }, body: JSON.stringify(body),
  });
  const read = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });
  async function challenge(email: string, purpose: EmailPurpose = 'register') {
    const response = await post('/v1/auth/web/email/code', { email, purpose });
    expect(response.status).toBe(202);
    const { challengeId } = await response.json();
    return { challengeId, code: sent.findLast(item => item.email === email && item.purpose === purpose)!.code };
  }
  async function register(email: string) {
    const proof = await challenge(email);
    return post('/v1/auth/web/email/register', { email, ...proof, password });
  }
  async function login(email = 'alice@planplan.test', currentPassword = password) {
    const response = await post('/v1/auth/web/email/login', { email, password: currentPassword });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const { userId } = await response.json();
    const session = await read('/v1/auth/web/session', { cookie });
    expect(session.status).toBe(200);
    const { csrfToken } = await session.json();
    return { cookie, userId, csrfToken, headers: { cookie, 'X-PlanPlan-Expected-User': userId, 'X-CSRF-Token': csrfToken, origin } };
  }

  it('注册只返回用户标识并设置 host-only 安全 Cookie；无登录时 session 为 401', async () => {
    expect((await read('/v1/auth/web/session')).status).toBe(401);
    const response = await register('alice@planplan.test');
    expect(response.status).toBe(201);
    expect(Object.keys(await response.json())).toEqual(['userId']);
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^__Host-planplan-session=/);
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=2592000']) expect(cookie).toContain(attribute);
    expect(cookie).not.toContain('Domain=');
    expect((await register('bob@planplan.test')).status).toBe(201);
  });

  it('会话自引导后通过预期账户读取真实邮箱账户，iOS 路由仍返回 Bearer', async () => {
    const browser = await login();
    expect(browser.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const response = await read('/v1/me', browser.headers);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: browser.userId, signInMethod: 'email', timezone: 'Asia/Shanghai' });
    const native = await post('/v1/auth/email/login', { email: 'alice@planplan.test', password });
    const { token, userId } = await native.json();
    expect(typeof token).toBe('string');
    expect(userId).toBe(browser.userId);
    expect(native.headers.get('set-cookie')).toBeNull();
    const iosWrite = await app.request('/v1/me/ai-consent', {
      method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ granted: false }),
    });
    expect(iosWrite.status).toBe(200);
  });

  it('拒绝缺失或外站 Origin 的登录，以及 Cookie 写入缺失、错误 CSRF', async () => {
    for (const invalidOrigin of ['', 'null', 'https://evil.test']) {
      const response = await post('/v1/auth/web/email/login', { email: 'alice@planplan.test', password }, { origin: invalidOrigin });
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('origin_forbidden');
    }
    const browser = await login();
    for (const csrf of ['', 'incorrect']) {
      const response = await app.request('/v1/me/ai-consent', {
        method: 'PUT', headers: { ...browser.headers, 'content-type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ granted: true }),
      });
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('csrf_invalid');
    }
    const wrongOrigin = await post('/v1/logout', {}, { ...browser.headers, origin: 'https://evil.test' });
    expect(wrongOrigin.status).toBe(403);
    const success = await app.request('/v1/me/ai-consent', {
      method: 'PUT', headers: { ...browser.headers, 'content-type': 'application/json' }, body: JSON.stringify({ granted: true }),
    });
    expect(success.status).toBe(200);
  });

  it('账户 B Cookie 不能读取或写入账户 A 旧页面的请求；缺失绑定也拒绝', async () => {
    const alice = await login();
    const bob = await login('bob@planplan.test');
    for (const expected of ['', alice.userId]) {
      const headers = { ...bob.headers, 'X-PlanPlan-Expected-User': expected };
      const reading = await read('/v1/plans', headers);
      expect(reading.status).toBe(409);
      expect((await reading.json()).error.code).toBe('account_mismatch');
      const writing = await post('/v1/operations', { clientOpId: 'wrong-user-operation', actions: [{ type: 'create_ledger' }] }, headers);
      expect(writing.status).toBe(409);
      const logout = await post('/v1/logout', {}, headers);
      expect(logout.status).toBe(409);
    }
    expect(await db.query('SELECT id FROM plans WHERE user_id=$1', [bob.userId])).toEqual([]);
    expect((await read('/v1/me', bob.headers)).status).toBe(200);
  });

  it('Cookie 和 Authorization 同时存在时拒绝，即使属于同一个账户', async () => {
    const browser = await login();
    const native = await post('/v1/auth/email/login', { email: 'alice@planplan.test', password });
    const { token } = await native.json();
    for (const path of ['/v1/me', '/v1/auth/web/session']) {
      const response = await read(path, { ...browser.headers, authorization: `Bearer ${token}` });
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe('credential_conflict');
    }
    expect((await read('/v1/auth/web/session', { authorization: `Bearer ${token}` })).status).toBe(401);
  });

  it('成功、鉴权失败、未知 API 和参数错误都禁止共享缓存', async () => {
    const browser = await login();
    const responses = [
      await read('/v1/me', browser.headers), await read('/v1/me'), await read('/v1/auth/web/session', { cookie: browser.cookie }),
      await read('/v1/unknown', browser.headers), await post('/v1/auth/web/email/login', {}),
      await post('/v1/auth/web/email/login', {}, { origin: 'https://evil.test' }),
    ];
    for (const response of responses) expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('退出清除 Cookie 并撤销同账户所有浏览器和 iOS 会话', async () => {
    const browser = await login();
    const otherBrowser = await login();
    const native = await post('/v1/auth/email/login', { email: 'alice@planplan.test', password });
    const { token } = await native.json();
    const response = await post('/v1/logout', {}, browser.headers);
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await read('/v1/me', otherBrowser.headers)).status).toBe(401);
    expect((await read('/v1/me', { authorization: `Bearer ${token}` })).status).toBe(401);
    expect((await read('/v1/auth/web/session', { cookie: browser.cookie })).status).toBe(401);
  });

  it('重置密码清除浏览器 Cookie、撤销旧会话且不自动登录', async () => {
    expect((await register('reset@planplan.test')).status).toBe(201);
    const browser = await login('reset@planplan.test');
    await db.query('DELETE FROM email_auth_limits');
    const proof = await challenge('reset@planplan.test', 'reset');
    const response = await post('/v1/auth/web/email/reset', { email: 'reset@planplan.test', ...proof, password: nextPassword }, { cookie: browser.cookie });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reset: true });
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await read('/v1/me', browser.headers)).status).toBe(401);
    expect((await login('reset@planplan.test', nextPassword)).userId).toBe(browser.userId);
  });

  it('删除账户也清除 Cookie，原会话立即失效', async () => {
    expect((await register('delete@planplan.test')).status).toBe(201);
    const browser = await login('delete@planplan.test');
    const response = await app.request('/v1/me', {
      method: 'DELETE', headers: { ...browser.headers, 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'DELETE', password }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await read('/v1/me', browser.headers)).status).toBe(401);
  });

  it('显式本机模式使用独立非 Secure Cookie，关闭 Web 配置时不接受 Cookie', async () => {
    const localApp = createApp(db, llm, { ...config, webAllowedOrigins: ['http://127.0.0.1:5173'], cookieSecure: false });
    const response = await post('/v1/auth/web/email/login', { email: 'alice@planplan.test', password }, { origin: 'http://127.0.0.1:5173' }, localApp);
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^planplan-local-session=/);
    expect(cookie).not.toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    const disabled = createApp(db, llm, { ...config, webAllowedOrigins: undefined });
    expect((await post('/v1/auth/web/email/login', {}, {}, disabled)).status).toBe(404);
    expect((await disabled.request('/v1/me', { headers: { cookie: cookie.split(';')[0]! } })).status).toBe(401);
  });
});

describe('Web 会话环境配置', () => {
  it('默认禁用 Web，HTTPS 默认 Secure，本机非 Secure 需显式选择', () => {
    expect(authConfigFromEnv({}).webAllowedOrigins).toBeUndefined();
    expect(authConfigFromEnv({ WEB_ALLOWED_ORIGINS: origin }).cookieSecure).toBe(true);
    expect(authConfigFromEnv({ WEB_ALLOWED_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173', WEB_COOKIE_SECURE: '0' }).cookieSecure).toBe(false);
  });
  it('拒绝生产非 Secure、任意来源、路径及非本机 HTTP', () => {
    for (const webAllowedOrigins of ['*', 'null', 'https://planplan.test/path', 'http://planplan.test']) {
      expect(() => authConfigFromEnv({ WEB_ALLOWED_ORIGINS: webAllowedOrigins })).toThrow();
    }
    expect(() => authConfigFromEnv({ WEB_ALLOWED_ORIGINS: origin, WEB_COOKIE_SECURE: '0' })).toThrow();
    expect(() => authConfigFromEnv({ WEB_COOKIE_SECURE: '0' })).toThrow();
    expect(() => authConfigFromEnv({ WEB_COOKIE_SECURE: 'yes' })).toThrow();
    expect(() => authConfigFromEnv({ NODE_ENV: 'production', WEB_ALLOWED_ORIGINS: 'http://localhost:5173', WEB_COOKIE_SECURE: '0' })).toThrow();
  });
});
