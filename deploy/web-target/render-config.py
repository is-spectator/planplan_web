#!/usr/bin/env python3
"""Render candidates only; never writes to /etc or reloads services."""
import argparse
import os
from pathlib import Path
import re

p = argparse.ArgumentParser()
p.add_argument('--domain', required=True)
p.add_argument('--node-bin', required=True)
p.add_argument('--pg-bin', required=True)
p.add_argument('--cert-chain', required=True)
p.add_argument('--cert-key', required=True)
p.add_argument('--trusted-proxy-include', help='Optional already reviewed server-scoped real-IP include')
p.add_argument('--output', required=True, type=Path)
a = p.parse_args()
if not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?', a.domain) or '.' not in a.domain or '..' in a.domain:
    raise SystemExit('Real DNS hostname required')
if a.domain.endswith('.example'):
    raise SystemExit('Do not install a placeholder domain')
for path in [a.node_bin, a.pg_bin, a.cert_chain, a.cert_key]+([a.trusted_proxy_include] if a.trusted_proxy_include else []):
    if not re.fullmatch(r'/[a-zA-Z0-9_./+-]+', path) or '..' in Path(path).parts:
        raise SystemExit('Absolute configuration path required')
os.umask(0o077)
a.output.mkdir(parents=True, exist_ok=True, mode=0o700)
values = {'@DOMAIN@': a.domain, '@NODE_BIN@': a.node_bin, '@PG_BIN@': a.pg_bin,
          '@CERT_CHAIN@': a.cert_chain, '@CERT_KEY@': a.cert_key,
          '@TRUSTED_PROXY_INCLUDE@': f'include {a.trusted_proxy_include};' if a.trusted_proxy_include else '# Direct TLS traffic; no proxy IP headers trusted'}
base = Path(__file__).resolve().parent
for name in ['nginx.conf', 'planplan-web.service', 'planplan-web-postgres.service']:
    text = (base / (name + '.in')).read_text()
    for key, value in values.items():
        text = text.replace(key, value)
    target = a.output / name
    if target.exists():
        raise SystemExit('Refusing to overwrite existing rendered configuration')
    target.write_text(text)
print('Rendered 3 configuration files; no services or system files changed')
