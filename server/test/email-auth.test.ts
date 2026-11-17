import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/db.js';
import { openTestDb } from './database.js';
import { createApp } from '../src/api/app.js';
import type { AuthConfig } from '../src/api/auth.js';
import { FakeLlm } from '../src/ai/llm.js';
import { emailConfigFromEnv } from '../src/auth/email-config.js';
import { authConfigFromEnv } from '../src/auth/config.js';
import { verifyEmailDeletion } from '../src/auth/email.js';
import { requestAccountDeletion, retryPendingDeletions } from '../src/services/deletion.js';
import { directMail, type EmailPurpose } from '../src/auth/mail.js';

const PASSWORD = 'a-safe-test-password-123';
const NEW_PASSWORD = 'another-safe-password-456';
const sent: { email: string; code: string; purpose: EmailPurpose }[] = [];
const cfg: AuthConfig = {
  jwtSecret: new TextEncoder().encode('a-jwt-secret-for-email-tests-at-least-32-bytes'), appleAudience: null, devLogin: false,
  email: {
    secret: new TextEncoder().encode('email-challenge-secret-longer-than-32-bytes'),
    allowedEmails: new Set(['alice@example.com', 'bob@example.com', 'carol@example.com', 'dave@example.com', 'eve@example.com', 'frank@example.com', 'grace@example.com', 'heidi@example.com', 'ivy@example.com', 'jane@example.com', 'karl@example.com']),
    mailer: { async send(email, code, purpose) { sent.push({ email, code, purpose }); } },
  },
};
const llm = new FakeLlm(() => ({ intent: 'smalltalk', reply: '你好' }));

