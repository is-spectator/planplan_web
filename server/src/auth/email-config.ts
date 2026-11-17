import { directMail, type VerificationMailer } from './mail.js';

export interface EmailAuthConfig {
  secret: Uint8Array;
  allowedEmails: ReadonlySet<string>;
  mailer: VerificationMailer;
}

export function emailConfigFromEnv(env: NodeJS.ProcessEnv): EmailAuthConfig | undefined {
  if (env.EMAIL_AUTH_ENABLED !== '1') return undefined;
  const aliased = (key: string, legacy: string, fallback?: string) => {
    if (env[key] !== undefined && env[legacy] !== undefined && env[key] !== env[legacy]) throw new Error(`邮箱配置冲突：${key} 与 ${legacy}`);
    const value = env[key] ?? env[legacy] ?? fallback;
    if (!value?.trim()) throw new Error(`邮箱登录缺少环境变量 ${key}（兼容 ${legacy}）`);
    return value;
  };
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`邮箱登录缺少环境变量 ${key}`);
    return value;
  };
  const secret = required('EMAIL_AUTH_SECRET');
  if (Buffer.byteLength(secret) < 32) throw new Error('EMAIL_AUTH_SECRET 至少需要 32 字节的随机密钥');
  const allowedEmails = new Set(required('BETA_EMAIL_ALLOWLIST').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (allowedEmails.size > 20 || [...allowedEmails].some((s) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))) throw new Error('内测名单必须是最多 20 个有效邮箱');
  return {
    secret: new TextEncoder().encode(secret), allowedEmails,
    mailer: directMail({ host: aliased('EMAIL_SMTP_HOST', 'DIRECTMAIL_SMTP_HOST', 'smtpdm.aliyun.com'), from: aliased('EMAIL_FROM', 'DIRECTMAIL_FROM').trim(), password: aliased('EMAIL_SMTP_PASSWORD', 'DIRECTMAIL_SMTP_PASSWORD').trim() }),
  };
}
