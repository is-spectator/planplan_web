import type { AuthConfig } from '../api/auth.js';
import { emailConfigFromEnv } from './email-config.js';
import { parseJwtKeyRing } from './key-ring.js';
import { validateWebConfig } from '../api/web-session.js';

/** Managed releases fail closed; the earlier password-protected test deployment remains available outside them. */
export function authConfigFromEnv(env: NodeJS.ProcessEnv): AuthConfig {
  const managed = ['beta', 'production'].includes(env.DEPLOYMENT_ENV ?? '');
  if (managed && env.DEV_LOGIN === '1') throw new Error('Beta/正式环境禁止测试账号登录');
  const email = emailConfigFromEnv(env);
  if (managed && !email) throw new Error('Beta/正式环境必须配置邮箱登录');
  const devLoginSecret = env.DEV_LOGIN_SECRET || undefined;
  if (env.NODE_ENV === 'production' && env.DEV_LOGIN === '1' && !devLoginSecret?.trim()) {
    throw new Error('生产环境开启测试登录必须设置 DEV_LOGIN_SECRET');
  }
  const production = managed || env.NODE_ENV === 'production';
  if (env.WEB_COOKIE_SECURE !== undefined && !['0', '1'].includes(env.WEB_COOKIE_SECURE)) throw new Error('WEB_COOKIE_SECURE must be 0 or 1');
  const web = {
    webAllowedOrigins: env.WEB_ALLOWED_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean),
    cookieSecure: env.WEB_COOKIE_SECURE !== '0',
  };
  validateWebConfig(web, production);
  if (managed && !env.JWT_KEYS_JSON) throw new Error('Beta/正式环境必须配置 JWT_KEYS_JSON');
  if (env.JWT_KEYS_JSON && env.JWT_SECRET) throw new Error('Do not configure JWT_SECRET alongside JWT_KEYS_JSON');
  const keyRing = env.JWT_KEYS_JSON ? parseJwtKeyRing(env.JWT_KEYS_JSON, env.DEPLOYMENT_ENV ?? 'development') : undefined;
  const secret = env.JWT_SECRET ?? (production ? '' : 'dev-only-secret-change-me-dev-only-secret');
  if (!keyRing && production && Buffer.byteLength(secret) < 32) throw new Error('JWT_SECRET 至少需要 32 字节的随机密钥');
  return {
    jwtSecret: keyRing?.current.secret ?? new TextEncoder().encode(secret),
    keyRing,
    appleAudience: managed ? null : env.APPLE_BUNDLE_ID ?? 'com.planplan.app',
    devLogin: !managed && (env.DEV_LOGIN === '1' || env.NODE_ENV !== 'production'),
    devLoginSecret,
    email,
    trustProxy: env.TRUST_PROXY === '1',
    ...web,
  };
}
