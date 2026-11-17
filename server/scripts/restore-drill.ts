/** 使用显式测试 PostgreSQL 管理连接创建独立数据库，完成后全部删除。绝不读取 .env。 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import pg from 'pg';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.js';
import { execute } from '../src/services/engine.js';
import { requestAccountDeletion } from '../src/services/deletion.js';

const adminUrl = process.env.DRILL_ADMIN_DATABASE_URL;
if (!adminUrl) throw new Error('Set DRILL_ADMIN_DATABASE_URL to a disposable PostgreSQL test server');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(adminUrl).hostname)) throw new Error('Restore drill only accepts a local disposable PostgreSQL server');
const prefix = `drill_${randomUUID().replaceAll('-', '')}`;
const names = [`${prefix}_source`, `${prefix}_restored`];
const targetUrl = (name: string) => { const u = new URL(adminUrl); u.pathname = `/${name}`; return u.toString(); };
const dir = await mkdtemp(join(tmpdir(), 'planplan-backup-drill-'));
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
const secrets = { BACKUP_KEY_ID: 'drill-only', BACKUP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), BACKUP_LEDGER_KEY: randomBytes(32).toString('hex') };
const sourceUrl = targetUrl(names[0]!);
const destinationUrl = targetUrl(names[1]!);
const invoke = (command: string, path: string, extra: Record<string, string> = {}, expectSuccess = true) => {
  const result = spawnSync(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), fileURLToPath(new URL('./database-backup.ts', import.meta.url)), command, path], {
    env: { ...process.env, ...secrets, DATABASE_URL: sourceUrl, ...extra }, encoding: 'utf8', timeout: 60_000,
  });
  if (expectSuccess && result.status !== 0) throw new Error(`Restore drill step ${command} failed (${result.status}); ${result.stderr.replaceAll(sourceUrl, '[source]').replaceAll(destinationUrl, '[target]')}`);
  return result;
};
try {
  for (const name of names) await admin.query(`CREATE DATABASE ${name}`);
  const source = await openDb(sourceUrl);
  let deletedId: string;
  let keptId: string;
  try {
    const [deleted] = await source.query<{ id: string }>(`INSERT INTO users (dev_name) VALUES ('delete-after-backup') RETURNING id`);
    const [kept] = await source.query<{ id: string }>(`INSERT INTO users (dev_name) VALUES ('survivor') RETURNING id`);
    deletedId = deleted!.id; keptId = kept!.id;
    await execute(source, { userId: deletedId, inputAt: new Date(), source: 'form' }, 'deleted-ledger', [{ type: 'create_ledger' }]);
    await execute(source, { userId: keptId, inputAt: new Date(), source: 'form' }, 'kept-ledger', [{ type: 'create_ledger' }]);
    invoke('ledger', join(dir, 'stale-deletions.json'));
    invoke('backup', dir);
    await requestAccountDeletion(source, deletedId);
  } finally { await source.close(); }
  const backupDir = join(dir, (await readdir(dir)).find((p) => p.startsWith('backup-'))!);
  const failingTools = join(dir, 'failing-tools');
  await mkdir(failingTools);
  await writeFile(join(failingTools, 'pg_dump'), '#!/bin/sh\nexit 9\n', { mode: 0o700 });
  assert.notEqual(invoke('backup', dir, { PATH: `${failingTools}:${process.env.PATH ?? ''}` }, false).status, 0);
  assert.equal((await readdir(dir)).filter((p) => p.startsWith('.pending-')).length, 0, 'failed backup leaves no plaintext or incomplete backup');
  const invalidDir = join(dir, 'backup-2000-01-01T00-00-00Z-invalid');
  const expiredDir = join(dir, 'backup-2000-01-01T00-00-00Z-expired');
  await mkdir(invalidDir);
  await mkdir(expiredDir);
  await writeFile(join(expiredDir, 'metadata.json'), JSON.stringify({ version: 1, file: 'database.dump.enc', createdAt: '2000-01-01T00:00:00Z' }));
  assert.equal(invoke('prune', dir, {}, false).status, 1, 'invalid backups must be reported');
  assert.equal((await readdir(dir)).includes('backup-2000-01-01T00-00-00Z-expired'), false, 'invalid directory must not block valid expiry cleanup');
  const cutoff = new Date().toISOString();
  const ledger = join(dir, 'latest-deletions.json');
  invoke('ledger', ledger);
  const restoreEnv = { RESTORE_DATABASE_URL: destinationUrl, RESTORE_ISOLATED: '1', RESTORE_REQUIRED_THROUGH: cutoff, RESTORE_DELETION_LEDGER: join(dir, 'stale-deletions.json') };
  assert.notEqual(invoke('restore', backupDir, restoreEnv, false).status, 0, 'stale deletion ledger must be refused');
  invoke('restore', backupDir, { ...restoreEnv, RESTORE_DELETION_LEDGER: ledger });
  const restored = await openDb(destinationUrl, { migrations: 'check' });
  try {
    assert.deepEqual(await restored.query('SELECT id FROM users'), [{ id: keptId! }]);
    assert.equal((await restored.query('SELECT id FROM deletion_jobs WHERE user_id = $1', [deletedId!])).length, 1);
    const replay = await execute(restored, { userId: keptId!, inputAt: new Date(), source: 'form' }, 'kept-ledger', [{ type: 'create_ledger' }]);
    assert.equal(replay.replayed, true);
    assert.equal((await restored.query('SELECT id FROM plans')).length, 1);
    console.log('Restore drill PASS: encrypted backup, failed-backup cleanup, expiry with malformed directory, stale-ledger rejection, deleted account purge, surviving account and idempotency preserved.');
  } finally { await restored.close(); }
} finally {
  for (const name of names) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
  await rm(dir, { recursive: true, force: true });
}
