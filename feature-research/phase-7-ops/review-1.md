# Review 1 — Phase 7 (Hardening + ops)

Reviewer: fresh context. Date 2026-09-03. Branch `phase-7-ops`, worktree
`/Users/alfonsobriceno/ClaudeXWhatsapp/.worktrees/phase-7-ops`.
Scope = union of plan §A ("Files touched", incl. the §H/§I additions) and the "Files changed"
lists in `audit-a.md` / `audit-b.md`, as seen in `git diff --cached`. Read-only review.

## Verdict

**fix-then-ship** — 5 blocking defects. Four are one-to-five-line fixes; none require redesign.
The architecture is sound and the tests are real (they assert behaviour, not execution).
Everything below was reproduced locally.

## What I ran

| Command                                        | Result                                          |
| ---------------------------------------------- | ----------------------------------------------- |
| `pnpm --filter @cxw/ops test`                  | 7 files, 63 tests, pass, 4.6 s, no open handles |
| `bash deploy/hetzner/test/cxw-ctl.test.sh`     | 51 passed, 0 failed                             |
| `bash deploy/hetzner/security-check.sh --repo` | 3 pass, 0 fail, 1 skip                          |
| `bash deploy/hetzner/chaos.sh --local`         | all 5 scenarios PASS, exit 0                    |
| targeted `tsx` probes against temp dirs        | see B2, B3, S2 below                            |
| `monitor.sh` against a stub ops bin            | see B1                                          |

---

## BLOCKING

### B1. `monitor.sh` reports `fail` on a completely healthy box, every 10 minutes

`deploy/hetzner/monitor.sh:48-50` and `:217-227`.

```sh
problem_count() {
  printf '%s' "$problems" | grep -c '[^[:space:]]' 2>/dev/null || echo 0
}
```

When `$problems` is empty, `grep -c` prints `0` **and exits 1**, so `|| echo 0` appends a second
`0`. `count` becomes the two-line string `0\n0`, `[ "$count" -eq 0 ]` errors with
`integer expression expected`, and the script takes the failure branch.

Reproduced with a stub `cxw-ops` that prints only `OK` lines and exits 0:

```
monitor.sh: line 218: [: 0
0: integer expected
cxw monitor: 0
0 problem(s)
$ cat state/monitor.status
fail 2026-09-03T03:36:08Z
```

Effect: `monitor.status` — the operator's primary signal and the thing the runbook will tell
you to `cat` — permanently reads `fail`, and `logger -p user.err` writes a bogus error to the
journal on every timer tick. The same `problem_count` call at line 143 mis-fires too.
`chaos.sh` never asserts on `monitor.status`, which is why both audits missed it.

Fix (drop the `|| echo 0`; `grep -c` already prints `0`):

```sh
problem_count() {
  [ -n "$problems" ] || { echo 0; return 0; }
  printf '%s' "$problems" | grep -c '[^[:space:]]' 2>/dev/null
}
```

Add a chaos assertion (or a monitor unit test) that a green run writes `ok ` to
`monitor.status`, otherwise this regresses silently.

### B2. A missing or corrupt `owners.json` makes `purge` delete the owner's entire history

`apps/ops/src/retention.ts:30-33` + `:88`, with `apps/ops/src/owners.ts:32-57`.

`loadOwners()` returns `[]` on a missing or unparsable owners file (it only logs a `warn`).
`notOwnerClause([])` then returns the literal `1 = 1`, so
`DELETE FROM messages WHERE ts < cutoff AND 1 = 1` deletes **everything** older than 180 days,
owner chats included, despite `CXW_RETENTION_OWNER_FOREVER=true`.

Reproduced (owners file absent, one owner row + one stranger row, both 400 days old):

```
purge result {"dryRun":false,"emergency":false,"textRows":2,...}
rows left: []
```

This runs unattended from `cxw-purge.timer` at 03:30 daily. A restore that forgets
`state/owners.json`, a truncated write, or pairing not yet done is enough to lose the archive
the whole product exists to keep. `alerts.ts` degrades safely in the same situation (no owner →
no WhatsApp send); retention does the opposite.

Fix in `purge()`, before touching the database:

```ts
const owners = cfg.retention.ownerForever ? loadOwners(cfg) : [];
if (cfg.retention.ownerForever && owners.length === 0) {
  logger.error({ file: cfg.ownersFile }, 'refusing to purge: owner allowlist is empty');
  return result; // zeros; let the monitor alert on it
}
```

