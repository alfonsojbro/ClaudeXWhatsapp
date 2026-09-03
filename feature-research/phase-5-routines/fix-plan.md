# Mini-plan — Phase 5 review fixes

From the reviewer's verdict on the staged diff. Blocking items 1-4 must all be fixed. The non-blocking
items listed here are also in scope because each is a real defect that is cheap to fix now; everything
the reviewer raised that is NOT listed here is deliberately deferred and must be recorded as such.

## Blocking

**B1. The service exits within a second of starting.** `apps/scheduler/src/scheduler.ts` calls
`this.timer.unref?.()` on the only periodic handle, and signal listeners do not ref the event loop, so
`main.ts` drains and exits. Under `Restart=always` this is a permanent 5-second crash loop.
Fix: add `unrefTimer?: boolean` to the scheduler deps, default **false**, and set it true only from the
tests that need it. Production must keep the tick timer ref'd.
Prove it: a test that runs the real `main.ts` entry (or the exact same start path) and asserts the
process is still alive after more than one tick interval.

**B2. One LLM job freezes the whole scheduler.** `tick()` awaits `processSpool()`, which awaits
`Promise.allSettled(started)`, and `tick()` is guarded by `this.ticking`. A 12-minute brief therefore
blocks routine reload, cron enqueue, calendar polling and every other spool item, so `health-check`
slots silently fall outside their 1-minute catch-up window and are neither run nor recorded as skipped.
Fix: `processSpool` registers each job promise in the existing `inFlight` set and returns without
awaiting them. `stop()` already awaits `inFlight`. Add an explicit `async idle()` helper for the tests
instead of relying on `tick()` to block, and update the existing tests to await it.
Prove it: a test where a long-running fake job is in flight and a later tick still enqueues and runs a
`health` routine.

**B3. Run logs are committed to git.** `.gitignore` has no rule for `vault/runs/**`, and `runs.ts`
writes the complete result body there — triaged mail, quoted WhatsApp messages, attendee addresses,
journal entries. Section 3.7 of `docs/IMPLEMENTATION_PLAN.md` has the box commit and push after every
vault write, and `scripts/check-secrets.sh` matches credential shapes only, so nothing stops it.
Fix: add to `.gitignore`:
    vault/runs/**
    !vault/runs/README.md
`.gitignore` is hereby added to the Files touched list for this phase.

**B4. A restart during delivery re-runs the LLM and re-delivers.** The spool row survives a crash
between `finishRun(done)` and `remove(item)`; `markStaleRunning` only touches `running` rows, so
`openRun` finds the `done` row and unconditionally calls `reopenRun`, re-running the whole Opus job.
Fix in `openRun`: if the existing row is `done`/`needs_input` **and** `delivered_at` is set, remove the
spool item and return without running. If it is `done`/`needs_input` with `delivered_at` null, move the
item straight to `stage: 'deliver'` carrying the already-produced text (read it back from the run log
body) rather than re-running the job.
Prove it: a test that simulates a crash in each of those two windows and asserts the runner call count
stays at 1.

## Non-blocking, also in scope

**N1. `parseReminder` DST bug** (`apps/brain/src/commands/reminder.ts`). It takes the timezone offset at
`now`, not at the target instant, so a reminder set across a DST boundary lands an hour off in both the
stored `once` value and the confirmation message. `parseLocalDateTimeInTz` in
`apps/scheduler/src/schedule.ts` already has the two-pass fix — reuse it: resolve the offset, parse,
then re-resolve the offset at the parsed instant and re-parse. Add a test crossing the
2026-10-25 Europe/Prague boundary.

**N2. A health alert can be lost forever** (`scheduler.ts`). State is stored before the alert is sent and
`sendAlert` swallows delivery errors, so a single failed send means that failure is never alerted again.
Persist the new health state only after the alert send succeeds.

**N3. No timeouts on Google REST calls** (`google.ts`). Add `AbortSignal.timeout(...)` to every fetch, as
`deliver.ts` already does.

**N4. Same-instant meetings collide** (`calendar-trigger.ts`). The slot key is `event.start`, so with the
spool's `UNIQUE(name, slot, trigger)` a second meeting at the same instant is silently dropped while
still being marked fired. Include the event id in the dedupe key so both produce a prep.

**N5. `meeting-prep.md` promises fields that are never sent.** Either request `location` and
`description` in `google.ts` `listEvents` and include them in the payload `calendar-trigger.ts`
serialises, or delete those claims from the routine body. Prefer sending the fields.

**N6. A bad `LOG_LEVEL` crashes startup** (`log.ts`). Validate against pino's levels and fall back to
`info` with a warning.

**N7. `CXW_ALERT_EMAIL_TO=CHANGEME`** in `deploy/hetzner/cxw.env.example` produces a live config value
that always fails at Gmail. Comment the line out, the way the file already does for `CXW_ALERT_CMD`.

**N8. Bridge port trap.** `config.ts` derives fallback port 7801, which matches nothing that will exist:
the env example and the box use 7411. Change the fallback to **7411** and note it in the audit, so the
repo has one answer. `BRIDGE_URL` stays the override.

**N9. `start()` does not align to the minute boundary**, contrary to plan.md. Align it, or state in the
audit that it is deliberate.

**N10. `evening-close.md` ends with a Rules block**, so the `STATUS: needs_input` instruction is
mid-body. Move it to the last line. Tighten the test so it asserts the STATUS instruction is on the last
non-empty line of every `kind: llm` routine, not merely present somewhere.

**N11. `run <name>` executes a paused routine.** Keep the behaviour, but say so in the reply, e.g.
`Queued <name> (currently paused). Result in about a minute.`

## Explicitly deferred, record in the audit, do NOT fix here

- Retention and pruning of `runs`, `fired_events`, `health_state` and `vault/runs/**` — section 4 of
  `docs/IMPLEMENTATION_PLAN.md` puts retention in Phase 7.
- Unit tests for `google.ts` and `calendar-trigger.ts` in isolation beyond what B/N above require.
- The three extra test files added outside the original Files touched list stay; they are tests only.
- The pre-existing `format:check` failures on seven files this phase did not touch.
