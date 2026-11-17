#!/usr/bin/env bash
# Creates only a NEW dedicated cluster/config. Does not install packages,
# start services, change nginx, create database roles, or touch existing clusters.
set -euo pipefail
umask 077
[[ "${1:-}" == --new-independent-cluster ]] || { echo 'Usage: prepare-postgres.sh --new-independent-cluster /absolute/pg/bin' >&2; exit 1; }
pg_bin="${2:?PostgreSQL 15 bin directory required}"
[[ "$EUID" == 0 && "$pg_bin" == /* && -x "$pg_bin/initdb" && -x "$pg_bin/postgres" ]] || exit 1
[[ "$("$pg_bin/postgres" --version)" == *' 15.19'* ]] || { echo 'Expected target PostgreSQL 15.19' >&2; exit 1; }
data_dir=/var/lib/planplan-web-postgres/15/data
tls_dir=/etc/planplan-web-postgres/tls
ca_dir=/etc/planplan-web-postgres/ca
[[ ! -e "$data_dir" && ! -e "$tls_dir" && ! -e "$ca_dir" ]] || { echo 'Refusing existing cluster or TLS directory' >&2; exit 1; }
if ss -ltnH | awk '{print $4}' | grep -Eq '(^|:)55432$'; then echo 'Port 55432 is already used' >&2; exit 1; fi
getent passwd postgres >/dev/null
script_dir="$(cd "$(dirname "$0")" && pwd)"
install -d -o postgres -g postgres -m 0700 /var/lib/planplan-web-postgres /var/lib/planplan-web-postgres/15
install -d -o root -g postgres -m 0750 /etc/planplan-web-postgres "$tls_dir"
install -d -o root -g root -m 0700 "$ca_dir"
runuser -u postgres -- "$pg_bin/initdb" -D "$data_dir" --auth-local=peer --auth-host=scram-sha-256 --encoding=UTF8 --locale=C
openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 3650 -subj '/CN=PlanPlan Web Local Database CA' \
  -keyout "$ca_dir/ca.key" -out "$ca_dir/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:3072 -sha256 -nodes -subj '/CN=localhost' \
  -keyout "$tls_dir/server.key" -out "$tls_dir/server.csr" >/dev/null 2>&1
cat > "$tls_dir/server.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1
EOF
openssl x509 -req -in "$tls_dir/server.csr" -CA "$ca_dir/ca.crt" -CAkey "$ca_dir/ca.key" \
  -CAcreateserial -out "$tls_dir/server.crt" -days 397 -sha256 -extfile "$tls_dir/server.ext" >/dev/null 2>&1
chown postgres:postgres "$tls_dir/server.key" "$tls_dir/server.crt"
chmod 0600 "$tls_dir/server.key"
chmod 0644 "$tls_dir/server.crt" "$ca_dir/ca.crt"
cat "$script_dir/postgresql.conf.append" >> "$data_dir/postgresql.conf"
install -o postgres -g postgres -m 0600 "$script_dir/pg_hba.conf" "$data_dir/pg_hba.conf"
echo 'New independent cluster prepared, not started. Render its unit and create isolated roles before use.'
