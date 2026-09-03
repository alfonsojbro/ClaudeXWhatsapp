# Mini-plan 2 — second review pass

The second review confirmed B1, B2, B3, N1-N3 and N5-N11 are correctly fixed, and that the N4 spool
migration is safe. It found one blocking defect plus seven smaller ones. All of them are in scope here.

## Blocking

**C1. `runs` has no `dedupe` column, so N4 nets out to zero.** The `spool` gained `dedupe`, but
`findRunBySlot` (`apps/scheduler/src/runs.ts`) still keys on `(name, slot, trigger)`. Two meetings at
the same instant produce two spool rows sharing a name, slot and the `calendar` trigger. On a later
tick, `recoverFinishedRun` looks up the second item, finds the FIRST meeting's `done` and delivered run
row, takes the `deliveredAt !== null` branch, removes the spool item and returns. The second prep is
never run and never delivered. Verified end to end against the real scheduler: two spool rows, one
runner call, one delivery, one run row.

The same key defect independently affects `openRun` and `history`: without the fix both meetings share
one `runs` row, so `history meeting-prep` shows one entry and the first prep's log path and cost are
overwritten.

Fix: carry `dedupe` into `runs` as schema version 3, using the same rebuild pattern `upgradeSpool`
already uses (a database written by commit `c636f5e` has a v2 `runs` table without the column, so a real
migration is required — do not simply widen the v2 schema). Thread `item.dedupe` through `startRun`,
`findRunBySlot` and `recordSkipped`, and through both call sites in `scheduler.ts`. Also key `inFlight`
on `${name}:${dedupe}` rather than `item.name`, so the two preps are not needlessly serialised across
ticks; the per-name lease already serialises them safely.

The current N4 test only asserts on `pendingFor(...)` after one tick and never executes the items.
Extend it: advance the clock to `start - lead`, tick, `idle()`, then assert two runner calls, two
deliveries and two `runs` rows.

## Also in scope

**C2. A crash on a quiet health run delivers raw probe output to WhatsApp.** In `executeHealth`, when
`!report.ok` but no state changed, the run log is written and `finishRun('done')` is called without
`markDelivered`. A crash before `remove` leaves `done` with `delivered_at` null, so on restart
`recoverFinishedRun` re-stages it as `deliver` and the owner receives the raw probe lines that the
health logic deliberately suppressed. Fix: call `markDelivered` on the quiet path, or skip
`recoverFinishedRun` for `kind: health`.

**C3. `diffAndStore` in `apps/scheduler/src/runner/health.ts` is dead code.** `scheduler.ts` imports
`diffHealth` and `storeHealthStates`; nothing imports `diffAndStore` and `src/index.ts` exports nothing
from `health.ts`. Delete it.

**C4. `unrefTimer` is a knob nothing turns.** No test sets it, so the flag adds an untested branch on
the exact code path that caused B1. Either have the test that needs it set it, or delete the option and
hard-code the ref'd timer.

**C5. `main.test.ts` proves liveness and nothing else.** Its temp vault has an empty `routines/`, so the
test would still pass if every tick threw inside `tick()`'s catch. Add one `kind: static` routine due at
boot and assert a run row appears, making it a real smoke test.

**C6. The `main.ts` entry guard breaks on paths containing a space.** `import.meta.url` is
percent-encoded and a raw `` `file://${entry}` `` is not, so on such a checkout `main()` never runs, the
process exits 0, and systemd loops silently with nothing in the journal. Use `pathToFileURL(entry).href`
from `node:url`. Apply the same fix to any other module using this guard, including the stub in
`apps/brain/src/index.ts` if it has the same shape.

**C7. No test covers the spool rebuild.** Every test opens a fresh `:memory:` database, so
`upgradeSpool`'s rebuild branch never executes in the suite. Add `apps/scheduler/tests/db.test.ts`:
create the v1 table shape, insert rows, call `migrate()` twice, and assert ids, row count, both indexes
and the schema version. Cover the new v3 `runs` rebuild the same way.

**C8. Document the alert path that can never fire.** With no `CXW_ALERT_EMAIL_TO` configured and the
WhatsApp probe down, `sendAlert` falls through to the bridge, which is down by definition, so the state
is never stored and no "recovered" message is ever sent either. That behaviour is acceptable, but say so
explicitly in the health section of `apps/scheduler/README.md`.

## Out of scope

Everything in the "Explicitly deferred" section of `fix-plan.md` stays deferred: retention and pruning,
isolated unit tests for `google.ts` and `calendar-trigger.ts`, and the pre-existing `format:check`
failures on seven untouched files.
