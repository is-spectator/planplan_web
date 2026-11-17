import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => { for (const d of roots.splice(0)) rmSync(d, { recursive: true }); });
const old = `ghcr.io/test/planplan-server@sha256:${'a'.repeat(64)}`;
const image = `ghcr.io/test/planplan-server@sha256:${'b'.repeat(64)}`;
function fixture(failure = '') {
  const root = mkdtempSync(join(tmpdir(), 'planplan-release-test-')); roots.push(root);
  const config = join(root, 'config'), state = join(root, 'state'), bin = join(root, 'bin'), upstream = join(root, 'upstream');
  for (const p of [config, join(config, 'secrets'), state, bin]) mkdirSync(p, { recursive: true });
  writeFileSync(join(config, 'deploy.env'), 'PUBLIC_DOMAIN=beta.example.com\nIMAGE_REPOSITORY=ghcr.io/test/planplan-server\n');
  writeFileSync(join(config, 'runtime.env'), 'DEPLOYMENT_ENV=beta\n');
  writeFileSync(join(config, 'secrets/runtime.json'), '{}');
  writeFileSync(join(state, 'current'), `blue ${old}\n`);
  writeFileSync(join(state, 'previous'), `green ${image}\n`);
  writeFileSync(upstream, 'reverse_proxy 127.0.0.1:18787\n');
  const mock = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const cmd = path.basename(process.argv[1]), args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({cmd,args})+'\\n');
if (cmd === 'docker' && args.includes('migrate-check') && process.env.MOCK_FAILURE === 'schema') process.exit(1);
if (cmd === 'curl') {
 const url = args.at(-1);
 if (process.env.MOCK_FAILURE === 'candidate' && url.startsWith('http:')) process.exit(1);
 if (process.env.MOCK_FAILURE === 'public' && url.startsWith('https:')) process.exit(1);
 console.log(JSON.stringify({ok:true,release:process.env.MOCK_IMAGE}));
}
if (cmd === 'jq') { let body=''; process.stdin.on('data',d=>body+=d); process.stdin.on('end',()=>{try {const v=JSON.parse(body);process.exit(v.ok && v.release===args[3]?0:1)}catch{process.exit(1)}}); }
`;
  for (const command of ['docker', 'curl', 'caddy', 'sleep', 'flock', 'jq']) writeFileSync(join(bin, command), mock, { mode: 0o755 });
  const run = (command: 'deploy' | 'rollback' = 'deploy') => spawnSync('bash', [resolve('../deploy/beta/release.sh'), command, ...(command === 'deploy' ? [image] : [])], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PLANPLAN_CONFIG_DIR: config, PLANPLAN_STATE_DIR: state,
      PLANPLAN_UPSTREAM: upstream, PLANPLAN_CADDY_CONFIG: join(root, 'Caddyfile'), MOCK_LOG: join(root, 'calls'), MOCK_FAILURE: failure, MOCK_IMAGE: image }, encoding: 'utf8', timeout: 20_000,
  });
  return { run, current: () => readFileSync(join(state, 'current'), 'utf8'), upstream: () => readFileSync(upstream, 'utf8'),
    calls: () => readFileSync(join(root, 'calls'), 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s) as { cmd: string; args: string[] }) };
}
it('switches only after schema and local/public health pass, preserving the previous digest', () => {
  const f = fixture(); const r = f.run(); expect(r.status, r.stderr).toBe(0);
  expect(f.current()).toBe(`green ${image}\n`); expect(f.upstream()).toContain('18788');
  const calls = f.calls();
  expect(calls.findIndex((c) => c.args.includes('migrate-check'))).toBeLessThan(calls.findIndex((c) => c.args.includes('serve')));
  expect(calls.at(-1)?.args).toContain('planplan-beta-blue');
});
it.each(['schema', 'candidate', 'public'])('failed %s leaves the current digest and previous route intact', (failure) => {
  const f = fixture(failure); const r = f.run(); expect(r.status).not.toBe(0);
  expect(f.current()).toBe(`blue ${old}\n`); expect(f.upstream()).toContain('18787');
  expect(f.calls().some((c) => c.cmd === 'docker' && c.args[0] === 'stop')).toBe(false);
}, 20_000);
it('rollback also fails closed on incompatible schema before starting a candidate', () => {
  const f = fixture('schema'); expect(f.run('rollback').status).not.toBe(0);
  expect(f.calls().some((c) => c.args.includes('serve'))).toBe(false);
  expect(f.current()).toBe(`blue ${old}\n`);
});
