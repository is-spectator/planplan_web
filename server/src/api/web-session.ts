import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AuthConfig } from './auth.js';
import { authenticate, issueToken } from './auth.js';
import type { Db } from '../db/db.js';
import { DomainError } from '../services/errors.js';

const secureName = '__Host-planplan-session';
const localName = 'planplan-local-session';
const lifetime = 30 * 24 * 60 * 60;
const cookieName = (auth: AuthConfig) => auth.cookieSecure === false ? localName : secureName;

/** Browser transport errors are separate from business/chat card error codes. */
export class WebSessionError extends Error {
  readonly details = {};
  constructor(readonly code: 'credential_conflict' | 'account_mismatch' | 'csrf_invalid' | 'origin_forbidden', message: string) { super(message); }
}

export function validateWebConfig(auth: Pick<AuthConfig, 'webAllowedOrigins' | 'cookieSecure'>, production = false): void {
  const origins = auth.webAllowedOrigins ?? [];
  if (auth.cookieSecure === false && (production || !origins.length)) throw new Error('Insecure Web cookies require explicit loopback development origins');
  for (const origin of origins) {
    let url: URL;
    try { url = new URL(origin); } catch { throw new Error('WEB_ALLOWED_ORIGINS must contain exact origins'); }
    if (url.origin !== origin || url.username || url.password) throw new Error('WEB_ALLOWED_ORIGINS must contain exact origins');
    if (auth.cookieSecure === false) {
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) throw new Error('Insecure Web cookies are allowed only on loopback origins');
    } else if (url.protocol !== 'https:') throw new Error('Secure Web cookies require HTTPS origins');
  }
}

export function webSessionToken(c: Context, auth: AuthConfig): string | undefined {
  if (!auth.webAllowedOrigins?.length) return undefined;
  return getCookie(c, cookieName(auth));
}

/** Reject ambiguous credentials even when the two tokens identify the same user. */
export function rejectCredentialConflict(c: Context): void {
  const secure = getCookie(c, secureName);
  const local = getCookie(c, localName);
  if (((secure || local) && c.req.header('authorization')) || (secure && local)) {
    throw new WebSessionError('credential_conflict', '登录信息冲突，请重新登录。');
  }
}

export function requireWebOrigin(c: Context, auth: AuthConfig): void {
  const origin = c.req.header('origin');
  if (!origin || !auth.webAllowedOrigins?.includes(origin)) throw new WebSessionError('origin_forbidden', '请求来源无法确认，请从原页面重试。');
}

export function csrfTokenFor(auth: AuthConfig, token: string): string {
  return createHmac('sha256', auth.jwtSecret).update('planplan-web-csrf\0').update(token).digest('base64url');
}

export function requireCookieRequest(c: Context, auth: AuthConfig, token: string, userId: string): void {
  if (c.req.header('X-PlanPlan-Expected-User') !== userId) {
    throw new WebSessionError('account_mismatch', '登录账户已经变化，请重新进入页面后再操作。');
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    requireWebOrigin(c, auth);
    const digest = (value: string) => createHash('sha256').update(value).digest();
    if (!timingSafeEqual(digest(c.req.header('X-CSRF-Token') ?? ''), digest(csrfTokenFor(auth, token)))) {
      throw new WebSessionError('csrf_invalid', '页面已失效，请重新加载后再操作。');
    }
  }
}

export async function setWebSession(c: Context, auth: AuthConfig, user: { id: string; token_version: number }): Promise<void> {
  setCookie(c, cookieName(auth), await issueToken(auth, user.id, user.token_version), {
    httpOnly: true, secure: auth.cookieSecure !== false, sameSite: 'Lax', path: '/', maxAge: lifetime,
  });
}

export function clearWebSession(c: Context, auth: AuthConfig): void {
  setCookie(c, cookieName(auth), '', {
    httpOnly: true, secure: auth.cookieSecure !== false, sameSite: 'Lax', path: '/', maxAge: 0, expires: new Date(0),
  });
}

export async function browserSession(c: Context, db: Db, auth: AuthConfig) {
  const token = webSessionToken(c, auth);
  if (!token || c.req.header('authorization')) throw new DomainError('unauthorized', '请先登录。');
  const userId = await authenticate(auth, db, `Bearer ${token}`);
  return { userId, csrfToken: csrfTokenFor(auth, token) };
}
