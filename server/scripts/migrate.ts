import { openDb } from '../src/db/db.js';
import { checkMigrations, migrate, rollbackLastMigration } from '../src/db/migrations.js';
import { managedDatabaseOptions } from '../src/runtime/database.js';
import { loadRuntimeSecrets } from '../src/runtime/secrets.js';

loadRuntimeSecrets();

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL explicitly; no implicit development database');
const command = process.argv[2] ?? 'up';
if (!['up', 'check', 'down'].includes(command)) throw new Error('Usage: db:migrate [up|check|down]');
const managed = ['beta', 'production'].includes(process.env.DEPLOYMENT_ENV ?? '');
const db = await openDb(url, { ...(managed ? managedDatabaseOptions(url, process.env) : {}), migrations: 'none' });
try {
  if (command === 'up') await migrate(db);
  if (command === 'check') await checkMigrations(db);
  if (command === 'down') await rollbackLastMigration(db);
  console.log(`Database migration ${command}: OK`);
} finally { await db.close(); }
