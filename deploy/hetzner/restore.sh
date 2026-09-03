#!/usr/bin/env bash
# restore.sh — restore a restic snapshot.
#
#   restore.sh                      # restore `latest` into /srv/cxw/backups/restore-<ts>/ (test restore)
#   restore.sh <snapshot-id>        # same, chosen snapshot
#   restore.sh latest --in-place    # stop services, restore over /srv/cxw/{data,state}, start services
#   restore.sh --list               # list snapshots
set -euo pipefail

CXW_ROOT=/srv/cxw
ENV_FILE="$CXW_ROOT/restic.env"
SNAP="${1:-latest}"
MODE="${2:-}"

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
if [[ -z "${RESTIC_REPOSITORY:-}" ]]; then
  [[ -r "$ENV_FILE" ]] || { echo "missing $ENV_FILE" >&2; exit 1; }
  set -a; . "$ENV_FILE"; set +a
fi

if [[ "$SNAP" == "--list" ]]; then
  restic snapshots --tag cxw
  exit 0
fi

if [[ "$MODE" == "--in-place" ]]; then
  echo "restore: IN PLACE from snapshot $SNAP — services will be stopped"
  read -r -p "type RESTORE to continue: " ans
  [[ "$ans" == "RESTORE" ]] || { echo "aborted"; exit 1; }
  systemctl stop cxw-scheduler cxw-brain cxw-bridge || true
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  for d in data state; do
    [[ -d "$CXW_ROOT/$d" ]] && mv "$CXW_ROOT/$d" "$CXW_ROOT/backups/pre-restore-$ts-$d"
  done
  restic restore "$SNAP" --target / --include "$CXW_ROOT/data" --include "$CXW_ROOT/state"
  chown -R cxw:cxw "$CXW_ROOT/data" "$CXW_ROOT/state"
  chmod 0700 "$CXW_ROOT/data" "$CXW_ROOT/state"
  systemctl start cxw-bridge cxw-brain cxw-scheduler
  echo "restore: done; previous data kept in $CXW_ROOT/backups/pre-restore-$ts-*"
  exit 0
fi

target="$CXW_ROOT/backups/restore-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$target"; chmod 0700 "$target"
restic restore "$SNAP" --target "$target"
echo "restore: snapshot $SNAP restored under $target"
echo "restore: contents:"
find "$target" -maxdepth 4 -type d | sed "s#^$target#  .#" | head -n 40
if [[ -n "$(find "$target" -name '*.sqlite' -print -quit 2>/dev/null)" ]]; then
  find "$target" -name '*.sqlite' -print0 | while IFS= read -r -d '' db; do
    printf 'restore: sqlite %s integrity: ' "${db#"$target"}"
    sqlite3 "$db" 'PRAGMA integrity_check;' | head -n1
  done
fi
echo "restore: compare with live data:  diff -rq $target$CXW_ROOT/data $CXW_ROOT/data | head"
echo "restore: clean up when satisfied:  rm -rf $target"
