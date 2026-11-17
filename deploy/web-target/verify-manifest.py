#!/usr/bin/env python3
import hashlib
import json
from pathlib import Path
import sys

base = Path(sys.argv[1]).resolve()
manifest = json.loads((base / 'source-manifest.json').read_text())
files = manifest['files']
assert manifest['format'] == 1 and isinstance(files, dict)
canonical = json.dumps(files, sort_keys=True, separators=(',', ':')).encode()
assert hashlib.sha256(canonical).hexdigest() == manifest['sourceSha256'], 'Manifest digest mismatch'
assert manifest['releaseId'] == 'source-sha256:' + manifest['sourceSha256']
for name, expected in files.items():
    relative = Path(name)
    assert not relative.is_absolute() and '..' not in relative.parts, 'Invalid source path'
    path = base / relative
    assert path.is_file() and not path.is_symlink(), 'Missing or unsafe source file'
    assert hashlib.sha256(path.read_bytes()).hexdigest() == expected, 'Source content changed'
print(json.dumps({'sourceVerified': True, 'files': len(files), 'releaseId': manifest['releaseId']}))
