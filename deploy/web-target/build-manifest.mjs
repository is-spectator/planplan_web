import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const base = resolve(process.argv[2]);
const source = JSON.parse(await readFile(join(base, 'source-manifest.json'), 'utf8'));
const hashes = {};
async function walk(dir) {
  for (const name of (await readdir(join(base, dir))).sort()) {
    const file = `${dir}/${name}`, stat = await lstat(join(base, file));
    if (stat.isSymbolicLink()) throw new Error('Build symlink refused');
    if (stat.isDirectory()) await walk(file);
    else if (stat.isFile()) hashes[file] = createHash('sha256').update(await readFile(join(base, file))).digest('hex');
  }
}
await walk('server/dist'); await walk('web');
const sorted = Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
const report = { format: 1, releaseId: source.releaseId, platform: process.platform, arch: process.arch,
  node: process.version, builtAt: new Date().toISOString(),
  buildSha256: createHash('sha256').update(JSON.stringify(sorted)).digest('hex'), files: sorted,
  validation: { targetPostgres: 'pending', managedTls: 'pending', mail: 'pending', legal: 'pending', publicHttps: 'pending' } };
await writeFile(join(base, 'build-manifest.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ releaseId: report.releaseId, buildSha256: report.buildSha256, files: Object.keys(sorted).length }));
