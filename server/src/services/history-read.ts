import type { Db, Transaction } from '../db/db.js';
import { dataVersion } from './repo.js';
import { fail } from './errors.js';

/** Count, aggregates and rows belong to one database snapshot. Older clients may omit the expected version. */
export async function historyRead<T>(db: Db, userId: string, expectedVersion: number | undefined, read: (q: Transaction) => Promise<T>): Promise<T> {
  return db.tx(async q => {
    await q.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const current = await dataVersion(q, userId);
    if (expectedVersion !== undefined && expectedVersion !== current)
      fail('version_conflict', '记录已变化，请从第一页重新查看。', { kind: 'history_changed', dataVersion: current });
    return read(q);
  });
}
