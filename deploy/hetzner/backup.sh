#!/usr/bin/env bash
# backup.sh — restic backup of ClaudeXWhatsapp state to a Hetzner Storage Box.
# Runs as root from cxw-backup.timer (every 6 h). Safe to run by hand.
#
# Requires /srv/cxw/restic.env with RESTIC_REPOSITORY and RESTIC_PASSWORD (see restic.env.example)
# and an SSH key for the Storage Box in root's ~/.ssh (Host storagebox, Port 23).
#
# Backs up: /srv/cxw/data (Baileys session, SQLite, media), /srv/cxw/state,
#           /srv/cxw/*.env (encrypted at rest by restic), and a consistent
#           `.backup` copy of every SQLite database found under data/.
set -euo pipefail

CXW_ROOT=/srv/cxw
ENV_FILE="$CXW_ROOT/restic.env"
STAGE="$CXW_ROOT/backups/stage"
STAMP="$CXW_ROOT/state/last-backup"
KEEP_WITHIN="${RESTIC_KEEP_WITHIN:-30d}"

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
if [[ -z "${RESTIC_REPOSITORY:-}" ]]; then
  [[ -r "$ENV_FILE" ]] || { echo "missing $ENV_FILE" >&2; exit 1; }
  set -a; . "$ENV_FILE"; set +a
fi
[[ -n "${RESTIC_REPOSITORY:-}" ]] || { echo "RESTIC_REPOSITORY not set" >&2; exit 1; }
[[ -n "${RESTIC_PASSWORD:-}${RESTIC_PASSWORD_FILE:-}" ]] || { echo "RESTIC_PASSWORD not set" >&2; exit 1; }
case "$RESTIC_REPOSITORY" in *CHANGEME*|*"<"*) echo "RESTIC_REPOSITORY still a placeholder" >&2; exit 1;; esac

echo "backup: repository $RESTIC_REPOSITORY"

# init once
if ! restic cat config >/dev/null 2>&1; then
  echo "backup: initialising repository"
  restic init
fi

# consistent SQLite copies
rm -rf "$STAGE"; mkdir -p "$STAGE"; chmod 0700 "$STAGE"
while IFS= read -r -d '' db; do
  rel=${db#"$CXW_ROOT/data/"}
  mkdir -p "$STAGE/$(dirname "$rel")"
  sqlite3 "$db" ".backup '$STAGE/$rel'"
  echo "backup: staged sqlite $rel"
done < <(find "$CXW_ROOT/data" -type f -name '*.sqlite' -print0 2>/dev/null || true)

paths=("$CXW_ROOT/data" "$CXW_ROOT/state" "$STAGE")
for f in "$CXW_ROOT"/*.env; do [[ -f "$f" ]] && paths+=("$f"); done

restic backup \
  --tag cxw --host cxw \
  --exclude '*.sqlite-wal' --exclude '*.sqlite-shm' \
  --exclude "$CXW_ROOT/data/media/**/tmp" \
  "${paths[@]}"

restic forget --tag cxw --keep-within "$KEEP_WITHIN" --prune --quiet
restic check --read-data-subset=5% --quiet || echo "backup: restic check reported issues" >&2

date -u +%Y-%m-%dT%H:%M:%SZ > "$STAMP"
rm -rf "$STAGE"
echo "backup: done $(cat "$STAMP")"
