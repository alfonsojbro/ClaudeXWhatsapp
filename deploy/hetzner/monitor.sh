#!/usr/bin/env bash
# monitor.sh — Phase 7 health monitor. Runs as user `cxw` every 10 min from cxw-monitor.timer.
#
# The checks themselves live in `cxw-ops health`; this script drives it, applies a restart
# budget, performs the allowlisted self-heals through cxw-ctl, re-checks, and records
# $CXW_STATE_DIR/monitor.status. It keeps the Phase 0 host checks (systemd units, tailscale,
# ufw) when those tools exist. It ALWAYS exits 0 so the timer never goes into a failed state.
#
# Portable to bash 3.2 (macOS) and bash 5 (Ubuntu): no mapfile, no declare -A, no ${var,,},
# no `date -d`, no `df --output`.
set -uo pipefail

CXW_STATE_DIR="${CXW_STATE_DIR:-/srv/cxw/state}"
CXW_OPS_BIN="${CXW_OPS_BIN:-/usr/local/bin/cxw-ops}"
CXW_CTL="${CXW_CTL:-/usr/local/bin/cxw-ctl}"
CXW_SUDO="${CXW_SUDO-sudo -n}"
CXW_HEAL_RECHECK_S="${CXW_HEAL_RECHECK_S:-20}"

STATUS_FILE="$CXW_STATE_DIR/monitor.status"
BUDGET_FILE="$CXW_STATE_DIR/restart-budget.log"
PANIC_FILE="$CXW_STATE_DIR/panic"
BUDGET_MAX=3
BUDGET_WINDOW_S=3600

mkdir -p "$CXW_STATE_DIR" 2>/dev/null || true

tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/cxw-monitor.XXXXXX") || exit 0
trap 'rm -rf "$tmpdir"' EXIT

now_epoch() { date +%s; }
utc_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

log() {
  echo "$*"
  if command -v logger >/dev/null 2>&1; then logger -t cxw-monitor "$*"; fi
}
log_err() {
  echo "$*" >&2
  if command -v logger >/dev/null 2>&1; then logger -t cxw-monitor -p user.err "$*"; fi
}

# Newline-delimited problem list (bash 3.2 chokes on empty arrays under `set -u`).
problems=""
note() {
  problems="${problems}$1
"
}
# Counts the non-blank lines in $problems. `grep -c` exits 1 on no match, so the old
# `|| echo 0` appended a second `0` and every arithmetic test on the result blew up
# (a green box reported `fail`). Never do arithmetic on grep's exit status here.
problem_count() {
  if [ -z "$problems" ]; then
    echo 0
    return 0
  fi
  printf '%s' "$problems" | grep -c '[^[:space:]]' 2>/dev/null | tr -d ' '
}

ctl() {
  # Word splitting on CXW_SUDO is deliberate: it may be "sudo -n" or the empty string.
  # shellcheck disable=SC2086
  $CXW_SUDO "$CXW_CTL" "$@"
}

alert() {
  "$CXW_OPS_BIN" alert-test "$@" || log_err "alert-test failed: $*"
}

# --- restart budget -----------------------------------------------------------------
# $BUDGET_FILE holds plain "<epoch> <action>" lines so awk works on bash 3.2 hosts.
budget_prune() {
  local cutoff keep
  cutoff=$(($(now_epoch) - BUDGET_WINDOW_S))
  [ -f "$BUDGET_FILE" ] || return 0
  keep="$tmpdir/budget"
  awk -v cutoff="$cutoff" '($1 + 0) >= cutoff' "$BUDGET_FILE" > "$keep" 2>/dev/null || return 0
  mv "$keep" "$BUDGET_FILE" 2>/dev/null || true
}

budget_count() {
  local action="$1" cutoff
  cutoff=$(($(now_epoch) - BUDGET_WINDOW_S))
  [ -f "$BUDGET_FILE" ] || {
    echo 0
    return 0
  }
  awk -v cutoff="$cutoff" -v act="$action" '
    {
      e = $1 + 0
      $1 = ""
      sub(/^[ \t]+/, "")
      if (e >= cutoff && $0 == act) n++
    }
    END { print n + 0 }
  ' "$BUDGET_FILE" 2>/dev/null || echo 0
}

budget_record() {
  echo "$(now_epoch) $1" >> "$BUDGET_FILE" 2>/dev/null || true
}

# --- heals --------------------------------------------------------------------------
perform_heal() {
  local action="$1"
  case "$action" in
    "restart bridge")
      log "heal: restart bridge"
      ctl restart bridge || log_err "heal failed: restart bridge"
      ;;
    "restart brain")
      log "heal: restart brain"
      ctl restart brain || log_err "heal failed: restart brain"
      ;;
    "purge --emergency")
      log "heal: purge --emergency"
      "$CXW_OPS_BIN" purge --emergency || log_err "heal failed: purge --emergency"
      ctl vacuum-journal || log_err "heal failed: vacuum-journal"
      ;;
    "backup")
      log "heal: backup"
      ctl backup || log_err "heal failed: backup"
      ;;
    *)
      log_err "unknown heal action, ignored: $action"
      return 1
      ;;
  esac
  return 0
}

