import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { databaseOptionsFromEnv, libpqConnection, restoreDatabaseEnv } from '../src/runtime/database.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true }); });
function env(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'planplan-ca-test-')); dirs.push(dir);
  const ca = join(dir, 'root.pem'); writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----');
  return { DEPLOYMENT_ENV: 'beta', PG_CA_FILE: ca, PGSSLMODE: 'disable' };
}
it('Node and libpq both require the configured CA and strict hostname verification', () => {
  const e: NodeJS.ProcessEnv = { ...env(), QWEN_API_KEY: 'do-not-forward', BACKUP_ENCRYPTION_KEY: 'do-not-forward' };
  const url = 'postgresql://tester:encoded%40pass@rds.example.invalid/db';
  expect(databaseOptionsFromEnv(url, e).ssl).toMatchObject({ rejectUnauthorized: true });
  const pg = libpqConnection(url, e).env;
  expect(pg).toMatchObject({ PGSSLMODE: 'verify-full', PGSSLROOTCERT: e.PG_CA_FILE, PGHOST: 'rds.example.invalid', PGPASSWORD: 'encoded@pass' });
  expect(pg).not.toHaveProperty('QWEN_API_KEY'); expect(pg).not.toHaveProperty('BACKUP_ENCRYPTION_KEY');
  expect(() => databaseOptionsFromEnv(`${url}?sslmode=disable`, e)).toThrow('PG_CA_FILE');
  expect(() => libpqConnection(url, { ...e, PG_CA_FILE: undefined })).toThrow('PG_CA_FILE');
  expect(() => libpqConnection(url, { ...e, NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toThrow('TLS');
});
it('restore target needs its own CA; local disposable drills remain independent', () => {
  const e = env(), url = 'postgresql://tester@rds.example.invalid/restore';
  expect(() => libpqConnection(url, restoreDatabaseEnv(e))).toThrow('PG_CA_FILE');
  const target = restoreDatabaseEnv({ ...e, RESTORE_PG_CA_FILE: e.PG_CA_FILE });
  expect(libpqConnection(url, target).env.PGSSLMODE).toBe('verify-full');
  expect(databaseOptionsFromEnv('postgresql://tester@127.0.0.1/drill', {})).toEqual({});
});
it('local verified TLS restore uses only the explicitly named target CA, never the live environment CA',()=>{
  const e={...env(),DEPLOYMENT_ENV:'local',PGSSLROOTCERT:'/live/root.pem'};
  const target=restoreDatabaseEnv(e),url='postgresql://tester@127.0.0.1/isolated?sslmode=verify-full&sslrootcert=%2Frestore%2Froot.pem';
  expect(libpqConnection(url,target).env).toMatchObject({PGSSLMODE:'verify-full',PGSSLROOTCERT:'/restore/root.pem'});
  expect(libpqConnection('postgresql://tester@127.0.0.1/isolated?sslmode=verify-full',target).env.PGSSLROOTCERT).toBeUndefined();
  expect(()=>libpqConnection('postgresql://tester@127.0.0.1/isolated?sslrootcert=relative.pem',target)).toThrow('absolute');
  expect(()=>libpqConnection(url,env())).toThrow('PG_CA_FILE');
});
