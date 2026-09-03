# Review 2 — Phase 7 (Hardening + ops), fix loop 1

Reviewer: fresh context. Date 2026-09-03. Branch `phase-7-ops`, worktree
`/Users/alfonsobriceno/ClaudeXWhatsapp/.worktrees/phase-7-ops`. Read-only.
Scope = the staged diff (`git diff --cached`), i.e. the union of `plan.md` §A + §H/§I additions,
`fix-plan-1.md` "Files touched", and the "Files changed" lists of `audit-a2.md` / `audit-b2.md`.

## Verdict

**fix-then-ship** — one blocking defect (a one-line fix in `retention.ts`), five should-fix.
All of B1–B5, S1–S9 from review-1 are genuinely fixed; I re-ran or reproduced each one.

## What I ran

| Command                                                     | Result                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------- |
| `pnpm --filter @cxw/ops test`                               | 7 files, **83 tests**, pass, 4.3 s, no open handles              |
| `pnpm --filter @cxw/ops typecheck`                          | clean                                                            |
| `pnpm exec eslint apps/ops`                                 | clean                                                            |
| `pnpm exec prettier --check apps/ops docs README.md deploy` | clean except pre-existing `docs/IMPLEMENTATION_PLAN.md`          |
| `bash deploy/hetzner/test/cxw-ctl.test.sh`                  | 52 passed, 0 failed                                              |
| `bash deploy/hetzner/security-check.sh --repo`              | 3 pass, 0 fail, 1 skip, exit 0                                   |
| `bash deploy/hetzner/chaos.sh --local`                      | exit 0, six scenarios PASS; table byte-identical to the run doc  |
| `shellcheck` on all deploy scripts                          | only the three pre-existing Phase 0 SC1090/SC1091 findings       |
| targeted `tsx` probes                                       | see each item below                                              |
| `monitor.sh` against stub ops bins                          | green run → `ok`; `purge` exit 2 → logged, monitor still exits 0 |

## Round-1 items — verification