Add the regression test (`owners file missing → textRows === 0`, owner rows still present).

### B3. The sentinel silently drops a `panic` when the ack cannot be sent

`apps/ops/src/sentinel.ts:132-140` with `:176`.

`runSentinel` persists the new state (with the message id already in `handled`) **before**
executing the hit. `executeHit` then does `await sendAck(...)` _first_; `sendAck` calls `fetch`
with no try/catch, so a refused connection or a 5 s `AbortSignal.timeout` rejects, `executeHit`
throws, the outer `catch` logs `sentinel poll failed`, and `panic()` never runs — and never will,
because the id is already marked handled.

Reproduced (bridge URL pointing at a closed port, owner row with text `panic`):

```
{"level":50,...,"err":"fetch failed","msg":"sentinel poll failed"}
panic flag exists: false
ctl calls: (none)
sentinel.json: { "lastSeen": ..., "handled": [ "m1" ] }
```

The sentinel exists precisely for the case where things are broken. A bridge that still records
incoming messages but fails `POST /send` (rate limit, 5xx, slow send, daily cap) turns the kill
switch into a no-op with no owner-visible signal.

Fix — the ack must never gate the action:

```ts
export async function executeHit(cfg, owners, hit) {
  if (hit.word === 'panic') {
    await sendAck(cfg, owners, PANIC_ACK).catch((err) =>
      logger.warn({ err: String(err) }, 'panic ack could not be delivered'),
    );
    await panic('sentinel kill switch', 'sentinel', cfg);
    return;
  }
  await resume(cfg);
  await sendAck(cfg, owners, '▶️ Resumed.').catch(() => {});
}
```

Consider also only persisting `handled` after the action succeeds, so a crash retries.
`executeHit` and `runSentinel` currently have **no** test coverage — only the pure `pollOnce`
and `isKillSwitchText` are tested. Add one.

### B4. `cxw-ctl status` execs `systemctl status` as root without `--no-pager`

`deploy/hetzner/cxw-ctl:43-47`.

The sudoers entry gives `cxw` passwordless root on this helper, and the allowlist permits
`status`. `systemctl status` pipes through a pager when stdout is a TTY; `less` offers `!command`
and `v` (editor), which is the textbook sudo-helper shell escape (GTFOBins lists `systemctl` for
exactly this). Whether systemd enables the pager's secure mode here depends on its
`SYSTEMD_PAGERSECURE` heuristics — a privileged helper must not depend on that. Any process
running as `cxw` (i.e. the brain, the bridge, the sentinel) that can allocate a pty gets root.

Two more hardening gaps in the same file:

- `SYSTEMCTL`/`JOURNALCTL` are unqualified (`:27-28`), so the resolved binary depends on `PATH`.
  Ubuntu's default `Defaults secure_path` saves this, but the sudoers file this phase ships does
  not assert it.
- The `CXW_CTL_TEST=1` escape hatch is gated only on an env var (`:22`). `sudo` refuses
  command-line env assignments without `SETENV:` on a default config, but the shipped sudoers
  sets neither `env_reset` nor `SETENV` explicitly.

Fix:

```sh
SYSTEMCTL=/usr/bin/systemctl
JOURNALCTL=/usr/bin/journalctl
export SYSTEMD_PAGER=cat SYSTEMD_PAGERSECURE=1
...
exec "$SYSTEMCTL" --no-pager "$action" "cxw-$unit"
...
exec "$JOURNALCTL" --no-pager --vacuum-size=200M
```

and ignore `CXW_CTL_TEST` when `id -u` is 0:

```sh
if [ "${CXW_CTL_TEST:-0}" = "1" ] && [ "$(id -u)" -ne 0 ]; then ... fi
```

Add to `deploy/hetzner/sudoers.d/cxw-ctl`:

```
Defaults!/usr/local/bin/cxw-ctl env_reset, secure_path="/usr/sbin:/usr/bin:/sbin:/bin"
```

Add a test case to `test/cxw-ctl.test.sh`: without `CXW_CTL_TEST`, `SYSTEMCTL=echo cxw-ctl status
bridge` must exit 77 (proving the override is not honoured outside test mode).

