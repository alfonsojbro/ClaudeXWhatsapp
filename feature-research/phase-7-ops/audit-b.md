# Audit — Phase 7, Implementer B (deploy scripts + ops units)

Branch `phase-7-ops`, worktree `/Users/alfonsobriceno/ClaudeXWhatsapp/.worktrees/phase-7-ops`.
No git commands were run. No file under `apps/` was read or edited.

## Files changed

Created:

- `deploy/hetzner/alert.sh`
- `deploy/hetzner/cxw-ctl`
- `deploy/hetzner/sudoers.d/cxw-ctl`
- `deploy/hetzner/security-check.sh`
- `deploy/hetzner/install-ops.sh`
- `deploy/hetzner/ops.env.example`
- `deploy/hetzner/chaos.sh`
- `deploy/hetzner/chaos/stub-services.mjs`
- `deploy/hetzner/chaos/fake-ctl.sh`
- `deploy/hetzner/chaos/cxw-ops-local.sh`
- `deploy/hetzner/test/cxw-ctl.test.sh`
- `deploy/hetzner/systemd/cxw-purge.service`
- `deploy/hetzner/systemd/cxw-purge.timer`
- `deploy/hetzner/systemd/cxw-sentinel.service`
- `feature-research/phase-7-ops/audit-b.md` (this file)

Modified (replaced):

- `deploy/hetzner/monitor.sh`
- `deploy/hetzner/systemd/cxw-monitor.service`
- `deploy/hetzner/systemd/cxw-monitor.timer` — rewritten with byte-identical content to the
  Phase 0 version (the 10-minute schedule was already correct), so git reports it unchanged.

Not mine: `pnpm-lock.yaml` shows as modified in `git status`. That is Implementer A's
`pnpm install` for `apps/ops`, not my edit.

## What changed, per file

**`deploy/hetzner/cxw-ctl`** — the only privileged action the `cxw` user gets. `set -euo
pipefail`, strict nested `case` allowlist: `start|stop|restart|status|is-active` ×
`bridge|brain|scheduler|sentinel|backup|monitor.timer|purge.timer|backup.timer` →
`systemctl <action> cxw-<unit>`; bare `backup` → `systemctl start cxw-backup.service`;
`vacuum-journal` → `journalctl --vacuum-size=200M`. Everything else (including >2 args, an
argument after `backup`/`vacuum-journal`, and no args at all) exits 64 and logs
`denied: $*` via `logger` when `logger` exists. `SYSTEMCTL`/`JOURNALCTL` overrides are read
only under `CXW_CTL_TEST=1`; outside test mode it refuses to run as non-root (exit 77).

**`deploy/hetzner/sudoers.d/cxw-ctl`** — `cxw ALL=(root) NOPASSWD: /usr/local/bin/cxw-ctl`
plus `Defaults!/usr/local/bin/cxw-ctl !requiretty`.

**`deploy/hetzner/test/cxw-ctl.test.sh`** — 51 assertions: all 40 action×unit pairs, `backup`,
`vacuum-journal`, and 9 denial cases (`stop sshd`, `restart "bridge; rm"`, `reboot`, empty,
unknown action, too many args, argument-after-`backup`, argument-after-`vacuum-journal`,
unit with no action).

