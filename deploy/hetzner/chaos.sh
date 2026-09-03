#!/usr/bin/env bash
# chaos.sh — deliberately break things and prove the ops layer notices, alerts and heals.
#
#   chaos.sh --local            safe: temp dirs + HTTP stubs, no root, no services touched
#   chaos.sh --box --i-know     DANGEROUS: kills real services on the Hetzner box (root only)
#
# --local prints a Markdown summary on stdout; copy it into docs/runs/chaos-<date>.md.
# Portable to bash 3.2 (macOS) and bash 5 (Ubuntu).
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
NODE_BIN="${NODE_BIN:-node}"

MODE=""
IKNOW=0
for arg in "$@"; do
  case "$arg" in
    --local) MODE=local ;;
    --box) MODE=box ;;
    --i-know) IKNOW=1 ;;
    -h | --help)
      sed -n '2,9p' "$0"
      exit 0
      ;;
    *)
      echo "chaos: unknown argument $arg" >&2
      exit 2
      ;;
  esac
done

if [ -z "$MODE" ]; then
  echo "chaos: pass --local (safe) or --box --i-know (dangerous)" >&2
  exit 2
fi

# ====================================================================================
# shared result table
# ====================================================================================
RESULTS=""
FAILED=0

record() {
  # record <scenario> <expected> <observed> <PASS|FAIL>
  RESULTS="${RESULTS}$1|$2|$3|$4
"
  [ "$4" = "FAIL" ] && FAILED=1
  echo "  -> $4: $1 — $3"
  return 0
}

print_summary() {
  echo
  echo "## Chaos run — $MODE mode — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  echo "| Scenario | Expected | Observed | Result |"
  echo "| --- | --- | --- | --- |"
  printf '%s' "$RESULTS" | while IFS='|' read -r s e o r; do
    [ -n "$s" ] || continue
    echo "| $s | $e | $o | $r |"
  done
  echo
  if [ "$FAILED" -eq 0 ]; then
    echo "**All scenarios passed.**"
  else
    echo "**At least one scenario FAILED.**"
  fi
}

