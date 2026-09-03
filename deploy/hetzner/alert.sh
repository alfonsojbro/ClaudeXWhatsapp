#!/usr/bin/env bash
# alert.sh — thin wrapper so the Phase 0 CXW_ALERT_CMD hook reaches the Phase 7 alert chain
# (WhatsApp first, then email, then Telegram). Set in cxw.env:
#   CXW_ALERT_CMD=/srv/cxw/repo/deploy/hetzner/alert.sh
set -euo pipefail
exec "${CXW_OPS_BIN:-/usr/local/bin/cxw-ops}" alert-test "$@"
