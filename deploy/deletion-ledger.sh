#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${PLANPLAN_SERVER_DIR:?Set compiled server directory}"
: "${BACKUP_DIRECTORY:?Set private spool directory}"
: "${DELETION_OSS_PREFIX:?Set dedicated deletion-ledger prefix}"
: "${OSSUTIL_CONFIG_FILE:?Set private ossutil config under /etc/planplan}"
case "$DELETION_OSS_PREFIX" in oss://*/*) ;; *) exit 2 ;; esac
mkdir -p "$BACKUP_DIRECTORY"
cd "$BACKUP_DIRECTORY"
# A failed cleanup must not suppress the independent recovery deletion ledger.
cleanup_status=0
node "$PLANPLAN_SERVER_DIR/dist/scripts/maintenance.js" retry-deletions || cleanup_status=$?
PLANPLAN_LEDGER_FILE=$(mktemp "$BACKUP_DIRECTORY/.ledger-XXXXXXXX.json")
rm "$PLANPLAN_LEDGER_FILE"
trap 'rm -f "$PLANPLAN_LEDGER_FILE"' EXIT
node "$PLANPLAN_SERVER_DIR/dist/scripts/maintenance.js" ledger "$PLANPLAN_LEDGER_FILE"
ossutil cp -f --config-file "$OSSUTIL_CONFIG_FILE" "$PLANPLAN_LEDGER_FILE" "${DELETION_OSS_PREFIX%/}/latest.json" >/dev/null
if (( cleanup_status != 0 )); then
  printf 'deletion_cleanup_failed; independent ledger uploaded\n' >&2
fi
exit "$cleanup_status"