**`deploy/hetzner/monitor.sh`** (replaces Phase 0) — `set -uo pipefail`, always exits 0.
Drives `"$CXW_OPS_BIN" health` (text mode) into a `mktemp -d` scratch dir, echoes it to
stdout, collects `^HEAL ` lines (`sort -u`), applies the restart budget, heals, sleeps
`CXW_HEAL_RECHECK_S`, re-runs `health --no-alert`, and writes `$CXW_STATE_DIR/monitor.status`
(`ok <utc>` / `fail <utc>` + one line per problem). Budget: `$CXW_STATE_DIR/restart-budget.log`
holds `<epoch> <action>` lines, max 3 per action per rolling hour, counted and pruned with
`awk`; on exhaustion it calls `"$CXW_OPS_BIN" alert-test "heal budget exhausted for <action>"`.
`restart brain` is skipped whenever `$CXW_STATE_DIR/panic` exists. `purge --emergency` also
runs `ctl vacuum-journal`. The ctl invocation is `$CXW_SUDO "$CXW_CTL" "$@"` with a
`# shellcheck disable=SC2086` (deliberate word splitting; `CXW_SUDO` may be empty). The Phase 0
`logger -t cxw-monitor`, `monitor.status`, systemd-unit, tailscale and ufw checks are kept, each
behind `command -v`. bash-3.2-safe: no `mapfile`, no `declare -A`, no `${var,,}`, no `date -d`,
no `df --output`, and a newline-delimited string instead of an array (bash 3.2 errors on an
empty array under `set -u`).

**`deploy/hetzner/alert.sh`** — `exec "${CXW_OPS_BIN:-/usr/local/bin/cxw-ops}" alert-test "$@"`.

**`deploy/hetzner/security-check.sh`** — PASS/FAIL/SKIP per line, exit 1 on any FAIL.
`--repo` runs only the four static checks: pino redaction (`redact` with a `paths` list under
`apps/*/src packages/*/src`, SKIP when no logger exists yet); every `mcp/*/src/*.ts` matching
`send_`/`gmail_send`/`calendar_create` by name or content must mention `confirm` (SKIP when
none exists yet); `deploy/hetzner/sudoers.d/cxw-ctl` present and parsing under `visudo -c -f`
(SKIP when visudo is absent); every `deploy/hetzner/*.sh` sets `-euo`/`-uo pipefail`. Box mode
adds env-file modes, ufw (active / default deny / no non-tailscale allow rules), `ss -tlnp`
listeners outside loopback+tailscale (port 22 excluded), sudoers installed 0440 root:root,
`/usr/local/bin/cxw-ctl` 0755 root:root, and `$CXW_ROOT/state` cxw-owned 0700. `stat` is
probed GNU-first then BSD (`stat -c` → `stat -f`), and mode checks only run in box mode.

**`deploy/hetzner/install-ops.sh`** — root-only, idempotent. Installs `cxw-ctl` 0755 root:root;
validates the sudoers file with `visudo -c -f` on a temp copy before installing it 0440
root:root; writes the `/usr/local/bin/cxw-ops` wrapper (`cd $REPO/apps/ops && exec
$REPO/node_modules/.bin/tsx src/cli.ts "$@"`, no setuid, runs as the caller); installs the five
units; appends only the keys from `ops.env.example` that are absent from `/srv/cxw/cxw.env`,
adds `CXW_ALERT_CMD` when missing, and re-asserts root:root 0600; ensures `/srv/cxw/state`
0700 cxw:cxw; `daemon-reload`; `enable --now cxw-monitor.timer cxw-purge.timer
cxw-sentinel.service`; prints a summary of everything it did.

**systemd units** — `cxw-monitor.service`: oneshot, `User=cxw`,
`EnvironmentFile=/srv/cxw/cxw.env` + `-/srv/cxw/google.env`, `WorkingDirectory=/srv/cxw/repo`,
`SyslogIdentifier=cxw-monitor`, `ReadWritePaths=/srv/cxw/data /srv/cxw/state /srv/cxw/repo
/home/cxw`. `cxw-monitor.timer`: 10 min, unchanged. `cxw-purge.service`/`.timer`:
`ExecStart=/usr/local/bin/cxw-ops purge`, user cxw, daily `03:30` with `Persistent=true`.
`cxw-sentinel.service`: simple, user cxw, `ExecStart=/usr/local/bin/cxw-ops sentinel`,
`Restart=always`, `After=…cxw-bridge.service` with no brain dependency.

**`deploy/hetzner/ops.env.example`** — header "append these to /srv/cxw/cxw.env (install-ops.sh
does this)", every new §B/§H/§I key with its default, `CHANGEME` for `SMTP_PASS`,
`TELEGRAM_BOT_TOKEN` and `BRIDGE_TOKEN`. Keys already in `cxw.env.example` are listed in a
comment as "not repeated" rather than duplicated.

