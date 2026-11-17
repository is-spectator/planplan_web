#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /opt/planplan-web/current/server
case "${1:-}" in
  backup) args=(backup /var/lib/planplan-web-backups/database) ;;
  ledger) args=() ;;
  prune) args=(prune /var/lib/planplan-web-backups/database) ;;
  *) echo 'Use backup, ledger or prune' >&2; exit 1 ;;
esac
exec 9>/var/lib/planplan-web-backups/maintenance.lock
flock -w 60 9
if [[ "$1" == ledger ]]; then
  # The exporter refuses existing files. Publish a complete new ledger atomically
  # so periodic refreshes work and a failed export preserves the previous copy.
  ledger_directory=$(mktemp -d /var/lib/planplan-web-backups/.ledger.XXXXXXXX)
  trap 'rm -rf -- "$ledger_directory"' EXIT
  /usr/bin/node-24 --env-file=/etc/planplan-web/backup.env dist/scripts/maintenance.js ledger "$ledger_directory/deletions.json"
  mv -f -- "$ledger_directory/deletions.json" /var/lib/planplan-web-backups/deletions.json
  exit 0
fi
exec /usr/bin/node-24 --env-file=/etc/planplan-web/backup.env dist/scripts/maintenance.js "${args[@]}"
