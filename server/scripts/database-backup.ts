import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { openDb } from '../src/db/db.js';
import { checkMigrations } from '../src/db/migrations.js';
import { applyDeletionLedger, exportDeletionLedger, verifyDeletionLedger } from '../src/db/recovery.js';
import { retryPendingDeletions } from '../src/services/deletion.js';
import { databaseOptionsFromEnv, libpqConnection, restoreDatabaseEnv } from '../src/runtime/database.js';
import { loadRuntimeSecrets } from '../src/runtime/secrets.js';

const run = promisify(execFile);
const command = process.argv[2];
const location = process.argv[3] ? resolve(process.argv[3]) : undefined;
if (!['backup', 'ledger', 'restore', 'prune'].includes(command ?? '') || !location) throw new Error('Usage: database-backup.ts backup|ledger|restore|prune <directory-or-ledger-file>');
// Retention is a local filesystem operation. Database/secret outages must not
// keep expired copies alive or require credentials merely to remove them.
if (command !== 'prune') loadRuntimeSecrets();
const keyText = process.env.BACKUP_ENCRYPTION_KEY ?? '';
const encryptionKey = Buffer.from(keyText, 'base64');
const ledgerKey = process.env.BACKUP_LEDGER_KEY ?? '';
const keyId = process.env.BACKUP_KEY_ID ?? '';
if (command !== 'prune' && (encryptionKey.length !== 32 || !keyId || Buffer.byteLength(ledgerKey) < 32)) throw new Error('Set BACKUP_KEY_ID, 32-byte base64 BACKUP_ENCRYPTION_KEY, and BACKUP_LEDGER_KEY (32+ bytes)');

async function pgCommand(name: string, args: string[], url: string, env = process.env) {
  try { await run(name, args, { env: libpqConnection(url, env).env, maxBuffer: 1024 * 1024, timeout: 10 * 60_000 }); }
  catch {
    // pg_restore 错误可含 COPY 行值，不能把原始 stderr 打进普通日志。
    throw new Error(`${name} failed; restored database remains isolated and incomplete files are removed`);
  }
}

async function digest(file: string) {
  const hash = createHash('sha256');
  for await (const part of createReadStream(file)) hash.update(part);
  return hash.digest('hex');
}

type BackupMetadata = { version: 1; keyId: string; createdAt: string; file: string; sha256: string; iv: string; tag: string };