| Item                                                 | State                               | Evidence                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1 monitor reports `fail` when green                 | **fixed**                           | stub ops printing only `OK` lines → `monitor.status` = `ok <utc>`, rc=0, no `integer expected`. `monitor.sh:51-57` early-returns 0 on an empty list. Chaos scenario 1 and 2 now assert it.                                                                                                                                                  |
| B2 empty owners deletes the archive                  | **fixed**                           | `retention.ts:122-128` refuses before opening the db. CLI: `purge` → rc=2, stdout 0 bytes, stderr `refusing to purge: owner list is empty (check CXW_OWNERS_FILE)`. Rows survive, no `last-purge.json`. Tests cover missing file, dry run, and the deliberate `ownerForever=false` path.                                                    |
| B3 sentinel drops panic when the ack fails           | **fixed**                           | `sentinel.ts:165-179` runs `panic()` first, ack `.catch()`ed. Probe with `BRIDGE_URL=http://127.0.0.1:1`: panic flag written, ctl log `stop scheduler`,`stop brain`, ack failure logged at warn. `runSentinel` and `executeHit` now have tests.                                                                                             |
| B4 `cxw-ctl status` pager escape                     | **fixed**                           | `cxw-ctl:16-18` exports `PATH`, `SYSTEMD_PAGER=cat`, `SYSTEMD_PAGERSECURE=1`; `:56` execs `status --no-pager --lines=20`; `:32-42` honours `SYSTEMCTL`/`JOURNALCTL` only when `CXW_CTL_TEST=1` **and** EUID≠0, else exits 77 for a non-root caller. Test 52/52 including the "override ignored" guard. Sudoers adds `Defaults!… env_reset`. |
| B5 `BRIDGE_TOKEN=CHANGEME`                           | **fixed**                           | `config.ts:104-111` `secret()` maps `changeme/change-me/change_me/todo/xxx` → unset; `ops.env.example` ships `BRIDGE_TOKEN=`, `SMTP_PASS=`, `TELEGRAM_BOT_TOKEN=` empty; `grep -c CHANGEME deploy/hetzner/ops.env.example` = 0.                                                                                                             |
| S1 cap warning never reaches the owner               | **fixed, with a gap**               | `checkCap`/`notifyCap` split as specified; `recordUsage` writes the pause flag but no marker (probe confirms flag written, no `cost-*` marker); `monitor.sh:159-161` runs `costs check` on every tick; chaos scenario 6 asserts one alert then none. See **S-2** and **S-3** below for two remaining gaps.                                  |
| S2 pino on stdout                                    | **fixed**                           | `logger.ts:34-41` `destination({ dest: 2, sync: true })`. `cxw-ops health --json` with a corrupt owners file and `LOG_LEVEL=info`: stdout parses as JSON, logs on stderr. Caveat in NOTES 3.                                                                                                                                                |
| S3 `install-ops.sh` newline                          | **fixed**                           | `install-ops.sh:79-89` `ensure_trailing_newline()` before both appends; read loop is `                                                                                                                                                                                                                                                      |     | [ -n "$line" ]`. |
| S4 kill switch from any chat                         | **fixed**                           | `sentinel.ts:109-111` requires `isOwnerJid(row.jid)`. The audit's deviation 1 (chat JID must be an owner; `from_me` alone never qualifies) is the correct call — the fix plan's literal OR would still have matched "panic" sent to a stranger, because outgoing rows carry our own JID in `sender`. Tests cover both directions.           |
| S5 dangling `media_path` / dry-run `last-purge.json` | **fixed**                           | `retention.ts:254-260` clears both spellings after the orphan walk; `:155` guards `last-purge.json` with `!dryRun`. Tests for both.                                                                                                                                                                                                         |
| S6 SQLite busy timeout                               | **fixed**                           | `db.ts:27-31` `PRAGMA busy_timeout = 5000` on every open, both stores. Behaviourally untested (needs a competing writer) — accepted.                                                                                                                                                                                                        |
| S7 panic reason logged                               | **fixed**                           | `killswitch.ts:114` logs `{ by, reasonLength }`. Test output shows `"reasonLength":11`, no `reason`.                                                                                                                                                                                                                                        |
| S8 vacuous redaction check                           | **fixed**                           | `security-check.sh:80-102` iterates `apps/*/src packages/*/src mcp/*/src`, requires `redact`+`paths` per package that mentions pino, one PASS/FAIL line each, SKIP only when nobody uses pino.                                                                                                                                              |
| S9 test gaps                                         | **fixed for A's four**              | `runSentinel`/`executeHit`, purge-with-empty-owners, the TZ month test (`costs.test.ts:227`), and the `cxw-ctl` non-test-mode guard all exist. Chaos now asserts `monitor.status`. One remaining false-confidence test: see S-1.                                                                                                            |
| media-path containment                               | **partially fixed**                 | escapes outside `dataDir` are refused and counted in `skipped` (verified), but everything inside `dataDir` is still fair game. See **BLOCKING B-1**.                                                                                                                                                                                        |
| §I1 extensions (`purge` exit 2, `skipped`)           | **honoured in code, stale in docs** | `monitor.sh` treats a non-zero `purge` as a logged heal failure and still exits 0 (verified with a stub that exits 2). Docs not updated: see S-5.                                                                                                                                                                                           |

---

## BLOCKING

### B-1. Media containment still allows the purge to delete `bridge.sqlite` and the Baileys session

`apps/ops/src/retention.ts:55-63` — `resolveMediaPath()` accepts any path that resolves under
`path.resolve(cfg.mediaDir)` **or** `path.resolve(cfg.dataDir)`.

`MEDIA_DIR` defaults to `$CXW_DATA_DIR/media`, so the `dataDir` root adds nothing legitimate and
buys back exactly the class of file the control exists to protect: `bridge.sqlite`,
`ops.sqlite`, and `session/` (the Baileys credentials) all live directly under `dataDir`.

Reproduced (row with `media_path = '../bridge.sqlite-decoy'`, 400 days old, third-party chat):

```
resolveMediaPath(cfg, '../bridge.sqlite-decoy')
  -> /…/data/bridge.sqlite-decoy          (accepted)
purge: {"textRows":1,"mediaRows":1,"files":1,"bytes":5,"skipped":0}
decoy file still exists: false            (deleted)
```

`media_path` is written by Phase 1 from the Baileys message key id, which the _sender_ chooses.
A hostile id containing `../` therefore reaches this function, and the code comment two lines
above says so ("data written by a remote party"). One aged message is enough to make the nightly
`cxw-purge.timer` unlink the entire message store or log the account out.

