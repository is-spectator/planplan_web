import { usageLogin } from '../services/usage.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getConnInfo } from '@hono/node-server/conninfo';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import type { AuthConfig } from './auth.js';
import { issueToken } from './auth.js';
import { loginEmail, normalizeEmail, registerEmail, requestEmailCode, resetEmailPassword } from '../auth/email.js';
import { clearWebSession, requireWebOrigin, setWebSession } from './web-session.js';

const email = z.string().max(254).transform(normalizeEmail).pipe(z.email());
const characters = (value: string) => Array.from(value).length;
const password = z.string().refine((value) => characters(value) >= 15, '密码至少 15 个字符').refine((value) => characters(value) <= 128, '密码最多 128 个字符');
const loginPassword = z.string().min(1).refine((value) => characters(value) <= 128, '密码最多 128 个字符');
const proof = { email, challengeId: z.uuid(), code: z.string().regex(/^\d{8}$/), password };

export function emailAuthRoutes(db: Db, auth: AuthConfig, mode: 'bearer' | 'cookie' = 'bearer') {
  const routes = new Hono();
  const cfg = auth.email;
  if (!cfg || mode === 'cookie' && !auth.webAllowedOrigins?.length) return routes;
  routes.use('*', bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: { code: 'invalid_input', message: '登录请求过大，请重试。' } }, 413) }));
  routes.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  // Before a session exists, an exact Origin allowlist prevents login CSRF.
  if (mode === 'cookie') routes.use('*', async (c, next) => { requireWebOrigin(c, auth); await next(); });
  const ip = (c: Parameters<typeof getConnInfo>[0]) => {
    // X-Real-IP is trusted only on an explicitly configured, private reverse-proxy hop.
    if (auth.trustProxy) return c.req.header('X-Real-IP') ?? 'unknown';
    try { return getConnInfo(c).remote.address ?? 'unknown'; } catch { return 'unknown'; }
  };
  routes.post('/code', async (c) => {
    const body = z.object({ email, purpose: z.enum(['register', 'reset']) }).strict().parse(await c.req.json());
    return c.json(await requestEmailCode(db, cfg, body.email, body.purpose, ip(c)), 202);
  });
  routes.post('/register', async (c) => {
    const body = z.object(proof).strict().parse(await c.req.json());
    const u = await registerEmail(db, cfg, body.email, body.challengeId, body.code, body.password, ip(c));
    await usageLogin(db, u.id, 'email');
    if (mode === 'cookie') {
      await setWebSession(c, auth, u);
      return c.json({ userId: u.id }, 201);
    }
    return c.json({ token: await issueToken(auth, u.id, u.token_version), userId: u.id }, 201);
  });
  routes.post('/login', async (c) => {
    const body = z.object({ email, password: loginPassword }).strict().parse(await c.req.json());
    const u = await loginEmail(db, cfg, body.email, body.password, ip(c));
    await usageLogin(db, u.id, 'email');
    if (mode === 'cookie') {
      await setWebSession(c, auth, u);
      return c.json({ userId: u.id });
    }
    return c.json({ token: await issueToken(auth, u.id, u.token_version), userId: u.id });
  });
  routes.post('/reset', async (c) => {
    const body = z.object(proof).strict().parse(await c.req.json());
    const result = await resetEmailPassword(db, cfg, body.email, body.challengeId, body.code, body.password, ip(c));
    if (mode === 'cookie') clearWebSession(c, auth);
    return c.json(result);
  });
  return routes;
}
