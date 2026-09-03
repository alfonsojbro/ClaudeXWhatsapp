# Audit — Implementer B, fix loop 2 (review-2 items S-5, S-6 + chaos re-run)

Worktree `/Users/alfonsobriceno/ClaudeXWhatsapp/.worktrees/phase-7-ops`, branch `phase-7-ops`.
No git commands run. No live server. `chaos.sh --box` never invoked.
`PATH=$HOME/.nvm/versions/node/v22.23.2/bin:$PATH` for every gate.

## Files changed

- `deploy/hetzner/security-check.sh`
- `docs/ARCHITECTURE.md`
- `docs/RUNBOOK.md`
- `docs/runs/chaos-2026-09-03.md`
- `feature-research/phase-7-ops/audit-b3.md` (this file)

Nothing under `apps/` was touched. Implementer A owned `apps/ops` for the whole run.

---

## S-6 — `security-check.sh` CHANGEME checks

Two new checks, plus a `warn()` helper and a `warns` counter (WARN prints a line but does not
count as a failure and never changes the exit code).

**Repo mode, check 5 — "example env"**. Iterates `deploy/hetzner/*.env.example`. Any file
containing `CHANGEME` that is _not_ `cxw.env.example` or `restic.env.example` is a `FAIL`; those
two are Phase 0's and produce a `WARN` line instead.

**Box mode, check 7 — "env secrets"**. Iterates the same `$CXW_ROOT/*.env` list that the
existing mode check builds (reuses `$envs`, so no second glob). Any file containing `CHANGEME` is
a `FAIL`. `SKIP` when no env file exists, so the message is not duplicated with check 6's
`FAIL env files: no …/*.env found`.

Box checks renumbered in comments only: 5→6, 6→8, 7→9, 8→10, 9→11, 10→12 (7 is the new one). No
logic moved.

Both summary lines now read `N passed, N failed, N warned, N skipped`.

### Evidence

```
$ shellcheck deploy/hetzner/security-check.sh      → clean, rc 0
$ bash -n deploy/hetzner/security-check.sh         → rc 0
$ bash deploy/hetzner/security-check.sh --repo
security-check: mode=repo repo=/Users/…/phase-7-ops

PASS pino redaction: apps/ops declares `redact` with `paths` (apps/ops/src/logger.ts)
SKIP confirm token: no send/create MCP tool implementations exist yet (mcp/*/src)
PASS sudoers: deploy/hetzner/sudoers.d/cxw-ctl parses (visudo -c)
PASS deploy scripts: all of deploy/hetzner/*.sh set -euo/-uo pipefail
PASS example env: no CHANGEME placeholder outside the Phase 0 example files
WARN example env: Phase 0 example files still ship CHANGEME (fill them in on the box): cxw.env.example restic.env.example

security-check: 4 passed, 0 failed, 1 warned, 1 skipped (repo mode)
repo exit=0
```

Exit 0 as required, and the two Phase 0 example files produce WARN, not FAIL.
(`grep -c CHANGEME`: `cxw.env.example` 3, `restic.env.example` 1, `ops.env.example` 0.)

Box mode exercised against a scratch `CXW_ROOT` in the session scratchpad (two throwaway `.env`
files, removed afterwards; no repo or system file touched):

```
CXW_ROOT=<scratch> with cxw.env containing CHANGEME:
  FAIL env secrets: CHANGEME placeholder still in: cxw.env
after rewriting cxw.env without it:
  PASS env secrets: no CHANGEME placeholder in <scratch>/*.env
```

The real box path (`/srv/cxw`) is unexecuted — there is no box.

---

## S-5 — docs drift

Every command, flag, path and field below was grepped against the tree before it was written.

### `docs/ARCHITECTURE.md`

