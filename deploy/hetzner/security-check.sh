#!/usr/bin/env bash
# security-check.sh — security posture pass. Prints PASS/FAIL/WARN/SKIP per check, exit 1 on any FAIL.
#
#   security-check.sh --repo   static repo checks only (runs on a dev Mac)
#   security-check.sh          repo checks + runtime box checks (root or the cxw user)
#
# Portable to bash 3.2 and bash 5.
set -uo pipefail

MODE=box
case "${1:-}" in
  --repo) MODE=repo ;;
  "" | --box) MODE=box ;;
  *)
    echo "usage: $0 [--repo|--box]" >&2
    exit 2
    ;;
esac

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CXW_ROOT="${CXW_ROOT:-/srv/cxw}"
fails=0
passes=0
skips=0
warns=0

pass() {
  echo "PASS $1"
  passes=$((passes + 1))
}
fail() {
  echo "FAIL $1"
  fails=$((fails + 1))
}
skip() {
  echo "SKIP $1"
  skips=$((skips + 1))
}
warn() {
  echo "WARN $1"
  warns=$((warns + 1))
}

# file_mode <path> -> octal mode, portable across GNU and BSD stat
file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}
file_owner() {
  stat -c '%U:%G' "$1" 2>/dev/null || stat -f '%Su:%Sg' "$1" 2>/dev/null
}

# filter_public_listeners <space-separated tailscale addrs>
# reads `ss` local-address column on stdin, prints only the addresses that are neither
# loopback, nor sshd on any address, nor bound to a tailscale address.
# Defined outside any $(...) on purpose: bash mis-parses `case` patterns inside
# command substitution.
filter_public_listeners() {
  local ts_addrs="$1" a t hit
  while IFS= read -r a; do
    [ -n "$a" ] || continue
    case "$a" in
      127.0.0.1:* | '[::1]:'* | *:22) continue ;;
    esac
    hit=0
    for t in $ts_addrs; do
      case "$a" in
        "$t":* | "[$t]:"*) hit=1 ;;
      esac
    done
    [ "$hit" -eq 1 ] || echo "$a"
  done
}

echo "security-check: mode=$MODE repo=$REPO_ROOT"
echo

# ====================================================================================
# Static repo checks (both modes)
# ====================================================================================

# --- 1. pino redaction --------------------------------------------------------------
# Per package, not repo-wide: the old version passed as soon as ANY one file anywhere
# declared `redact` with `paths`, so a second app could log JIDs and message bodies
# forever without this check ever noticing.
pino_pkgs=0
for src in "$REPO_ROOT"/apps/*/src "$REPO_ROOT"/packages/*/src "$REPO_ROOT"/mcp/*/src; do
  [ -d "$src" ] || continue
  grep -rq 'pino' "$src" 2>/dev/null || continue
  pino_pkgs=$((pino_pkgs + 1))
  pkg=$(basename "$(dirname "$src")")
  kind=$(basename "$(dirname "$(dirname "$src")")")
  redact_file=""
  for f in $(grep -rl 'redact' "$src" 2>/dev/null || true); do
    if grep -q 'paths' "$f" 2>/dev/null; then
      redact_file="$f"
      break
    fi
  done
  if [ -n "$redact_file" ]; then
    pass "pino redaction: $kind/$pkg declares \`redact\` with \`paths\` (${redact_file#"$REPO_ROOT"/})"
  else
    fail "pino redaction: $kind/$pkg uses pino with no \`redact\` \`paths\` list — phone numbers and message text may be logged"
  fi
done
if [ "$pino_pkgs" -eq 0 ]; then
  skip "pino redaction: no package uses pino yet (apps/*/src, packages/*/src, mcp/*/src)"
fi

# --- 2. confirm token on send/create MCP tools --------------------------------------
send_files=""
if [ -d "$REPO_ROOT/mcp" ]; then
  for f in "$REPO_ROOT"/mcp/*/src/*.ts; do
    [ -f "$f" ] || continue
    case "$f" in
      *send_* | *gmail_send* | *calendar_create*)
        send_files="$send_files $f"
        continue
        ;;
    esac
    if grep -qE 'send_|gmail_send|calendar_create' "$f" 2>/dev/null; then
      send_files="$send_files $f"
    fi
  done
fi
if [ -z "$send_files" ]; then
  skip "confirm token: no send/create MCP tool implementations exist yet (mcp/*/src)"
