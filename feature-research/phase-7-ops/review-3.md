# Review 3 — Phase 7 (Hardening + ops), fix loop 2

Reviewer: fresh context. Date 2026-09-03. Branch `phase-7-ops`, worktree
`/Users/alfonsobriceno/ClaudeXWhatsapp/.worktrees/phase-7-ops`. Read-only, no git state changed.
Scope: `review-2.md` B-1 and S-1..S-6, plus regressions from those fixes only.
Sources read: `review-2.md`, `fix-plan-2.md`, `audit-a3.md`, `audit-b3.md`, and
`git diff --cached -- apps/ops deploy/hetzner/security-check.sh docs`.

## Verdict

**ship** — all seven round-2 items are genuinely fixed; I re-ran every reproduction.
One SHOULD-FIX (a narrow false refusal introduced by the S-4 realpath change) and six notes.
Nothing found is worth another loop before merge.

## What I ran

| Command                                        | Result                                                    |
| ---------------------------------------------- | --------------------------------------------------------- |
| `pnpm --filter @cxw/ops test`                  | 7 files, **88 tests**, pass, 3.7 s, no open handles       |
| `pnpm --filter @cxw/ops typecheck`             | clean                                                     |
| `pnpm exec eslint apps/ops`                    | clean                                                     |
| `prettier --check apps/ops docs/... deploy`    | "All matched files use Prettier code style!"              |
| `bash deploy/hetzner/security-check.sh --repo` | 4 passed, 0 failed, 1 warned, 1 skipped, **exit 0**       |
| `bash deploy/hetzner/chaos.sh --local`         | **exit 0**, six scenarios PASS, table matches the run doc |
| targeted `tsx` probes                          | one per item below, plus the regression matrix            |

## Round-2 items — verification

| Item                                            | State     | Evidence (my own re-run)                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B-1** purge can delete `bridge.sqlite`        | **fixed** | `retention.ts:71-80` roots on `cfg.mediaDir` only. Probe (400-day row, `media_path='../bridge.sqlite-decoy'`): `resolve -> null`, `purge {"mediaRows":0,"files":0,"skipped":1}`, decoy **and** `bridge.sqlite` both survive. Test at `retention.test.ts:180`.                                                                                                                     |
| **S-1** brain + running sentinel double-fire    | **fixed** | Live probe: real `runSentinel` loop running, panic row inserted, `handleOpsCommand` handles it. `stop scheduler` count **1** (was 2), only `by:"owner"` in the log, `sentinel.json handled: ["kid1"]`, no second ack. `sentinel.ts:106-110,222`.                                                                                                                                  |
| **S-2** failed delivery burns the month's alert | **fixed** | `costs.ts:329-339` delivers first, claims the marker only on success. Probe: `{channel:null}` twice → `delivery failed` both times, markers `['cost-paused']` only; a working callback then delivers **once** and the next call says `already notified this month`. A throwing callback is caught, logged, counted as failure, markers absent. Test at `costs.test.ts:213`.       |
| **S-3** `costs check` prints nothing            | **fixed** | Real CLI, four runs: `cost: ok $0.00 / $10 (0%) — no alert needed`, `cost: paused $12.00 / $10 (120%) — delivery failed` (twice), `— notified`, `— already notified this month`. Exit 0 every time. `cli.ts:136-137`.                                                                                                                                                             |
| **S-4** symlinked data dir disables retention   | **fixed** | Probe with `MEDIA_DIR` a symlink to a separate volume: relative, symlink-absolute and real-absolute spellings all resolve; end-to-end `purge` → `{"mediaRows":1,"files":1,"skipped":0}`, file gone. Test at `retention.test.ts:205`.                                                                                                                                              |
| **S-5** docs drift                              | **fixed** | Every claim checked against the code: `ARCHITECTURE.md:262,271-278,383,405-406,434-436,520-528` and `RUNBOOK.md:512-534,578-590,670-682,759`. Purge JSON has `skipped` and exit 2, markers attributed to `notifyCap`, `cost-paused-alerted-<YYYY-MM>` present, containment is `MEDIA_DIR`-only, sentinel re-read documented, "six scenarios" corrected. No stale field list left. |
| **S-6** no `CHANGEME` check on the box          | **fixed** | New repo check 5 (`security-check.sh:167-193`) and box check 7 (`:231-247`). Scratch-repo probe with `ops.env.example=CHANGEME` → `FAIL`, **exit 1**, and the Phase 0 `WARN` printed alongside without masking it. Scratch `CXW_ROOT` probe → `FAIL env secrets: CHANGEME placeholder still in: cxw.env`; empty `CXW_ROOT` → `SKIP`, no duplicate message.                        |

