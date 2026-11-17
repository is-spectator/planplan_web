import { loadRuntimeSecrets } from '../src/runtime/secrets.js';
import { databaseOptionsFromEnv } from '../src/runtime/database.js';
import { openDb } from '../src/db/db.js';
import { productMetrics } from '../src/services/metrics.js';

try {
  loadRuntimeSecrets();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Explicit database URL required');
  const db = await openDb(url, { ...databaseOptionsFromEnv(url, process.env), migrations: 'check' });
  try { console.log(JSON.stringify(await productMetrics(db), null, 2)); }
  finally { await db.close(); }
} catch {
  console.error(JSON.stringify({ event: 'product_metrics_failed' }));
  process.exitCode = 1;
}
