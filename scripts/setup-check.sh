#!/usr/bin/env bash
# setup-check: what is already done on this machine, one line per check.
#
#   scripts/setup-check.sh            # all checks
#   scripts/setup-check.sh box        # only the checks whose name starts with "box"
#
# Output format, one check per line:  <ok|todo|skip> <name> — <detail>
# The /setup skill runs this before each section of docs/GETTING_STARTED.md and
# skips the steps that report ok. It prints presence and shape only. It never
# prints the value of a token, key, or number, and never writes anything.
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root" || exit 1
filter="${1:-}"

say() {
  case "$2" in "$filter"*) printf '%s %s — %s\n' "$1" "$2" "$3" ;; esac
}
have() { command -v "$1" >/dev/null 2>&1; }

# Read one variable from .env without echoing it. Shell wins over the file.
envval() {
  local key="$1" v
  v="${!key:-}"
  if [[ -z "$v" && -f .env ]]; then
    v=$(grep -E "^${key}=" .env | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')
  fi
  printf '%s' "$v"
}
is_set() { [[ -n "$(envval "$1")" ]]; }

# --- tools -------------------------------------------------------------------
if have node; then
  v=$(node -v)
  case "$v" in v22.*) say ok tools.node "$v" ;; *) say todo tools.node "$v installed, the apps need v22 (guide 3.1)" ;; esac
else
  say todo tools.node "not installed (guide 3.1)"
fi
if have pnpm; then say ok tools.pnpm "$(pnpm -v)"; else say todo tools.pnpm "not installed (guide 3.1)"; fi
if [[ -d node_modules/.pnpm ]]; then say ok tools.deps "node_modules present"; else say todo tools.deps "run pnpm install (guide 3.2)"; fi
if have claude; then say ok tools.claude "$(claude --version 2>/dev/null | head -n1)"; else say todo tools.claude "Claude Code CLI not installed (guide 3.6, step 27)"; fi

