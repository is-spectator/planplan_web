import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { EmailAuthConfig } from '../auth/email-config.js';
import type { JwtKeyRing } from '../auth/key-ring.js';
import type { Db } from '../db/db.js';
import { DomainError } from '../services/errors.js';

const APPLE_JWKS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

export interface AuthConfig {
  jwtSecret: Uint8Array;
  keyRing?: JwtKeyRing;
  appleAudience: string | null;
  devLogin: boolean;
  devLoginSecret?: string;
  email?: EmailAuthConfig;
  trustProxy?: boolean;
  /** Explicit browser origins; absent means browser authentication is disabled. */
  webAllowedOrigins?: readonly string[];
  /** Defaults to true. false is only for explicit loopback development. */
  cookieSecure?: boolean;
}

/** 远程测试登录使用独立密钥；固定长度摘要避免比较时泄露密钥前缀。 */
export function verifyDevLoginSecret(cfg: AuthConfig, supplied: string | undefined): void {
  if (!cfg.devLoginSecret) return;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(supplied ?? ''), digest(cfg.devLoginSecret))) {
    throw new DomainError('unauthorized', '登录校验失败，请重试。');
  }
}

export async function issueToken(cfg: AuthConfig, userId: string, tokenVersion: number): Promise<string> {
  const token = new SignJWT({ tv: tokenVersion }).setProtectedHeader({ alg: 'HS256', ...(cfg.keyRing ? { kid: cfg.keyRing.current.kid } : {}) }).setSubject(userId).setIssuedAt().setExpirationTime('30d');
  if (cfg.keyRing) token.setIssuer(cfg.keyRing.issuer).setAudience(cfg.keyRing.audience);
  return token.sign(cfg.keyRing?.current.secret ?? cfg.jwtSecret);
}

export async function authenticate(cfg: AuthConfig, db: Db, header: string | undefined): Promise<string> {
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new DomainError('unauthorized', '请先登录。');
  let payload;
  try {
    if (cfg.keyRing) {
      const ring = cfg.keyRing;
      ({ payload } = await jwtVerify(token, (header) => {
        if (header.kid === ring.current.kid) return ring.current.secret;
        const previous = ring.previous.find((k) => k.kid === header.kid && Date.now() < k.acceptUntil);
        if (!previous) throw new Error('Unknown or expired key');
        return previous.secret;
      }, { algorithms: ['HS256'], issuer: ring.issuer, audience: ring.audience }));
    } else ({ payload } = await jwtVerify(token, cfg.jwtSecret, { algorithms: ['HS256'] }));
    if (!payload.sub || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.sub) || !Number.isSafeInteger(payload.tv) || Number(payload.tv) < 0) throw new Error('Invalid session claims');
  } catch {
    throw new DomainError('unauthorized', '登录已过期，请重新登录。');
  }
  const [u] = await db.query<{ token_version: number; deleted_at: Date | null }>(`SELECT token_version, deleted_at FROM users WHERE id = $1`, [payload.sub]);
  if (!u || u.deleted_at || u.token_version !== payload.tv) throw new DomainError('unauthorized', '登录已失效，请重新登录。');
  return payload.sub as string;
}

/** 校验 Apple 返回的 identity token，得到稳定的用户标识 sub。 */
export async function verifyAppleToken(cfg: AuthConfig, identityToken: string): Promise<string> {
  if (!cfg.appleAudience) throw new DomainError('unauthorized', '服务端还没有配置 Apple 登录。');
  try {
    const { payload } = await jwtVerify(identityToken, APPLE_JWKS, { issuer: 'https://appleid.apple.com', audience: cfg.appleAudience });
    if (!payload.sub) throw new Error('no sub');
    return payload.sub;
  } catch {
    throw new DomainError('unauthorized', 'Apple 登录校验失败，请重试。');
  }
}

export async function upsertUser(db: Db, by: { appleSub?: string; devName?: string }): Promise<{ id: string; token_version: number }> {
  const col = by.appleSub ? 'apple_sub' : 'dev_name';
  const val = by.appleSub ?? by.devName!;
  const [u] = await db.query<{ id: string; token_version: number }>(
    `INSERT INTO users (${col}) VALUES ($1) ON CONFLICT (${col}) DO UPDATE SET ${col} = EXCLUDED.${col} RETURNING id, token_version`,
    [val],
  );
  return u!;
}