### B5. `ops.env.example` ships `BRIDGE_TOKEN=CHANGEME` and `install-ops.sh` installs it silently

`deploy/hetzner/ops.env.example:30`, `deploy/hetzner/install-ops.sh:77-98`,
`apps/ops/src/config.ts:152`, `apps/ops/src/alerts.ts:136`.

`install-ops.sh` appends every absent key from `ops.env.example` to `/srv/cxw/cxw.env`, so a
fresh install writes `BRIDGE_TOKEN=CHANGEME` into the production secrets file. `config.ts` does
not special-case the placeholder, so ops sends `Authorization: Bearer CHANGEME` on `POST /send`,
and the Phase 1 bridge (which reads the same env file) will accept exactly that token. The
bridge's send API ends up "protected" by a value published in this repo, and nothing ever fails,
so nobody notices.

Fix — pick one:

- drop `BRIDGE_TOKEN` from `ops.env.example` entirely (it is a Phase 1 key; ops already treats it
  as optional), **or**
- have `install-ops.sh` generate it: `BRIDGE_TOKEN=$(openssl rand -hex 32)` when the key is absent.

Either way, make `config.ts` treat `CHANGEME` as unset for `BRIDGE_TOKEN`, `SMTP_PASS` and
`TELEGRAM_BOT_TOKEN`, and add a `security-check.sh` line that FAILs when any `CHANGEME` remains
in `/srv/cxw/*.env`.

---

## SHOULD-FIX

### S1. The cost-cap warning never reaches the owner

`apps/ops/src/costs.ts:203-244`, `recordUsage` at `:123`, `deploy/hetzner/monitor.sh` (no call).

Plan §D4 says `checkCap` is called "by `recordUsage` and by the monitor", and its return text is
the owner-facing warning. `recordUsage` calls it and **discards** the string (audit-a deviation 4),
and the `cost-warned-<month>` marker / `cost-paused` flag then suppress it for every later caller.
`monitor.sh` never runs `cxw-ops costs check` at all. Net effect: at 80 % the owner is told
nothing, and at 100 % the assistant pauses its own routines without a word. The costs test file
even documents the hazard in a comment (`test/costs.test.ts:99`).

Fix: in `monitor.sh`, after the health block:

```sh
cap_msg=$("$CXW_OPS_BIN" costs check 2>/dev/null | grep -E '^(⚠️|🛑)' || true)
[ -z "$cap_msg" ] || alert "$cap_msg"
```

and stop `recordUsage` from consuming the text (write the pending text into the marker, or have
`checkCap` take a `{ peek: true }`).

### S2. pino writes to stdout, so `cxw-ops health --json` is not parseable JSON

`apps/ops/src/logger.ts:28`. §I1 requires `--json` to print "a single JSON object … and nothing
else on stdout". Reproduced with a corrupt owners file:

```
$ cxw-ops health --json 1>out 2>err
$ node -e 'JSON.parse(fs.readFileSync("out"))'
SyntaxError: Unexpected non-whitespace character after JSON at position 568
```

stderr was empty; the pino warn line and the `[alert:…]` batch both went to stdout. Nothing
consumes `--json` today (monitor.sh uses text mode), so this is not blocking — but it will bite
the first person who pipes it to `jq`, and `cxw-ops purge`'s JSON line has the same exposure.

Fix: `pino({...}, pino.destination(2))`. Logs on stderr are also the right thing under
`StandardError=journal`.

### S3. `install-ops.sh` corrupts `cxw.env` when the file has no trailing newline

`deploy/hetzner/install-ops.sh:79-89`. `printf '%s\n' "$line" >> "$ENV_FILE"` assumes the file
already ends in `\n`. Reproduced:

```
TZ=Europe/Prague\nANTHROPIC_API_KEY=sk-secretCXW_OPS_DB=/srv/cxw/data/ops.sqlite\n
```

The API key is silently mangled and the first appended key is lost. Both `*.env.example` files
currently end with a newline, so a clean install is safe — but the file is hand-edited by the
operator, and `install-ops.sh` has never been executed for real (audit-b risk 3).

Fix, before the loop:

```sh
[ -z "$(tail -c 1 "$ENV_FILE")" ] || printf '\n' >> "$ENV_FILE"
```

Same guard for the `CXW_ALERT_CMD` append. Also note the `while read` loop drops the last line of
`ops.env.example` if that file ever loses its trailing newline.

