import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/api/app.js';
import type { AuthConfig } from '../src/api/auth.js';
import { FakeLlm } from '../src/ai/llm.js';
import type { Db } from '../src/db/db.js';
import { openTestDb } from './database.js';

const secret = 'test-only-dev-login-secret-32-bytes';
const auth: AuthConfig = {
  jwtSecret: new TextEncoder().encode('test-jwt-secret-test-jwt-secret-32'),
  appleAudience: 'com.test',
  devLogin: true,
  devLoginSecret: secret,
};
const llm = new FakeLlm(() => ({ intent: 'smalltalk', reply: '你好' }));

describe('受保护的测试登录', () => {
  let db: Db;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    db = await openTestDb();
    app = createApp(db, llm, auth);
  });
  afterAll(async () => { await db.close(); });

  const login = (body: unknown, supplied?: string, target = app) => target.request('/v1/auth/dev', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(supplied === undefined ? {} : { 'X-Dev-Login-Secret': supplied }) },
    body: JSON.stringify(body),
  });

  it('缺失、空值、错误长度和相同长度的错误密钥均拒绝且不创建账号', async () => {
    const before = await db.query('SELECT id FROM users');
    const responses: { error: { code: string; message: string } }[] = [];
    for (const supplied of [undefined, '', 'wrong', secret.replace('32', '33')]) {
      const res = await login({ name: 'unauthorized-user' }, supplied);
      expect(res.status).toBe(401);
      responses.push(await res.json());
    }
    expect(responses.every((body) => JSON.stringify(body) === JSON.stringify(responses[0]))).toBe(true);
    expect(responses[0]!.error.code).toBe('unauthorized');
    expect(await db.query('SELECT id FROM users')).toEqual(before);
  });

  it('正确密钥签发可访问本账号的令牌', async () => {
    const res = await login({ name: 'protected-user' }, secret);
    expect(res.status).toBe(200);
    const { token, userId } = await res.json();
    const me = await app.request('/v1/me', { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    expect((await me.json()).id).toBe(userId);
  });

  it('通过密钥校验后仍拒绝类型错误、非法账号名和未知字段', async () => {
    for (const body of [null, [], {}, { name: 123 }, { name: 'x' }, { name: 'a'.repeat(33) }, { name: 'has space' }, { name: 'alice', secret }]) {
      const res = await login(body, secret);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('invalid_input');
    }
  });

  it('关闭测试登录时即使有正确密钥也返回 404', async () => {
    const disabled = createApp(db, llm, { ...auth, devLogin: false });
    expect((await login({ name: 'alice' }, secret, disabled)).status).toBe(404);
  });

  it('未配置密钥时保留本地免密登录行为', async () => {
    const local = createApp(db, llm, { ...auth, devLoginSecret: undefined });
    expect((await login({ name: 'local-user' }, undefined, local)).status).toBe(200);
  });
});

describe('生产启动保护', () => {
  it.each([undefined, '', '   '])('生产开启测试登录而密钥为 %j 时立即拒绝启动', (value) => {
    const cwd = mkdtempSync(join(tmpdir(), 'planplan-login-guard-'));
    const env = { ...process.env, NODE_ENV: 'production', DEV_LOGIN: '1', DEV_LOGIN_SECRET: value };
    if (value === undefined) delete env.DEV_LOGIN_SECRET;
    try {
      const child = spawnSync(process.execPath, [
        '--import', createRequire(import.meta.url).resolve('tsx'),
        fileURLToPath(new URL('../src/main.ts', import.meta.url)),
      ], { cwd, env, encoding: 'utf8', timeout: 10_000 });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(1);
      expect(child.stderr).toContain('生产环境开启测试登录必须设置 DEV_LOGIN_SECRET');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