# ====================================================================================
# LOCAL MODE
# ====================================================================================
run_local() {
  if [ ! -f "$REPO/apps/ops/src/cli.ts" ]; then
    echo "chaos: $REPO/apps/ops/src/cli.ts is missing." >&2
    echo "chaos: the ops CLI (Implementer A) must exist before the local chaos run." >&2
    exit 1
  fi
  if [ ! -x "$REPO/node_modules/.bin/tsx" ]; then
    echo "chaos: $REPO/node_modules/.bin/tsx is missing — run \`pnpm install\` at the repo root." >&2
    exit 1
  fi
  if ! command -v "$NODE_BIN" > /dev/null 2>&1; then
    echo "chaos: node not found (set NODE_BIN)" >&2
    exit 1
  fi

  TMP=$(mktemp -d "${TMPDIR:-/tmp}/cxw-chaos.XXXXXX") || exit 1
  export STUB_DIR="$TMP/stubs"
  mkdir -p "$STUB_DIR"

  trap 'local_cleanup' EXIT INT TERM

  export CXW_DATA_DIR="$TMP/data"
  export CXW_STATE_DIR="$TMP/state"
  mkdir -p "$CXW_DATA_DIR" "$CXW_STATE_DIR"
  chmod 0700 "$CXW_STATE_DIR"

  OWNER_JID="10000000000@s.whatsapp.net"
  OTHER_JID="20000000001@s.whatsapp.net"

  # --- seed the bridge sqlite + media files ----------------------------------------
  echo "chaos: seeding $CXW_DATA_DIR/bridge.sqlite"
  CHAOS_OWNER_JID="$OWNER_JID" CHAOS_OTHER_JID="$OTHER_JID" "$NODE_BIN" --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const fs = require("node:fs");
    const path = require("node:path");
    const data = process.env.CXW_DATA_DIR;
    const owner = process.env.CHAOS_OWNER_JID;
    const other = process.env.CHAOS_OTHER_JID;
    const media = path.join(data, "media");
    fs.mkdirSync(path.join(media, other), { recursive: true });
    fs.mkdirSync(path.join(media, owner), { recursive: true });
    const db = new DatabaseSync(path.join(data, "bridge.sqlite"));
    db.exec("CREATE TABLE IF NOT EXISTS messages (jid TEXT, id TEXT, ts INTEGER, from_me INTEGER, sender TEXT, type TEXT, text TEXT, quoted_id TEXT, media_path TEXT, PRIMARY KEY (jid, id))");
    const old = Math.floor(Date.now() / 1000) - 30 * 86400;
    const oldMs = old * 1000;
    const ins = db.prepare("INSERT OR REPLACE INTO messages (jid, id, ts, from_me, sender, type, text, quoted_id, media_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const write = (jid, name) => {
      const p = path.join(media, jid, name);
      fs.writeFileSync(p, "chaos-media-payload");
      fs.utimesSync(p, oldMs / 1000, oldMs / 1000);
      return p;
    };
    for (let i = 1; i <= 3; i++) {
      const p = write(other, "third-" + i + ".jpg");
      ins.run(other, "third-" + i, old, 0, other, "image", "third party media " + i, null, p);
    }
    const op = write(owner, "owner-1.jpg");
    ins.run(owner, "owner-1", old, 1, owner, "image", "owner media that must survive", null, op);
    db.close();
    console.log("seeded 3 third-party rows + 1 owner row (30 days old)");
  ' || {
    echo "chaos: seeding failed" >&2
    exit 1
  }

  # --- owners file + backup marker --------------------------------------------------
  printf '{ "owners": ["%s"] }\n' "$OWNER_JID" > "$TMP/owners.json"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$CXW_STATE_DIR/last-backup"

  # --- stubs ------------------------------------------------------------------------
  export STUB_BRIDGE_PORT=17801
  export STUB_BRAIN_PORT=17802
  export STUB_GOOGLE_PORT=17803
  export STUB_LOG="$STUB_DIR/bridge-send.log"
  export STUB_GOOGLE_FAIL="$STUB_DIR/google-fail"
  export FAKE_CTL_LOG="$TMP/fake-ctl.log"
  export NODE_BIN
  : > "$STUB_LOG"
  : > "$FAKE_CTL_LOG"

  for name in bridge brain google; do
    "$NODE_BIN" "$HERE/chaos/stub-services.mjs" --only "$name" > "$STUB_DIR/$name.out" 2>&1 &
    echo $! > "$STUB_DIR/$name.pid"
  done
  sleep 1

  # --- env the ops CLI reads --------------------------------------------------------
  export BRIDGE_URL="http://127.0.0.1:$STUB_BRIDGE_PORT"
  export BRAIN_URL="http://127.0.0.1:$STUB_BRAIN_PORT"
  export CXW_GOOGLE_TOKEN_URL="http://127.0.0.1:$STUB_GOOGLE_PORT/token"
  export GOOGLE_CLIENT_ID=stub
  export GOOGLE_CLIENT_SECRET=stub
  export GOOGLE_REFRESH_TOKEN=stub
  export SMTP_HOST=smtp.invalid
  export ALERT_EMAIL_FROM=a@b
  export ALERT_EMAIL_TO=c@d
  export TELEGRAM_ALERTS=false
  export CXW_ALERT_TRANSPORT=log
  export CXW_ALERT_REPEAT_MIN=999
  export CXW_ALERT_AFTER_FAILURES=1
  export CXW_CLAUDE_AUTH_DEEP_CHECK_MIN=0
  export CLAUDE_CODE_OAUTH_TOKEN=stub
  export CXW_BACKUP_MAX_AGE_H=8
  export CXW_HEAL_RECHECK_S=2
  export CXW_SUDO=""
  export CXW_CTL="$HERE/chaos/fake-ctl.sh"
  export CXW_OPS_BIN="$HERE/chaos/cxw-ops-local.sh"
  export CXW_OWNERS_FILE="$TMP/owners.json"
  export BRIDGE_DB="$CXW_DATA_DIR/bridge.sqlite"
  export CXW_OPS_DB="$CXW_DATA_DIR/ops.sqlite"
  export MEDIA_DIR="$CXW_DATA_DIR/media"
  export CXW_PURGE_EMERGENCY_MEDIA_DAYS=14
  export CXW_RETENTION_OWNER_FOREVER=true
  export LOG_LEVEL=warn
  # A dev Mac is often over the 85% default, which would make every scenario fail on the
  # disk check. 100 = "used >= 100%", i.e. never. Scenario 4 overrides it to 0.
  export CXW_DISK_LIMIT_PCT=100

  OUT="$TMP/out"
  mkdir -p "$OUT"

  # monitor_status -> the first word of $CXW_STATE_DIR/monitor.status ("ok" / "fail" / "").
  monitor_status() {
    if [ -f "$CXW_STATE_DIR/monitor.status" ]; then
      head -n1 "$CXW_STATE_DIR/monitor.status" | awk '{ print $1 }'
    else
      echo "missing"
    fi
  }

  # ---------------------------------------------------------------- scenario 1
  echo "chaos: scenario 1 — baseline"
  "$CXW_OPS_BIN" health > "$OUT/s1.txt" 2>&1
  rc=$?
  bash "$HERE/monitor.sh" > "$OUT/s1m.txt" 2>&1
  s1_status=$(monitor_status)
  obs=""
  [ "$rc" -eq 0 ] || obs="$obs health exit $rc;"
  grep -q '\[alert:' "$OUT/s1.txt" && obs="$obs $(grep -c '\[alert:' "$OUT/s1.txt") alert line(s);"
  [ "$s1_status" = "ok" ] || obs="$obs monitor.status=$s1_status;"
  if [ -z "$obs" ]; then
    record "1 baseline" "health exit 0, no alert, monitor.status ok" "exit 0, no alert line, monitor.status ok" PASS
  else
    record "1 baseline" "health exit 0, no alert, monitor.status ok" "$obs" FAIL
  fi

  # ---------------------------------------------------------------- scenario 2
  echo "chaos: scenario 2 — bridge down, alert falls back to email, monitor heals"
  kill "$(cat "$STUB_DIR/bridge.pid")" 2>/dev/null
  sleep 0.5
  "$CXW_OPS_BIN" health > "$OUT/s2a.txt" 2>&1
  bash "$HERE/monitor.sh" > "$OUT/s2b.txt" 2>&1
  sleep 0.5
  "$CXW_OPS_BIN" health > "$OUT/s2c.txt" 2>&1
  obs=""
  grep -q '\[alert:email\].*whatsapp FAILING' "$OUT/s2a.txt" || obs="$obs no email alert;"
  grep -q '\[alert:whatsapp\].*whatsapp FAILING' "$OUT/s2a.txt" && obs="$obs whatsapp channel used while down;"
  grep -q '^HEAL restart bridge' "$OUT/s2b.txt" || obs="$obs no HEAL line;"
  grep -q '^restart bridge$' "$FAKE_CTL_LOG" || obs="$obs ctl not called;"
  grep -q '\[alert:whatsapp\].*whatsapp recovered' "$OUT/s2c.txt" || obs="$obs no recovery alert;"
  s2_status=$(monitor_status)
  [ "$s2_status" = "ok" ] || obs="$obs monitor.status=$s2_status after heal;"
  if [ -z "$obs" ]; then
    record "2 bridge down" "email alert, HEAL restart bridge, ctl called, recovery on WhatsApp, monitor.status ok after heal" \
      "all five observed" PASS
  else
    record "2 bridge down" "email alert, HEAL restart bridge, ctl called, recovery on WhatsApp, monitor.status ok after heal" \
      "$obs" FAIL
  fi

  # ---------------------------------------------------------------- scenario 3
  echo "chaos: scenario 3 — google token 401 then restored"
  : > "$STUB_GOOGLE_FAIL"
  "$CXW_OPS_BIN" health > "$OUT/s3a.txt" 2>&1
  rm -f "$STUB_GOOGLE_FAIL"
  "$CXW_OPS_BIN" health > "$OUT/s3b.txt" 2>&1
  obs=""
  grep -q '\[alert:whatsapp\].*google FAILING' "$OUT/s3a.txt" || obs="$obs no google FAILING alert on whatsapp;"
  grep -q '\[alert:whatsapp\].*google recovered' "$OUT/s3b.txt" || obs="$obs no google recovery alert;"
  if [ -z "$obs" ]; then
    record "3 google unplugged" "google FAILING then recovered, both via WhatsApp" "both observed" PASS
  else
    record "3 google unplugged" "google FAILING then recovered, both via WhatsApp" "$obs" FAIL
  fi

  # ---------------------------------------------------------------- scenario 4
  echo "chaos: scenario 4 — disk pressure triggers the emergency purge"
  CXW_DISK_LIMIT_PCT=0 bash "$HERE/monitor.sh" > "$OUT/s4a.txt" 2>&1
  "$CXW_OPS_BIN" health > "$OUT/s4b.txt" 2>&1
  rc=$?
  owner_media_left=$(find "$CXW_DATA_DIR/media/$OWNER_JID" -type f 2>/dev/null | wc -l | tr -d ' ')
  third_media_left=$(find "$CXW_DATA_DIR/media/$OTHER_JID" -type f 2>/dev/null | wc -l | tr -d ' ')
  purged=$(grep -o '"mediaRows":[0-9]*' "$OUT/s4a.txt" | head -n1 | tr -dc '0-9')
  [ -n "$purged" ] || purged=0
  obs=""
  grep -q '^HEAL purge --emergency' "$OUT/s4a.txt" || obs="$obs no HEAL purge line;"
  [ "$purged" -ge 1 ] || obs="$obs mediaRows=$purged;"
  [ "$owner_media_left" -eq 1 ] || obs="$obs owner media lost ($owner_media_left left);"
  [ "$third_media_left" -eq 0 ] || obs="$obs third-party media kept ($third_media_left left);"
  [ "$rc" -eq 0 ] || obs="$obs disk still failing after restore (exit $rc);"
  if [ -z "$obs" ]; then
    record "4 disk pressure" "HEAL purge --emergency, mediaRows>=1, owner media survives, then recovery" \
      "mediaRows=$purged, owner files=$owner_media_left, third-party files=$third_media_left" PASS
  else
    record "4 disk pressure" "HEAL purge --emergency, mediaRows>=1, owner media survives, then recovery" "$obs" FAIL
  fi

  # ---------------------------------------------------------------- scenario 5
  echo "chaos: scenario 5 — alert dedupe over three failing runs"
  : > "$STUB_GOOGLE_FAIL"
  : > "$OUT/s5.txt"
  for i in 1 2 3; do
    "$CXW_OPS_BIN" health >> "$OUT/s5.txt" 2>&1
    echo "--- run $i ---" >> "$OUT/s5.txt"
  done
  rm -f "$STUB_GOOGLE_FAIL"
  n=$(grep -c '\[alert:' "$OUT/s5.txt" | tr -d ' ')
  if [ "$n" -eq 1 ]; then
    record "5 alert dedupe" "exactly 1 alert across 3 failing runs" "$n alert line" PASS
  else
    record "5 alert dedupe" "exactly 1 alert across 3 failing runs" "$n alert lines" FAIL
  fi

  # ---------------------------------------------------------------- scenario 6
  echo "chaos: scenario 6 — monthly cost cap alerts once, then stays quiet"
  "$NODE_BIN" --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.env.CXW_OPS_DB);
    db.exec(`CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      source TEXT NOT NULL,
      chat_jid TEXT,
      routine TEXT,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0
    )`);
    db.prepare("INSERT INTO usage (ts, source, model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?)")
      .run(Date.now(), "chaos", "claude-fable-5-1", 1000, 1000, 0.02);
    db.close();
    console.log("seeded 1 usage row, cost_usd=0.02");
  ' > "$OUT/s6seed.txt" 2>&1 || {
    echo "chaos: cost seeding failed" >&2
    cat "$OUT/s6seed.txt" >&2
  }
  CXW_COST_MONTHLY_CAP_USD=0.01 "$CXW_OPS_BIN" costs check > "$OUT/s6a.txt" 2>&1
  CXW_COST_MONTHLY_CAP_USD=0.01 "$CXW_OPS_BIN" costs check > "$OUT/s6b.txt" 2>&1
  first=$(grep -c '\[alert:' "$OUT/s6a.txt" | tr -d ' ')
  second=$(grep -c '\[alert:' "$OUT/s6b.txt" | tr -d ' ')
  obs=""
  [ "$first" -eq 1 ] || obs="$obs first run produced $first alert line(s);"
  grep -q '\[alert:.*cost' "$OUT/s6a.txt" || obs="$obs first alert does not mention cost;"
  [ "$second" -eq 0 ] || obs="$obs second run produced $second alert line(s);"
  if [ -z "$obs" ]; then
    record "6 cost cap" "one cost alert on the first check, none on the second" \
      "1 alert then 0" PASS
  else
    record "6 cost cap" "one cost alert on the first check, none on the second" "$obs" FAIL
  fi

  print_summary
  echo
  echo "captured output: $OUT (removed on exit)"
}

