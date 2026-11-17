import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true }); });
function fixture(failure: string) {
  const root = mkdtempSync(join(tmpdir(), 'planplan-backup-failure-')); roots.push(root);
  const bin = join(root, 'bin'), spool = join(root, 'spool'), log = join(root, 'calls');
  mkdirSync(bin); mkdirSync(spool);
  const mock = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const command=path.basename(process.argv[1]),args=process.argv.slice(2);
const action=command==='node'?args[1]:'upload';
fs.appendFileSync(process.env.MOCK_LOG,action+'\\n');
if(action===process.env.MOCK_FAILURE)process.exit(1);
if(action==='ledger')fs.writeFileSync(args[2],'{}');
if(action==='backup')console.log(JSON.stringify({backup:path.join(process.env.BACKUP_DIRECTORY,'backup-synthetic')}));
`;
  for (const command of ['node', 'ossutil']) writeFileSync(join(bin, command), mock, { mode: 0o755 });
  return {
    run: (script: string) => spawnSync('bash', [resolve('../deploy', script)], { encoding: 'utf8', env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_LOG: log, MOCK_FAILURE: failure,
      PLANPLAN_SERVER_DIR: join(root, 'server'), BACKUP_DIRECTORY: spool,
      BACKUP_OSS_PREFIX: 'oss://synthetic/backups', DELETION_OSS_PREFIX: 'oss://synthetic/deletions', OSSUTIL_CONFIG_FILE: join(root, 'synthetic-config'),
    } }),
    calls: () => readFileSync(log, 'utf8').trim().split('\n'),
  };
}
it('failed account cleanup still exports/uploads the independent deletion ledger and reports failure', () => {
  const f = fixture('retry-deletions');
  const r = f.run('deletion-ledger.sh');
  expect(r.status).toBe(1);
  expect(f.calls()).toEqual(['retry-deletions', 'ledger', 'upload']);
  expect(r.stderr).toContain('deletion_cleanup_failed');
});
it('ledger export failure never uploads an incomplete ledger', () => {
  const f = fixture('ledger'); expect(f.run('deletion-ledger.sh').status).toBe(1);
  expect(f.calls()).toEqual(['retry-deletions', 'ledger']);
});
it('database cleanup failure runs local retention first and does not create a new backup', () => {
  const f = fixture('retry-deletions'); expect(f.run('database-backup.sh').status).toBe(1);
  expect(f.calls()).toEqual(['prune', 'retry-deletions']);
});
it('backup database failure still runs local retention first', () => {
  const f = fixture('backup'); expect(f.run('database-backup.sh').status).toBe(1);
  expect(f.calls()).toEqual(['prune', 'retry-deletions', 'backup']);
});
it('real prune deletes an expired synthetic copy without database or mounted secrets', () => {
  const root = mkdtempSync(join(tmpdir(), 'planplan-retention-check-')); roots.push(root);
  const old = join(root, 'backup-2000-01-01T00-00-00Z-test'); mkdirSync(old);
  writeFileSync(join(old, 'metadata.json'), JSON.stringify({ version: 1, file: 'database.dump.enc', createdAt: '2000-01-01T00:00:00Z' }));
  writeFileSync(join(old, 'database.dump.enc'), 'synthetic');
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/maintenance.ts', 'prune', root], {
    encoding: 'utf8', env: { PATH: process.env.PATH, DEPLOYMENT_ENV: 'production', PLANPLAN_SECRETS_FILE: '/absent/secret-mount', DATABASE_URL: 'postgresql://unreachable.invalid/no-database' },
  });
  expect(r.status, r.stderr).toBe(0);
  expect(existsSync(old)).toBe(false);
  expect(JSON.parse(r.stdout)).toMatchObject({ removed: 1, maximumRetentionDays: 28 });
});
