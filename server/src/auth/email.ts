import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Db, Queryable } from '../db/db.js';
import { DomainError } from '../services/errors.js';
import type { DeletionGuard } from '../services/deletion.js';
import { checkPassword, checkUnknownPassword, hashPassword } from './password.js';
import type { EmailAuthConfig } from './email-config.js';
import type { EmailPurpose } from './mail.js';

const invalidCode = () => new DomainError('unauthorized', '验证码无效或已过期，请重新获取。');
const invalidLogin = () => new DomainError('unauthorized', '邮箱或密码不正确，请重试。');
export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export const emailDigest = (cfg: EmailAuthConfig, value: string) => createHmac('sha256', cfg.secret).update(value).digest('hex');
const codeDigest = (cfg: EmailAuthConfig, id: string, email: string, purpose: EmailPurpose, code: string) => emailDigest(cfg, `${purpose}\0${id}\0${email}\0${code}`);

export async function pruneEmailAuth(db: Db) {
  await db.query(`DELETE FROM email_auth_challenges WHERE expires_at < now()`);
  await db.query(`DELETE FROM email_auth_limits WHERE updated_at < now() - interval '1 day'`);
}

type Credential = { user_id: string; password_hash: string; token_version: number };
type Challenge = { id: string; email_key: string; purpose: EmailPurpose; code_hash: string; user_id: string | null; eligible: boolean; attempts: number; expires_at: Date; used_at: Date | null };

// SMTP must not affect the public response duration and reveal account existence.
// This bounded queue is deliberately transient: callers can request another code after restart.
let mailDeliveries = 0;
const pendingMail: (() => Promise<void>)[] = [];
function enqueueMail(deliver: () => Promise<void>): boolean {
  const run = (work: () => Promise<void>) => {
    mailDeliveries++;
    void work().finally(() => {
      mailDeliveries--;
      const next = pendingMail.shift();
      if (next) run(next);
    });
  };
  if (mailDeliveries < 2) run(deliver);
  else if (pendingMail.length < 16) pendingMail.push(deliver);
  else return false;
  return true;
}

async function limit(db: Db, cfg: EmailAuthConfig, name: string, max: number, seconds: number) {
  const key = emailDigest(cfg, name);
  const allowed = await db.tx(async (q) => {
    await q.query(`INSERT INTO email_auth_limits (key) VALUES ($1) ON CONFLICT DO NOTHING`, [key]);
    const [row] = await q.query<{ hits: Date[] }>(`SELECT hits FROM email_auth_limits WHERE key = $1 FOR UPDATE`, [key]);
    const cutoff = Date.now() - seconds * 1000;
    const hits = row!.hits.map((v) => new Date(v)).filter((v) => v.getTime() > cutoff);
    if (hits.length >= max) return false;
    hits.push(new Date());
    await q.query(`UPDATE email_auth_limits SET hits = $2, updated_at = now() WHERE key = $1`, [key, hits]);
    return true;
  }, `email-limit:${key}`);
  if (!allowed) throw new DomainError('rate_limited', '请求较频繁，请稍后再试。');
}

async function credential(q: Queryable, email: string): Promise<Credential | undefined> {
  const [row] = await q.query<Credential>(`SELECT e.user_id, e.password_hash, u.token_version FROM email_credentials e JOIN users u ON u.id = e.user_id WHERE e.email = $1 AND u.deleted_at IS NULL`, [email]);
  return row;
}

async function emailInUse(q: Queryable, email: string): Promise<boolean> {
  return (await q.query('SELECT user_id FROM email_credentials WHERE email = $1', [email])).length > 0;
}

export async function requestEmailCode(db: Db, cfg: EmailAuthConfig, email: string, purpose: EmailPurpose, ip: string) {
  await limit(db, cfg, `mail-email-minute:${email}`, 1, 60);
  await limit(db, cfg, `mail-email-hour:${email}`, 5, 3600);
  await limit(db, cfg, `mail-ip:${ip}`, 20, 3600);
  await limit(db, cfg, 'mail-total', 300, 86400);
  // Cleanup runs even when a caller requests a nonexistent account.
  await pruneEmailAuth(db);
  const owner = await credential(db, email);
  const eligible = purpose === 'register' ? cfg.allowedEmails.has(email) && !await emailInUse(db, email) : !!owner;
  const id = randomUUID();
  const code = randomInt(0, 100_000_000).toString().padStart(8, '0');
  const emailKey = emailDigest(cfg, email);
  await db.tx(async (q) => {
    await q.query(`UPDATE email_auth_challenges SET used_at = now() WHERE email_key = $1 AND purpose = $2 AND used_at IS NULL`, [emailKey, purpose]);
    await q.query(`INSERT INTO email_auth_challenges (id, email_key, purpose, code_hash, user_id, eligible, expires_at) VALUES ($1,$2,$3,$4,$5,$6,now() + interval '10 minutes')`, [id, emailKey, purpose, codeDigest(cfg, id, email, purpose, code), owner?.user_id ?? null, eligible]);
  }, `email:${emailKey}`);
  if (eligible) {
    const failed = async (event: 'auth_mail_failed' | 'auth_mail_queue_full') => {
      // Never leak provider errors, recipients, SMTP credentials, or verification codes.
      console.warn(JSON.stringify({ event, requestId: id }));
      try { await db.query(`UPDATE email_auth_challenges SET used_at = now() WHERE id = $1`, [id]); }
      catch { console.warn(JSON.stringify({ event: 'auth_mail_cleanup_failed', requestId: id })); }
    };
    const queued = enqueueMail(async () => {
      try { await cfg.mailer.send(email, code, purpose); }
      catch { await failed('auth_mail_failed'); }
    });
    if (!queued) {
      void failed('auth_mail_queue_full');
    }
  }
  // Same response for known/unknown, invited/uninvited and already registered addresses.
  return { challengeId: id, expiresIn: 600, retryAfter: 60, message: '如果邮箱符合条件，将收到验证码。请检查收件箱或垃圾邮件。' };
}

