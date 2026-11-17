import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadRuntimeSecrets } from '../src/runtime/secrets.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true }); });
function file(contents: string) {
  const d = mkdtempSync(join(tmpdir(), 'planplan-secret-test-')); dirs.push(d);
  const f = join(d, 'runtime.json'); writeFileSync(f, contents, { mode: 0o600 }); return f;
}
it('managed environments require a private mount; values are not silently overwritten', () => {
  expect(() => loadRuntimeSecrets({ DEPLOYMENT_ENV: 'beta' })).toThrow('PLANPLAN_SECRETS_FILE');
  const path = file(JSON.stringify({ DATABASE_URL: 'postgresql://example/db' }));
  const env: NodeJS.ProcessEnv = { DEPLOYMENT_ENV: 'beta', PLANPLAN_SECRETS_FILE: path };
  loadRuntimeSecrets(env); expect(env.DATABASE_URL).toBe('postgresql://example/db');
  expect(() => loadRuntimeSecrets({ ...env, DATABASE_URL: 'other' })).toThrow('Conflicting');
  chmodSync(path, 0o644); expect(() => loadRuntimeSecrets(env)).toThrow('private');
});
it('rejects arbitrary configuration and validates before mutating', () => {
  const env: NodeJS.ProcessEnv = { PLANPLAN_SECRETS_FILE: file(JSON.stringify({ JWT_SECRET: 'secret', NODE_OPTIONS: '--inspect=0.0.0.0' })) };
  expect(() => loadRuntimeSecrets(env)).toThrow('invalid key'); expect(env.JWT_SECRET).toBeUndefined();
  expect(() => loadRuntimeSecrets({ PLANPLAN_SECRETS_FILE: file('not-json') })).toThrow('valid JSON');
});
it('allows the new SMTP credential aliases but does not admit host/TLS configuration into secrets', () => {
  const env: NodeJS.ProcessEnv = { PLANPLAN_SECRETS_FILE: file(JSON.stringify({ EMAIL_FROM: 'verify@example.test', EMAIL_SMTP_PASSWORD: 'synthetic-smtp-password' })) };
  loadRuntimeSecrets(env);
  expect(env.EMAIL_FROM).toBe('verify@example.test'); expect(env.EMAIL_SMTP_PASSWORD).toBe('synthetic-smtp-password');
  expect(() => loadRuntimeSecrets({ ...env, EMAIL_SMTP_PASSWORD: 'different' })).toThrow('Conflicting configuration for EMAIL_SMTP_PASSWORD');
  for (const key of ['EMAIL_SMTP_HOST', 'EMAIL_SMTP_PORT', 'NODE_TLS_REJECT_UNAUTHORIZED']) {
    const rejected: NodeJS.ProcessEnv = { PLANPLAN_SECRETS_FILE: file(JSON.stringify({ EMAIL_FROM: 'verify@example.test', [key]: 'unsafe' })) };
    expect(() => loadRuntimeSecrets(rejected)).toThrow('invalid key'); expect(rejected.EMAIL_FROM).toBeUndefined();
  }
});
