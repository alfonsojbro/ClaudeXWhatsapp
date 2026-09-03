#!/usr/bin/env bash
# cxw-ctl.test.sh — allowlist test for deploy/hetzner/cxw-ctl.
# Runs anywhere (macOS bash 3.2 included): SYSTEMCTL/JOURNALCTL are replaced by `echo`.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
CTL="$here/../cxw-ctl"

pass=0
fail=0

run() {
  CXW_CTL_TEST=1 SYSTEMCTL=echo JOURNALCTL=echo bash "$CTL" "$@" 2>/dev/null
}

expect_ok() {
  local want="$1"
  shift
  local got rc
  got=$(run "$@")
  rc=$?
  if [ "$rc" -eq 0 ] && [ "$got" = "$want" ]; then
    echo "PASS allow: cxw-ctl $* -> $got"
    pass=$((pass + 1))
  else
    echo "FAIL allow: cxw-ctl $* -> rc=$rc out='$got' (want rc=0 out='$want')"
    fail=$((fail + 1))
  fi
}

expect_denied() {
  local label="$1"
  shift
  local got rc
  got=$(run "$@")
  rc=$?
  if [ "$rc" -eq 64 ]; then
    echo "PASS deny: $label"
    pass=$((pass + 1))
  else
    echo "FAIL deny: $label -> rc=$rc out='$got' (want rc=64)"
    fail=$((fail + 1))
  fi
}

for unit in bridge brain scheduler sentinel backup monitor.timer purge.timer backup.timer; do
  for action in start stop restart is-active; do
    expect_ok "$action cxw-$unit" "$action" "$unit"
  done
  # `status` must never be able to open a pager: `less` offers `!command` and `v`,
  # which would be a root shell escape out of a NOPASSWD sudo helper.
  expect_ok "status --no-pager --lines=20 cxw-$unit" status "$unit"
done

expect_ok "start cxw-backup.service" backup
expect_ok "--no-pager --vacuum-size=200M" vacuum-journal

expect_denied "stop sshd" stop sshd
expect_denied "restart 'bridge; rm'" restart "bridge; rm"
expect_denied "reboot" reboot
expect_denied "empty"
expect_denied "unknown action" enable bridge
expect_denied "too many args" restart bridge extra
expect_denied "backup with arg" backup bridge
expect_denied "vacuum-journal with arg" vacuum-journal bridge
expect_denied "unit without action" bridge

# Outside test mode the SYSTEMCTL override must be ignored. As a non-root caller the
# script must refuse with 77 before it ever execs anything, so `echo` is never reached.
outside=$(SYSTEMCTL=echo JOURNALCTL=echo bash "$CTL" status bridge 2>/dev/null)
outside_rc=$?
if [ "$outside_rc" -eq 77 ] && [ -z "$outside" ]; then
  echo "PASS guard: SYSTEMCTL override ignored without CXW_CTL_TEST (rc=77, no output)"
  pass=$((pass + 1))
else
  echo "FAIL guard: SYSTEMCTL override without CXW_CTL_TEST -> rc=$outside_rc out='$outside' (want rc=77, no output)"
  fail=$((fail + 1))
fi

# In test mode the caller must still not be root; this suite never runs as root.
if [ "$(id -u)" -eq 0 ]; then
  echo "FAIL guard: this test suite must not be run as root"
  fail=$((fail + 1))
fi

echo "---"
echo "cxw-ctl.test.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
