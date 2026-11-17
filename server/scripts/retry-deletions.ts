import { openDb } from '../src/db/db.js';
import { pruneCompletedDeletions, retryPendingDeletions } from '../src/services/deletion.js';
import { databaseOptionsFromEnv } from '../src/runtime/database.js';
import { loadRuntimeSecrets } from '../src/runtime/secrets.js';
loadRuntimeSecrets();
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL explicitly');
const db = await openDb(process.env.DATABASE_URL, { ...databaseOptionsFromEnv(process.env.DATABASE_URL), migrations: 'check' });
try {
  const result = await retryPendingDeletions(db);
  console.log(JSON.stringify(result));
  if (result.pending) process.exitCode = 1;
  if (process.env.VERIFIED_BACKUP_CUTOFF) {
    const removed = await pruneCompletedDeletions(db, new Date(process.env.VERIFIED_BACKUP_CUTOFF));
    console.log(JSON.stringify({ expiredDeletionReceiptsRemoved: removed }));
  }
} finally { await db.close(); }
