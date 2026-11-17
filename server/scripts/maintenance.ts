// Host-side production maintenance entry point. Provider/DB failures must never
// print raw errors (which can include connection strings or COPY row contents).
try {
  const command = process.argv[2];
  if (command === 'retry-deletions') await import('./retry-deletions.js');
  else if (command === 'migrate') {
    process.argv.splice(2, 1);
    await import('./migrate.js');
  } else if (['backup', 'ledger', 'restore', 'prune'].includes(command ?? '')) await import('./database-backup.js');
  else throw new Error('Unknown maintenance command');
} catch {
  console.error(JSON.stringify({ event: 'database_maintenance_failed', severity: 'error' }));
  process.exitCode = 1;
}
