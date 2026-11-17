import { expect, it } from 'vitest';
import { readinessProbe } from '../src/runtime/readiness.js';
import { openTestDb } from './database.js';

it('readiness validates schema and stops passing after a schema mismatch', async () => {
  const db = await openTestDb(); let now = 0;
  const check = readinessProbe(db, () => now);
  expect(await check()).toBe(true);
  await db.query("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1");
  now += 5001;
  expect(await check()).toBe(false);
  await db.close(); now += 5001;
  expect(await check()).toBe(false);
});