else
  missing=""
  for f in $send_files; do
    grep -q 'confirm' "$f" 2>/dev/null || missing="$missing $(basename "$(dirname "$(dirname "$f")")")/$(basename "$f")"
  done
  if [ -z "$missing" ]; then
    pass "confirm token: every send/create MCP tool file mentions \`confirm\`"
  else
    fail "confirm token: send/create tool without a confirm step:$missing"
  fi
fi

# --- 3. sudoers file present and valid ----------------------------------------------
SUDOERS_SRC="$REPO_ROOT/deploy/hetzner/sudoers.d/cxw-ctl"
if [ ! -f "$SUDOERS_SRC" ]; then
  fail "sudoers: deploy/hetzner/sudoers.d/cxw-ctl is missing from the repo"
elif command -v visudo > /dev/null 2>&1; then
  if visudo -c -f "$SUDOERS_SRC" > /dev/null 2>&1; then
    pass "sudoers: deploy/hetzner/sudoers.d/cxw-ctl parses (visudo -c)"
  else
    fail "sudoers: deploy/hetzner/sudoers.d/cxw-ctl does not parse (visudo -c)"
  fi
else
  skip "sudoers: visudo not available to validate deploy/hetzner/sudoers.d/cxw-ctl"
fi

# --- 4. every deploy script fails loudly --------------------------------------------
unsafe=""
for f in "$REPO_ROOT"/deploy/hetzner/*.sh; do
  [ -f "$f" ] || continue
  if ! grep -qE '^set -(euo|uo) pipefail' "$f"; then
    unsafe="$unsafe $(basename "$f")"
  fi
done
if [ -z "$unsafe" ]; then
  pass "deploy scripts: all of deploy/hetzner/*.sh set -euo/-uo pipefail"
else
  fail "deploy scripts: missing \`set -euo pipefail\`:$unsafe"
fi

# --- 5. no CHANGEME placeholders in example env files -------------------------------
# cxw.env.example and restic.env.example are Phase 0's and still ship placeholders on
# purpose (the operator pastes real values during install); they only get a WARN.
# Any other example file with CHANGEME is a defect: an operator who copies it gets a
# config the app treats as a real secret.
legacy_placeholders=""
bad_placeholders=""
for f in "$REPO_ROOT"/deploy/hetzner/*.env.example; do
  [ -f "$f" ] || continue
  grep -q 'CHANGEME' "$f" 2>/dev/null || continue
  case "$(basename "$f")" in
    cxw.env.example | restic.env.example)
      legacy_placeholders="$legacy_placeholders $(basename "$f")"
      ;;
    *)
      bad_placeholders="$bad_placeholders $(basename "$f")"
      ;;
  esac
done
if [ -n "$bad_placeholders" ]; then
  fail "example env: CHANGEME placeholder left in deploy/hetzner:$bad_placeholders"
else
  pass "example env: no CHANGEME placeholder outside the Phase 0 example files"
fi
if [ -n "$legacy_placeholders" ]; then
  warn "example env: Phase 0 example files still ship CHANGEME (fill them in on the box):$legacy_placeholders"
fi

if [ "$MODE" = "repo" ]; then
  echo
  echo "security-check: $passes passed, $fails failed, $warns warned, $skips skipped (repo mode)"
  [ "$fails" -eq 0 ] || exit 1
  exit 0
fi

# ====================================================================================
# Runtime box checks
# ====================================================================================
echo

# --- 6. env file modes --------------------------------------------------------------
envs=""
for f in "$CXW_ROOT"/*.env; do
  [ -f "$f" ] || continue
  envs="$envs $f"
done
if [ -z "$envs" ]; then
  fail "env files: no $CXW_ROOT/*.env found"
else
  bad=""
  for f in $envs; do
    m=$(file_mode "$f")
    o=$(file_owner "$f")
    if [ "$m" != "600" ] || [ "$o" != "root:root" ]; then
      bad="$bad $(basename "$f")($o $m)"
    fi
  done
  if [ -z "$bad" ]; then
    pass "env files: all $CXW_ROOT/*.env are root:root 0600"
  else
    fail "env files: not root:root 0600:$bad"
  fi
fi

# --- 7. no CHANGEME placeholders in the live env files ------------------------------
# The example-file check cannot catch a hand-edited /srv/cxw/cxw.env, which is exactly
# where the Phase 0 placeholders land. A literal CHANGEME here means a credential was
# never filled in.
if [ -z "$envs" ]; then
  skip "env secrets: no $CXW_ROOT/*.env found to scan for CHANGEME"
else
  placeholders=""
  for f in $envs; do
    grep -q 'CHANGEME' "$f" 2>/dev/null && placeholders="$placeholders $(basename "$f")"
  done
  if [ -z "$placeholders" ]; then
    pass "env secrets: no CHANGEME placeholder in $CXW_ROOT/*.env"
  else
    fail "env secrets: CHANGEME placeholder still in:$placeholders"
  fi
fi

# --- 8. ufw -------------------------------------------------------------------------
if command -v ufw > /dev/null 2>&1; then
  ufw_out=$(ufw status verbose 2>/dev/null || true)
  if printf '%s' "$ufw_out" | grep -q '^Status: active'; then
    pass "ufw: active"
  else
    fail "ufw: not active"
  fi
  if printf '%s' "$ufw_out" | grep -qi 'deny (incoming)'; then
    pass "ufw: default deny incoming"
  else
    fail "ufw: default incoming policy is not deny"
  fi
  allowed=$(printf '%s' "$ufw_out" | grep -E '^[0-9]' | grep -iv 'tailscale' || true)
  if [ -z "$allowed" ]; then
    pass "ufw: no allow rules outside the tailscale interface"
  else
    fail "ufw: allow rules outside tailscale: $(printf '%s' "$allowed" | tr '\n' ';')"
  fi
else
  skip "ufw: not installed"
fi

# --- 9. no public listeners ---------------------------------------------------------
if command -v ss > /dev/null 2>&1; then
  ts_addrs=""
  if command -v tailscale > /dev/null 2>&1; then
    ts_addrs=$(tailscale ip 2>/dev/null | tr '\n' ' ')
  fi
  public=$(ss -tlnH 2>/dev/null | awk '{ print $4 }' | filter_public_listeners "$ts_addrs")
  if [ -z "$public" ]; then
    pass "listeners: nothing bound outside loopback/tailscale"
  else
    fail "listeners: publicly bound sockets: $(printf '%s' "$public" | tr '\n' ' ')"
  fi
else
  skip "listeners: ss not available"
fi

# --- 10. sudoers installed -----------------------------------------------------------
if [ -f /etc/sudoers.d/cxw-ctl ]; then
  m=$(file_mode /etc/sudoers.d/cxw-ctl)
  o=$(file_owner /etc/sudoers.d/cxw-ctl)
  if [ "$m" = "440" ] && [ "$o" = "root:root" ]; then
    pass "sudoers: /etc/sudoers.d/cxw-ctl installed root:root 0440"
  else
    fail "sudoers: /etc/sudoers.d/cxw-ctl is $o $m (want root:root 440)"
  fi
else
  fail "sudoers: /etc/sudoers.d/cxw-ctl not installed (run install-ops.sh)"
fi

# --- 11. cxw-ctl mode ----------------------------------------------------------------
if [ -f /usr/local/bin/cxw-ctl ]; then
  m=$(file_mode /usr/local/bin/cxw-ctl)
  o=$(file_owner /usr/local/bin/cxw-ctl)
  if [ "$m" = "755" ] && [ "$o" = "root:root" ]; then
    pass "cxw-ctl: /usr/local/bin/cxw-ctl is root:root 0755"
  else
    fail "cxw-ctl: /usr/local/bin/cxw-ctl is $o $m (want root:root 755)"
  fi
else
  fail "cxw-ctl: /usr/local/bin/cxw-ctl not installed (run install-ops.sh)"
fi

# --- 12. state dir ------------------------------------------------------------------
if [ -d "$CXW_ROOT/state" ]; then
  m=$(file_mode "$CXW_ROOT/state")
  o=$(file_owner "$CXW_ROOT/state")
  if [ "$m" = "700" ] && [ "${o%%:*}" = "cxw" ]; then
    pass "state dir: $CXW_ROOT/state is cxw-owned 0700"
  else
    fail "state dir: $CXW_ROOT/state is $o $m (want cxw:cxw 700)"
  fi
else
  fail "state dir: $CXW_ROOT/state does not exist"
fi

echo
echo "security-check: $passes passed, $fails failed, $warns warned, $skips skipped (box mode)"
[ "$fails" -eq 0 ] || exit 1
exit 0
