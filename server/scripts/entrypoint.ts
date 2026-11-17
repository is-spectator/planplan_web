import { loadRuntimeSecrets } from '../src/runtime/secrets.js';

try {
  if (!['beta', 'production'].includes(process.env.DEPLOYMENT_ENV ?? '')) throw new Error('Container deployment environment must be explicit');
  loadRuntimeSecrets();
  const command = process.argv[2] ?? 'serve';
  if (command === 'serve') await import('../src/main.js');
  else if (command === 'migrate-check' || command === 'migrate-up') {
    process.argv[2] = command === 'migrate-check' ? 'check' : 'up';
    await import('./migrate.js');
  } else throw new Error('Unknown container command');
} catch {
  // Provider/database errors can embed credentials. Details belong in local tests,
  // never in production container logs.
  console.error(JSON.stringify({ event: 'startup_failed', severity: 'error' }));
  process.exitCode = 1;
}
