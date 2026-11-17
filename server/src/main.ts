import { pruneOperationConfirmations } from './services/form-operations.js';
import { pruneUsage } from './services/usage.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { openDb } from './db/db.js';
import { createApp } from './api/app.js';
import { pruneEmailAuth } from './auth/email.js';
import { authConfigFromEnv } from './auth/config.js';
import { createRuntimeLlm } from './ai/runtime.js';
import { createRuntimeCreationLlm } from './ai/creation-runtime.js';
import { loadLegalConfig } from './api/legal.js';
import { loadRuntimeSecrets } from './runtime/secrets.js';
import { managedDatabaseOptions } from './runtime/database.js';
import { Monitor, alertHookFromEnv, observedLlm } from './runtime/observability.js';
import { pruneRequestLimits } from './runtime/rate-limit.js';

// Managed launches only use the explicit mounted secret file; local .env loading
// remains a development convenience for existing workflows.
if (!['beta', 'production'].includes(process.env.DEPLOYMENT_ENV ?? '')) {
  for (const p of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../.env')]) if (existsSync(p)) process.loadEnvFile(p);
}
loadRuntimeSecrets();

const env = (k: string, fallback?: string) => {
  const v = process.env[k] ?? fallback;
  if (v === undefined || !v.trim()) throw new Error(`缺少环境变量 ${k}`);
  return v;
};

const auth = authConfigFromEnv(process.env);

const legal = loadLegalConfig(process.env);
const managedEnvironment = ['beta', 'production'].includes(process.env.DEPLOYMENT_ENV ?? '');
const rateLimitSecret = new TextEncoder().encode(process.env.RATE_LIMIT_SECRET ?? (managedEnvironment ? env('RATE_LIMIT_SECRET') : 'local-only-rate-limit-secret-32-bytes'));
if (rateLimitSecret.length < 32) throw new Error('RATE_LIMIT_SECRET requires at least 32 bytes');
const monitor = new Monitor({ alert: alertHookFromEnv(process.env) });
const databaseUrl = process.env.DATABASE_URL ?? `pglite://${resolve(process.cwd(), '.data')}`;
if (managedEnvironment && !/^postgres(ql)?:\/\//.test(databaseUrl)) throw new Error('Beta/正式环境必须配置 PostgreSQL DATABASE_URL');
const db = await openDb(databaseUrl, { ...(managedEnvironment ? managedDatabaseOptions(databaseUrl, process.env) : { migrations: 'auto' as const }), onPoolError: () => monitor.result('database', false) });
await pruneOperationConfirmations(db);
const meteredLlm = createRuntimeLlm(db, process.env);
await meteredLlm.maintain();
const llm = observedLlm(meteredLlm, monitor);
const reviewerUserIds = new Set((process.env.COMMUNITY_REVIEWER_USER_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean));
if ([...reviewerUserIds].some(value => !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value))) throw new Error('Invalid community reviewer user ID');
const app = createApp(db, llm, auth, legal, { reviewerUserIds, releaseId: process.env.RELEASE_ID, rateLimitSecret, monitor, creationLlm: createRuntimeCreationLlm(process.env, meteredLlm.usageStore) });

let auditingUsage = false;
setInterval(() => {
  if (auditingUsage) return;
  auditingUsage = true;
  void meteredLlm.maintain().catch(() => { console.warn('model_usage_audit_failed'); monitor.maintenanceFailure(); }).finally(() => { auditingUsage = false; });
}, 60_000).unref();

if (auth.email) {
  let pruning = false;
  setInterval(() => {
    if (pruning) return;
    pruning = true;
    void pruneEmailAuth(db).catch(() => monitor.maintenanceFailure()).finally(() => { pruning = false; });
  }, 3600_000).unref();
}
let pruningLimits = false;
setInterval(() => {
  if (pruningLimits) return;
  pruningLimits = true;
  void Promise.all([pruneRequestLimits(db), pruneUsage(db), pruneOperationConfirmations(db)]).catch(() => monitor.maintenanceFailure()).finally(() => { pruningLimits = false; });
}, 60_000).unref();

for (const event of ['uncaughtException', 'unhandledRejection'] as const) process.on(event, () => {
  console.error(JSON.stringify({ event: 'process_failed', severity: 'error' }));
  process.exit(1);
});

const port = Number(process.env.PORT ?? 8787);
const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '0.0.0.0' }, () => console.log(JSON.stringify({ event: 'server_started' })));
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 25_000).unref();
  server.close(() => { void db.close().finally(() => { clearTimeout(timeout); process.exit(0); }); });
});