The fix plan mandated both roots, so this is a plan defect rather than an implementer error, but
it must not ship as is.

**Fix** (`retention.ts:57`):

```ts
const roots = [path.resolve(cfg.mediaDir)];
```

and add a regression test: a row whose `media_path` is `../bridge.sqlite` is counted in `skipped`
and the file survives. Update `apps/ops/README.md:44` ("inside `MEDIA_DIR` or `CXW_DATA_DIR`") to
match.

---

## SHOULD-FIX

### S-1. The brain handler and a _running_ sentinel still double-fire

`apps/ops/src/sentinel.ts:196-228`. `runSentinel` reads `sentinel.json` once, at boot, and then
keeps `handled` in memory; it never re-reads the file. `handleOpsCommand` writes the id to that
file. So the brain→sentinel direction is unprotected whenever the sentinel is already running,
which is the normal case (it is a `Restart=always` unit).

Reproduced (sentinel running, row inserted, brain handles `panic` with `messageId`):

```
brain reply: true
… "by":"owner"    → ctl: stop scheduler, stop brain
… "by":"sentinel" → ctl: stop scheduler, stop brain      (5 s later)
stop-scheduler count: 2
```

The owner also receives the `🛑 Panic…` ack twice. Both actions are idempotent, so this is noise
rather than damage — but plan §D5, `docs/ARCHITECTURE.md:350` and `docs/RUNBOOK.md:513`/`:530` all
state that the two paths "never double-fire" and "whichever gets there first wins", which is
currently false.