# invoked from the EXIT trap in run_local
# shellcheck disable=SC2329
local_cleanup() {
  for name in bridge brain google all; do
    if [ -f "$STUB_DIR/$name.pid" ]; then
      kill "$(cat "$STUB_DIR/$name.pid")" 2>/dev/null || true
    fi
  done
  if [ -n "${TMP:-}" ] && [ -d "$TMP" ]; then rm -rf "$TMP"; fi
}

# ====================================================================================
# BOX MODE — real services, root only
# ====================================================================================
# invoked from the EXIT trap in run_box
# shellcheck disable=SC2329
box_restore() {
  echo "chaos: restoring"
  if [ -f /srv/cxw/google.env.chaos ]; then
    mv -f /srv/cxw/google.env.chaos /srv/cxw/google.env || true
    chown root:root /srv/cxw/google.env || true
    chmod 0600 /srv/cxw/google.env || true
  fi
  rm -f /srv/cxw/data/chaos.fill
  systemctl start cxw-bridge.service 2>/dev/null || true
  systemctl start cxw-brain.service 2>/dev/null || true
  echo "chaos: restore done"
}

run_box() {
  if [ "$IKNOW" -ne 1 ]; then
    echo "chaos: --box kills live services. Re-run with --box --i-know if you mean it." >&2
    exit 2
  fi
  if [ "$(id -u)" -ne 0 ]; then
    echo "chaos: --box must run as root" >&2
    exit 1
  fi

  trap 'box_restore' EXIT INT TERM
  MON=/srv/cxw/repo/deploy/hetzner/monitor.sh
  OUTB=$(mktemp -d /tmp/cxw-chaos-box.XXXXXX)

  # ---------------------------------------------------------------- bridge
  echo "chaos: killing cxw-bridge"
  systemctl kill cxw-bridge.service
  sleep 5
  "$MON" > "$OUTB/bridge.txt" 2>&1
  if grep -q 'HEAL restart bridge' "$OUTB/bridge.txt" && systemctl is-active --quiet cxw-bridge.service; then
    record "box: bridge killed" "monitor heals cxw-bridge" "bridge active again" PASS
  else
    record "box: bridge killed" "monitor heals cxw-bridge" "bridge not restored — see $OUTB/bridge.txt" FAIL
  fi

  # ---------------------------------------------------------------- google
  echo "chaos: moving google.env aside"
  mv /srv/cxw/google.env /srv/cxw/google.env.chaos
  "$MON" > "$OUTB/google.txt" 2>&1
  if grep -q 'FAIL google' "$OUTB/google.txt"; then
    record "box: google unplugged" "google check fails and alerts" "FAIL google observed" PASS
  else
    record "box: google unplugged" "google check fails and alerts" "google check did not fail" FAIL
  fi
  mv -f /srv/cxw/google.env.chaos /srv/cxw/google.env
  chown root:root /srv/cxw/google.env
  chmod 0600 /srv/cxw/google.env

  # ---------------------------------------------------------------- disk
  echo "chaos: filling the disk to within 1 GB of full"
  avail=$(df -B1 /srv/cxw/data | awk 'NR == 2 { print $4 }')
  fill=$((avail - 1073741824))
  if [ "$fill" -gt 0 ]; then
    fallocate -l "$fill" /srv/cxw/data/chaos.fill
    "$MON" > "$OUTB/disk.txt" 2>&1
    if grep -q 'HEAL purge --emergency' "$OUTB/disk.txt"; then
      record "box: disk pressure" "monitor runs purge --emergency" "HEAL line observed" PASS
    else
      record "box: disk pressure" "monitor runs purge --emergency" "no HEAL line — see $OUTB/disk.txt" FAIL
    fi
    rm -f /srv/cxw/data/chaos.fill
  else
    record "box: disk pressure" "monitor runs purge --emergency" "skipped: less than 1 GB free" FAIL
  fi

  print_summary
  echo
  echo "captured output: $OUTB"
}

if [ "$MODE" = "local" ]; then
  run_local
else
  run_box
fi

[ "$FAILED" -eq 0 ] || exit 1
exit 0
