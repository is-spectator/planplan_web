import type { Db } from '../src/db/db.js';
import { openTestDb } from './database.js';
import { execute, type Action, type ExecContext } from '../src/services/engine.js';

let n = 0;
export const opId = () => `op-${Date.now()}-${++n}`;

export async function setup() {
  const db = await openTestDb();
  const [u] = await db.query<{ id: string }>(`INSERT INTO users (dev_name, ai_consent) VALUES ($1, true) RETURNING id`, [`u${++n}`]);
  const userId = u!.id;
  const at = (iso: string): ExecContext => ({ userId, inputAt: new Date(iso), source: 'form' });
  const run = (iso: string, ...actions: Action[]) => execute(db, at(iso), opId(), actions);
  return { db, userId, at, run };
}

export type Ctx = Awaited<ReturnType<typeof setup>>;
export type { Db };