### S4. Kill-switch words fire from any chat, including third-party ones

`apps/ops/src/sentinel.ts:104`. `from_me === 1` means _any_ message the owner's phone sends
anywhere. Sending the single word "resume" to a recruiter, or "panic" to a friend, executes the
production kill switch. This matches plan §D5 literally, but the brain-side handler is gated on
`isOwner` (i.e. the owner's own chat), so the two paths disagree.

Fix: also require the conversation to be an owner chat —
`const fromOwner = isOwnerJid(row.jid, owners) && (row.from_me === 1 || isOwnerJid(row.sender ?? row.jid, owners));`
This keeps the self-chat path (the documented way to use it) and drops the false positives.

### S5. The orphan media walk leaves dangling `media_path` values

`apps/ops/src/retention.ts:202-241`. The walk unlinks by mtime alone and never touches the
database, so any surviving row that points at a removed file keeps a path to nothing (the
brain will fail to open it). Audit-a flags the deletion itself; the dangling pointer is the part
worth fixing, and it is cheap: after the walk, `UPDATE messages SET media_path = NULL WHERE
media_path IN (…removed…)`, or check `SELECT 1 FROM messages WHERE media_path = ?` before
unlinking.

Related, same file: `purge()` writes `last-purge.json` **on a dry run too** (`:113`), overwriting
the record of the last real purge. Guard it with `if (!dryRun)`.

### S6. No SQLite busy timeout on the bridge database

`apps/ops/src/db.ts:16-22`. The daily purge opens `bridge.sqlite` read-write while the bridge is
writing. With no busy timeout, `SQLITE_BUSY` throws immediately, `purge()` propagates, the CLI
exits 1 and `cxw-purge.service` fails — retention just stops happening. Audit-a raises this
(risk 4); I agree it should be fixed now: `new DatabaseSync(file, { readOnly, timeout: 5000 })`
or `db.exec('PRAGMA busy_timeout = 5000')` after open.

### S7. The `panic` reason is owner message text and is logged unredacted

`apps/ops/src/killswitch.ts:113` — `logger.warn({ reason, by }, 'panic: …')`, where `reason`
comes straight from `args.join(' ')` of the WhatsApp message (`commands.ts:108`). `reason` is not
in `REDACT_PATHS`, so arbitrary message content lands in the journal at warn level. Visible in the
test run output: `"reason":"test reason",...,"msg":"panic: stopping scheduler and brain"`.
Everything else I checked is clean — no `log.info/warn/error` call in the package passes a JID or a
message body outside the redact list, and no alert text contains a phone number.

Fix: drop `reason` from the log call, or add `reason`/`*.reason` to `REDACT_PATHS`. The reason is
still preserved in the `panic` flag file (0600, in a 0700 dir), which is the right place for it.

### S8. `security-check.sh`'s redaction check can pass vacuously

`deploy/hetzner/security-check.sh:77-90`. It collects every file under `apps/*/src packages/*/src`
containing `redact`, then passes if **any one** of them also contains `paths`. Now that
`apps/ops/src/logger.ts` exists, this check passes forever regardless of what the bridge, brain or
scheduler loggers do — exactly the case it was written to catch. Fix: require that every
`logger.ts`-shaped file in each app declares `redact` with `paths`, and FAIL (not skip) when an
app has a logger without one.

Two smaller notes on the same script: the ufw rule check (`:199`) accepts any rule whose line
contains the string `tailscale`, which includes an operator-written comment; and the port-22
exclusion in `filter_public_listeners` (`:57`) means a world-exposed sshd is never reported by
that check (it is covered by the ufw check, but only as long as bootstrap's comment text keeps
saying "tailscale").

### S9. Test gaps that map exactly onto the blocking defects

- `runSentinel` / `executeHit`: no coverage (B3).
- `purge` with an empty/missing owners file: no coverage (B2).
- `monitor.sh`: no test at all, and chaos never asserts on `monitor.status` (B1).
- `cxw-ctl` outside `CXW_CTL_TEST=1`: no test proving the `SYSTEMCTL` override is ignored (B4).
- `helpers.ts:47` passes `TZ: 'UTC'` in the config env map, but `state.ts` month/day helpers read
  the **process** time zone — the TZ handling in §D4 is therefore never exercised.

Otherwise the suite is good: the assertions are behavioural (exact cost-line string, exact ctl
call order, row counts and file existence after a purge, one-alert-in-three-ticks), and I could
not find a test that would still pass with its logic removed.

---

## NOTES

1. **Scope.** Everything staged is inside the plan's "Files touched" once §H and §I additions
   (`alert.sh`, `chaos/cxw-ops-local.sh`, `bin/cxw-ops.js`, `pnpm-lock.yaml`) are counted, with one
   exception: `feature-research/phase-7-ops/chaos-local-output.txt` is a scratch capture that is in
   neither list. Harmless, no behaviour, but it is creep — delete it or fold it into the audit.
   Implementer C's deliverables (`docs/RUNBOOK.md`, `docs/ARCHITECTURE.md`,
   `docs/runs/chaos-2026-09-03.md`, the `README.md` Operations section) are not in this diff; C1–C10
   currently live only in `plan.md` and `apps/ops/README.md`.