describe('邮箱账户安全闭环', () => {
  let db: Db;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => { db = await openTestDb(); app = createApp(db, llm, cfg); });
  afterAll(async () => { await db.close(); });
  const request = (path: string, body: unknown, token?: string, method = 'POST', target = app) => target.request(path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  async function code(email: string, purpose: EmailPurpose = 'register') {
    const res = await request('/v1/auth/email/code', { email, purpose });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['challengeId', 'expiresIn', 'message', 'retryAfter']);
    return { ...body, code: sent.findLast((m) => m.email === email.toLowerCase() && m.purpose === purpose)?.code };
  }
  const register = (email: string, challengeId: string, value: string, password = PASSWORD) => request('/v1/auth/email/register', { email, challengeId, code: value, password });

  it('邮箱验证前不创建用户，正确验证码只创建独立邮箱账户', async () => {
    const proof = await code('Alice@Example.com');
    expect(await db.query('SELECT id FROM users')).toEqual([]);
    const challenge = (await db.query<{ code_hash: string; email_key: string }>('SELECT code_hash,email_key FROM email_auth_challenges WHERE id=$1', [proof.challengeId]))[0]!;
    expect(challenge.code_hash).not.toContain(proof.code);
    expect(challenge.email_key).not.toContain('alice');
    const res = await register(' ALICE@example.com ', proof.challengeId, proof.code);
    expect(res.status).toBe(201);
    const auth = await res.json();
    const me = await app.request('/v1/me', { headers: { authorization: `Bearer ${auth.token}` } });
    expect((await me.json()).signInMethod).toBe('email');
    const stored = (await db.query<{ password_hash: string }>('SELECT password_hash FROM email_credentials'))[0]!;
    expect(stored.password_hash).toMatch(/^\$argon2id\$v=19\$/);
    expect(stored.password_hash.split('$')[3]!.split(',').sort()).toEqual(['m=65536', 'p=1', 't=3']);
    expect(stored.password_hash).not.toContain(PASSWORD);
    expect((await register('alice@example.com', proof.challengeId, proof.code)).status).toBe(401);
    const login = await request('/v1/auth/email/login', { email: 'alice@example.com', password: PASSWORD });
    expect((await login.json()).userId).toBe(auth.userId);
  });

  it('未邀请、未知和已注册邮箱对外返回相同信息，不发未知账户重置信', async () => {
    const uninvited = await code('outsider@example.com');
    const unknown = await code('unknown@example.com', 'reset');
    expect(uninvited.message).toBe(unknown.message);
    expect(uninvited.code).toBeUndefined();
    expect(unknown.code).toBeUndefined();
    const before = sent.length;
    await db.query('DELETE FROM email_auth_limits');
    const known = await code('alice@example.com');
    expect(known.message).toBe(unknown.message);
    expect(sent.length).toBe(before);
    const wrong = await request('/v1/auth/email/login', { email: 'alice@example.com', password: 'wrong-password' });
    const nonexistent = await request('/v1/auth/email/login', { email: 'unknown@example.com', password: 'wrong-password' });
    expect(wrong.status).toBe(401); expect(nonexistent.status).toBe(401);
    expect(await wrong.json()).toEqual(await nonexistent.json());
  });

  it('错误验证码尝试次数持久化，第五次后正确码也不可用', async () => {
    const proof = await code('bob@example.com');
    const wrong = proof.code === '00000000' ? '00000001' : '00000000';
    for (let i = 0; i < 5; i++) expect((await register('bob@example.com', proof.challengeId, wrong)).status).toBe(401);
    expect((await register('bob@example.com', proof.challengeId, proof.code)).status).toBe(401);
    expect((await db.query<{ attempts: number }>('SELECT attempts FROM email_auth_challenges WHERE id=$1', [proof.challengeId]))[0]!.attempts).toBe(5);
    expect(await db.query('SELECT * FROM email_credentials WHERE email=$1', ['bob@example.com'])).toEqual([]);
  });

  it('验证码绑定邮箱、用途和有效期', async () => {
    const proof = await code('carol@example.com');
    expect((await register('dave@example.com', proof.challengeId, proof.code)).status).toBe(401);
    expect((await request('/v1/auth/email/reset', { email: 'carol@example.com', challengeId: proof.challengeId, code: proof.code, password: NEW_PASSWORD })).status).toBe(401);
    await db.query(`UPDATE email_auth_challenges SET expires_at = now() - interval '1 second' WHERE id=$1`, [proof.challengeId]);
    expect((await register('carol@example.com', proof.challengeId, proof.code)).status).toBe(401);
  });

  it('同时兑换同一验证码只成功一次', async () => {
    const proof = await code('dave@example.com');
    const responses = await Promise.all([register('dave@example.com', proof.challengeId, proof.code), register('dave@example.com', proof.challengeId, proof.code)]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 401]);
    expect(await db.query('SELECT user_id FROM email_credentials WHERE email=$1', ['dave@example.com'])).toHaveLength(1);
  });

  it('重置密码撤销旧会话，验证码不可重放，数据归属保持', async () => {
    await db.query('DELETE FROM email_auth_limits');
    const login = await request('/v1/auth/email/login', { email: 'alice@example.com', password: PASSWORD });
    const before = await login.json();
    const allowed = cfg.email!.allowedEmails as Set<string>;
    allowed.delete('alice@example.com'); // Removing invitations does not disable existing accounts.
    const proof = await code('alice@example.com', 'reset');
    const body = { email: 'alice@example.com', challengeId: proof.challengeId, code: proof.code, password: NEW_PASSWORD };
    expect((await request('/v1/auth/email/reset', body)).status).toBe(200);
    expect((await app.request('/v1/me', { headers: { authorization: `Bearer ${before.token}` } })).status).toBe(401);
    expect((await request('/v1/auth/email/login', { email: 'alice@example.com', password: PASSWORD })).status).toBe(401);
    const after = await request('/v1/auth/email/login', { email: 'alice@example.com', password: NEW_PASSWORD });
    expect((await after.json()).userId).toBe(before.userId);
    expect((await request('/v1/auth/email/reset', body)).status).toBe(401);
    allowed.add('alice@example.com');
  });

  it('多实例共享发送限流，重复点击不会再次发信', async () => {
    await db.query('DELETE FROM email_auth_limits');
    const secondApp = createApp(db, llm, cfg);
    const proof = await code('eve@example.com');
    expect(proof.code).toMatch(/^\d{8}$/);
    const before = sent.length;
    const retry = await request('/v1/auth/email/code', { email: 'eve@example.com', purpose: 'register' }, undefined, 'POST', secondApp);
    expect(retry.status).toBe(429); expect(sent.length).toBe(before);
  });

  it('发信失败不会暴露供应商异常、验证码或地址', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const appFail = createApp(db, llm, { ...cfg, email: { ...cfg.email!, mailer: { async send() { throw new Error('SMTP SECRET detail'); } } } });
      const res = await request('/v1/auth/email/code', { email: 'frank@example.com', purpose: 'register' }, undefined, 'POST', appFail);
      expect(res.status).toBe(202);
      const response = await res.json();
      expect(JSON.stringify(response)).not.toContain('SECRET');
      expect(JSON.stringify(spy.mock.calls)).not.toContain('frank');
      expect(JSON.stringify(spy.mock.calls)).not.toContain('SECRET');
      await vi.waitFor(async () => expect((await db.query<{ used_at: Date | null }>('SELECT used_at FROM email_auth_challenges WHERE id=$1', [response.challengeId]))[0]!.used_at).not.toBeNull());
    } finally { spy.mockRestore(); }
  });

  it('发码响应不等待 SMTP，旧发送失败不会废弃新的验证码', async () => {
    await db.query('DELETE FROM email_auth_limits');
    let rejectDelivery!: (reason: Error) => void;
    const delivery = new Promise<void>((_, reject) => { rejectDelivery = reject; });
    const slowApp = createApp(db, llm, { ...cfg, email: { ...cfg.email!, mailer: { send: () => delivery } } });
    const first = await request('/v1/auth/email/code', { email: 'ivy@example.com', purpose: 'register' }, undefined, 'POST', slowApp);
    expect(first.status).toBe(202); // A pending SMTP promise must not hold up the HTTP response.
    const oldChallenge = (await first.json()).challengeId;
    await db.query('DELETE FROM email_auth_limits');
    const latest = await code('ivy@example.com');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      rejectDelivery(new Error('synthetic delivery failure'));
      await vi.waitFor(() => expect(spy).toHaveBeenCalled());
      const rows = await db.query<{ id: string; used_at: Date | null }>('SELECT id,used_at FROM email_auth_challenges WHERE id = ANY($1::uuid[])', [[oldChallenge, latest.challengeId]]);
      expect(rows.find((r) => r.id === latest.challengeId)!.used_at).toBeNull();
      expect(rows.find((r) => r.id === oldChallenge)!.used_at).not.toBeNull();
    } finally { spy.mockRestore(); }
  });

  it('账户删除需当前密码，删除后凭据与会话均失效', async () => {
    const proof = await code('grace@example.com');
    const auth = await (await register('grace@example.com', proof.challengeId, proof.code)).json();
    expect((await request('/v1/me', { confirm: 'DELETE' }, auth.token, 'DELETE')).status).toBe(401);
    expect((await request('/v1/me', { confirm: 'DELETE', password: PASSWORD }, auth.token, 'DELETE')).status).toBe(200);
    expect(await db.query('SELECT user_id FROM email_credentials WHERE user_id=$1', [auth.userId])).toEqual([]);
    expect((await app.request('/v1/me', { headers: { authorization: `Bearer ${auth.token}` } })).status).toBe(401);
  });

  it('密码验证后发生重置时，旧验证结果不能删除账户', async () => {
    await db.query('DELETE FROM email_auth_limits');
    const proof = await code('jane@example.com');
    const auth = await (await register('jane@example.com', proof.challengeId, proof.code)).json();
    const guard = await verifyEmailDeletion(db, cfg.email, auth.userId, PASSWORD);
    await db.query('DELETE FROM email_auth_limits');
    const reset = await code('jane@example.com', 'reset');
    expect((await request('/v1/auth/email/reset', { email: 'jane@example.com', challengeId: reset.challengeId, code: reset.code, password: NEW_PASSWORD })).status).toBe(200);
    await expect(requestAccountDeletion(db, auth.userId, guard)).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await db.query<{ deleted_at: Date | null }>('SELECT deleted_at FROM users WHERE id=$1', [auth.userId]))[0]!.deleted_at).toBeNull();
    expect(await db.query('SELECT id FROM deletion_jobs WHERE user_id=$1', [auth.userId])).toEqual([]);
    const currentGuard = await verifyEmailDeletion(db, cfg.email, auth.userId, NEW_PASSWORD);
    expect((await requestAccountDeletion(db, auth.userId, currentGuard)).status).toBe('completed');
  });

  it('注销待清理期间不能登录、重置或重新注册已有邮箱', async () => {
    await db.query('DELETE FROM email_auth_limits');
    const proof = await code('karl@example.com');
    const auth = await (await register('karl@example.com', proof.challengeId, proof.code)).json();
    await db.query('DELETE FROM email_auth_limits');
    const reset = await code('karl@example.com', 'reset');
    await db.exec('CREATE TABLE email_deletion_blocker (user_id uuid REFERENCES users(id))');
    await db.query('INSERT INTO email_deletion_blocker VALUES ($1)', [auth.userId]);
    try {
      expect((await requestAccountDeletion(db, auth.userId)).status).toBe('pending');
      expect((await request('/v1/auth/email/login', { email: 'karl@example.com', password: PASSWORD })).status).toBe(401);
      expect((await request('/v1/auth/email/reset', { email: 'karl@example.com', challengeId: reset.challengeId, code: reset.code, password: NEW_PASSWORD })).status).toBe(401);
      await db.query('DELETE FROM email_auth_limits');
      const sentBefore = sent.length;
      await code('karl@example.com');
      expect(sent.length).toBe(sentBefore);
    } finally {
      await db.exec('DROP TABLE email_deletion_blocker');
      await retryPendingDeletions(db);
    }
  });

  it('短密码、未知字段和关闭的邮箱服务不能创建账户', async () => {
    const proof = await code('heidi@example.com');
    expect((await register('heidi@example.com', proof.challengeId, proof.code, 'short')).status).toBe(400);
    expect((await register('heidi@example.com', proof.challengeId, proof.code, 'x'.repeat(14))).status).toBe(400);
    expect((await register('heidi@example.com', proof.challengeId, proof.code, '😀'.repeat(14))).status).toBe(400);
    expect((await register('heidi@example.com', proof.challengeId, proof.code, 'x'.repeat(15))).status).toBe(201);
    expect((await request('/v1/auth/email/login', { email: 'heidi@example.com', password: PASSWORD, secret: 'nope' })).status).toBe(400);
    const closed = createApp(db, llm, { ...cfg, email: undefined });
    expect((await request('/v1/auth/email/login', { email: 'heidi@example.com', password: PASSWORD }, undefined, 'POST', closed)).status).toBe(404);
    expect((await request('/v1/auth/apple', { identityToken: 'unused' })).status).toBe(404);
    expect((await request('/v1/auth/dev', { name: 'not-allowed' })).status).toBe(404);
    expect((await request('/v1/auth/email/login', { email: 'heidi@example.com', password: 'x'.repeat(17000) })).status).toBe(413);
  });
});

