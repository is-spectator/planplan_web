import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { OpenDbOptions } from '../db/db.js';

/** RDS uses a verified TLS connection. URL ssl options cannot override the CA. */
export function managedDatabaseOptions(url: string, env: NodeJS.ProcessEnv): OpenDbOptions {
  const parsed = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('Managed deployments require PostgreSQL');
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification must remain enabled');
  for (const name of parsed.searchParams.keys()) {
    if (/^ssl|^uselibpqcompat$/i.test(name)) throw new Error('Configure managed database TLS using PG_CA_FILE only');
  }
  if (!env.PG_CA_FILE || !isAbsolute(env.PG_CA_FILE)) throw new Error('Managed deployments require an absolute PG_CA_FILE path');
  const ca = readFileSync(env.PG_CA_FILE, 'utf8');
  if (!ca.includes('-----BEGIN CERTIFICATE-----')) throw new Error('Invalid database CA bundle');
  return { migrations: 'check', ssl: { ca, rejectUnauthorized: true }, connectionTimeoutMillis: 2000, statementTimeoutMillis: 10_000 };
}

export function databaseOptionsFromEnv(url: string, env: NodeJS.ProcessEnv = process.env): OpenDbOptions {
  return ['beta', 'production'].includes(env.DEPLOYMENT_ENV ?? '') ? managedDatabaseOptions(url, env) : {};
}

/** Restore credentials and trust roots never fall back to the live database's CA. */
export function restoreDatabaseEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.RESTORE_DEPLOYMENT_ENV && !['beta', 'production', 'local'].includes(env.RESTORE_DEPLOYMENT_ENV)) throw new Error('Invalid restore environment');
  return { ...env, DEPLOYMENT_ENV: env.RESTORE_DEPLOYMENT_ENV ?? env.DEPLOYMENT_ENV,
    PG_CA_FILE: env.RESTORE_PG_CA_FILE, PGSSLROOTCERT: undefined, PGSSLMODE: undefined };
}

export function libpqConnection(url: string | undefined, env: NodeJS.ProcessEnv = process.env) {
  if (!url || !/^postgres(ql)?:\/\//.test(url)) throw new Error('Explicit PostgreSQL connection URL required');
  const u = new URL(url);
  if (env.DEPLOYMENT_ENV === 'local' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new Error('Local restore override requires a loopback target');
  const dbname = decodeURIComponent(u.pathname.slice(1));
  if (!dbname) throw new Error('Database name required');
  const managed = ['beta', 'production'].includes(env.DEPLOYMENT_ENV ?? '');
  if (managed) managedDatabaseOptions(url, env); // Same TLS validation as Node PG.
  const localRootCert = u.searchParams.get('sslrootcert');
  if (!managed && localRootCert && !isAbsolute(localRootCert)) throw new Error('Local database CA must use an absolute path');
  // pg_dump/pg_restore do not need the model, email, JWT or encryption secrets.
  return { dbname, env: { PATH: env.PATH, HOME: env.HOME, TMPDIR: env.TMPDIR, LANG: env.LANG,
    PGCONNECT_TIMEOUT: '5', PGAPPNAME: 'planplan-maintenance', PGHOST: u.hostname, PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: dbname,
    PGSSLMODE: managed ? 'verify-full' : u.searchParams.get('sslmode') ?? env.PGSSLMODE ?? 'prefer',
    // A local isolated restore may name its own CA in its explicit target URL.
    // restoreDatabaseEnv still removes live-environment trust roots.
    PGSSLROOTCERT: managed ? env.PG_CA_FILE : localRootCert ?? env.PGSSLROOTCERT,
  } };
}