| Change                                                                                                                                                                           | Verified against                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| CLI contract table: `purge` JSON gains `skipped`; exit column now `0, **2** on refusal`                                                                                          | `retention.ts:38,119`, `cli.ts:115`, `apps/ops/README.md:18`            |
| CLI contract table: `costs` row now says "the `check` status line"                                                                                                               | `cli.ts:136`                                                            |
| New paragraph under the table: `purge` exit 2 semantics (empty stdout, reason on stderr), what `skipped` counts, and that `monitor.sh` logs a non-zero `purge` and still exits 0 | `retention.ts:122-128,149-151`, `monitor.sh` heal path, review-2 note 2 |
| New paragraph: the exact `costs check` status line and its four `<status>` values                                                                                                | `costs.ts:296-302,325,327,342,352`                                      |
| §5 panic flow: added a line to PATH B saying the sentinel re-reads `state/sentinel.json` at the top of every poll                                                                | `sentinel.ts` (A's S-1 fix)                                             |
| §5 prose: new paragraph explaining the dedupe is the `sentinel.json` handled-id set, re-read per poll, and that whichever path marks first wins                                  | same                                                                    |
| §6 state table: `cost-warned-<YYYY-MM>` written/read by `notifyCap()` (`costs check`), not `checkCap()`, and only after a successful delivery                                    | `costs.ts:305-309, 316-352`                                             |
| §6 state table: new row `cost-paused-alerted-<YYYY-MM>`                                                                                                                          | `costs.ts:307`                                                          |
| §6 state table: `last-purge.json` field list gains `skipped`                                                                                                                     | `retention.ts:155-157` (spreads `result`)                               |
| §6 state table: `sentinel.json` "Read by" now notes the per-poll re-read                                                                                                         | `sentinel.ts`                                                           |
| §7 threshold table: new row for the `cost-paused-alerted-<YYYY-MM>` marker, both markers attributed to `notifyCap()`                                                             | `costs.ts:305-309`                                                      |
| §7 Retention prose: containment sentence now says `MEDIA_DIR` **only**, names `bridge.sqlite` / `ops.sqlite` / `session/` as out of reach, and explains `skipped`                | A's B-1 fix in `retention.ts`, review-2 B-1                             |
| NOTES 3: marker written after delivery succeeds, failed delivery leaves no marker and the next tick retries                                                                      | `costs.ts:342,352` (A's S-2 fix)                                        |

### `docs/RUNBOOK.md`

| Section | Change                                                                                                                                                                                                            |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §13.1   | Dedupe wording: the sentinel re-reads `/srv/cxw/state/sentinel.json` at the top of every 5-second poll instead of trusting its boot-time copy; says plainly what the old behaviour cost (kill switch + ack twice) |
| §14     | Purge JSON line now `{ dryRun, emergency, textRows, mediaRows, files, bytes, skipped }`, with what `skipped` means and that only the count is logged, never the path                                              |
| §14     | New paragraph: a purge can **refuse** — exit 2, empty stdout, `refusing to purge: owner list is empty (check CXW_OWNERS_FILE)` on stderr, nothing deleted, `last-purge.json` not rewritten, dry run included      |
| §14     | New command to spot a refusing purge: `journalctl -u cxw-monitor.service --since -1d \| grep "heal failed: purge"` — the string `heal failed: purge --emergency` is what `monitor.sh` writes                      |
| §15.1   | New block documenting the always-printed status line, its `<level>` values (`ok`/`warn`/`paused`), its four `<status>` values, that the owner text follows only on a delivering run, and exit always 0            |
| §15.1   | New paragraph: the marker is written only after a channel accepted, so a dead alert chain no longer eats the month's only warning                                                                                 |
| §17.1   | "runs five scenarios" → "runs six scenarios (baseline, bridge down, Google token, disk pressure, alert dedupe, monthly cost cap)"                                                                                 |

The `costs check` status-line format was **not** taken from the fix plan. I polled
`apps/ops/src/cli.ts` for A's landing and found `capStatusLine` at `apps/ops/src/costs.ts:297`
(imported at `cli.ts:12`, called at `cli.ts:136`), so the documented format is read from A's
committed code, including the fourth status `no alert needed` that the fix plan did not list.

---

## Chaos re-run

`bash deploy/hetzner/chaos.sh --local` — run once after A's code landed, first attempt, no retry
needed.

```
scenario 1 baseline           PASS
scenario 2 bridge down        PASS
scenario 3 google unplugged   PASS
scenario 4 disk pressure      PASS   (mediaRows=3, owner files=1, third-party files=0)
scenario 5 alert dedupe       PASS
scenario 6 cost cap           PASS   (1 alert then 0)
**All scenarios passed.**
```

A second silent run confirmed `EXIT=0` (the first run's exit code was lost to a shell quirk in
how `PIPESTATUS` was read, so it was re-measured rather than guessed).

The emitted Markdown table is identical to the one already in `docs/runs/chaos-2026-09-03.md`,
row for row; only the summary timestamp differs (`04:23:13Z` vs the recorded `03:55:53Z`). I
therefore left the recorded table untouched and added a short "Re-run after fix loop 2" note
under it stating the re-run, its exit code, what changed in the code since, and the new
timestamp. Rewriting the table would have produced a diff that is nothing but a clock.

Scenario 4 is the one that exercises A's B-1 containment change end to end: the emergency purge
still deletes all 3 third-party media files and still spares the owner's file.

---

## Gates

| Gate                                                                                  | Result                                                                        |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `shellcheck deploy/hetzner/security-check.sh`                                         | clean, rc 0                                                                   |
| `bash -n deploy/hetzner/security-check.sh`                                            | rc 0                                                                          |
| `bash deploy/hetzner/security-check.sh --repo`                                        | 4 passed, 0 failed, 1 warned, 1 skipped, **exit 0**; Phase 0 files WARN       |
| `bash deploy/hetzner/chaos.sh --local`                                                | six scenarios PASS, **exit 0**                                                |
| `prettier --write` on the three docs by name                                          | all three unchanged on the final pass                                         |
| `prettier --check docs/ARCHITECTURE.md docs/RUNBOOK.md docs/runs/chaos-2026-09-03.md` | "All matched files use Prettier code style!", exit 0                          |
| `docs/IMPLEMENTATION_PLAN.md`                                                         | not staged, not modified — prettier was never pointed at the `docs` directory |

Prettier was run on the three files **by name only**, never on `docs`, so the pre-existing
formatting of `docs/IMPLEMENTATION_PLAN.md` is untouched.

---

## Deviations from the plan

1. **Prettier was never run as `--write docs`.** The plan's gate line says
   `pnpm exec prettier --write docs && pnpm exec prettier --check <three files>`, but the same
   instruction forbids letting prettier touch `docs/IMPLEMENTATION_PLAN.md`, and `--write docs`
   would have reformatted it. I ran `--write` on the three files by name. The `--check` gate is
   unchanged and passes.
2. **`docs/runs/chaos-2026-09-03.md` got a note, not a rewrite.** The plan asked me to "confirm
   the table still matches". It does, so I recorded the confirmation rather than replacing an
   identical table with a new timestamp.
3. **Box checks renumbered in comments.** Inserting a repo check as 5 pushed the box comment
   numbers up. Comments only; no check moved between modes and no logic changed.
4. **One extra status value documented.** A's `capStatusLine` emits `no alert needed` below the
   warn threshold, which the fix plan's format string did not mention. Documented it, because a
   RUNBOOK that lists three of four possible outputs is worse than one that lists all four.
5. **A WARN tier was added to `security-check.sh`.** The fix plan called for "a `WARN` line" but
   the script had no such concept — only `pass`/`fail`/`skip`. I added `warn()` and a `warns`
   counter and extended both summary lines. WARN never affects the exit code.

## Open risks

1. **Box mode is still unexecuted against a real box.** The new `env secrets` check was proven
   against a scratch directory only. `/srv/cxw` does not exist yet.
2. **The docs now assert behaviour I did not test myself.** The sentinel per-poll re-read,
   `notifyCap`'s marker-after-delivery, and the `MEDIA_DIR`-only containment are A's code and
   A's tests; I read the source to write the prose but ran no `apps/ops` test. Reviewer round 3
   should check the docs against A's tests, not against my reading.
3. **`docs/ARCHITECTURE.md:475`-ish (§13.1 in RUNBOOK, "they never double-fire")** is now true,
   but only because of A's `sentinel.ts` change. If that change is reverted, this sentence goes
   back to being wrong in two files.
4. **The `journalctl … grep "heal failed: purge"` recipe I added to §14 is untested on a box.**
   The string matches what `monitor.sh` writes and what review-2 note 2 reproduced with a stub,
   but no real journal has ever contained it.
5. **Review-2 note 2 is unaddressed and out of scope**: a purge that has been refusing for weeks
   shows up in the journal only, never in `monitor.status`. That would be a one-line `note`
   change in `monitor.sh`, which is not on my "Files touched" list.