# --- local config --------------------------------------------------------------
if [[ -f .env ]]; then
  say ok env.file ".env present"
  if grep -qE '^CXW_[A-Z_]+=\./' .env; then say ok env.paths "relative CXW_* paths; the apps resolve them against the repo folder (guide step 11)"; else say ok env.paths "absolute CXW_* paths"; fi
  t=$(envval BRIDGE_TOKEN)
  if [[ ${#t} -ge 16 ]]; then say ok env.bridge_token "set"; else say todo env.bridge_token "empty or shorter than 16 chars (guide step 12; lands with phase 1)"; fi
  if is_set CLAUDE_CODE_OAUTH_TOKEN; then say ok env.anthropic "subscription token set"
  elif is_set ANTHROPIC_API_KEY; then say ok env.anthropic "API key set (fallback path)"
  else say todo env.anthropic "no CLAUDE_CODE_OAUTH_TOKEN and no ANTHROPIC_API_KEY (guide 3.6; lands with phase 2)"; fi
  if is_set OPENAI_API_KEY; then say ok env.openai "set"; else say skip env.openai "optional, voice notes only (phase 3)"; fi
else
  say todo env.file "no .env (guide step 10)"
  say todo env.bridge_token "no .env"
  say todo env.anthropic "no .env"
fi

owners=$(envval CXW_OWNERS_FILE); owners=${owners:-config/owners.json}
if [[ -f "$owners" ]]; then
  if grep -q '420123456789' "$owners"; then say todo owners "still the example number (guide step 14)"
  elif grep -qE '"[0-9]{6,15}"' "$owners"; then say ok owners "$owners has a number"
  else say todo owners "$owners has no digits-only number (guide step 14)"; fi
else
  say todo owners "no $owners (guide step 13)"
fi

# --- whatsapp ------------------------------------------------------------------
data=$(envval CXW_DATA_DIR); data=${data:-data}
if [[ -f "$data/session/creds.json" ]]; then say ok whatsapp.session "paired: $data/session/creds.json exists"
else say todo whatsapp.session "not paired: no $data/session/creds.json (guide 3.4; lands with phase 1)"; fi
if grep -q '"pair"' package.json; then say ok whatsapp.pair_script "pnpm pair available"; else say skip whatsapp.pair_script "pnpm pair not on this branch (lands with phase 1)"; fi

# --- google --------------------------------------------------------------------
if [[ -f google.env ]]; then say ok google.env "google.env present"; else say todo google.env "no google.env (guide 4; lands with phase 4)"; fi
if grep -q '"google:auth"' package.json; then say ok google.auth_script "pnpm google:auth available"; else say skip google.auth_script "pnpm google:auth not on this branch (lands with phase 4)"; fi

# --- anthropic login on the mac ----------------------------------------------------
if have claude; then
  if claude auth status 2>/dev/null | grep -qE '"loggedIn": *true'; then
    say ok anthropic.login "claude auth status reports a login"
  else
    say todo anthropic.login "claude auth status reports no login (guide step 28: claude login or claude setup-token)"
  fi
fi

# --- box ---------------------------------------------------------------------------
ts=""
for c in tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
  if [[ -x "$c" ]] || have "$c"; then ts="$c"; break; fi
done
if [[ -n "$ts" ]]; then
  if "$ts" status >/dev/null 2>&1; then say ok box.tailscale "connected"; else say todo box.tailscale "installed but not connected (guide step 48)"; fi
else
  say todo box.tailscale "Tailscale not installed on this machine (guide step 48)"
fi
if ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new root@cxw true >/dev/null 2>&1; then
  say ok box.ssh "ssh root@cxw answers"
  if ssh -o BatchMode=yes -o ConnectTimeout=5 root@cxw 'test -d /srv/cxw/repo/.git' 2>/dev/null; then say ok box.repo "/srv/cxw/repo cloned"; else say todo box.repo "repo not cloned on the box (guide 5.3)"; fi
  if ssh -o BatchMode=yes -o ConnectTimeout=5 root@cxw 'grep -qE "^CLAUDE_CODE_OAUTH_TOKEN=(CHANGEME|)$" /srv/cxw/cxw.env' 2>/dev/null; then say todo box.claude_token "cxw.env still has the placeholder token (guide 5.5)"; else say ok box.claude_token "cxw.env token filled or file absent"; fi
  if ssh -o BatchMode=yes -o ConnectTimeout=5 root@cxw 'systemctl is-active --quiet cxw-bridge' 2>/dev/null; then say ok box.bridge "cxw-bridge active"; else say todo box.bridge "cxw-bridge not active (guide 5.6)"; fi
  if ssh -o BatchMode=yes -o ConnectTimeout=5 root@cxw 'test -f /srv/cxw/data/session/creds.json' 2>/dev/null; then say ok box.whatsapp "box is paired"; else say todo box.whatsapp "box not paired (guide step 78 or 79)"; fi
  if ssh -o BatchMode=yes -o ConnectTimeout=5 root@cxw 'test -f /srv/cxw/google.env' 2>/dev/null; then say ok box.google "google.env on the box"; else say todo box.google "google.env not on the box (guide step 68; phase 4)"; fi
  if ssh -o BatchMode=yes -o ConnectTimeout=5 root@cxw 'systemctl list-timers cxw-backup.timer --no-pager 2>/dev/null | grep -q cxw-backup' 2>/dev/null; then say ok box.backup "backup timer present"; else say todo box.backup "backup timer missing (guide 5.7)"; fi
else
  say todo box.ssh "ssh root@cxw does not answer over Tailscale (guide 5.1-5.2, or the box does not exist yet)"
fi

# --- cloudflare ------------------------------------------------------------------------
if [[ -f deploy/cloudflare/access-policy.md ]]; then say ok cloudflare.docs "phase 8 files present: deploy/cloudflare/"; else say skip cloudflare.console "console not on this branch (lands with phase 8)"; fi

# --- phases ------------------------------------------------------------------------------
# Presence of a phase's code in this checkout, not git ancestry: an early push of a phase
# branch reads as "merged" to `git branch --merged`, which is misleading.
phase_marker() { [[ -e "$2" ]] && printf '%s' "$1 " || printf ''; }
merged="0 "
merged+=$(phase_marker 1 apps/bridge/src/pair.ts)
merged+=$(phase_marker 2 apps/brain/src/router.ts)
merged+=$(phase_marker 3 apps/brain/src/media)
merged+=$(phase_marker 4 mcp/google/src/auth.ts)
merged+=$(phase_marker 5 apps/brain/src/commands/routines.ts)
merged+=$(phase_marker 6 apps/brain/src/memory/commands.ts)
merged+=$(phase_marker 7 deploy/hetzner/alert.sh)
merged+=$(phase_marker 8 deploy/cloudflare/access-policy.md)
merged+=$(phase_marker 9 apps/brain/src/commands/followups.ts)
say ok phases.present "code for phases ${merged% } in this checkout (branch $(git branch --show-current 2>/dev/null), $(git rev-parse --short HEAD 2>/dev/null))"