if (command === 'backup') {
  const url = process.env.DATABASE_URL!;
  libpqConnection(url);
  const db = await openDb(url, { ...databaseOptionsFromEnv(url), migrations: 'check' });
  const backupName = `backup-${new Date().toISOString().replaceAll(':', '-')}-${randomBytes(4).toString('hex')}`;
  const dir = join(location, `.pending-${backupName}`);
  const completedDir = join(location, backupName);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const plain = join(dir, 'database.dump');
  try {
    const createdAt = new Date().toISOString();
    if ((await retryPendingDeletions(db)).pending) throw new Error('Unfinished account deletions block new backups; retry cleanup first');
    // 删除请求 UUID 不重复装进长期备份，避免清单保留期与备份保留期相加。
    await pgCommand('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--exclude-schema=planplan_recovery', '--exclude-table-data=public.deletion_jobs', '--exclude-table-data=public.request_rate_limits', '--file', plain], url);
    await chmod(plain, 0o600);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    const encrypted = join(dir, 'database.dump.enc');
    await pipeline(createReadStream(plain), cipher, createWriteStream(encrypted, { mode: 0o600 }));
    const metadata: BackupMetadata = { version: 1, keyId, createdAt, file: 'database.dump.enc', sha256: await digest(encrypted), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
    await writeFile(join(dir, 'metadata.json'), JSON.stringify(metadata), { mode: 0o600 });
    await rm(plain, { force: true });
    await rename(dir, completedDir);
    console.log(JSON.stringify({ backup: completedDir, encrypted: true, createdAt }));
  } finally { await rm(dir, { recursive: true, force: true }); await db.close(); }
} else if (command === 'ledger') {
  const db = await openDb(process.env.DATABASE_URL!, { ...databaseOptionsFromEnv(process.env.DATABASE_URL!), migrations: 'check' });
  try {
    const ledger = await exportDeletionLedger(db, ledgerKey);
    await writeFile(location, JSON.stringify(ledger), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ ledger: location, generatedAt: ledger.generatedAt, requests: ledger.entries.length }));
  } finally { await db.close(); }
} else if (command === 'restore') {
  const targetUrl = process.env.RESTORE_DATABASE_URL!;
  const restoreEnv = restoreDatabaseEnv(process.env);
  const { dbname } = libpqConnection(targetUrl, restoreEnv);
  const restoreOptions = databaseOptionsFromEnv(targetUrl, restoreEnv);
  if (targetUrl === process.env.DATABASE_URL) throw new Error('Restore target must differ from the live database');
  if (process.env.RESTORE_ISOLATED !== '1') throw new Error('Set RESTORE_ISOLATED=1 only for an isolated empty database with no application traffic');
  const metadata = JSON.parse(await readFile(join(location, 'metadata.json'), 'utf8')) as BackupMetadata;
  if (metadata.version !== 1 || metadata.keyId !== keyId || metadata.file !== 'database.dump.enc') throw new Error('Unsupported backup or wrong backup key ID');
  const encrypted = join(location, metadata.file);
  if (await digest(encrypted) !== metadata.sha256) throw new Error('Backup checksum mismatch');
  const ledgerFile = process.env.RESTORE_DELETION_LEDGER;
  if (!ledgerFile || !process.env.RESTORE_REQUIRED_THROUGH) throw new Error('Provide a fresh independent RESTORE_DELETION_LEDGER and RESTORE_REQUIRED_THROUGH cutoff');
  const cutoff = new Date(process.env.RESTORE_REQUIRED_THROUGH);
  if (cutoff.getTime() < Date.parse(metadata.createdAt)) throw new Error('Recovery cutoff cannot precede the backup');
  const ledger = verifyDeletionLedger(JSON.parse(await readFile(ledgerFile, 'utf8')), ledgerKey, cutoff);
  const target = await openDb(targetUrl, { ...restoreOptions, migrations: 'none' });
  try {
    const [tables] = await target.query<{ count: number }>(`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`);
    if (tables!.count) throw new Error('Restore target is not empty; no existing data will be overwritten');
    await target.exec(`CREATE SCHEMA planplan_recovery;
      CREATE TABLE planplan_recovery.guard (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), ready boolean NOT NULL DEFAULT false);
      INSERT INTO planplan_recovery.guard (ready) VALUES (false);`);
  } finally { await target.close(); }
  const temp = await mkdtemp(join(tmpdir(), 'planplan-restore-'));
  try {
    const plain = join(temp, 'database.dump');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(metadata.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(metadata.tag, 'base64'));
    await pipeline(createReadStream(encrypted), decipher, createWriteStream(plain, { mode: 0o600 }));
    await pgCommand('pg_restore', ['--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', '--dbname', dbname, plain], targetUrl, restoreEnv);
    const restored = await openDb(targetUrl, { ...restoreOptions, migrations: 'none' });
    try {
      await checkMigrations(restored, undefined, { isolatedRecovery: true });
      const removed = await applyDeletionLedger(restored, ledger);
      await restored.query('UPDATE planplan_recovery.guard SET ready = true WHERE singleton = true');
      await checkMigrations(restored);
      console.log(JSON.stringify({ restored: true, removedDeletedAccounts: removed, ledgerThrough: ledger.generatedAt, isolated: true }));
    } finally { await restored.close(); }
  } finally { await rm(temp, { recursive: true, force: true }); }
} else {
  // 只清理本脚本生成且 metadata 合法的备份目录，28天为固定上限，不接受更长保留期。
  const cutoff = Date.now() - 28 * 86400_000;
  let removed = 0;
  let invalid = 0;
  for (const entry of await readdir(location, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^backup-\d{4}-\d{2}-\d{2}T/.test(entry.name)) continue;
    const dir = join(location, basename(entry.name));
    let metadata: BackupMetadata;
    try {
      metadata = JSON.parse(await readFile(join(dir, 'metadata.json'), 'utf8')) as BackupMetadata;
      if (metadata.version !== 1 || metadata.file !== 'database.dump.enc' || !Number.isFinite(Date.parse(metadata.createdAt))) throw new Error('invalid');
    } catch { invalid++; continue; }
    if (Date.parse(metadata.createdAt) <= cutoff) { await rm(dir, { recursive: true }); removed++; }
  }
  console.log(JSON.stringify({ removed, invalidDirectories: invalid, maximumRetentionDays: 28 }));
  if (invalid) process.exitCode = 1;
}
