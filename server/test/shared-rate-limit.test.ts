import { expect, it } from 'vitest';
import { openDb } from '../src/db/db.js';
import { SharedRateLimiter, pruneRequestLimits } from '../src/runtime/rate-limit.js';
import { openTestDb } from './database.js';

const secret = Buffer.alloc(32, 5);
it('shares sliding windows across limiter instances without storing user IDs', async () => {
  const db = await openTestDb();
  const a = new SharedRateLimiter(db, secret), b = new SharedRateLimiter(db, secret);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).consume('chat', 'private-user-id', 5)));
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
  const rows = await db.query<{ key_hash: string; count: number }>('SELECT key_hash, cardinality(hits)::int AS count FROM request_rate_limits');
  expect(rows).toHaveLength(1); expect(rows[0]!.count).toBe(5); expect(JSON.stringify(rows)).not.toContain('private-user-id');
  await b.consume('write', 'private-user-id', 5);
  await db.query("UPDATE request_rate_limits SET hits = ARRAY[clock_timestamp() - interval '2 minutes'], expires_at = clock_timestamp() - interval '1 minute'");
  await a.consume('chat', 'private-user-id', 5);
  await pruneRequestLimits(db);
  expect(await db.query('SELECT * FROM request_rate_limits')).toHaveLength(1);
});
it.skipIf(!process.env.TEST_DATABASE_URL)('serializes the initial bucket across independent PostgreSQL pools', async () => {
  const db = await openTestDb();
  const [row] = await db.query<{ schema: string }>('SELECT current_schema() AS schema');
  const other = await openDb(process.env.TEST_DATABASE_URL!, { schema: row!.schema, migrations: 'check' });
  try {
    const instances = [new SharedRateLimiter(db, secret), new SharedRateLimiter(other, secret)];
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => instances[i % 2]!.consume('chat', 'same-user', 7)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(7);
  } finally { await other.close(); }
});