# --- 1. run the health checks -------------------------------------------------------
health_out="$tmpdir/health.txt"
: > "$health_out"
if [ -x "$CXW_OPS_BIN" ] || command -v "$CXW_OPS_BIN" > /dev/null 2>&1; then
  "$CXW_OPS_BIN" health > "$health_out" 2> "$tmpdir/health.err"
  health_rc=$?
else
  health_rc=127
  echo "FAIL monitor - cxw-ops not found at $CXW_OPS_BIN" > "$health_out"
fi
cat "$health_out"
if [ -s "$tmpdir/health.err" ]; then cat "$tmpdir/health.err" >&2; fi

if [ "$health_rc" -ne 0 ]; then
  while IFS= read -r line; do
    case "$line" in
      FAIL\ *) note "${line#FAIL }" ;;
    esac
  done < "$health_out"
  if [ "$(problem_count)" -eq 0 ]; then
    note "cxw-ops health exited $health_rc"
  fi
fi

# --- 1b. cost cap ------------------------------------------------------------------
# `costs check` owns the whole cap decision: it writes the pause flag and delivers the
# warn / paused message through the alert chain at most once per month per level. The
# monitor only has to run it. Its exit status never affects this script.
if [ -x "$CXW_OPS_BIN" ] || command -v "$CXW_OPS_BIN" > /dev/null 2>&1; then
  "$CXW_OPS_BIN" costs check || log_err "costs check exited non-zero"
fi

# --- 2. self-heal within budget -----------------------------------------------------
budget_prune
healed=0
heal_list="$tmpdir/heals.txt"
grep '^HEAL ' "$health_out" 2>/dev/null | sed 's/^HEAL //' | sort -u > "$heal_list" || true

while IFS= read -r action; do
  [ -n "$action" ] || continue
  if [ "$action" = "restart brain" ] && [ -e "$PANIC_FILE" ]; then
    log "skipping 'restart brain': panic flag present"
    continue
  fi
  used=$(budget_count "$action")
  if [ "$used" -ge "$BUDGET_MAX" ]; then
    log_err "heal budget exhausted for $action ($used in the last hour)"
    note "heal budget exhausted for $action"
    alert "heal budget exhausted for $action"
    continue
  fi
  budget_record "$action"
  if perform_heal "$action"; then
    healed=1
  fi
done < "$heal_list"

# --- 3. re-check after healing ------------------------------------------------------
if [ "$healed" -eq 1 ]; then
  sleep "$CXW_HEAL_RECHECK_S"
  recheck="$tmpdir/recheck.txt"
  "$CXW_OPS_BIN" health --no-alert > "$recheck" 2>&1
  recheck_rc=$?
  cat "$recheck"
  problems=""
  if [ "$recheck_rc" -eq 0 ]; then
    log "post-heal re-check: all checks ok"
  else
    log_err "post-heal re-check: still failing"
    while IFS= read -r line; do
      case "$line" in
        FAIL\ *) note "${line#FAIL }" ;;
      esac
    done < "$recheck"
    if [ "$(problem_count)" -eq 0 ]; then note "cxw-ops health exited $recheck_rc after heal"; fi
  fi
fi

# --- 4. host checks kept from Phase 0 (only when the tools exist) --------------------
if command -v systemctl > /dev/null 2>&1; then
  for s in cxw-bridge cxw-brain cxw-scheduler cxw-sentinel; do
    if systemctl is-enabled --quiet "$s" 2>/dev/null; then
      systemctl is-active --quiet "$s" 2>/dev/null || note "service $s is not active"
    fi
  done
  for t in cxw-backup.timer cxw-monitor.timer cxw-purge.timer; do
    if systemctl is-enabled --quiet "$t" 2>/dev/null; then
      systemctl is-active --quiet "$t" 2>/dev/null || note "$t not active"
    fi
  done
fi

if command -v tailscale > /dev/null 2>&1; then
  tailscale status > /dev/null 2>&1 || note "tailscale not connected"
fi

if command -v ufw > /dev/null 2>&1; then
  ufw status 2>/dev/null | grep -q '^Status: active' || note "ufw not active"
fi

# --- 5. status file -----------------------------------------------------------------
count=$(problem_count)
if [ "$count" -eq 0 ]; then
  echo "ok $(utc_now)" > "$STATUS_FILE" 2>/dev/null || true
  log "ok"
else
  {
    echo "fail $(utc_now)"
    printf '%s' "$problems"
  } > "$STATUS_FILE" 2>/dev/null || true
  log_err "cxw monitor: $count problem(s)"
fi

exit 0
