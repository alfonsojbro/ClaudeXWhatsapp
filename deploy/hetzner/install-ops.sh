#!/usr/bin/env bash
# install-ops.sh — install the Phase 7 ops layer on the Hetzner box. Root, idempotent.
#
# Installs:  /usr/local/bin/cxw-ctl (0755 root:root) + /etc/sudoers.d/cxw-ctl (0440 root:root)
#            /usr/local/bin/cxw-ops wrapper (0755 root:root, runs as the calling user)
#            cxw-monitor.{service,timer}, cxw-purge.{service,timer}, cxw-sentinel.service
# Appends:   missing keys from ops.env.example to /srv/cxw/cxw.env (kept root:root 0600)
# Enables:   cxw-monitor.timer, cxw-purge.timer, cxw-sentinel
#
# Run after deploy/hetzner/bootstrap.sh, from the checked-out repo:
#   sudo /srv/cxw/repo/deploy/hetzner/install-ops.sh
set -euo pipefail

CXW_ROOT=/srv/cxw
REPO="${CXW_REPO_DIR:-$CXW_ROOT/repo}"
HERE=$(cd "$(dirname "$0")" && pwd)
ENV_FILE="$CXW_ROOT/cxw.env"
OPS_ENV_EXAMPLE="$HERE/ops.env.example"
SYSTEMD_DIR=/etc/systemd/system
UNITS="cxw-monitor.service cxw-monitor.timer cxw-purge.service cxw-purge.timer cxw-sentinel.service"

did=()
say() {
  echo "install-ops: $1"
  did+=("$1")
}

[ "$(id -u)" -eq 0 ] || {
  echo "install-ops: run as root" >&2
  exit 1
}
[ -d "$REPO" ] || {
  echo "install-ops: repo not found at $REPO (run bootstrap.sh first)" >&2
  exit 1
}
[ -f "$ENV_FILE" ] || {
  echo "install-ops: $ENV_FILE not found (run bootstrap.sh first)" >&2
  exit 1
}

# --- 1. privileged helper -----------------------------------------------------------
install -o root -g root -m 0755 "$HERE/cxw-ctl" /usr/local/bin/cxw-ctl
say "installed /usr/local/bin/cxw-ctl (0755 root:root)"

# --- 2. sudoers ---------------------------------------------------------------------
sudoers_tmp=$(mktemp)
trap 'rm -f "$sudoers_tmp"' EXIT
install -m 0440 "$HERE/sudoers.d/cxw-ctl" "$sudoers_tmp"
if visudo -c -f "$sudoers_tmp" > /dev/null; then
  install -o root -g root -m 0440 "$HERE/sudoers.d/cxw-ctl" /etc/sudoers.d/cxw-ctl
  say "installed /etc/sudoers.d/cxw-ctl (0440 root:root, visudo -c passed)"
else
  echo "install-ops: sudoers file failed visudo -c; not installed" >&2
  exit 1
fi

# --- 3. cxw-ops wrapper -------------------------------------------------------------
# Runs as whoever calls it (no setuid, no sudo): systemd units call it as cxw.
cat > /usr/local/bin/cxw-ops <<WRAPPER
#!/usr/bin/env bash
# cxw-ops — installed by install-ops.sh. Do not edit; re-run install-ops.sh instead.
set -euo pipefail
cd $REPO/apps/ops
exec $REPO/node_modules/.bin/tsx src/cli.ts "\$@"
WRAPPER
chown root:root /usr/local/bin/cxw-ops
chmod 0755 /usr/local/bin/cxw-ops
say "installed /usr/local/bin/cxw-ops wrapper -> $REPO/apps/ops"

# --- 4. systemd units ---------------------------------------------------------------
for u in $UNITS; do
  install -o root -g root -m 0644 "$HERE/systemd/$u" "$SYSTEMD_DIR/$u"
done
say "installed systemd units: $UNITS"

# --- 5. env keys --------------------------------------------------------------------
# cxw.env is hand-edited by the operator, so it may not end in a newline. Appending to
# such a file glues the new key onto the end of the last value and silently mangles both.
ensure_trailing_newline() {
  local f="$1"
  [ -s "$f" ] || return 0
  [ -z "$(tail -c 1 "$f")" ] || printf '\n' >> "$f"
}

added=0
ensure_trailing_newline "$ENV_FILE"
if [ -f "$OPS_ENV_EXAMPLE" ]; then
  # `|| [ -n "$line" ]` keeps the last line of the example even if it lacks a newline.
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      [A-Z]*=*) ;;
      *) continue ;;
    esac
    key=${line%%=*}
    if ! grep -q "^[[:space:]]*${key}=" "$ENV_FILE"; then
      printf '%s\n' "$line" >> "$ENV_FILE"
      added=$((added + 1))
    fi
  done < "$OPS_ENV_EXAMPLE"
fi
if ! grep -q '^[[:space:]]*CXW_ALERT_CMD=' "$ENV_FILE"; then
  ensure_trailing_newline "$ENV_FILE"
  printf 'CXW_ALERT_CMD=%s/deploy/hetzner/alert.sh\n' "$REPO" >> "$ENV_FILE"
  added=$((added + 1))
  say "set CXW_ALERT_CMD=$REPO/deploy/hetzner/alert.sh"
fi
chown root:root "$ENV_FILE"
chmod 0600 "$ENV_FILE"
say "appended $added missing key(s) to $ENV_FILE (root:root 0600)"

# --- 5b. google.env placeholder ------------------------------------------------------
# cxw-monitor.service carries `EnvironmentFile=-/srv/cxw/google.env` and the google health
# check reads GOOGLE_* from the environment, but nothing else in the repo creates the file.
# Create it empty (commented) so the operator has one obvious place to paste Phase 4's
# tokens. `EnvironmentFile=-` already tolerates it being absent, so this never breaks a run.
GOOGLE_ENV="$CXW_ROOT/google.env"
if [ ! -f "$GOOGLE_ENV" ]; then
  cat > "$GOOGLE_ENV" <<'GOOGLEENV'
# /srv/cxw/google.env — root:root 0600. Read by cxw-monitor.service (EnvironmentFile=-).
# Filled in by Phase 4 (Google OAuth). Until then the google health check reports
# `disabled` when CXW_GOOGLE_CHECK=off, or FAILs once these are set but invalid.
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GOOGLE_REFRESH_TOKEN=
GOOGLEENV
  chown root:root "$GOOGLE_ENV"
  chmod 0600 "$GOOGLE_ENV"
  say "created $GOOGLE_ENV placeholder (root:root 0600, all keys commented)"
else
  chown root:root "$GOOGLE_ENV"
  chmod 0600 "$GOOGLE_ENV"
  say "kept existing $GOOGLE_ENV (root:root 0600)"
fi

# --- 6. state dir -------------------------------------------------------------------
install -d -o cxw -g cxw -m 0700 "$CXW_ROOT/state"
say "ensured $CXW_ROOT/state (0700 cxw:cxw)"

# --- 7. enable ----------------------------------------------------------------------
systemctl daemon-reload
systemctl enable --now cxw-monitor.timer cxw-purge.timer cxw-sentinel.service
say "enabled and started cxw-monitor.timer, cxw-purge.timer, cxw-sentinel.service"

echo
echo "install-ops: done. Summary:"
for d in "${did[@]}"; do echo "  - $d"; done
echo
echo "Next: verify with"
echo "  sudo -u cxw /usr/local/bin/cxw-ops health"
echo "  sudo -u cxw $REPO/deploy/hetzner/security-check.sh"
