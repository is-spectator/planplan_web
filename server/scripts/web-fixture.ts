/** Isolated local browser acceptance fixture. Never imported by src/main.ts. */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { openDb } from '../src/db/db.js';
import { createApp } from '../src/api/app.js';
import type { AuthConfig } from '../src/api/auth.js';
import { registerEmail, requestEmailCode } from '../src/auth/email.js';
import type { EmailPurpose } from '../src/auth/mail.js';
import { FakeLlm } from '../src/ai/llm.js';
import { createRuntimeLlm } from '../src/ai/runtime.js';
import { createRuntimeCreationLlm } from '../src/ai/creation-runtime.js';
import { webFixtureLegal } from './web-fixture-legal.js';

if (process.env.NODE_ENV === 'production' || ['beta', 'production'].includes(process.env.DEPLOYMENT_ENV ?? '')) {
  throw new Error('The Web acceptance fixture is local development only');
}

// No .env, existing DATABASE_URL, SMTP, or existing server data is loaded here.
const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../.data/web-fixture');
await mkdir(directory, { recursive: true });
const db = await openDb(`pglite://${directory}`);
const mailbox: { email: string; code: string; purpose: EmailPurpose; createdAt: string }[] = [];
const accounts = ['tester@planplan.test', 'second@planplan.test', 'template-flow@planplan.test', 'template-webkit@planplan.test', 'model-flow@planplan.test', 'creation-flow@planplan.test', 'creation-webkit@planplan.test', 'creation-other@planplan.test', 'creation-model@planplan.test', 'platform-author@planplan.test', 'platform-consumer@planplan.test', 'platform-reviewer@planplan.test', 'platform-model@planplan.test'];
const password = 'PlanPlan-local-test-2026';
const auth: AuthConfig = {
  jwtSecret: new TextEncoder().encode('local-web-fixture-public-signing-key-do-not-deploy'),
  appleAudience: null, devLogin: false,
  webAllowedOrigins: ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:4173', 'http://127.0.0.1:8788'],
  cookieSecure: false,
  email: {
    secret: new TextEncoder().encode('local-web-fixture-public-email-key-do-not-deploy'),
    allowedEmails: new Set([...accounts, 'invite@planplan.test', 'beta01@planplan.test', 'beta02@planplan.test', 'beta03@planplan.test']),
    mailer: { async send(email, code, purpose) {
      if (!email.endsWith('@planplan.test')) throw new Error('Fixture mail is limited to synthetic .test accounts');
      mailbox.push({ email, code, purpose, createdAt: new Date().toISOString() });
    } },
  },
};

for (const email of accounts) {
  const existing = await db.query('SELECT user_id FROM email_credentials WHERE email=$1', [email]);
  if (existing.length) continue;
  const challenge = await requestEmailCode(db, auth.email!, email, 'register', 'fixture-seed');
  const code = mailbox.findLast(mail => mail.email === email && mail.purpose === 'register')?.code;
  if (!code) throw new Error('Fixture registration mail was not captured');
  await registerEmail(db, auth.email!, email, challenge.challengeId, code, password, 'fixture-seed');
}

const realModel = process.env.PLANPLAN_FIXTURE_REAL_AI === '1';
// Only explicitly named model settings reach the real model client; no inherited
// database, mail, runtime config, or automatic fallback-model configuration.
const modelEnv: NodeJS.ProcessEnv = Object.fromEntries(
  ['AI_PROVIDER', 'QWEN_API_KEY', 'QWEN_BASE_URL', 'QWEN_MODEL', 'QWEN_OUTPUT', 'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL', 'OPENROUTER_MODEL', 'OPENROUTER_OUTPUT', 'OPENROUTER_TIMEOUT_MS'].map(key => [key, process.env[key]]),
);
const meteredLlm = realModel ? createRuntimeLlm(db, modelEnv) : null;
const llm = meteredLlm ?? new FakeLlm(() => ({ intent: 'unsupported', unsupported_kind: 'other', reply: '暂时无法理解这条内容，可以使用手动记录。' }));
const reviewers = await db.query<{user_id:string}>("SELECT user_id FROM email_credentials WHERE email='platform-reviewer@planplan.test'");
const app = createApp(db, llm, auth, undefined, { reviewerUserIds: new Set(reviewers.map(row => row.user_id)), localLegal: webFixtureLegal(realModel, modelEnv), ...(meteredLlm ? { creationLlm: createRuntimeCreationLlm(modelEnv, meteredLlm.usageStore) } : {}) });

// Test harness only. Not mounted in the production API and never delivers email.
app.get('/__fixture/mail', c => {
  c.header('Cache-Control', 'private, no-store');
  const email = c.req.query('email');
  if (!email || !auth.email!.allowedEmails.has(email)) return c.json({ messages: [] });
  return c.json({ messages: mailbox.filter(message => message.email === email) });
});

const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 8788 }, () => {
  console.log(JSON.stringify({ event: 'web_fixture_started', url: 'http://127.0.0.1:8788', model: realModel ? 'real' : 'stub', accounts }));
});
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  server.close(() => { void db.close().finally(() => process.exit(0)); });
});
