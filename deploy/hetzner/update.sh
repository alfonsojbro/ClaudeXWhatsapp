#!/usr/bin/env bash
# update.sh — pull the latest code and restart the three services. Run as root.
#   /srv/cxw/repo/deploy/hetzner/update.sh            # pull --ff-only, install, restart
#   /srv/cxw/repo/deploy/hetzner/update.sh --no-restart
set -euo pipefail
CXW_ROOT=/srv/cxw
REPO="$CXW_ROOT/repo"
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -d "$REPO/.git" ]] || { echo "no repo at $REPO" >&2; exit 1; }

# Reject anything unrecognised. A typo like --no-resart must not silently
# restart production services.
restart=1
case "${1:-}" in
  '') ;;
  --no-restart) restart=0 ;;
  *) echo "usage: update.sh [--no-restart]" >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { echo "usage: update.sh [--no-restart]" >&2; exit 2; }

# pnpm and node come from sudo's secure_path (/usr/bin), which is where
# bootstrap.sh installs them and what the systemd units hardcode. If node ever
# moves (nvm, for example) this needs an explicit PATH.
run_cxw() { sudo -u cxw -H env GIT_SSH_COMMAND="ssh -i /home/cxw/.ssh/cxw_deploy -o IdentitiesOnly=yes" "$@"; }

before=$(run_cxw git -C "$REPO" rev-parse --short HEAD)
run_cxw git -C "$REPO" pull --ff-only
after=$(run_cxw git -C "$REPO" rev-parse --short HEAD)
echo "update: $before -> $after"

run_cxw pnpm --dir "$REPO" install --frozen-lockfile

# Re-install the unit files if any of them differs from the installed copy.
units=("$REPO"/deploy/hetzner/systemd/cxw-*)
# An unmatched glob leaves the literal pattern in the array. Fail loudly rather
# than reporting success having installed nothing.
[[ -f "${units[0]}" ]] || { echo "no unit files under $REPO/deploy/hetzner/systemd" >&2; exit 1; }
units_changed=0
for u in "${units[@]}"; do
  cmp -s "$u" "/etc/systemd/system/$(basename "$u")" || units_changed=1
done
if [[ $units_changed -eq 1 ]]; then
  echo "update: systemd units changed, reinstalling"
  install -m 0644 "${units[@]}" /etc/systemd/system/
  systemctl daemon-reload
  # Enable anything new; already-enabled units are untouched. Skip the
  # timer-triggered services, which carry no [Install] section: enabling one
  # only prints a notice, and must never abort the update between
  # daemon-reload and the restart below.
  for u in "${units[@]}"; do
    case "$(basename "$u")" in
      cxw-backup.service | cxw-monitor.service) continue ;;
    esac
    systemctl enable "$(basename "$u")" >/dev/null || true
  done
  systemctl restart cxw-backup.timer cxw-monitor.timer || true
fi

if [[ $restart -eq 1 ]]; then
  # Do not let set -e abort before the status block: a failed restart is
  # exactly when the operator needs the diagnostics.
  rc=0
  systemctl restart cxw-bridge cxw-brain cxw-scheduler || rc=$?
  sleep 3
  systemctl --no-pager --lines=0 status cxw-bridge cxw-brain cxw-scheduler || true
  if [[ $rc -ne 0 ]]; then
    echo "update: restart failed (rc=$rc). If a unit is in 'failed' after a bad" >&2
    echo "update: env file, clear it with: systemctl reset-failed cxw-brain" >&2
    exit $rc
  fi
fi
echo "update: done"
