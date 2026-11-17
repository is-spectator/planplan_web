import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll } from 'vitest';
import { openDb, type Db, type OpenDbOptions } from '../src/db/db.js';

const opened = new Set<Db>();
afterAll(async () => {
  // DROP SCHEMA CASCADE locks every object in a fixture. Cleaning all schemas
  // concurrently can exhaust PostgreSQL's shared lock table after tests pass.
  const errors: unknown[] = [];
  for (const db of [...opened]) {
    try { await db.close(); } catch (error) { errors.push(error); }
  }
  // Still attempt every cleanup, while making any cleanup failure fail the suite.
  if (errors.length) throw new AggregateError(errors, 'Test database cleanup failed');
});

/** CI 的 PostgreSQL 每个 fixture 使用独立 schema，保持与 PGlite 的干净内存库语义一致。 */
export async function openTestDb(options: OpenDbOptions = {}): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  let db: Db;
  let cleanup = async () => {};
  if (url) {
    const schema = `test_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try { await admin.query(`CREATE SCHEMA ${schema}`); } finally { await admin.end(); }
    cleanup = async () => {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try { await client.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await client.end(); }
    };
    try { db = await openDb(url, { ...options, schema }); } catch (e) { await cleanup(); throw e; }
  } else db = await openDb('pglite://memory', options);
  const originalClose = db.close.bind(db);
  let closed = false;
  db.close = async () => {
    if (closed) return;
    closed = true;
    opened.delete(db);
    await originalClose();
    await cleanup();
  };
  opened.add(db);
  return db;
}
