import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { cpus, platform, arch } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';
import { openDb, type Db, type Queryable } from '../src/db/db.js';
import { migrate, checkMigrations } from '../src/db/migrations.js';
import { FakeLlm } from '../src/ai/llm.js';
import { sanitizeTurn } from '../src/ai/turn.js';
import { Chat } from '../src/services/chat.js';
import { ledgerView, studyView, planCards } from '../src/services/views.js';
import { isBizDate, monthOf, monthStart, monthEnd, shanghaiDate, weekOf } from '../src/domain/time.js';
import { LEDGER_GROUP_SQL } from '../src/services/view-aggregates.js';
import { seedPerformanceFixture, PERF_USER, LEDGER, STUDY, EMPTY_PLAN } from './fixture.js';

const url = process.env.PERF_DATABASE_URL;
if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Set PERF_DATABASE_URL to a local disposable PostgreSQL server; remote benchmarks require a separately reviewed harness');
if (new URL(url).search) throw new Error('Performance URL must not override connection options');
const numeric = (key: string, fallback: number, min: number, max: number) => {
  const n = Number(process.env[key] ?? fallback); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${key}`); return n;
};
const samples = numeric('PERF_SAMPLES', 50, 20, 1000);
const rtt = numeric('PERF_QUERY_DELAY_MS', 0, 0, 100);
const readConcurrency = numeric('PERF_READ_CONCURRENCY', 1, 1, 20);
const label = process.env.PERF_LABEL ?? 'local';
if (!/^[a-z0-9_-]{1,40}$/.test(label)) throw new Error('Invalid PERF_LABEL');
const today = process.env.PERF_TODAY ?? shanghaiDate(new Date());
if (!isBizDate(today)) throw new Error('PERF_TODAY must be a valid business date');
const schema = `perf_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Client({ connectionString: url }); await admin.connect();
await admin.query(`CREATE SCHEMA ${schema}`);
let base: Db | undefined;
type Sample = { ms: number; queries: number; rows: number };
const trace = new AsyncLocalStorage<{ queries: number; rows: number }>();
const instrument = (q: Queryable): Queryable => ({ query: async <T>(sql: string, params?: unknown[]) => {
  const stats = trace.getStore(); if (stats) stats.queries++;
  if (rtt) await new Promise((r) => setTimeout(r, rtt));
  const rows = await q.query<T>(sql, params); if (stats) stats.rows += rows.length; return rows;
} });
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1]!;
const measure = async (fn: () => Promise<unknown>): Promise<Sample> => {
  const stats = { queries: 0, rows: 0 }; const start = performance.now();
  await trace.run(stats, fn); return { ms: performance.now() - start, ...stats };
};
try {
  base = await openDb(url, { schema, migrations: 'none' });
  const [namespace] = await base.query<{ schema: string }>('SELECT current_schema() AS schema');
  if (namespace?.schema !== schema) throw new Error('Refusing to modify a database outside the isolated benchmark schema');
  await migrate(base); await checkMigrations(base);
  const fixture = await seedPerformanceFixture(base, today);
  const counted: Db = { ...instrument(base), exec: base.exec.bind(base), close: base.close.bind(base),
    tx: (fn, lock) => base!.tx((q) => fn({ ...instrument(q), exec: q.exec.bind(q) }), lock) };
  const fake = new FakeLlm((text) => {
    if (text.startsWith('perf-record-')) return { intent: 'write', writes: [sanitizeTurn({ intent: 'write', writes: [{ op: 'add_expense', is_fact: true, amount_text: '12.34', currency: 'CNY', category: '餐饮', date_kind: 'today', note: text }], missing: [] })!.writes[0]!] };
    if (text.startsWith('perf-create-')) return { intent: 'write', writes: [sanitizeTurn({ intent: 'write', writes: [{ op: 'create_study', is_fact: true, plan_name: text, activity: text, days_per_week: 3, min_minutes: 20, date_kind: 'today' }], missing: [] })!.writes[0]!] };
    return { intent: 'query', query: { kind: 'ledger_summary', plan_id: LEDGER, period: 'this_month', from: null, to: null, category: null } };
  });
  const chat = new Chat(counted, fake);
  const inputAt = () => new Date(`${today}T04:00:00Z`); let seq = 0;
  const send = async (type: string) => {
    const id = `perf-${type}-${++seq}`;
    const response = await chat.send(PERF_USER, { clientMsgId: id, inputAt: inputAt(), text: id });
    if (response.transient || response.assistant.cards.some((c) => c.type === 'error' || c.type === 'clarify')) throw new Error('Synthetic benchmark operation did not complete');
    if (type !== 'query' && !response.assistant.cards.some((c) => c.type === 'receipt')) throw new Error('Synthetic write missing receipt');
    return response;
  };
  const results: Record<string, { samples: number; p50Ms: number; p95Ms: number; maxMs: number; queriesP95: number; rowsP95: number; concurrency: number }> = {};
  const bench = async (name: string, fn: () => Promise<unknown>, cleanup?: () => Promise<void>, concurrency = 1) => {
    for (let i = 0; i < 3; i++) { await fn(); await cleanup?.(); }
    const values: Sample[] = [];
    for (let i = 0; i < samples; i += concurrency) {
      values.push(...await Promise.all(Array.from({ length: Math.min(concurrency, samples - i) }, () => measure(fn))));
      await cleanup?.();
    }
    const ms = values.map((x) => x.ms);
    results[name] = { samples, p50Ms: percentile(ms, .5), p95Ms: percentile(ms, .95), maxMs: Math.max(...ms), queriesP95: percentile(values.map((x) => x.queries), .95), rowsP95: percentile(values.map((x) => x.rows), .95), concurrency };
  };
  await bench('ledger_detail', () => ledgerView(counted, PERF_USER, LEDGER, monthOf(today)), undefined, readConcurrency);
  await bench('study_detail', () => studyView(counted, PERF_USER, STUDY, weekOf(today), today), undefined, readConcurrency);
  await bench('refresh_plan_list', () => planCards(counted, PERF_USER, today, 'active'), undefined, readConcurrency);
  const cleanChat = async () => {
    await base!.query('DELETE FROM messages WHERE user_id = $1', [PERF_USER]);
    await base!.query('DELETE FROM pending_actions WHERE user_id = $1', [PERF_USER]);
    await base!.query('DELETE FROM operations WHERE user_id = $1', [PERF_USER]);
    await base!.query('DELETE FROM events');
  };
  await bench('query_fake_model', () => send('query'), cleanChat);
  await bench('record_fake_model', () => send('record'), async () => {
    await base!.query("DELETE FROM records WHERE user_id = $1 AND source = 'chat'", [PERF_USER]); await cleanChat();
  });
  await base.query('DELETE FROM plans WHERE id = $1', [EMPTY_PLAN]);
  await bench('create_fake_model', () => send('create'), async () => {
    await base!.query("DELETE FROM plans WHERE user_id = $1 AND name LIKE 'perf-create-%'", [PERF_USER]); await cleanChat();
  });
  const [version] = await admin.query('SHOW server_version').then((r) => r.rows as { server_version: string }[]);
  const queryPlans = await base.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + LEDGER_GROUP_SQL, [LEDGER, PERF_USER, monthStart(monthOf(today)), monthEnd(monthOf(today))]);
  const report = { generatedAt: new Date().toISOString(), label, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    scope: 'Local service functions only; no HTTP/client rendering/mobile network/provider latency. FakeLlm returns immediately. Not PRD release acceptance.',
    environment: { node: process.version, postgres: version!.server_version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, cores: cpus().length, artificialQueryDelayMs: rtt },
    fixture, methodology: { warmupPerCase: 3, percentile: 'nearest-rank ceil(0.95 * samples)', readConcurrency, writesConcurrency: 1, queryCount: 'application SQL calls; excludes transaction begin/advisory lock/commit', cleanup: 'outside timing, records reset to 10000; create starts at 99 plans and ends at 100', localFeedback: 'not measured', realModelAndNetwork: 'not measured' }, results, queryPlans };
  const dir = resolve('perf/reports'); await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, `${label}.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: `perf/reports/${label}.json`, results }, null, 2));
} finally {
  await base?.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
}