describe('邮箱部署配置', () => {
  const valid: NodeJS.ProcessEnv = {
    DEPLOYMENT_ENV: 'beta', EMAIL_AUTH_ENABLED: '1', EMAIL_AUTH_SECRET: 'test-email-hmac-secret-at-least-32-bytes',
    BETA_EMAIL_ALLOWLIST: 'alice@example.com', DIRECTMAIL_FROM: 'sender@example.com', DIRECTMAIL_SMTP_PASSWORD: 'synthetic-unused',
    JWT_KEYS_JSON: JSON.stringify({ current: { kid: 'test', secret: Buffer.alloc(32, 1).toString('base64') } }),
  };
  it('内测及正式环境必须启用邮箱登录与强 JWT 密钥，禁用测试和 Apple 登录', () => {
    for (const DEPLOYMENT_ENV of ['beta', 'production']) {
      const env = { ...valid, DEPLOYMENT_ENV };
      expect(authConfigFromEnv(env)).toMatchObject({ devLogin: false, appleAudience: null });
      expect(() => authConfigFromEnv({ ...env, DEV_LOGIN: '1' })).toThrow('禁止测试');
      expect(() => authConfigFromEnv({ ...env, EMAIL_AUTH_ENABLED: undefined })).toThrow('必须配置邮箱');
      expect(() => authConfigFromEnv({ ...env, JWT_KEYS_JSON: undefined })).toThrow('JWT_KEYS_JSON');
      expect(() => authConfigFromEnv({ ...env, JWT_KEYS_JSON: '{}' })).toThrow('JWT_KEYS_JSON');
    }
    expect(authConfigFromEnv({ NODE_ENV: 'production', DEV_LOGIN: '1', DEV_LOGIN_SECRET: 'synthetic-test-pass', JWT_SECRET: 'test-jwt-signing-secret-at-least-32-bytes' }).devLogin).toBe(true);
  });
  it('缺失密钥、名单、发信配置时拒绝启用，不能使用任意 SMTP 主机', () => {
    expect(emailConfigFromEnv({})).toBeUndefined();
    expect(() => emailConfigFromEnv({ EMAIL_AUTH_ENABLED: '1' })).toThrow('EMAIL_AUTH_SECRET');
    expect(() => emailConfigFromEnv({ EMAIL_AUTH_ENABLED: '1', EMAIL_AUTH_SECRET: 'short' })).toThrow('32');
    expect(() => directMail({ host: 'attacker.example', from: 'sender@example.com', password: 'unused' })).toThrow();
  });
});
