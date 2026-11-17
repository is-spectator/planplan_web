#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${PLANPLAN_SERVER_DIR:?Set compiled server directory}"
: "${BACKUP_DIRECTORY:?Set private backup spool directory}"
: "${BACKUP_OSS_PREFIX:?Set oss://bucket/beta-database prefix in another mainland region}"
: "${DELETION_OSS_PREFIX:?Set separate oss://bucket/beta-deletions prefix}"
: "${OSSUTIL_CONFIG_FILE:?Set private ossutil config under /etc/planplan}"
case "$BACKUP_OSS_PREFIX" in oss://*/*) ;; *) exit 2 ;; esac
case "$DELETION_OSS_PREFIX" in oss://*/*) ;; *) exit 2 ;; esac

mkdir -p "$BACKUP_DIRECTORY"
chmod 700 "$BACKUP_DIRECTORY"
cd "$BACKUP_DIRECTORY"
# Local retention must run even when the database or deletion cleanup is down.
node "$PLANPLAN_SERVER_DIR/dist/scripts/maintenance.js" prune "$BACKUP_DIRECTORY"
node "$PLANPLAN_SERVER_DIR/dist/scripts/maintenance.js" retry-deletions
PLANPLAN_BACKUP_RESULT=$(node "$PLANPLAN_SERVER_DIR/dist/scripts/maintenance.js" backup "$BACKUP_DIRECTORY")
PLANPLAN_NEW_BACKUP=$(printf '%s' "$PLANPLAN_BACKUP_RESULT" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.parse(s).backup))')

# Upload completed backups only. OSS credentials come from the configured RAM role/profile.
# Restrict this identity to these prefixes; set the remote lifecycle before enabling the timer.
ossutil cp -r --config-file "$OSSUTIL_CONFIG_FILE" "$PLANPLAN_NEW_BACKUP/" "${BACKUP_OSS_PREFIX%/}/$(basename "$PLANPLAN_NEW_BACKUP")/" >/dev/null

PLANPLAN_LEDGER_FILE=$(mktemp "$BACKUP_DIRECTORY/.ledger-XXXXXXXX.json")
rm "$PLANPLAN_LEDGER_FILE"
trap 'rm -f "$PLANPLAN_LEDGER_FILE"' EXIT
node "$PLANPLAN_SERVER_DIR/dist/scripts/maintenance.js" ledger "$PLANPLAN_LEDGER_FILE"
ossutil cp -f --config-file "$OSSUTIL_CONFIG_FILE" "$PLANPLAN_LEDGER_FILE" "${DELETION_OSS_PREFIX%/}/latest.json" >/dev/null
node "$PLANPLAN_SERVER_DIR/dist/scripts/maintenance.js" prune "$BACKUP_DIRECTORY"