## Regression checks requested

**(a) containment matrix** (`retention.ts:71-80`) — probed each case:

| Case                                                                          | Result                                                              |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| media dir does not exist yet, relative `a.jpg`                                | accepted (correct)                                                  |
| media dir does not exist yet, `../escape.bin`                                 | `null` (correct)                                                    |
| media dir is itself a symlink, relative / abs-via-link / abs-via-real         | all three accepted (correct)                                        |
| stored `a/../b.jpg` landing back inside the media dir                         | accepted (correct)                                                  |
| absolute path inside the media dir                                            | accepted (correct)                                                  |
| `../bridge.sqlite`, `../media2/z.jpg`, the media dir itself, `""`, `"."`      | all `null` (correct)                                                |
| symlink **inside** the media dir pointing at `dataDir` (`evil/bridge.sqlite`) | `null` — escape blocked                                             |
| jid dir is a symlink (orphan walk)                                            | `Dirent.isDirectory()` is false for a symlink, so the walk skips it |
| a media file that is itself a symlink                                         | unlinked as the link, target untouched (matches the doc comment)    |
| **file's parent dir missing AND an ancestor is a symlink**                    | **`null` — false refusal, see SHOULD-FIX 1**                        |

**(b) sentinel re-read** — cost is one `readFileSync` + `JSON.parse` of a ~2.4 KB file per 5 s poll
(`sentinel.ts:106`); negligible. A corrupt `sentinel.json` returns `null` from `readJsonFile`
(`state.ts:15-21`) and the loop keeps running: I wrote `{ this is not json` into it under a live
sentinel, waited 6 s, deleted the file, waited 6 s, then inserted a real `panic` row — it fired
correctly (`stop scheduler`, `stop brain`). The set is capped: `MAX_HANDLED = 200`
(`sentinel.ts:13`) applied in `markHandled`, `writeSentinelState` and `pollOnce`'s return.
500 `markHandled` calls → 200 persisted; a 200-id memory set unioned with a 200-id file →
200 out. Bounded.

**(c) `notifyCap` vs the pause flag** — verified: `checkCap` writes `cost-paused` from
`recordUsage` (`costs.ts:136,233-243`) before any notification, so the scheduler pauses even when
every channel is down (`getPauseState -> {"paused":true,"reasons":["cost-cap"]}` with the alert
chain dead). A later successful delivery writes `cost-paused-alerted-<month>` and
`cost-warned-<month>` exactly once, and the next call reports `already notified this month`
without re-sending (counter stayed at 1).

**(d) `costs check` output vs `monitor.sh`** — `monitor.sh:159-161` runs it and only logs a
non-zero exit; stdout goes straight to the journal, nothing parses it. `chaos.sh:325-326` counts
`\[alert:` lines only, which `cost: …` never matches — the six-scenario run passes unchanged.

**(e) `security-check.sh` tiers** — `warn()` (`:39-42`) increments `warns` only; both summaries
print `N passed, N failed, N warned, N skipped` and both exits are gated on `fails`
(`:197-199`, `:328-330`). Proven: a repo with a real FAIL plus the Phase 0 WARN exits 1; the
real repo with only the WARN exits 0.

**(f) docs vs code** — matched line by line, see S-5 above. No claim in `ARCHITECTURE.md` or
`RUNBOOK.md` about these seven behaviours is now false.

---

## BLOCKING

None.

## SHOULD-FIX

### 1. The S-4 realpath change refuses a path whose parent directory is missing, when any ancestor is a symlink

`apps/ops/src/retention.ts:74`

```ts
const candidate = path.join(realOrResolve(path.dirname(resolved)), path.basename(resolved));
```

`realOrResolve` (`:49-56`) tries `realpathSync` on the **immediate** parent and falls back to
`path.resolve` when it does not exist. The root side (`:73`) is always realpath'd. When the
parent is missing the two sides use different spellings, so containment fails:

```
mediaDir exists at /var/folders/…/media   (/var is a symlink to /private/var)
resolveMediaPath(cfg, 'sub/a.jpg')                 -> null      <- should be accepted
resolveMediaPath(cfg, <abs mediaDir>/x/y.jpg)      -> null      <- should be accepted
same probe with no symlinked ancestor              -> accepted  (correct)
```