2. **`NoNewPrivileges=false` on monitor and sentinel: agreed.** Both units must exec setuid `sudo`,
   and `NoNewPrivileges=true` would make every heal and every kill-switch action fail silently. The
   rest of the hardening block matches `cxw-brain.service`, and the comment in each unit explains
   why. The alternative (a setuid-free privileged path via a socket-activated helper) is not worth
   it here. `RestrictSUIDSGID=false` follows for the same reason.
3. **`bfree` vs `bavail` (`health.ts:129`).** `bfree` counts root-reserved blocks, so the reported
   used-% is a few points lower than what `df` shows the `cxw` user. Since the alert is about "will
   the box wedge", and the reserve is only usable by root, `bavail` is the more honest number for a
   non-root service. Either is defensible; if you keep `bfree`, say so in the runbook so nobody
   chases the discrepancy with `df`.
4. **Sentinel `ts` strictness.** `pollOnce` uses `ts > lastSeen`, and Phase 1 stores unix
   **seconds**, so a message written later but stamped in the same second as the last processed row
   is skipped forever. Using `>=` plus the existing `handled` set would close the window at no cost.
5. **Bridge `/health` tolerance is correct.** `checkWhatsApp` requires `ok === true && connected ===
true` and accepts `uptimeSec`/`uptime_s`; it never reads `selfJid`/`jid`, so both Phase 1 shapes
   work. `POST /send` success is `res.ok && body.ok !== false` — matches §I.
6. **Contracts C1–C10 verified as implemented**: `handleOpsCommand` (non-owner → null, unknown verb
   → null, ack-before-stop), `recordUsage` (`total_cost_usd` passthrough, one row per model),
   `getPauseState` (stale cost flag from a past month ignored), `dailyCostLine` (byte-exact format,
   integer cap prints `$100`), pause-flag JSON shapes, both owners-file shapes with digit
   normalisation and `@g.us` exclusion, seconds/ms handling in SQL and in JS. Pricing prefix match
   works including longest-prefix (`claude-fable-5-1` before `claude-fable-5`) and dated ids.
7. **CLI exit codes match §I1**: health 0/1 with delivery errors not affecting the code, `alert-test`
   0 only when a channel accepted, `purge` always 0, unknown command 64. `alert-test` with no
   `health.json` correctly starts at email.
8. **`cxw-purge.service` carries `[Install] WantedBy=multi-user.target`.** Harmless as installed
   (only the timer is enabled), but if anyone runs `systemctl enable cxw-purge.service` it will also
   fire at every boot. Drop the `[Install]` section, as `cxw-monitor.service` correctly does.
9. **`apps/ops/bin/cxw-ops.js` is committed 0644** and imports `../dist/src/cli.js`, which only
   exists after `pnpm build`. Package managers set the exec bit on link, and the deploy path uses the
   `install-ops.sh` tsx wrapper, so this is cosmetic — but the shim will fail confusingly if anyone
   invokes it before building.
10. **Chaos coverage.** The five scenarios are genuine (scenario 4 checks owner media survives _and_
    third-party media is gone, scenario 2 checks the fake-ctl log, scenario 5 counts alert lines).
    Cleanup via the `EXIT INT TERM` trap works and `--box` is double-guarded. Not covered: the
    sentinel, the cost cap, and `monitor.status` — the last of which hid B1.