async function consume(q: Queryable, cfg: EmailAuthConfig, email: string, id: string, purpose: EmailPurpose, code: string): Promise<Challenge | undefined> {
  const [row] = await q.query<Challenge>(`SELECT * FROM email_auth_challenges WHERE id = $1 FOR UPDATE`, [id]);
  if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now() || row.attempts >= 5) return undefined;
  await q.query(`UPDATE email_auth_challenges SET attempts = attempts + 1 WHERE id = $1`, [id]);
  const supplied = Buffer.from(codeDigest(cfg, id, email, purpose, code), 'hex');
  const expected = Buffer.from(row.code_hash, 'hex');
  if (row.email_key !== emailDigest(cfg, email) || row.purpose !== purpose || !row.eligible || !timingSafeEqual(supplied, expected)) return undefined;
  await q.query(`UPDATE email_auth_challenges SET used_at = now() WHERE id = $1`, [id]);
  return row;
}

export async function registerEmail(db: Db, cfg: EmailAuthConfig, email: string, id: string, code: string, password: string, ip: string): Promise<{ id: string; token_version: number }> {
  await limit(db, cfg, `verify-ip:${ip}`, 30, 900);
  await limit(db, cfg, `verify-email:${email}`, 10, 900);
  const passwordHash = await hashPassword(password);
  const user = await db.tx(async (q) => {
    const challenge = await consume(q, cfg, email, id, 'register', code);
    if (!challenge || !cfg.allowedEmails.has(email) || await emailInUse(q, email)) return undefined;
    const [u] = await q.query<{ id: string; token_version: number }>(`INSERT INTO users DEFAULT VALUES RETURNING id, token_version`);
    await q.query(`INSERT INTO email_credentials (user_id, email, password_hash) VALUES ($1,$2,$3)`, [u!.id, email, passwordHash]);
    await q.query(`DELETE FROM email_auth_challenges WHERE email_key = $1`, [emailDigest(cfg, email)]);
    return u;
  }, `email:${emailDigest(cfg, email)}`);
  if (!user) throw invalidCode();
  return user;
}

export async function loginEmail(db: Db, cfg: EmailAuthConfig, email: string, password: string, ip: string): Promise<{ id: string; token_version: number }> {
  await limit(db, cfg, `login-ip:${ip}`, 30, 900);
  await limit(db, cfg, `login-email:${email}`, 10, 900);
  const owner = await credential(db, email);
  if (!owner) { await checkUnknownPassword(password); throw invalidLogin(); }
  if (!await checkPassword(owner.password_hash, password)) throw invalidLogin();
  const user = await db.tx(async (q) => {
    const latest = await credential(q, email);
    return latest && latest.password_hash === owner.password_hash ? { id: latest.user_id, token_version: latest.token_version } : undefined;
  }, owner.user_id);
  if (!user) throw invalidLogin();
  return user;
}

export async function resetEmailPassword(db: Db, cfg: EmailAuthConfig, email: string, id: string, code: string, password: string, ip: string) {
  await limit(db, cfg, `verify-ip:${ip}`, 30, 900);
  await limit(db, cfg, `verify-email:${email}`, 10, 900);
  const owner = await credential(db, email);
  const passwordHash = await hashPassword(password);
  const changed = await db.tx(async (q) => {
    const challenge = await consume(q, cfg, email, id, 'reset', code);
    const latest = await credential(q, email);
    if (!owner || !latest || !challenge || challenge.user_id !== latest.user_id) return false;
    await q.query(`UPDATE email_credentials SET password_hash = $2, password_changed_at = now() WHERE user_id = $1`, [latest.user_id, passwordHash]);
    await q.query(`UPDATE users SET token_version = token_version + 1 WHERE id = $1`, [latest.user_id]);
    await q.query(`DELETE FROM email_auth_challenges WHERE user_id = $1`, [latest.user_id]);
    return true;
  }, owner?.user_id ?? `email:${emailDigest(cfg, email)}`);
  if (!changed) throw invalidCode();
  return { reset: true };
}

/** Destructive account deletion requires the current password for email accounts. */
export async function verifyEmailDeletion(db: Db, cfg: EmailAuthConfig | undefined, userId: string, password: unknown): Promise<DeletionGuard | undefined> {
  const [row] = await db.query<{ password_hash: string; token_version: number; deleted_at: Date | null }>(`SELECT e.password_hash, u.token_version, u.deleted_at FROM email_credentials e JOIN users u ON u.id = e.user_id WHERE e.user_id = $1`, [userId]);
  if (!row) return;
  if (!cfg || row.deleted_at || typeof password !== 'string' || Array.from(password).length > 128) throw invalidLogin();
  await limit(db, cfg, `delete-user:${userId}`, 5, 900);
  if (!await checkPassword(row.password_hash, password)) throw invalidLogin();
  return async (q) => {
    const [latest] = await q.query<{ password_hash: string; token_version: number }>(`SELECT e.password_hash, u.token_version FROM email_credentials e JOIN users u ON u.id = e.user_id WHERE e.user_id = $1 AND u.deleted_at IS NULL`, [userId]);
    if (!latest || latest.password_hash !== row.password_hash || latest.token_version !== row.token_version) {
      throw new DomainError('unauthorized', '账户凭据已更新，请重新登录后再删除。');
    }
  };
}