On the box this bites exactly the configuration S-4 exists for: `/srv/cxw/data` symlinked to an
attached volume. A row whose `MEDIA_DIR/<jid>/` directory is already gone is then counted in
`skipped` instead of having its `media_path` cleared, so `logger.warn('media rows outside the
media directory were skipped')` (`:166-169`) fires for a benign row. No data is lost and nothing
unsafe is unlinked — but `skipped` is the security counter, and a false positive there sends the
operator hunting a `../` attack that never happened. It also contradicts
`RUNBOOK.md:578-582` ("`skipped` counts media rows whose `media_path` did not resolve inside
`MEDIA_DIR`").

**Fix**: canonicalise the parent by climbing to the nearest ancestor that exists, instead of
giving up after one `realpathSync` failure.

```ts
/** realpath of the deepest existing ancestor, with the missing tail re-appended. */
function realOrResolve(p: string): string {
  const resolved = path.resolve(p);
  const tail: string[] = [];
  let dir = resolved;
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...tail);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return resolved;
      tail.unshift(path.basename(dir));
      dir = parent;
    }
  }
}
```

Keep the call site as it is (parent + basename), so "a media file that is itself a symlink is
unlinked as the link it is" still holds. Add a test: media dir behind a symlink, stored path
`<jid>/gone.jpg` whose `<jid>` directory does not exist → `skipped` is 0 and `mediaRows` is 1.

## NOTES

1. **Out-of-scope creep, harmless.** `audit-a3.md` lists `apps/ops/src/index.ts`, which is not in
   `fix-plan-2.md` "Files touched — Implementer A". The change is three added re-exports
   (`capStatusLine`, `NotifyCapResult`, `NotifyCapStatus`, `index.ts:44,63-64`); no behaviour.
   `audit-b3.md` lists `docs/runs/chaos-2026-09-03.md`, which the plan only asked B to _confirm_;
   the edit is a nine-line "Re-run after fix loop 2" note (`:35-42`), no table rewritten. Both
   are recorded rather than acted on.
2. **`runSentinel` passing `cfg` to `pollOnce` is not asserted by any test.** `sentinel.test.ts:168`
   exercises `pollOnce(db, state, owners, cfg)` directly; nothing asserts the one-argument wiring
   at `sentinel.ts:222`, so deleting that argument would leave the suite green and silently
   restore S-1. I verified the wiring live instead. A cheap guard: in the existing
   `runSentinel` test, `markHandled` the id before starting the loop and assert no `ctl` call.
3. **A corrupt `sentinel.json` silently disables the dedupe.** `readJsonFile` swallows the parse
   error (`state.ts:15-21`), so `pollOnce` falls back to the in-memory set and the brain/sentinel
   double-fire returns until the next `markHandled` rewrites the file. The loop does not crash
   (verified). One `logger.warn` in `readSentinelState` when the file exists but does not parse
   would make it visible.
4. **Narrow write race on `sentinel.json`.** `runSentinel` re-reads at the top of a poll and writes
   the union after the actions (`sentinel.ts:240`). A `markHandled` from the brain landing between
   those two points is overwritten. It only matters when the sentinel has a hit in the same poll
   in which the brain marks a _different, newer_ id; the loser id can then be fired twice.
   Milliseconds wide, both actions idempotent. Accept, or make `writeSentinelState` merge with the
   on-disk set before writing.
5. **`costs check` "exit code is always 0"** (`RUNBOOK.md:682`, `apps/ops/README.md:36`) is true for
   the notify path but not for a `checkCap` throw (a corrupt `ops.sqlite`), which `cli.ts:216-219`
   turns into exit 1. `monitor.sh:160` logs that and carries on, so nothing breaks; the sentence
   is just absolute where the code is not.
6. **The repo-mode WARN is permanent.** `cxw.env.example` and `restic.env.example` ship `CHANGEME`
   by design, so `security-check.sh --repo` will print that WARN on every run forever. Intended
   per `fix-plan-2.md`, but a line that is always there is a line nobody reads. Consider dropping
   it once box check 7 is exercised on a real `/srv/cxw`.
7. **Diff granularity.** Every file in scope is staged as a new file (`A`), so `git diff --cached`
   cannot isolate the fix-loop-2 delta from the earlier rounds. I reviewed the final state of each
   file against the round-2 reproductions rather than a per-round diff.

## Review-2 notes still open (not in `fix-plan-2.md`, unchanged, listed so they are not lost)

- Note 2: a purge refusing for weeks appears in the journal only, never in `monitor.status`
  (`monitor.sh` heal path). One `note "purge refused"` line.
- Note 5: `cxw-purge.service` still carries `[Install] WantedBy=multi-user.target`.
- Note 9: chaos scenario 6 seeds `source = "chaos"`, outside the documented `'chat' | 'routine'`
  union (`chaos.sh:316`).
