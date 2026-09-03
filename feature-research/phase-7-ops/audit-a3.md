# Audit A3 — Implementer A, fix loop 2 (Phase 7 ops)

Scope: `review-2.md` items **B-1, S-1, S-2, S-3, S-4**, per `fix-plan-2.md` "Files touched —
Implementer A". Worktree `/Users/alfonsobriceno/ClaudeXWhatsapp/.worktrees/phase-7-ops`,
branch `phase-7-ops`. No git commands run, no server started, no dependency added.

## Files changed

- `apps/ops/src/retention.ts`
- `apps/ops/src/sentinel.ts`
- `apps/ops/src/costs.ts`
- `apps/ops/src/cli.ts`
- `apps/ops/src/index.ts`
- `apps/ops/README.md`
- `apps/ops/test/retention.test.ts`
- `apps/ops/test/sentinel.test.ts`
- `apps/ops/test/costs.test.ts`

Nothing outside `apps/ops/` was touched.

---

## B-1 — media containment root is `MEDIA_DIR` only

**Change** (`retention.ts`): `resolveMediaPath()` now compares against a single root,
`cfg.mediaDir`. `cfg.dataDir` is gone from the roots, so `bridge.sqlite`, `ops.sqlite` and the
Baileys `session/` are out of reach of the purge. The doc comment says why. `apps/ops/README.md`
now reads "Only files under `MEDIA_DIR` are ever unlinked", and the `skipped` field comment plus
the `logger.warn` message say "media directory" instead of "data directory".

**Before** (probe: row with `media_path = '../bridge.sqlite-decoy'`, 400 days old, third-party
chat, decoy file written under `dataDir`):

```
B-1 resolveMediaPath ../bridge.sqlite-decoy -> /…/data/bridge.sqlite-decoy
B-1 purge {"dryRun":false,"emergency":false,"textRows":1,"mediaRows":1,"files":1,"bytes":5,"skipped":0}
B-1 decoy still exists: false
```

**After** (same probe):

```
B-1 resolveMediaPath ../bridge.sqlite-decoy -> null
B-1 purge {"dryRun":false,"emergency":false,"textRows":1,"mediaRows":0,"files":0,"bytes":0,"skipped":1}
B-1 decoy still exists: true
```

**Regression test** — `retention.test.ts` › "refuses a media_path that climbs out of the media dir
into the data dir": a row whose `media_path` is `../bridge.sqlite` (the real store) is counted in
`skipped`, `files`/`mediaRows` stay 0, the store file still exists and the owner row survives.

---

## S-1 — running sentinel and brain handler no longer double-fire

**Change** (`sentinel.ts`): `pollOnce` takes an optional 4th argument `cfg`. When given, it reads
`sentinel.json` once per poll and unions the persisted handled ids into the in-memory set before
scanning rows; the union is returned as `next.handled`, so it is also persisted. `runSentinel`
passes `cfg`, so the loop re-reads the file at the start of every poll. Without `cfg` the function
stays pure with respect to the file system (existing callers and tests unchanged).

**Before** (probe: state object created, then `markHandled(cfg,'k1')`, then `pollOnce`):

```
S-1 hits after markHandled: [{"id":"k1","jid":"10000000000@s.whatsapp.net","word":"panic",…}]
```

**After**:

```
S-1 hits after markHandled: []
```

**Regression test** — `sentinel.test.ts` › "skips an id the brain handler marked after the state
object was created": asserts `pollOnce(db, state, owners)` (no cfg) still yields 1 hit — proving
the row is otherwise live — and `pollOnce(db, state, owners, cfg)` yields none and carries `k1`
forward in `next.handled`.

---

## S-2 — a failed alert no longer burns the month's notification

**Change** (`costs.ts`): `notifyCap` calls `deliver` **first** and writes
`cost-warned-<YYYY-MM>` / `cost-paused-alerted-<YYYY-MM>` only on success. A result is treated as a
failure only when it is an object whose `channel` is `null` (what `deliver()` returns when every
channel is down) — a plain callback returning nothing still counts as delivered, so existing
callers are unaffected. A throwing callback is caught, logged at warn, and counts as a failure
instead of propagating out of the monitor tick. The paused-level warn-marker claim moved inside
the success branch too.

**Before** (probe: cap 0.01, spend above it, no channel configured):

```
S-2 notify #1 delivered= true  level= paused
S-2 notify #2 delivered= false          <- owner never got the first one
S-2 markers: [ 'cost-paused', 'cost-paused-alerted-2026-09', 'cost-warned-2026-09' ]
```

**After**:

```
S-2 notify #1 delivered= false level= paused
S-2 notify #2 delivered= false text= true
S-2 markers: [ 'cost-paused' ]           <- only the pause flag; the alert retries
```

**Regression test** — `costs.test.ts` › "does not burn the month marker when every alert channel is
down": a `{ channel: null }` callback leaves both markers absent and reports
`status: 'delivery failed'`; the next call with a working callback delivers exactly once and the
one after that reports `already notified this month`.

---

## S-3 — `costs check` always prints a status line

**Change**: `costs.ts` gains `NotifyCapStatus` (`notified` | `already notified this month` |
`delivery failed` | `no alert needed`), a `status` field on `NotifyCapResult`, and an exported
`capStatusLine()` that formats
`cost: <level> $<total> / $<cap> (<pct>%) — <status>`. `cli.ts` prints it on every
`costs check` run, before the alert text (which is still printed only when delivered). Both are
re-exported from `index.ts`. The rest of the §I1 CLI contract is untouched.

**Before**: second and later runs printed nothing and exited 0, even while the month was paused.

**After** (live CLI, temp state dir):