**`deploy/hetzner/chaos/stub-services.mjs`** — dependency-free ESM. bridge 17801
(`GET /health`, `POST /send` appending to `$STUB_LOG`), brain 17802 (`GET /health`), google
17803 (`POST /token`, 401 `invalid_grant` while `$STUB_GOOGLE_FAIL` exists). `--only
bridge|brain|google` starts one service and writes `$STUB_DIR/<name>.pid`; `--help` prints usage.

**`deploy/hetzner/chaos/fake-ctl.sh`** — appends every call to `$FAKE_CTL_LOG`, respawns the
bridge/brain stub on `restart`/`start`, kills it on `stop`, ignores the rest. Always exits 0.

**`deploy/hetzner/chaos/cxw-ops-local.sh`** — `exec "$REPO/node_modules/.bin/tsx"
"$REPO/apps/ops/src/cli.ts" "$@"`, `REPO` derived from the script path.

**`deploy/hetzner/chaos.sh`** — `--local` fails fast with a clear message when
`apps/ops/src/cli.ts` or `node_modules/.bin/tsx` is missing, then creates a temp
`CXW_DATA_DIR`/`CXW_STATE_DIR`, seeds `bridge.sqlite` through `node --no-warnings -e` with
`node:sqlite` `DatabaseSync` (3 third-party rows + 1 owner row, ts in unix seconds 30 days
back, each with a real media file whose mtime is also backdated), starts the three stubs,
writes the owners file and a fresh `last-backup`, exports the §I2 env, and runs the five
scenarios, calling `"$CXW_OPS_BIN" health` and `deploy/hetzner/monitor.sh` directly. PASS/FAIL
is decided by grepping captured stdout; a Markdown table goes to stdout; an `EXIT INT TERM`
trap kills the stubs and removes the temp dir; exit 1 if any scenario fails.
`--box --i-know` implements the real versions (`systemctl kill cxw-bridge`, `mv google.env`
aside, `fallocate` to within 1 GB of full) with a restoring trap; it refuses without
`--i-know` (exit 2) and when not root (exit 1). **`--box` was never run.**

## Verification (run from the worktree root, Node 22.23.2, shellcheck 0.11.0)

### 1. shellcheck

```
$ shellcheck deploy/hetzner/monitor.sh deploy/hetzner/alert.sh deploy/hetzner/security-check.sh \
    deploy/hetzner/install-ops.sh deploy/hetzner/chaos.sh deploy/hetzner/cxw-ctl \
    deploy/hetzner/chaos/*.sh deploy/hetzner/test/*.sh
shellcheck: clean, exit 0
```

Note: `shellcheck deploy/hetzner/*.sh` (what CI runs) still exits 1, but only because of
**pre-existing** findings in files outside my scope — `backup.sh:22` and `restore.sh:18`
SC1090, `bootstrap.sh:26` SC1091. Verified those three alone also exit 1 before any of my
changes. Not fixed: those files are explicitly out of scope (plan §G).

### 2. `bash -n` (macOS `/bin/bash` 3.2)

```
ok  deploy/hetzner/alert.sh
ok  deploy/hetzner/backup.sh
ok  deploy/hetzner/bootstrap.sh
ok  deploy/hetzner/chaos.sh
ok  deploy/hetzner/install-ops.sh
ok  deploy/hetzner/monitor.sh
ok  deploy/hetzner/restore.sh
ok  deploy/hetzner/security-check.sh
ok  deploy/hetzner/cxw-ctl
ok  deploy/hetzner/chaos/cxw-ops-local.sh
ok  deploy/hetzner/chaos/fake-ctl.sh
ok  deploy/hetzner/test/cxw-ctl.test.sh
```

### 3. `bash deploy/hetzner/test/cxw-ctl.test.sh`