The test that is supposed to cover this (`apps/ops/test/sentinel.test.ts:109`, "is shared between
the brain handler and the sentinel") only exercises `markHandled`/`isHandled` against the file; it
never runs the loop, so it passes while the real path is broken.

**Fix**: merge the persisted set into the in-memory state at the top of each poll —

```ts
const persisted = readSentinelState(cfg);
if (persisted !== null) state = { lastSeen: state.lastSeen, handled: persisted.handled };
```

— or have `pollOnce` consult `isHandled(cfg, row.id)`. Then extend the `runSentinel` test with a
`markHandled` before the loop sees the row.

### S-2. A failed alert delivery silently burns the once-a-month cost notification

`apps/ops/src/costs.ts:297-315`. `notifyCap` writes `cost-warned-<YYYY-MM>` /
`cost-paused-alerted-<YYYY-MM>` **before** calling `deliver`, and never looks at the result.
`deliver()` does not throw when every channel fails — it returns `{ channel: null }`.

Reproduced (cap 1, spend 2, no SMTP, no Telegram, bridge unreachable):

```
alert delivery failed on every channel
notify #1 delivered= true  level= paused
notify #2 delivered= false          <- owner never got the first one
markers: [ 'cost-paused', 'cost-paused-alerted-2026-09', 'cost-warned-2026-09' ]
```

This is the same failure mode S1 was raised for, moved one layer out: the most likely time for
the alert chain to be down is exactly when things are wrong. Fix: only claim the marker when the
callback reports success (`deliver` already returns `{ channel }`; make the callback's resolved
value meaningful and skip the marker when `channel === null`).

### S-3. `cxw-ops costs check` prints nothing once the month's notification is spent

`apps/ops/src/cli.ts:123-129` — `if (result.delivered && result.text !== null) out(result.text)`.
`docs/RUNBOOK.md:648-650` tells the operator to run `costs check` to see the cap state, but on
every run after the first it prints nothing at all and exits 0, even while the month is paused.
Fix: always print `result.text` (or a one-line level summary) and keep `delivered` as the only
thing the markers gate.

### S-4. A symlinked data dir silently disables media retention

`apps/ops/src/retention.ts:55-63` compares `path.resolve` results only, never `fs.realpath`. If
`/srv/cxw/data` (or any parent) is a symlink — an attached volume is the obvious case — and the
bridge stores absolute paths, every row is refused.

```
CXW_DATA_DIR=<symlink to real data dir>, stored abs path = real path
resolveMediaPath(...) -> null        (all media rows skipped, forever)
```

The only signal is `logger.warn({ skipped })`. Trailing slashes are fine (verified). Fix:
compare `fs.realpathSync(root)` against `fs.realpathSync(path.dirname(resolved))`, falling back
to the current string compare when the path does not exist.

### S-5. Docs drift on exactly the two §I1 extensions and on the cap markers

- `docs/ARCHITECTURE.md:262` still documents the purge JSON as
  `{ dryRun, emergency, textRows, mediaRows, files, bytes }` with exit **0**. It now carries
  `skipped` and exits 2 on refusal (`apps/ops/README.md:18` has it right).
- `docs/RUNBOOK.md:575` repeats the old field list; §14 never mentions the refusal, which is the
  one new way a purge can fail.
- `docs/ARCHITECTURE.md:389` says `cost-warned-<YYYY-MM>` is "written by `checkCap()` … read by
  `checkCap()`" — after the split it is written and read by `notifyCap()`, and
  `cost-paused-alerted-<YYYY-MM>` is missing from the table entirely (§7's threshold table too).
- `docs/RUNBOOK.md:727` still says the local chaos run "runs five scenarios"; there are six.

### S-6. `security-check.sh` has no `CHANGEME` check on the box

Deliberate (audit-b2 deviation 2: the fix plan listed only S8 for that file), but review-1's B5
asked for it and the example-file fix cannot catch a hand-edited `/srv/cxw/cxw.env` — which still
ships `CLAUDE_CODE_OAUTH_TOKEN=CHANGEME` and `ANTHROPIC_API_KEY=CHANGEME` from Phase 0's
`cxw.env.example`. One box-mode line: FAIL when any `/srv/cxw/*.env` contains `CHANGEME`.

---

## NOTES

1. **Scope is clean.** Every staged path is in the plan's "Files touched" (with the §H/§I
   additions `alert.sh`, `chaos/cxw-ops-local.sh`, `bin/cxw-ops.js`, `pnpm-lock.yaml`) or in the
   fix plan's lists. Review-1's creep (`chaos-local-output.txt`) is gone. The only extra paths are
   `feature-research/phase-7-ops/*.md`, which are the orchestration record, no behaviour.
2. **`monitor.sh` handles `purge` exiting 2 correctly** — verified with a stub: it logs
   `heal failed: purge --emergency`, still runs `vacuum-journal`, and exits 0. It does not `note`
   the refusal, so a purge that has been refusing for weeks shows up in the journal only, never in
   `monitor.status`. One `note "purge refused"` line would close that.
3. **`health --json` is pure JSON in live transport only.** With `CXW_ALERT_TRANSPORT=log` and a
   configured channel, `alerts.ts:132/152/176` write `[alert:…]` to stdout after the JSON object,
   so `--json | jq` breaks in chaos/test mode. Harmless on the box (transport is `live`), but the
   §I1 wording is unqualified.
4. **`monitor.sh:192`** captures the post-heal re-check with `2>&1`, so pino JSON now lands in
   that file and is `cat`ed to the journal. Parsing is unaffected (`FAIL `/`HEAL ` prefixes never
   match a JSON line); cosmetic only. Consider `2>>/dev/stderr`.
5. **`cxw-purge.service` still carries `[Install] WantedBy=multi-user.target`** (review-1 note 8,
   not in the fix plan). Only the timer is enabled, so it is latent; drop the section as
   `cxw-monitor.service` does.
6. **Sudoers `secure_path` omission is justified** (audit-b2 deviation 1): the helper sets its own
   `PATH` and execs both binaries absolutely, which is strictly stronger than a per-command
   `Defaults`. `env_reset` is belt-and-braces given the EUID check inside `cxw-ctl`.
7. **`cxw-ctl.test.sh` still exercises the full allowlist as a non-root caller** (52 cases,
   including the eight units × five actions and nine denials). It cannot exercise the real
   root path — inherent, and the 77-guard is the right trade.
8. **`recordUsage` still writes the pause flag** and **`getPauseState` still ignores a flag from a
   past month**; `checkCap` removes the stale file. Verified by probe.
9. **`chaos.sh --local` output matches `docs/runs/chaos-2026-09-03.md` row for row** (only the
   timestamp differs). Scenario 6 seeds `source = "chaos"`, which is outside the documented
   `'chat' | 'routine'` union — harmless for reads, but a reader may copy it.
10. **`notifyCap` claiming the warn marker at the paused level** (audit-a2 deviation 5) is right:
    spend only grows, so a stale 80 % warning after a pause would be noise.
