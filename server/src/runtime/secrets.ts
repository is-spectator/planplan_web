import { readFileSync, statSync } from 'node:fs';

// Only these values may be supplied by the KMS/secret-agent materialized mount.
// Never load arbitrary process configuration or execute an env-file as shell code.
const SECRET_KEYS = new Set([
  'DATABASE_URL', 'QWEN_API_KEY', 'OPENROUTER_API_KEY', 'JWT_SECRET', 'JWT_KEYS_JSON', 'EMAIL_AUTH_SECRET',
  'DIRECTMAIL_SMTP_PASSWORD', 'DIRECTMAIL_FROM', 'EMAIL_SMTP_PASSWORD', 'EMAIL_FROM', 'BETA_EMAIL_ALLOWLIST',
  'RATE_LIMIT_SECRET', 'ALERT_WEBHOOK_URL',
  'BACKUP_ENCRYPTION_KEY', 'BACKUP_LEDGER_KEY', 'RESTORE_DATABASE_URL',
]);

export function loadRuntimeSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const managed = ['beta', 'production'].includes(env.DEPLOYMENT_ENV ?? '');
  const file = env.PLANPLAN_SECRETS_FILE;
  if (!file) {
    if (managed) throw new Error('Managed deployments require PLANPLAN_SECRETS_FILE');
    return;
  }
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > 64 * 1024 || (stat.mode & 0o007) !== 0) throw new Error('Secret mount must be a private regular file, at most 64 KiB');
  let values: unknown;
  try { values = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('Secret mount is not valid JSON'); }
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Secret mount must contain an object');
  for (const [key, value] of Object.entries(values)) {
    if (!SECRET_KEYS.has(key) || typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('Secret mount contains an invalid key or value');
    if (env[key] !== undefined && env[key] !== value) throw new Error(`Conflicting configuration for ${key}`);
  }
  // Validate the complete object before making any change.
  Object.assign(env, values);
}