```
cxw-ctl.test.sh: 51 passed, 0 failed
(exit 0)
```

### 4. `bash deploy/hetzner/security-check.sh --repo`

```
security-check: mode=repo repo=/Users/alfonsobriceno/ClaudeXWhatsapp/.worktrees/phase-7-ops

PASS pino redaction: redact config with `paths` found
SKIP confirm token: no send/create MCP tool implementations exist yet (mcp/*/src)
PASS sudoers: deploy/hetzner/sudoers.d/cxw-ctl parses (visudo -c)
PASS deploy scripts: all of deploy/hetzner/*.sh set -euo/-uo pipefail

security-check: 3 passed, 0 failed, 1 skipped (repo mode)
exit=0
```

### 5. stubs smoke test

```
$ node deploy/hetzner/chaos/stub-services.mjs --help     # prints usage, exit 0
$ node deploy/hetzner/chaos/stub-services.mjs &          # all three
$ curl -s http://127.0.0.1:17801/health
{"ok":true,"connected":true,"selfJid":"10000000000@s.whatsapp.net","uptimeSec":1,"sentToday":0,"dailyCap":200}
$ curl -s -X POST -d '{"jid":"x","text":"hi"}' http://127.0.0.1:17801/send
{"ok":true,"ids":["stub"]}
$ curl -s http://127.0.0.1:17802/health
{"ok":true,"sessions":0}
$ curl -s -X POST -d '{}' http://127.0.0.1:17803/token
{"access_token":"stub","expires_in":3600,"token_type":"Bearer"}
```

### 6. `bash deploy/hetzner/chaos.sh --local` — exit 0, all five scenarios PASS

Implementer A's `apps/ops` had landed, so this ran for real against the CLI.

```
chaos: seeding /var/folders/.../cxw-chaos.dbN6jK/data/bridge.sqlite
seeded 3 third-party rows + 1 owner row (30 days old)
chaos: scenario 1 — baseline
  -> PASS: 1 baseline — exit 0, no alert line
chaos: scenario 2 — bridge down, alert falls back to email, monitor heals
  -> PASS: 2 bridge down — all four observed
chaos: scenario 3 — google token 401 then restored
  -> PASS: 3 google unplugged — both observed
chaos: scenario 4 — disk pressure triggers the emergency purge
  -> PASS: 4 disk pressure — mediaRows=3, owner files=1, third-party files=0
chaos: scenario 5 — alert dedupe over three failing runs
  -> PASS: 5 alert dedupe — 1 alert line

## Chaos run — local mode — 2026-09-03T03:27:27Z

| Scenario | Expected | Observed | Result |
| --- | --- | --- | --- |
| 1 baseline | health exit 0, no alert | exit 0, no alert line | PASS |
| 2 bridge down | email alert, HEAL restart bridge, ctl called, recovery on WhatsApp | all four observed | PASS |
| 3 google unplugged | google FAILING then recovered, both via WhatsApp | both observed | PASS |
| 4 disk pressure | HEAL purge --emergency, mediaRows>=1, owner media survives, then recovery | mediaRows=3, owner files=1, third-party files=0 | PASS |
| 5 alert dedupe | exactly 1 alert across 3 failing runs | 1 alert line | PASS |

**All scenarios passed.**
```

### 7. fail-fast path and `--box` guard

```
$ bash <copy of chaos.sh in a tree with no apps/ops> --local
chaos: /tmp/.../apps/ops/src/cli.ts is missing.
chaos: the ops CLI (Implementer A) must exist before the local chaos run.
exit=1

$ bash deploy/hetzner/chaos.sh --box
chaos: --box kills live services. Re-run with --box --i-know if you mean it.
exit=2
```

## Deviations from the plan, and why

1. **`chaos.sh --local` exports `CXW_DISK_LIMIT_PCT=100` in the base env.** §I2 only specified
   `CXW_DISK_LIMIT_PCT=0` for scenario 4. Without a base override the dev Mac's real disk
   (90.4 % used, over the 85 % default) made scenarios 1, 2, 3 and 5 fail on the `disk` check.
   `100` means "used ≥ 100 %", i.e. never; scenario 4 still overrides it to `0`. Commented in
   the script.
