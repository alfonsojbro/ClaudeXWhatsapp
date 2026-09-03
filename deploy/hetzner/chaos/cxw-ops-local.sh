#!/usr/bin/env bash
# cxw-ops-local.sh — run the ops CLI straight from the repo (local chaos runs, no install).
# chaos.sh exports CXW_OPS_BIN=<this script>.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
exec "$REPO/node_modules/.bin/tsx" "$REPO/apps/ops/src/cli.ts" "$@"