```
--- check (no spend)
cost: ok $0.00 / $10 (0%) — no alert needed
--- after spend above the cap, no channel configured
cost: paused $12.00 / $10 (120%) — delivery failed
cost: paused $12.00 / $10 (120%) — delivery failed     (retries, marker still unclaimed)
--- warn level with a channel configured
[alert:telegram] ⚠️ cxw: 90% of the monthly cost cap used ($9.00 / $10).
cost: warn $9.00 / $10 (90%) — notified
⚠️ cxw: 90% of the monthly cost cap used ($9.00 / $10).
cost: warn $9.00 / $10 (90%) — already notified this month
```

`deploy/hetzner/chaos.sh` scenario 6 counts `[alert:` lines only, which the new line does not
match, so its 1-then-0 assertion is unaffected.

**Regression test** — `costs.test.ts` › "formats one status line for `costs check`" pins the exact
string for both the `notified` and `already notified this month` cases.

---

## S-4 — a symlinked data dir no longer disables media retention

**Change** (`retention.ts`): both sides of the containment check go through `fs.realpathSync`, via
a `realOrResolve()` helper that falls back to `path.resolve` when the path does not exist. The
candidate is realpath'd through its **parent directory** plus its basename, so a media file that
is itself a symlink is still unlinked as the link it is. The function returns the _resolved_
spelling (not the realpath'd one) so the `seen` de-duplication still matches the paths the orphan
walk builds from `cfg.mediaDir`.

**Before** (probe: `CXW_DATA_DIR` is a symlink, stored path is the real absolute path):

```
S-4 resolveMediaPath(abs real path) -> null      (every media row skipped, forever)
```

**After**:

```
S-4 resolveMediaPath(abs real path) -> /private/tmp/cxw-real-yoDZ9f/media/a.jpg
```

**Regression test** — `retention.test.ts` › "purges absolute paths normally when the data dir is a
symlink": data dir is a symlink to a real volume, the row stores the real absolute path,
`skipped` is 0, `files` is 1 and the file is gone.

---

## Deviations from the fix plan

1. **`pollOnce` gained an optional `cfg` parameter** instead of the merge living only inside
   `runSentinel`. `review-2.md` S-1 offered both shapes; this one satisfies the fix plan's
   requested test literally ("mark an id handled … then `pollOnce` must skip it") without a
   5-second poll wait in the suite, and keeps a single mechanism rather than a merge in the loop
   plus a check in the poll. `runSentinel` passes `cfg`, so the running loop does re-read
   `sentinel.json` at the start of every poll and the union does become the in-memory set, as the
   plan requires.
2. **`resolveMediaPath` returns the resolved path, not the realpath'd one.** Returning the
   canonical path broke the existing "dry run changes nothing" test on macOS, where `/var` is a
   symlink to `/private/var`: the DB path resolved to `/private/var/…` while the orphan walk
   produced `/var/…`, so the same file was counted twice. The realpath is used for the containment
   comparison only.
3. **`notifyCap` catches a throwing `deliver` callback** (logs at warn, counts as a failure)
   rather than letting it propagate. The fix plan only named the `{ channel: null }` case; a throw
   is the same failure with a different shape, and letting it escape would abort the monitor tick.
4. **`NotifyCapResult.status` was added** (and exported as `NotifyCapStatus`) rather than deriving
   the three suffixes in `cli.ts`. `formatCap` stays module-private that way, and the status line
   has one definition. A fourth value, `no alert needed`, covers the `level: 'ok'` case that the
   fix plan's three suffixes did not name.
5. **`apps/ops/README.md` wording** goes slightly beyond the mandated sentence: it also names what
   lives in `CXW_DATA_DIR` and notes the `realpath` comparison, so S-4 is documented next to B-1.

## Gates

```
$ pnpm --filter @cxw/ops typecheck
> tsc --noEmit -p tsconfig.json
(exit 0, no output)

$ pnpm --filter @cxw/ops test
 Test Files  7 passed (7)
      Tests  88 passed (88)
   Duration  5.97s
(83 before; +5 new. No open handles.)

$ pnpm exec eslint apps/ops
(no output, exit 0)

$ pnpm exec prettier --write apps/ops && pnpm exec prettier --check apps/ops
Checking formatting...
All matched files use Prettier code style!

$ pnpm -r typecheck && pnpm lint
apps/scheduler typecheck: Done
apps/brain typecheck: Done
apps/bridge typecheck: Done
mcp/whatsapp typecheck: Done
mcp/vault typecheck: Done
> eslint .
(exit 0)
```

Probe files used for the before/after evidence were written under `apps/ops/test/__probe*.ts` and
deleted again; they are not in the tree.

## Open risks

1. **`deliveryFailed()` is duck-typed.** Any future `deliver`-shaped callback that returns an
   object with a `channel` property meaning something else would be misread. The only production
   caller is `cli.ts`, which forwards `alerts.deliver`.
2. **The symlink test creates a real symlink**, so it needs a filesystem that supports one. Fine on
   macOS and Linux; it would fail on a Windows runner without developer mode. The repo has no
   Windows CI.
3. **`costs check` on a box with no configured channel now prints `delivery failed` every tick**
   while the cap is exceeded, and retries the alert every 10 minutes. That is the intended
   behaviour (an undelivered warning must not be marked as sent), but it is a change in journal
   volume for a misconfigured box.
4. **`docs/ARCHITECTURE.md` / `docs/RUNBOOK.md` are Implementer B's files** — I confirmed by
   grep that B's in-flight text already describes the status line and the "written only after the
   alert was actually delivered" marker semantics, matching what I implemented, but I did not edit
   them.
