#!/usr/bin/env bash
# fake-ctl.sh — stand-in for cxw-ctl during `chaos.sh --local`.
# Records every call to $FAKE_CTL_LOG and, for `restart bridge` / `restart brain`,
# respawns the matching stub from stub-services.mjs. Always exits 0.
#
# Env (exported by chaos.sh): STUB_DIR, FAKE_CTL_LOG, NODE_BIN, STUB_*_PORT, STUB_LOG,
# STUB_GOOGLE_FAIL.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
STUB_DIR="${STUB_DIR:-${TMPDIR:-/tmp}}"
FAKE_CTL_LOG="${FAKE_CTL_LOG:-$STUB_DIR/fake-ctl.log}"
NODE_BIN="${NODE_BIN:-node}"

echo "$*" >> "$FAKE_CTL_LOG"

respawn() {
  local name="$1"
  local pidfile="$STUB_DIR/$name.pid"
  local old
  if [ -f "$pidfile" ]; then
    old=$(cat "$pidfile" 2>/dev/null || echo "")
    if [ -n "$old" ]; then kill "$old" 2>/dev/null || true; fi
    sleep 0.3
  fi
  "$NODE_BIN" "$HERE/stub-services.mjs" --only "$name" > "$STUB_DIR/$name.out" 2>&1 &
  echo $! > "$pidfile"
  # give the listener a moment to bind
  sleep 0.6
}

case "${1:-} ${2:-}" in
  "restart bridge" | "start bridge")
    respawn bridge
    ;;
  "restart brain" | "start brain")
    respawn brain
    ;;
  "stop bridge")
    if [ -f "$STUB_DIR/bridge.pid" ]; then kill "$(cat "$STUB_DIR/bridge.pid")" 2>/dev/null || true; fi
    ;;
  "stop brain")
    if [ -f "$STUB_DIR/brain.pid" ]; then kill "$(cat "$STUB_DIR/brain.pid")" 2>/dev/null || true; fi
    ;;
  *)
    # scheduler/sentinel/backup/vacuum-journal: logged only, nothing to do locally
    ;;
esac

exit 0
