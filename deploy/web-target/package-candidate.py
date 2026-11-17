#!/usr/bin/env python3
"""Snapshot the authorized, possibly uncommitted source; never read dotenv/data.

Creates a private reviewable source archive. Native dependencies are installed
and compiled on Linux by build-candidate.sh, not copied from a developer Mac.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tarfile
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--frontend', required=True, type=Path)
parser.add_argument('--server', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
os.umask(0o077)
dest = args.output.resolve()
dest.mkdir(parents=True, exist_ok=True, mode=0o700)

selected = [
    ('frontend', args.frontend.resolve(), ['package.json', 'package-lock.json', 'index.html',
        'vite.config.ts', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json',
        'eslint.config.js', 'src', 'public']),
    ('server', args.server.resolve(), ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'vitest.config.ts',
        'src', 'scripts', 'test', 'evals', 'perf']),
    ('deploy', Path(__file__).resolve().parent, ['.']),
    # Existing backend tests exercise these controllers using synthetic commands.
    # They are test inputs, never deployment entry points for this web target.
    ('deploy', args.server.resolve().parent / 'deploy', ['beta/release.sh', 'database-backup.sh', 'deletion-ledger.sh']),
]
excluded = {'node_modules', 'dist', '.git', '.data', '__pycache__', '.DS_Store',
            'test-results', 'playwright-report', 'coverage'}
def excluded_path(path):
    return any(p in excluded or p.startswith('.env') or p.endswith(('.pem', '.key', '.p12'))
               or p.endswith('.tsbuildinfo') for p in path.parts)

with tempfile.TemporaryDirectory(prefix='planplan-web-candidate-', dir=dest) as temporary:
    stage = Path(temporary) / 'candidate'
    stage.mkdir()
    files = {}
    for prefix, base, entries in selected:
        for entry in entries:
            item = base / entry
            if not item.exists():
                if entry == 'public':
                    continue
                raise SystemExit(f'Missing source entry: {prefix}/{entry}')
            candidates = sorted(item.rglob('*')) if item.is_dir() else [item]
            for source in candidates:
                relative = source.relative_to(base)
                if excluded_path(relative):
                    continue
                # Evaluation checkpoints are generated evidence and may still be
                # updating. They are not runtime inputs or part of the release.
                if prefix == 'server' and relative.parts[:2] == ('evals', 'reports'):
                    continue
                if source.is_symlink():
                    raise SystemExit(f'Symlink not allowed in candidate: {prefix}/{relative}')
                if not source.is_file():
                    continue
                data = source.read_bytes()
                # This detects actual OpenRouter keys, not placeholder variable names.
                import re
                if re.search(rb'sk-or-v1-[0-9a-fA-F]{64}', data):
                    raise SystemExit('Potential live provider credential detected; archive not created')
                target = stage / prefix / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                target.chmod(0o700 if source.stat().st_mode & 0o111 else 0o600)
                files[f'{prefix}/{relative.as_posix()}'] = hashlib.sha256(data).hexdigest()
    canonical = json.dumps(files, sort_keys=True, separators=(',', ':')).encode()
    source_hash = hashlib.sha256(canonical).hexdigest()
    manifest = {'format': 1, 'releaseId': f'source-sha256:{source_hash}',
                'identity': 'exact source snapshot, not a Git commit claim',
                'sourceSha256': source_hash, 'files': files}
    (stage / 'source-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
    archive = dest / f'planplan-web-{source_hash[:16]}.tar.gz'
    if archive.exists():
        raise SystemExit('Candidate archive already exists; choose an empty output directory')
    with tarfile.open(archive, 'w:gz') as tf:
        tf.add(stage, arcname='candidate')
    archive.chmod(0o600)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (dest / f'{archive.name}.sha256').write_text(f'{digest}  {archive.name}\n')
    print(json.dumps({'archive': str(archive), 'sha256': digest, 'releaseId': manifest['releaseId'], 'files': len(files)}))
