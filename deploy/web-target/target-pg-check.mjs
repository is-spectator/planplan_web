// Synthetic tests only. Never load the application's runtime secrets or .env.
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, isAbsolute, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const [candidateInput, configInput, outputInput] = process.argv.slice(2);
if (!candidateInput || !configInput || !outputInput) throw new Error('Usage: target-pg-check.mjs <candidate> <private-test-config.json> <evidence-dir>');
process.umask(0o077);
const candidate = resolve(candidateInput), output = resolve(outputInput);
const workers=process.env.PLANPLAN_TEST_WORKERS??'1';
if(!['1','2'].includes(workers))throw new Error('Use one or two isolated test workers');
const configStat = await stat(configInput);
if ((configStat.mode & 0o077) !== 0 || !configStat.isFile()) throw new Error('Test configuration must be a private 0600 file');
const config = JSON.parse(await readFile(configInput, 'utf8'));
if (Object.keys(config).sort().join(',') !== 'PG_CA_FILE,TEST_DATABASE_URL') throw new Error('Unexpected test configuration keys');
const url = new URL(config.TEST_DATABASE_URL);
if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new Error('Loopback test server required');
if (url.pathname !== '/planplan_web_test' || url.username !== 'planplan_web_test' || url.port !== '55432' || url.search) throw new Error('Dedicated isolated test role/database on port 55432 required');
if (!isAbsolute(config.PG_CA_FILE)) throw new Error('Absolute CA file required');
const ca = await readFile(config.PG_CA_FILE, 'utf8');
const require = createRequire(join(candidate, 'server/package.json'));
const { default: pg } = await import(require.resolve('pg'));
const tlsOptions = { connectionString: url.toString(), ssl: { ca, rejectUnauthorized: true }, connectionTimeoutMillis: 3000 };
const db = new pg.Client(tlsOptions);
await db.connect();
let server;
try {
  const { rows } = await db.query("SELECT current_setting('server_version') AS version, current_setting('server_version_num')::int AS version_num, ssl, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()");
  server = rows[0];
  if (server.version_num !== 150019 || !server.ssl) throw new Error('This acceptance target must be PostgreSQL 15.19 over verified TLS');
} finally { await db.end(); }
for (const ssl of [false, { rejectUnauthorized: true }]) {
  const wrong = new pg.Client({ connectionString: url.toString(), ssl, connectionTimeoutMillis: 3000 });
  let accepted = false;
  try { await wrong.connect(); accepted = true; } catch { /* expected: HBA or untrusted CA */ }
  finally { await wrong.end().catch(() => {}); }
  if (accepted) throw new Error('Unencrypted or untrusted database connection unexpectedly accepted');
}
// test/database.ts and restore-drill.ts use pg's URL TLS contract. Runtime uses
// managedDatabaseOptions instead; verify it separately with the same CA.
const { managedDatabaseOptions } = await import(join(candidate, 'server/dist/src/runtime/database.js'));
const runtime = new pg.Client({ connectionString: url.toString(), ...managedDatabaseOptions(url.toString(), { PG_CA_FILE: config.PG_CA_FILE }) });
await runtime.connect(); await runtime.end();
url.searchParams.set('sslmode', 'verify-full'); url.searchParams.set('sslrootcert', config.PG_CA_FILE);
const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR,
  NODE_OPTIONS:process.env.NODE_OPTIONS,
  PGSSLROOTCERT:config.PG_CA_FILE,
  NODE_ENV: 'test', DEPLOYMENT_ENV: 'local', TEST_DATABASE_URL: url.toString(), DRILL_ADMIN_DATABASE_URL: url.toString() };
await mkdir(output, { recursive: true, mode: 0o700 });
async function run(name, cmd, args) {
  const log = createWriteStream(join(output, `${name}.log`), { mode: 0o600 });
  const child = spawn(cmd, args, { cwd: join(candidate, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const status = await new Promise((res, rej) => { child.once('error', rej); child.once('close', res); });
  await new Promise(res => log.end(res));
  if (status !== 0) throw new Error(`${name} failed; restricted evidence log retained`);
}
const source = JSON.parse(await readFile(join(candidate, 'source-manifest.json'), 'utf8'));
const discovery=join(output,'test-files.json');
await run('test-discovery','pnpm',['exec','vitest','list','--filesOnly',`--json=${discovery}`,'--exclude','dist/**']);
const files=JSON.parse(await readFile(discovery,'utf8')).map(row=>row.file).sort();
const expected=Object.keys(source.files).filter(name=>/^server\/test\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)).sort();
if(!files.length||JSON.stringify(files.map(file=>`server/${relative(join(candidate,'server'),file)}`).sort())!==JSON.stringify(expected))throw new Error('Test discovery differs from the complete source manifest');
const counts={files:files.length,tests:0,passed:0,failed:0,pending:0};
// A fresh Vitest process per file bounds accumulated transformer/worker memory
// on the small shared host. No test is excluded or retried into a false pass.
for(const [index,file] of files.entries()){
 const resultPath=join(output,`test-${index+1}.json`);
 await run(`test-${index+1}`,'pnpm',['exec','vitest','run',file,'--exclude','dist/**','--pool=forks','--no-file-parallelism',`--maxWorkers=${workers}`,'--testTimeout=30000','--hookTimeout=30000','--reporter=json',`--outputFile=${resultPath}`]);
 const result=JSON.parse(await readFile(resultPath,'utf8'));
 if(!result.success||result.numFailedTests||result.testResults.length!==1||result.testResults[0].name!==file)throw new Error('Incomplete or mismatched test file result');
 counts.tests+=result.numTotalTests;counts.passed+=result.numPassedTests;counts.failed+=result.numFailedTests;counts.pending+=result.numPendingTests;
 await writeFile(join(output,'test-progress.json'),JSON.stringify({...counts,completedFiles:index+1}),{mode:0o600});
}
await run('postgres15-restore-drill', process.execPath, ['--import', require.resolve('tsx'), 'scripts/restore-drill.ts']);
await writeFile(join(output, 'target-postgres.json'), `${JSON.stringify({ testedAt: new Date().toISOString(), releaseId: source.releaseId,
  validatorSha256:createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
  serverVersion: server.version, serverVersionNum: server.version_num, verifiedTls: true, cipher: server.cipher,
  refusedPlaintext: true, refusedUntrustedCA: true, managedRuntimeTls: true, fullSuite: 'passed', counts, encryptedRestoreDrill: 'passed',
  realMail: 'not tested', realModel: 'not called', publicDeployment: 'not performed' }, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ targetPostgres: server.version, verifiedTls: true, fullSuite: 'passed', counts, restoreDrill: 'passed', evidence: output }));
