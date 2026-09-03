#!/usr/bin/env bash
# monitor.sh — health checks without an LLM. Runs every 10 min from cxw-monitor.timer.
# Writes /srv/cxw/state/monitor.status (ok|fail + reasons), logs to the journal, and
# calls $CXW_ALERT_CMD with the message when something is wrong (Phase 7 wires WhatsApp/email).
set -uo pipefail

CXW_ROOT=/srv/cxw
STATUS_FILE="$CXW_ROOT/state/monitor.status"
BRIDGE_HOST="${BRIDGE_HOST:-127.0.0.1}"
BRIDGE_PORT="${BRIDGE_PORT:-7411}"
DISK_LIMIT="${CXW_DISK_LIMIT_PCT:-85}"
BACKUP_MAX_AGE_H="${CXW_BACKUP_MAX_AGE_H:-8}"

problems=()
note() { problems+=("$1"); }

# services
for s in cxw-bridge cxw-brain cxw-scheduler; do
  if systemctl is-enabled --quiet "$s" 2>/dev/null; then
    systemctl is-active --quiet "$s" || note "service $s is not active"
  fi
done
systemctl is-active --quiet cxw-backup.timer  || note "cxw-backup.timer not active"

# disk
use=$(df --output=pcent "$CXW_ROOT" 2>/dev/null | tail -n1 | tr -dc '0-9')
[[ -n "$use" && "$use" -lt "$DISK_LIMIT" ]] || note "disk usage ${use:-?}% >= ${DISK_LIMIT}%"

# tailscale
if command -v tailscale >/dev/null 2>&1; then
  tailscale status >/dev/null 2>&1 || note "tailscale not connected"
fi
ufw status 2>/dev/null | grep -q '^Status: active' || note "ufw not active"

# last backup age
stamp="$CXW_ROOT/state/last-backup"
if [[ -f "$stamp" ]]; then
  last=$(date -d "$(cat "$stamp")" +%s 2>/dev/null || echo 0)
  age_h=$(( ( $(date +%s) - last ) / 3600 ))
  [[ "$age_h" -le "$BACKUP_MAX_AGE_H" ]] || note "last backup ${age_h}h ago"
else
  note "no backup has completed yet"
fi

# bridge health endpoint (available from Phase 1; skipped if the service is not enabled)
if systemctl is-enabled --quiet cxw-bridge 2>/dev/null && systemctl is-active --quiet cxw-bridge; then
  if ! curl -fsS -m 5 "http://${BRIDGE_HOST}:${BRIDGE_PORT}/health" >/dev/null 2>&1; then
    note "bridge /health not responding on ${BRIDGE_HOST}:${BRIDGE_PORT}"
  fi
fi

mkdir -p "$(dirname "$STATUS_FILE")"
if [[ ${#problems[@]} -eq 0 ]]; then
  echo "ok $(date -u +%FT%TZ)" > "$STATUS_FILE"
  logger -t cxw-monitor "ok"
  exit 0
fi

msg="cxw monitor: ${#problems[@]} problem(s): $(printf '%s; ' "${problems[@]}")"
{ echo "fail $(date -u +%FT%TZ)"; printf '%s\n' "${problems[@]}"; } > "$STATUS_FILE"
logger -t cxw-monitor -p user.err "$msg"
echo "$msg" >&2
if [[ -n "${CXW_ALERT_CMD:-}" ]]; then
  "$CXW_ALERT_CMD" "$msg" || logger -t cxw-monitor -p user.err "alert command failed"
fi
exit 1
