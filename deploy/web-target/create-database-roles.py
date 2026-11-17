#!/usr/bin/env python3
"""Create NEW dedicated roles/databases; credentials go only to root-only files.

Requires the prepared independent cluster to be running. No existing role,
database, configuration or password is modified. No network/admin credential.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess

p = argparse.ArgumentParser()
p.add_argument('--new-independent-databases', action='store_true', required=True)
p.add_argument('--pg-bin', required=True, type=Path)
p.add_argument('--output', required=True, type=Path)
a = p.parse_args()
if os.geteuid() != 0 or not a.pg_bin.is_absolute() or a.output.exists():
    raise SystemExit('Root, an absolute PG bin, and a new credential output directory are required')
os.umask(0o077)
cmd = ['runuser', '-u', 'postgres', '--', str(a.pg_bin / 'psql'), '-X', '-qAt',
       '-h', '/run/planplan-web-postgres', '-p', '55432', '-U', 'postgres', '-d', 'postgres',
       '-v', 'ON_ERROR_STOP=1']
def sql(text):
    r = subprocess.run(cmd, input=text, text=True, capture_output=True)
    if r.returncode:
        raise SystemExit('Dedicated PostgreSQL setup failed; no database error or credential is printed')
    return r.stdout.strip()

if sql("SELECT current_setting('server_version_num')") != '150019':
    raise SystemExit('PostgreSQL 15.19 required')
if sql("SELECT count(*) FROM pg_roles WHERE rolname IN ('planplan_web_owner','planplan_web_app','planplan_web_test')") != '0':
    raise SystemExit('Dedicated roles already exist; refusing changes')
if sql("SELECT count(*) FROM pg_database WHERE datname IN ('planplan_web','planplan_web_test')") != '0':
    raise SystemExit('Dedicated databases already exist; refusing changes')
passwords = {name: secrets.token_hex(32) for name in ['planplan_web_owner', 'planplan_web_app', 'planplan_web_test']}
# Persist first so even a partial setup never loses the generated credentials.
a.output.mkdir(mode=0o700)
def write(name, value):
    path = a.output / name
    path.write_text(json.dumps(value, indent=2) + '\n')
    path.chmod(0o600)
def url(role, db):
    return f'postgres://{role}:{passwords[role]}@127.0.0.1:55432/{db}'
write('owner-db.json', {'DATABASE_URL': url('planplan_web_owner', 'planplan_web')})
write('app-db.json', {'DATABASE_URL': url('planplan_web_app', 'planplan_web')})
write('test-db.json', {'TEST_DATABASE_URL': url('planplan_web_test', 'planplan_web_test'),
                       'PG_CA_FILE': '/etc/planplan-web/pg-ca.pem'})
sql('BEGIN;\n' + '\n'.join(
    f"CREATE ROLE {role} LOGIN NOSUPERUSER NOCREATEROLE {'CREATEDB' if role == 'planplan_web_test' else 'NOCREATEDB'} NOREPLICATION PASSWORD '{password}';"
    for role, password in passwords.items()) + '\nCOMMIT;')
sql('CREATE DATABASE planplan_web OWNER planplan_web_owner;')
sql('CREATE DATABASE planplan_web_test OWNER planplan_web_test;')
sql('REVOKE ALL ON DATABASE planplan_web FROM PUBLIC; GRANT CONNECT ON DATABASE planplan_web TO planplan_web_app; '
    'REVOKE ALL ON DATABASE planplan_web_test FROM PUBLIC;')
print(json.dumps({'rolesCreated': 3, 'databasesCreated': 2, 'credentialsWritten': 3, 'valuesPrinted': False}))