2. **`cxw-monitor.service` and `cxw-sentinel.service` set `NoNewPrivileges=false` and
   `RestrictSUIDSGID=false`**, unlike `cxw-brain.service`. Both units call
   `sudo -n /usr/local/bin/cxw-ctl`, and sudo is setuid — `NoNewPrivileges=true` would break
   every self-heal and every kill-switch action silently. The rest of the hardening block
   (`ProtectSystem=strict`, `ProtectKernelTunables`, `ProtectControlGroups`, `PrivateTmp`,
   `UMask=0077`, the `ReadWritePaths` list) matches `cxw-brain.service`. Commented in both units.
3. **`security-check.sh` excludes port 22 from the "public listener" check.** sshd on `0.0.0.0:22`
   is expected on the box and is fenced off by ufw, which is checked separately. Without the
   exclusion the check would fail on every healthy box.
4. **`cxw-ctl` exits 77, not 64, when run as non-root.** 64 is reserved for "denied by the
   allowlist" so an operator can tell a policy denial from a wrong-user invocation.
5. **`cxw-ctl` denies `backup <anything>` and `vacuum-journal <anything>`** and any invocation
   with more than two arguments. Not stated in the plan; it closes the "extra argument slips
   through" shape of the allowlist.
6. **`fake-ctl.sh` also handles `start`/`stop` for bridge and brain**, not just `restart`. Costs
   nothing and makes the fake usable for future scenarios.
7. **`stub-services.mjs` also serves `POST /` on the google stub** (in addition to `/token`), so
   a `CXW_GOOGLE_TOKEN_URL` without the path still works.
8. **`security-check.sh --repo` skips all mode/ownership checks**, as instructed, so the same
   script is usable on a Mac; `stat` is still probed GNU-first then BSD for box mode.

## Open risks and questions

1. **CI's `shellcheck deploy/hetzner/*.sh` step is already red** on `backup.sh`, `restore.sh`
   and `bootstrap.sh` (SC1090/SC1091), independent of this branch. My files are clean, but the
   CI step will still fail until a Phase 0 owner adds `# shellcheck source=/dev/null` (or
   `disable=SC1090,SC1091`) to those three. I did not touch them — out of scope.
2. **CI does not shellcheck `deploy/hetzner/cxw-ctl`, `chaos/*.sh` or `test/*.sh`** (the glob is
   `*.sh` at one level, and `cxw-ctl` has no extension). Widening the glob and running
   `bash deploy/hetzner/test/cxw-ctl.test.sh` in CI would be worth a follow-up, but
   `.github/workflows/ci.yml` is outside my file list.
3. **`install-ops.sh` was never executed** — there is no box and no root here. Its logic is
   `bash -n`- and shellcheck-clean only. The `visudo -c -f`, `install`, and
   `systemctl enable --now` paths are unverified end to end.
4. **`chaos.sh --box` is untested by construction.** It is guarded twice (`--i-know` + root) and
   restores in a trap, but the first real run should be watched by a human.
5. **`monitor.sh` re-check clears the problem list before re-populating it.** If the re-check
   itself crashes (non-zero with no `FAIL` lines) the status file records
   "cxw-ops health exited N after heal" and loses the pre-heal detail. Acceptable; the pre-heal
   detail is still in the journal and on stdout.
6. **The restart budget is per action, not per unit.** `restart bridge` and `restart brain` have
   independent budgets, which matches §I2's "per action per hour" wording; if the intent was
   per unit the two are the same thing here.
7. **`ops.env.example` ships `BRIDGE_TOKEN=CHANGEME`.** If the bridge does not require a token,
   an operator who leaves the placeholder in place will have ops send
   `Authorization: Bearer CHANGEME`. Whether A's `config.ts` treats `CHANGEME` as unset is worth
   confirming during review.
