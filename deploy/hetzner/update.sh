#!/usr/bin/env bash
# update.sh — pull the latest code and restart the three services. Run as root.
#   /srv/cxw/repo/deploy/hetzner/update.sh            # pull --ff-only, install, restart
#   /srv/cxw/repo/deploy/hetzner/update.sh --no-restart
set -euo pipefail
CXW_ROOT=/srv/cxw
REPO="$CXW_ROOT/repo"
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -d "$REPO/.git" ]] || { echo "no repo at $REPO" >&2; exit 1; }

run_cxw() { sudo -u cxw -H env GIT_SSH_COMMAND="ssh -i /home/cxw/.ssh/cxw_deploy -o IdentitiesOnly=yes" "$@"; }

before=$(run_cxw git -C "$REPO" rev-parse --short HEAD)
run_cxw git -C "$REPO" pull --ff-only
after=$(run_cxw git -C "$REPO" rev-parse --short HEAD)
echo "update: $before -> $after"

run_cxw pnpm --dir "$REPO" install --frozen-lockfile

# Re-install the unit files if any of them differs from the installed copy.
units=("$REPO"/deploy/hetzner/systemd/cxw-*)
units_changed=0
for u in "${units[@]}"; do
  [[ -f "$u" ]] || continue
  cmp -s "$u" "/etc/systemd/system/$(basename "$u")" || units_changed=1
done
if [[ $units_changed -eq 1 ]]; then
  echo "update: systemd units changed, reinstalling"
  install -m 0644 "${units[@]}" /etc/systemd/system/
  systemctl daemon-reload
fi

if [[ "${1:-}" != "--no-restart" ]]; then
  systemctl restart cxw-bridge cxw-brain cxw-scheduler
  sleep 3
  systemctl --no-pager --lines=0 status cxw-bridge cxw-brain cxw-scheduler || true
fi
echo "update: done"
