# Audit — Phase 5 routines, STAGE A1 (core modules + unit tests)

Branch: `phase-5-routines` (worktree `/Users/alfonsobriceno/ClaudeXWhatsapp-phase-5-routines`).
Scope: the foundation modules only. `index.ts`, `main.ts`, `deliver.ts`, `google.ts`, `prompt.ts`,
`calendar-trigger.ts`, `scheduler.ts`, `runner/*`, `apps/brain/**`, `vault/**`, `deploy/**` are
untouched and belong to a later stage.

## Files changed

Created (10 source files):

- `apps/scheduler/src/types.ts`
- `apps/scheduler/src/config.ts`
- `apps/scheduler/src/log.ts`
- `apps/scheduler/src/routine.ts`
- `apps/scheduler/src/schedule.ts`
- `apps/scheduler/src/db.ts`
- `apps/scheduler/src/lease.ts`
- `apps/scheduler/src/spool.ts`
- `apps/scheduler/src/runs.ts`
- `apps/scheduler/src/chunk.ts`

Created (5 test files):

- `apps/scheduler/tests/routine.test.ts`
- `apps/scheduler/tests/schedule.test.ts`
- `apps/scheduler/tests/lease.test.ts`
- `apps/scheduler/tests/spool.test.ts`
- `apps/scheduler/tests/chunk.test.ts`

Created (paper trail):

- `feature-research/phase-5-routines/audit.md` (this file)

Modified: none. No file outside the list above was created, edited, deleted or reformatted. No git
command was run.

## What each file contains

### `src/types.ts`

Shared vocabulary and the four ports. `RunStatus`, `Trigger`, `RoutineKind`, `ModelAlias`,
`SpoolStage`, `CalendarTriggerConfig`, `RoutineFrontmatter`, `Routine`, `RoutineProblem`.
`JobResult` is a discriminated union of `JobSuccess { isError: false, text, costUsd, numTurns,
sessionId }` and `JobFailure { isError: true, error }`. Ports: `JobRunner.run(routine, prompt,
signal)`, `Deliverer.send(to, text)` (throws on failure), `CalendarSource.listEvents(from, to)`,
`Clock.now()`. `CalendarEvent` / `CalendarAttendee` are declared here so stage A2's
`calendar-trigger.ts` and the test fakes share one shape.

### `src/config.ts`

`loadConfig(env = process.env): Config`, pure and zod-validated. Reads only the record given; never
touches the filesystem; never throws for a missing Google or Anthropic credential. Addendum
section 5 names are honoured: `CXW_TZ` -> `TZ` -> `Europe/Prague`; `SCHEDULER_DB` defaults to
`<CXW_DATA_DIR>/scheduler.sqlite`; `BRIDGE_URL` falls back to
`http://${BRIDGE_HOST ?? 127.0.0.1}:${BRIDGE_PORT ?? 7801}`; `CXW_DISK_LIMIT_PCT` is a max-used
percentage defaulting to 85; `CXW_BACKUP_MAX_AGE_H` defaults to 8. Optional values are omitted from
the result object rather than set to `undefined`, as `exactOptionalPropertyTypes` requires.

### `src/log.ts`

`createLogger(name, env)` plus a shared `log`. Level from `LOG_LEVEL`, default `info`. The module
docstring states the privacy rule (no message bodies, prompt text or delivered result text at
`info` or above); nothing in this stage logs any of those.

### `src/routine.ts`

`parseRoutine`, `loadRoutines`, `writeRoutine`, `setEnabled`, `deleteRoutine`, `routineFilePath`,
plus `MODEL_IDS`, `NAME_RE` and a `RoutineError` that carries the offending path. Validation is
exactly as plan.md specifies: exactly one of `schedule`/`once`; cron checked by constructing a
croner `Cron`; timezone checked with `Intl.DateTimeFormat`; `name` matched against
`^[a-z0-9][a-z0-9-]*$` and required to equal the filename stem. Defaults: timezone from config,
`opus`, `tools: []`, `deliver_to: owner`, `enabled: true`, `kind: llm`, `max_turns: 30`,
`catch_up_minutes` 10 for cron and 1440 for once. `loadRoutines` never throws for one bad file: it
returns `{ routines, problems }`. `setEnabled` rewrites only the `enabled:` line inside the
frontmatter block and leaves every other byte — comments, blank lines, line endings — alone;
when no such line exists it appends one.

### `src/schedule.ts`

`nextRun`, `dueSlot`, `describeCron`, `formatInTz`, `tzOffsetMinutes`, plus `isValidCron`,
`isValidTimeZone` and `parseLocalDateTimeInTz`. `dueSlot` implements the outage semantics verbatim:
the candidate slot is `Cron(expr, {timezone}).nextRun(now - catch_up)`, due when it has passed and
is newer than `lastSlot`; the first slot missed during an outage comes back as `missedSlot` so the
caller can record a `skipped` run.

### `src/db.ts`

`openDb(path | ':memory:')`. WAL for file databases (not for `:memory:`, where it is meaningless),
`busy_timeout=5000`, `foreign_keys=ON`. Migrations are `CREATE TABLE IF NOT EXISTS` inside one
transaction, so re-opening an existing database is a no-op; the six tables from plan.md plus
`schema_version` are created, with two supporting indexes.

### `src/lease.ts`

`claimLease` is the single `INSERT ... ON CONFLICT ... WHERE leases.expires_at < @now OR
leases.owner = excluded.owner` from plan.md; claimed iff `changes === 1`. `heartbeatLease` updates
`WHERE name = ? AND owner = ?` and returns false when the lease was lost. `releaseLease` deletes the
owner's own row. `getLease` is a read helper used by the tests and, later, by the scheduler.

### `src/spool.ts`

`enqueue` (`INSERT OR IGNORE`, so the `UNIQUE(name, slot, trigger)` makes it idempotent),
`dueItems`, `pendingFor`, `getItem`, `markFailed`, `toDeliverStage`, `remove`, `backoffMs`.
Backoff is `min(60000 * 2 ** attempts, 1800000)` computed from the post-increment attempt count;
`MAX_ATTEMPTS` is 3 for `run` and 10 for `deliver`, and an item that reaches its ceiling is removed
and reported as `dropped`.

### `src/runs.ts`

`startRun`, `finishRun`, `markDelivered`, `recordSkipped`, `history`, `getRun`, `getState`,
`setState`, `markStaleRunning`, `writeRunLog`, `runLogStamp`. `markStaleRunning` fails every row
left `running` whose routine has no unexpired lease, with error text exactly `stale after restart`.
`writeRunLog` creates `vault/runs/<name>/<YYYY-MM-DDTHH-mm-ssZ>.md` (directories included) with the
frontmatter listed in plan.md and returns the path.

### `src/chunk.ts`

`chunkText(text, max = 3500)`: blank line, then line break, then hard cut. Never returns an empty
chunk, never exceeds `max`, and drops only the whitespace at the split points.

## Deviations from plan.md / the addendum, and why

1. **Extra helpers beyond the named exports.** `schedule.ts` also exports `isValidCron`,
   `isValidTimeZone` and `parseLocalDateTimeInTz`; `spool.ts` also exports `getItem`, `backoffMs`
   and `toDeliverStage`; `runs.ts` also exports `markDelivered`, `getRun` and `runLogStamp`;
   `lease.ts` exports `getLease`; `db.ts` exports `migrate` and `schemaVersion`. These are the
   pieces `scheduler.ts` will need in stage A2 (`toDeliverStage` in particular implements plan.md's
   "a delivery failure converts the spool item to `stage='deliver'`") and they keep the tests from
   reaching into SQL. Nothing named in the plan was renamed or dropped.
2. **`parseLocalDateTimeInTz` lives in `schedule.ts`, not `routine.ts`.** `once` has to be resolved
   against the routine's timezone, and the zone maths already lives in `schedule.ts`. `routine.ts`
   imports it, so the dependency runs one way only (`routine -> schedule -> types`).
3. **`Routine` carries `onceAt` and `modelId` as resolved fields.** The plan describes the file
   format but not the in-memory shape. Resolving the model alias and the `once` instant once at
   parse time keeps `schedule.ts` and the future runners free of that logic.
4. **`writeRoutine` uses a hand-rolled YAML serialiser, not `matter.stringify`.** js-yaml would
   quote and order fields unpredictably and would round-trip `once: 2026-09-05T09:00:00` into a
   `Date`. The serialiser emits a fixed field order and quotes only when needed. The parser accepts
   both a string and a js-yaml `Date` for `once`, so hand-written files keep working either way.
5. **`db.ts` skips WAL for `:memory:`.** WAL is not applicable to an in-memory database. File
   databases get it as specified.
6. **`loadRoutines` skips `README.md`.** `vault/routines/README.md` already exists in the repo and
   is documentation, not a routine; without this it would show up in `problems` on every tick.
7. **`config.ts` derives the repo root from `import.meta.url`, not `process.cwd()`.** The systemd
   unit runs with `WorkingDirectory=/srv/cxw/app`, but a `cwd`-relative default would break when the
   scheduler is started from anywhere else, including tests. Only the defaults for `CXW_VAULT_DIR`
   and `CXW_WORKSPACE_DIR` use it; both are overridable by env.
8. **`log.ts` does not configure pino redaction.** Nothing at this layer receives message content,
   so there is no field to redact. The constraint is expressed as a documented rule instead; the
   modules that do handle result text (`deliver.ts`, `runner/*`) arrive in stage A2 and must honour
   it.
9. **`runs.ts` has no dedicated test file.** The stage brief lists exactly five test files and
   `runs.test.ts` is not among them, so I did not add one. I verified `startRun` / `finishRun` /
   `recordSkipped` / `history` / `getState` / `setState` / `markStaleRunning` / `writeRunLog` by
   hand with a throwaway script in the scratchpad (not committed): the stale-run sweep fails an
   unleased `running` row with `stale after restart` and leaves a leased one alone, and the run log
   is written at the expected path with the expected frontmatter. **Open item for a later stage:
   `runs.ts` still needs its own regression tests.**

Nothing in the plan was impossible to implement as written.

## Test results

```
export PATH=$HOME/.nvm/versions/node/v22.23.2/bin:$PATH
corepack pnpm lint                              # clean
corepack pnpm --filter @cxw/scheduler typecheck # clean
corepack pnpm --filter @cxw/scheduler test      # 5 files, 84 tests, all passing
```

Coverage by file: `routine.test.ts` 26, `schedule.test.ts` 30, `lease.test.ts` 10,
`spool.test.ts` 14, `chunk.test.ts` 10 (84 total). Every test is deterministic: dates are injected,
databases are `:memory:` or a `os.tmpdir()` file that is removed in `afterEach`, and nothing touches
the network.

Plan bullets covered: frontmatter parse and defaults, model-alias mapping, schedule/once
exclusivity in both directions, invalid cron, invalid timezone, name/filename mismatch, non-kebab
name, `loadRoutines` skipping a bad file, `writeRoutine` round-trip, `setEnabled` preserving
comments and other lines; next run for `0 7 * * 1-5` at `2026-09-03T00:00Z` in `Europe/Prague`
(`05:00Z`) and `America/Managua` (`13:00Z`), the Prague DST shift to `06:00Z` after 2026-10-25,
`dueSlot` inside and outside the catch-up window, same-slot suppression, missed-slot detection,
once due/expired/already-fired; lease claim, contention, expiry takeover, heartbeat extend,
heartbeat after loss, release; spool idempotent enqueue, due ordering, backoff growth, per-stage
attempt ceilings, deliver-stage payload preserved, and a reopen of the same database file keeping
the item pending without duplicating it; chunk paragraph/line/hard-cut behaviour, no empty chunk,
never over `max`, and no character loss beyond split whitespace.

`corepack pnpm format:check` still fails, on the same pre-existing files it failed on before this
stage: `docs/IMPLEMENTATION_PLAN.md`, `feature-research/phase-1-bridge/plan.md`,
`feature-research/phase-3-media/plan.md`, `feature-research/phase-5-routines/plan.md`,
`packages/shared/src/index.ts`, `tsconfig.json`, `vitest.config.ts` — plus
`feature-research/phase-5-routines/plan-addendum.md`, which is the orchestrator's own untracked
planning document and not a file this stage created. Every file I wrote is prettier-clean
(`prettier --write` was run on those fifteen paths and nothing else).

## Open risks

- **`runs.ts` is untested** (see deviation 9). It is exercised only by hand so far.
- **`describeCron` is deliberately partial.** It covers the shapes the starter routines and the
  brain's `parseSchedulePhrase` produce (`every day`, `weekdays`, `weekends`, day lists, multiple
  hours, `*/N` minutes and hours) and returns the raw expression for anything else. A user-written
  cron in the vault will therefore sometimes render as the raw expression in the `routines`
  listing. That is a cosmetic degradation, not a failure.
- **`heartbeatLease` follows plan.md literally** and does not check expiry. If a lease expires and
  nobody else takes it, the original owner's heartbeat still succeeds and revives it. That is the
  documented behaviour; a lease actually stolen by another owner is correctly reported as lost.
- **`parseLocalDateTimeInTz` resolves ambiguous local times with a two-pass offset fix.** During the
  hour that repeats at a DST fall-back, the second pass settles on one of the two instants. The
  routines that use `once` are reminders, where an hour of ambiguity twice a year is tolerable.
- **`config.ts` silently falls back to `Europe/Prague`** when `CXW_TZ`/`TZ` names a zone the runtime
  does not know, rather than failing startup. Stage A2's `main.ts` should log a warning when that
  substitution happens.
- **Schema version is pinned at 1 with no down-migration path.** `migrate` bumps
  `schema_version` but there is no per-version migration list yet; the next schema change must add
  one.

---

# Audit — Phase 5 routines, STAGE A2 (runners, delivery, scheduler loop, service entry)

Branch: `phase-5-routines` (worktree `/Users/alfonsobriceno/ClaudeXWhatsapp-phase-5-routines`).
Scope: everything that sits on top of the A1 foundation. `apps/brain/**`, `vault/**`, `deploy/**`,
`packages/**`, `mcp/**` and every root config file are untouched and belong to a later stage.

## Files changed

Created (9 source files):

- `apps/scheduler/src/deliver.ts`
- `apps/scheduler/src/google.ts`
- `apps/scheduler/src/prompt.ts`
- `apps/scheduler/src/calendar-trigger.ts`
- `apps/scheduler/src/scheduler.ts`
- `apps/scheduler/src/main.ts`
- `apps/scheduler/src/runner/static.ts`
- `apps/scheduler/src/runner/health.ts`
- `apps/scheduler/src/runner/brain.ts`

Created (3 test files and the package README):

- `apps/scheduler/tests/helpers.ts`
- `apps/scheduler/tests/runs.test.ts`
- `apps/scheduler/tests/scheduler.test.ts`
- `apps/scheduler/README.md`

Modified (3 files):

- `apps/scheduler/src/index.ts` — kept `SERVICE`, `describe()`, `main()` and the `import.meta.url`
  entry guard; added the library surface.
- `apps/scheduler/src/runs.ts` — added two exports only (`findRunBySlot`, `reopenRun`). No existing
  function, signature or behaviour was changed. See deviation 1.
- `apps/scheduler/package.json` — `start` script only: `tsx src/index.ts` -> `tsx src/main.ts`.
- `feature-research/phase-5-routines/audit.md` — this section; A1's section is unchanged.

No other file was created, edited, deleted or reformatted. No git command was run.

## What each file contains

### `src/deliver.ts`

`BridgeDeliverer` implements the `Deliverer` port: `chunkText` at 3500, one `POST ${bridgeUrl}/send`
per chunk with JSON `{ to, text }`, 2 s between chunks, `AbortSignal.timeout(10_000)` per request,
throws on any non-2xx (the message carries the status and at most 200 characters of the body).
`Authorization: Bearer …` is sent only when a token is configured. `isBridgeConnected(bridgeUrl,
token?, fetchImpl?)` does `GET /health` with a 5 s timeout and returns `connected === true`, false on
any error. `fetch` and the inter-chunk delay are injected, so no test waits or touches the network.
Also exports the minimal `FetchLike` / `HttpResponse` types the other modules and the fakes share.

### `src/google.ts`

`GoogleClient` with `getAccessToken()` (refresh-token grant, cached until a minute before expiry),
`listEvents(from, to)` (primary calendar, `singleEvents`, ordered) and `sendEmail(to, subject, body)`
(base64url MIME through the Gmail REST API). It implements `CalendarSource`, so it plugs straight
into the scheduler. `createGoogleClient(env, fetchImpl?, now?)` returns `null` unless all three
Google variables are present. No token value is logged or put into an error message.

### `src/prompt.ts`

`buildJobPrompt(routine, now, extraContext?)` emits the context header (routine name, local date and
time in the routine timezone, timezone), an optional trigger-context block, the routine body, and
`OUTPUT_CONTRACT` — plain WhatsApp text, about 3500 characters per section, long output written under
`vault/` with a five-line summary, and a mandatory last line of `STATUS: done|needs_input|failed`.
`parseStatusMarker(text)` strips a recognised marker (case-insensitive) and returns the status; a
missing or unrecognised marker yields `done` with the text untouched.

### `src/calendar-trigger.ts`

`pollCalendarTriggers(routine, calendar, db, now, options?)`: lists `[now, now + lead + poll]`, keeps
events with at least one non-self attendee when `require_attendees` is set, skips anything already in
`fired_events`, and enqueues a `calendar` run whose `next_attempt_at` is `start - lead_minutes` and
whose payload is the event JSON. Returns which events were spooled and how many were deduped.

### `src/runner/static.ts`

`StaticRunner` returns the trimmed routine body as a successful `JobResult` with zero cost.

### `src/runner/health.ts`

`runHealthCheck(deps, now)` runs the four probes and never throws: `whatsapp` (injected bridge
probe), `google` (injected token refresh; `null` means "not configured" and counts as ok with a
note), `disk` (injected `statfs`, fails when used percent exceeds `CXW_DISK_LIMIT_PCT`), `backup`
(injected `stat`, fails when the stamp file is older than `CXW_BACKUP_MAX_AGE_H` or missing). It
returns `{ ok, checks, alertText }`. `getHealthState` / `setHealthState` / `diffAndStore` /
`changeAlertText` implement the state-change dedupe over the `health_state` table.

### `src/runner/brain.ts`

`BrainJobRunner` over the Agent SDK, with the option names verified in addendum section 4:
`abortController`, `cwd`, `model`, `maxTurns`, `permissionMode: 'dontAsk'`, `allowedTools`
(`mcp__<tool>__*` plus Read/Grep/Glob), `disallowedTools`, `mcpServers`, `settingSources: []`, and
`systemPrompt` as `{ type: 'preset', preset: 'claude_code' }` with `append` added only when
`<CXW_WORKSPACE_DIR>/CLAUDE.md` exists. No `resume` or `sessionId`: every run is a fresh session.
`selectMcpServers` reads `<CXW_WORKSPACE_DIR>/.mcp.json` and passes only the servers the routine
names, raising an error that names the missing server; an absent `.mcp.json` is fine only when
`tools` is empty. A `JOB_TIMEOUT_MS` timer and the caller's signal both abort the run. `query` and
the file reader are injected, so no test spawns the CLI or needs credentials.

### `src/scheduler.ts`

The `Scheduler` class with `tick(now)`, `start(intervalMs)`, `stop()` and `executeItem(item)`. Each
tick reloads the routine directory (logging but not failing on bad files), enqueues due cron and once
slots (recording a `skipped` row for a slot missed during an outage), polls calendar triggers on the
`CALENDAR_POLL_MINUTES` throttle, and works the spool. LLM jobs are capped at `MAX_CONCURRENT_JOBS`;
`health` and `static` routines bypass that cap, and one run per routine is enforced by the lease. The
lease is heartbeated every `LEASE_TTL_MS / 3` and a lost lease aborts the job through the
`AbortController`. Execution order is exactly plan.md's: claim lease, open run, run job, parse the
STATUS marker, write the run log, finish the run, deliver, `delivered_at`, delete a `once` file,
release the lease, remove the item. Delivery failure re-stages the item as `deliver` with the result
text; a job failure re-spools the same `run` item. Health alerts fire only on state change, over
WhatsApp normally and by e-mail when the `whatsapp` probe itself is down. Every port is injected.

### `src/main.ts`

Loads the config, opens the database, sweeps stale `running` rows, builds the real ports (bridge
deliverer, Google client or `null`, brain runner, static runner, health deps, e-mail alert), starts
the scheduler, and stops cleanly on SIGTERM/SIGINT. It fails fast when neither `ANTHROPIC_API_KEY`
nor `CLAUDE_CODE_OAUTH_TOKEN` is set and at least one enabled routine is `kind: llm`. The
`import.meta.url` entry guard is kept, so importing the module has no side effect.

### `src/index.ts`

`SERVICE`, `describe()` and `main()` still work exactly as before. Added: routine
load/parse/write/setEnabled/delete and `routineFilePath`; `nextRun`, `dueSlot`, `describeCron`,
`formatInTz` and the other schedule helpers; `openDb` and friends; spool `enqueue`/`dueItems`/
`markFailed`/`pendingFor`/`remove`; runs `history`/`getState`/`setState`/`recordSkipped`/
`writeRunLog`; `chunkText`; the prompt helpers; `loadConfig`; `Scheduler`; and the shared types.

## Deviations from plan.md / the addendum, and why

1. **Two new exports in `runs.ts` (`findRunBySlot`, `reopenRun`).** plan.md requires a job failure to
   re-spool the same item, and the tests require "no duplicate run rows". Without a way to find the
   row already recorded for a slot, every retry would insert a second `runs` row. Both functions are
   additive; nothing existing changed. The stage brief explicitly allows a narrowly-scoped addition.
2. **An unconfigured backup stamp file counts as ok, with the note `not configured`.** plan.md says a
   _missing file_ is not ok, which the code follows for a configured path that does not exist.
   `CXW_BACKUP_STAMP_FILE` is optional in the config, and treating "not set" as a failure would make
   the health check alert permanently on a box without backups configured yet. This mirrors the
   `google` probe's documented "not configured counts as ok with a note".
3. **A routine with a calendar `trigger` never fires on its cron.** plan.md gives `meeting-prep` both
   `schedule: "*/5 * * * *"` and a calendar trigger. Firing both would run the routine every five
   minutes with no event. The cron is therefore read as the poll cadence only, and such routines are
   skipped by the cron enqueue path. This matches the plan's intent for `meeting-prep`.
4. **`runHealthCheck` takes `(deps, now)` and the alerting lives in `scheduler.ts`.** plan.md
   describes `runHealthCheck(deps)` returning `{ ok, checks }` plus alert text, which it does; the
   `health_state` comparison is exposed as `diffAndStore` / `changeAlertText` in the same file, and
   the scheduler decides the channel. Keeping the channel choice out of the probe module is what lets
   the tests assert the WhatsApp/e-mail split without a network.
5. **`isBridgeConnected` takes an optional third `fetchImpl` argument.** The brief specifies
   `isBridgeConnected(bridgeUrl, token?)`; the extra optional parameter is what makes the function
   testable without the network. Call sites that pass two arguments are unaffected.
6. **`Scheduler` also exposes `loadedRoutines()` and `SystemClock`.** Both are small: the first lets
   a test assert which files parsed on the last tick, the second is the production `Clock`.
7. **The brain runner's default `query` is imported lazily.** A static import of
   `@anthropic-ai/claude-agent-sdk` would load the SDK for anything that imports the module, including
   the brain's routine commands. The default implementation therefore does a dynamic import inside
   the generator; the injected fake never reaches it.
8. **The `deliver` stage looks its run row up by `(name, slot, trigger)`.** The `spool` table has no
   run id column and the schema is A1's, so re-staging a delivery finds the run row rather than
   carrying its id. Nothing in the schema changed.
9. **`recordSkipped` for a missed slot is written before the enqueue, not inside `dueSlot`.**
   `dueSlot` (A1) reports `missedSlot`; the scheduler records the row. That keeps `schedule.ts` pure.

Nothing in the plan for this stage was impossible to implement as written.

## Test results

```
export PATH=$HOME/.nvm/versions/node/v22.23.2/bin:$PATH
corepack pnpm lint                              # clean
corepack pnpm --filter @cxw/scheduler typecheck # clean
corepack pnpm --filter @cxw/scheduler test      # 7 files, 122 tests, all passing
corepack pnpm test                              # every workspace package, all passing
```

Stage A2 added 38 tests (84 -> 122): `runs.test.ts` 21 and `scheduler.test.ts` 17.

`runs.test.ts` covers what A1 left untested: `startRun`/`finishRun` transitions and the mirror into
`routine_state`, `markDelivered`, `findRunBySlot`/`reopenRun`, `recordSkipped` with the default and an
explicit reason, `history` ordering, limit and per-routine scoping, `getState`/`setState` upsert
semantics, the stale-run sweep in all four cases (no lease, live lease, expired lease, non-running
row), and `writeRunLog`'s path, stamp, frontmatter and error quoting.

`scheduler.test.ts` covers every integration bullet in plan.md "Tests": a 07:00 Prague tick runs
`morning-brief` once and writes a run log; a tick at 07:00:30 does not re-run it; a runner failure
spools with backoff, records `failed` once and does not retry before the backoff expires; the retry
after the backoff reuses the same run row; a deliverer failure after a successful run moves the item
to `stage: 'deliver'` with the result as payload while the runner call count stays 1, and the next
tick delivers from that payload; a `once` routine's file is deleted after delivery; `STATUS:
needs_input` yields status `needs_input`; a `health` routine uses the health probes, never the LLM,
alerts once on failure and once on recovery, stays silent and writes no log while healthy, and
switches to e-mail when the `whatsapp` probe is the failing one; a calendar trigger spools at
`start - lead`, skips an event with no other attendees, and injects the event into the prompt; a
disabled routine and an invalid file are both handled without stopping the tick.

**Acceptance test for the phase**: the test named "run weekly-review on demand: the queued run
executes, logs and delivers" (suite `manual runs`) enqueues exactly what the brain's `run <name>`
command will (`trigger: 'manual'`, `stage: 'run'`, slot = now), ticks once, and asserts the fake
runner ran `weekly-review`, the run log carries `trigger: manual`, the fake deliverer received the
text, the run row is `done` with `delivered_at` set, and the spool is empty.

Every test is deterministic: `FixedClock` for time, `:memory:` databases, a temp vault removed in
`afterEach`, and fakes for the runner, deliverer, calendar, `query`, `fetch` and the health probes.
No network, no real timers, no Anthropic or Google credentials, no Claude CLI.

`corepack pnpm format:check` still fails on exactly the same eight paths as after stage A1 (the seven
pre-existing files plus the untracked `plan-addendum.md`). Everything this stage wrote is
prettier-clean; `prettier --check apps/scheduler` passes.

## Open risks

- **`BrainJobRunner` has no test file.** The stage brief lists three test files and a brain-runner
  test is not among them, so I did not add one; `tests/helpers.ts` ships the `fakeQuery` double for
  whoever writes it. `selectMcpServers` and `buildOptions` are exported precisely so they can be
  tested without the SDK. **Open item: `runner/brain.ts` and `google.ts` still need unit tests.**
- **`deliver.ts` and `google.ts` are exercised only through their types.** The fakes in
  `tests/helpers.ts` (`fakeFetch`) make a `deliver.test.ts` cheap to add later.
- **The calendar poll throttle is in-memory.** A restart re-polls immediately. That is harmless —
  `fired_events` still dedupes — but it does mean a crash loop would hit the Calendar API each start.
- **`stop()` waits for in-flight jobs but does not abort them.** A job at the 15-minute timeout will
  hold shutdown until systemd's `TimeoutStopSec=120` kills the process. Aborting in-flight jobs on
  SIGTERM would be a small, separate change.
- **Health alerts are not re-sent while a probe stays down.** That is what plan.md asks for, but it
  means an outage produces exactly one message; the recovery message is the only follow-up.
- **`main.ts` has no test.** It is thin composition, but `needsAnthropicCredentials` and
  `buildScheduler` are exported so a later stage can cover the fail-fast rule.

---

# Audit — Phase 5 routines, STAGE B (brain commands, starter routines, docs, env)

Branch: `phase-5-routines` (worktree `/Users/alfonsobriceno/ClaudeXWhatsapp-phase-5-routines`).
Scope: the brain-side command handlers, the two scheduler test files A2 left open, the nine starter
routine files, the two READMEs, and the scheduler block in the env example. No scheduler source file
was touched. `apps/bridge/**`, `packages/**`, `mcp/**`, root configs and
`deploy/hetzner/systemd/**` are untouched. No git command was run.

## Files changed

Created (3 source files):

- `apps/brain/src/commands/routines.ts`
- `apps/brain/src/commands/schedule-phrase.ts`
- `apps/brain/src/commands/reminder.ts`

Created (5 test files):

- `apps/brain/tests/routine-commands.test.ts`
- `apps/brain/tests/schedule-phrase.test.ts`
- `apps/brain/tests/reminder.test.ts`
- `apps/scheduler/tests/deliver.test.ts`
- `apps/scheduler/tests/brain-runner.test.ts`

Created (1 doc):

- `apps/brain/README.md`

Created (9 routine files):

- `vault/routines/morning-brief.md`
- `vault/routines/evening-close.md`
- `vault/routines/weekly-review.md`
- `vault/routines/meeting-prep.md`
- `vault/routines/inbox-digest.md`
- `vault/routines/memory-consolidate.md`
- `vault/routines/memory-review.md`
- `vault/routines/followups.md`
- `vault/routines/health-check.md`

Modified (5 files):

- `apps/brain/src/index.ts` — `SERVICE`, `describe()`, `main()` and the `import.meta.url` entry
  guard are unchanged; a re-export block for the command handlers was added above the guard.
- `vault/routines/README.md` — extended from the six-line stub into the full frontmatter reference.
- `deploy/hetzner/cxw.env.example` — one appended scheduler block. No existing line was reordered,
  renamed or changed.
- `apps/scheduler/tests/routine.test.ts` — one added suite ("the shipped starter routines") plus the
  `node:url` import it needs. No existing test was changed.
- `feature-research/phase-5-routines/audit.md` — this section. A1 and A2 are unchanged.

## What each file contains

### `src/commands/schedule-phrase.ts`

`parseSchedulePhrase(phrase): { cron, human } | null`, fully deterministic — no model call, so one
phrase always yields one cron. The grammar is
`every (day|weekday[s]|weekend[s]|<daynames>|hour|N minutes|N hours) [at H[:MM][am|pm] [and …]]`.
Day forms default to 09:00; interval forms reject a trailing time. `human` comes from the
scheduler's own `describeCron`, so the listing and the creation reply agree. `SUPPORTED_FORMS` is
exported for the "I did not understand" reply.

### `src/commands/reminder.ts`

`parseReminder(text, now, tz): { when, what } | null`. chrono-node with `forwardDate: true` and the
reference `{ instant: now, timezone: tzOffsetMinutes(tz, now) }`, so a wall-clock time in the phrase
resolves against the owner's zone. A leading `remind me` is stripped; both word orders work. `what`
is the phrase with the matched time span cut out and the glue words (`to`, `on`, `at`, `about`,
punctuation) trimmed from both ends. Returns `null` for an unreadable time, a past time, or an empty
subject.

### `src/commands/routines.ts`

`handleRoutineCommand(text, ctx): Promise<string | null>` and the six commands. `null` means "not a
routine command". The module never checks the sender; the README states that owner-only enforcement
is the router's job. `slugify` is exported because the reminder and `new routine` names both use it
and it is worth testing directly.

### `apps/brain/README.md`

How the Phase-2 router must wire this in: call it before the LLM loop, owner only, `null` falls
through. Plus the command table, the `RoutineCommandContext` shape, the schedule grammar with a
worked table, and the reminder file format.

### `apps/scheduler/tests/deliver.test.ts` (14 tests)

`BridgeDeliverer` posts `{ to, text }` to `/send`, chunks long text and posts each chunk in order
with none over the limit, paces between chunks but not before the first, sends
`Authorization: Bearer …` only when a non-empty token is configured, throws on a non-2xx carrying
the status, stops at the first refused chunk, and tolerates a trailing slash on the bridge URL.
`isBridgeConnected` is true only for `connected === true` and false for `false`, a truthy non-boolean,
a missing field, a non-2xx status and a thrown request. `fetch` and the delay are injected.

### `apps/scheduler/tests/brain-runner.test.ts` (12 tests)

`BrainJobRunner` against a temp workspace holding a real `.mcp.json`, with the injected fake `query`.
Covers: only the named MCP servers are selected; an empty `tools` list selects none; a name missing
from `.mcp.json` errors with that name; an absent `.mcp.json` errors when tools are listed; the model
alias maps to the real id for `opus`, `haiku` and `fable`; `permissionMode: 'dontAsk'`,
`settingSources: []`, `cwd`, `maxTurns`, `allowedTools` and `disallowedTools`; the Claude Code preset
gains `append` only when `workspace/CLAUDE.md` exists; a `subtype: 'success'` result returns text,
cost, turns and session id; a non-success subtype comes back as an error carrying the subtype; an
iterator that ends with no result message gives `no_result`; a bad options build and a thrown query
both come back as failures rather than exceptions. No credentials, no CLI spawn.

### The nine routine files

Each parses under `apps/scheduler/src/routine.ts` with `name` equal to the filename stem, and each
is written to read well in Obsidian: short sections, explicit inclusion and exclusion rules, and a
character budget so the output fits WhatsApp. Every `kind: llm` body ends with the STATUS
instruction. `evening-close` ends with `STATUS: needs_input` and carries the note telling the next
brain turn to store the reply as `vault/raw/note-journal-<date>.md`. `weekly-review` states in bold
that no `git log` and no shell are available and that vault file listings plus `captured:` headers
are the way to tell what is new. `meeting-prep` explains that its cron is only the poll cadence and
that the event JSON arrives as trigger context. `memory-consolidate` (tools: vault) makes
`vault/raw` append-only and never assumes any Phase-6 code. `memory-review` (tools: vault, whatsapp)
is read-only by instruction and closes by asking what to correct. `health-check` is `kind: health`
with `catch_up_minutes: 1` and its body is documentation, which it says in its first line.

## Deviations from the plan and the brief, and why

1. **`handleRoutineCommand` is `async` but does no I/O await.** The signature the brief fixes is
   `Promise<string | null>`, and every branch is synchronous today (better-sqlite3 and `fs` are
   both sync). The function therefore contains one `await Promise.resolve()` so it is a genuine
   async function rather than a lint-flagged one. The contract the router sees is unchanged.
2. **`run`, `pause`, `resume` and `history` only match a kebab-case name.** The regexes are
   `^(run|pause|resume|history)\s+([a-z0-9][a-z0-9-]*)$`. That is the same character class routine
   names are validated against, and it keeps `running late, sorry` out of the command path. A
   message with a name-shaped argument that does not exist still gets the "available names" reply;
   a message that is not name-shaped falls through to the LLM loop, which is the better failure.
3. **A `null` return does not distinguish "no time" from "time in the past".** The brief asks
   `parseReminder` to return `null` for a past time so the caller can explain. Both cases produce one
   reply that names the requirement ("I need a future time and a subject"). Splitting them would
   need a second return channel for one extra sentence of copy.
4. **`slugify` is exported.** Not named in the plan. Both name generators use it and the name shape
   is worth asserting directly.
5. **The `routines` listing shows `next —` for an event-driven routine**, not a poll time. Its cron
   is the poll cadence (A2 deviation 3), so printing "next 12:35" would be misleading. The schedule
   column reads `event-driven`.
6. **Several times of day must share a minute.** `every day at 12 and 6pm` is `0 12,18 * * *`;
   `every day at 12:00 and 18:30` returns `null`. Cron has a single minute field, so the alternative
   is silently firing at 12:30 as well. Rejecting is the honest answer, and the reply lists the
   supported forms.
7. **`vault/routines/README.md` was rewritten, not appended to.** The brief says extend it into the
   full reference. The stub's six-line example survives as the "Shape" block with the same fields;
   nothing it asserted was contradicted.
8. **`BRIDGE_URL` in the env example is `http://127.0.0.1:7411`,** matching the `BRIDGE_PORT=7411`
   already in that file, not the code's derived default of 7801. The env file on the box is the
   single source of truth for the port (addendum section 5); leaving the two lines disagreeing inside
   one file would be a trap.
9. **`BRIDGE_TOKEN` and `CXW_ALERT_EMAIL_TO` are `CHANGEME`.** Both are secret-shaped.
   `check-secrets` passes.
10. **The two "no yield" generators in `brain-runner.test.ts` are plain async iterables.** ESLint's
    `require-yield` rejects an `async function*` with no `yield`, which is exactly what an
    "ends with no result" case needs. They are written as objects with a `[Symbol.asyncIterator]`
    instead.

Nothing in the plan for this stage was impossible to implement as written.

## Test results

```
export PATH=$HOME/.nvm/versions/node/v22.23.2/bin:$PATH
corepack pnpm lint          # clean
corepack pnpm typecheck     # clean, all 7 packages
corepack pnpm test          # scheduler 146, brain 35 — 181 tests, all passing
corepack pnpm check-secrets # exit 0
```

Stage B added 59 tests: scheduler 122 -> 146 (`deliver.test.ts` 14, `brain-runner.test.ts` 12,
`routine.test.ts` +1 for the nine starter files) and brain 0 -> 35 (`schedule-phrase.test.ts` 10,
`reminder.test.ts` 9, `routine-commands.test.ts` 16).

Every brief-mandated expectation is asserted: `every weekday at 7` -> `0 7 * * 1-5`, `every day at
7:30pm` -> `30 19 * * *`, `every monday and thursday at 9` -> `0 9 * * 1,4`, `every 30 minutes` ->
`*/30 * * * *`, nonsense -> `null`; and `Friday 9am to call Marco` from Wednesday 2026-09-02 12:00
Prague -> `2026-09-04T07:00:00.000Z` with `what` exactly `call Marco` (the same phrase in
`America/Managua` gives `15:00Z`, which pins the timezone handling rather than the offset happening
to cancel). `routines` lists the next run, state and last result; `run weekly-review` inserts one
manual `run` spool row at the current slot; `pause morning-brief` writes `enabled: false` to disk and
`resume` writes it back; an unknown name lists the available names and enqueues nothing; and three
unrelated messages, including `running late, sorry`, return `null`.

All brain tests use an in-memory database, a `mkdtemp` vault removed in `afterEach`, and an injected
clock fixed at `2026-09-02T10:00:00Z`. No network, no real time, no credentials.

`corepack pnpm format:check` still fails on exactly the same eight pre-existing paths as after
stage A2 and on no others. Every file this stage wrote outside `vault/` and `deploy/` is
prettier-clean.

## Open risks

- **`parseReminder` uses the zone offset at `now`, not at the target instant.** A reminder set just
  before a DST change for a time just after it lands one hour off. Prague changes twice a year at
  03:00; the window is narrow but real. A fix would re-resolve the offset at the parsed instant and
  re-parse, the way `parseLocalDateTimeInTz` does.
- **The `new routine` name is the first four words of the prompt, slugified.** Two prompts starting
  with the same four words collide and the second gets a `-2` suffix, which reads poorly in the
  `routines` listing. There is no rename command yet; the fix is to edit the file in Obsidian, and
  the file name and the `name:` field must be changed together.
- **`new routine` always writes `tools: [google, whatsapp, vault]`.** A routine that only needs the
  vault therefore starts three MCP servers per run. That is the plan's specified default; a
  `tools:` clause in the phrase grammar would be the improvement.
- **The `history` preview falls back to the error text when there is no result preview.** That is
  useful, but it means a failed run's line shows an error where the reader may expect output. The
  status column immediately before it says `failed`, so it reads correctly, but it is worth knowing.
- **`chrono-node` is a natural-language parser and its behaviour can shift between versions.** The
  reminder tests pin nine concrete phrases; a dependency bump that changes any of them will fail
  loudly rather than silently rescheduling someone's reminder.
- **The routine bodies are prompts, and prompts are untested.** The tests prove the nine files parse
  and end with a STATUS instruction. Whether `morning-brief` actually produces a good brief can only
  be judged by running it against the real MCP servers, which is a Phase-2 activity.
- **`vault/routines/README.md` restates the schema that lives in `routine.ts`.** The starter-routine
  test keeps the nine files honest, but nothing enforces that the README's table matches the zod
  schema. A schema change must update both.

---

# Review fixes — Phase 5, remediation pass

Applies `feature-research/phase-5-routines/fix-plan.md`: blocking items B1–B4 and non-blocking items
N1–N11. Nothing outside that list was changed. No git command was run; the working tree was edited
in place and staging was left alone.

## Files changed

Modified:

- `.gitignore`
- `apps/scheduler/src/scheduler.ts`
- `apps/scheduler/src/runs.ts`
- `apps/scheduler/src/db.ts`
- `apps/scheduler/src/spool.ts`
- `apps/scheduler/src/calendar-trigger.ts`
- `apps/scheduler/src/google.ts`
- `apps/scheduler/src/types.ts`
- `apps/scheduler/src/log.ts`
- `apps/scheduler/src/config.ts`
- `apps/scheduler/src/runner/health.ts`
- `apps/scheduler/tests/helpers.ts`
- `apps/scheduler/tests/scheduler.test.ts`
- `apps/scheduler/tests/routine.test.ts`
- `apps/brain/src/commands/reminder.ts`
- `apps/brain/src/commands/routines.ts`
- `apps/brain/tests/reminder.test.ts`
- `apps/brain/tests/routine-commands.test.ts`
- `deploy/hetzner/cxw.env.example`
- `vault/routines/evening-close.md`
- `feature-research/phase-5-routines/audit.md` (this section)

Created:

- `apps/scheduler/tests/main.test.ts`

## Blocking items

### B1 — the service exited within a second of starting

`SchedulerDeps` gained `unrefTimer?: boolean`, defaulting to **false**. `start()` no longer calls
`unref()` unconditionally; it does so only when that flag is set. No production path sets it, and no
test sets it either — the tests drive `tick()` directly and never start the timer — so the flag
exists purely as the documented escape hatch the fix plan asked for.

New test `apps/scheduler/tests/main.test.ts` runs the real `src/main.ts` in a child process with a
temp data dir and a temp vault, waits for the service to log `scheduler starting`, then asserts the
process is still alive three tick intervals later and that SIGTERM makes it exit 0. Verified to fail
before the fix (`expected +0 to be null`: the child had already exited) and after re-introducing the
unconditional `unref()`.

Two details of that test worth recording:

- It spawns `node --import <tsx loader> src/main.ts` rather than the `tsx` CLI. The CLI forks a
  child of its own, so the exit code the test observes would be the wrapper's 143 (killed by
  SIGTERM) rather than `main.ts`'s own 0. The file under test is the same one the `start` script
  runs.
- It waits for the `scheduler starting` log line before starting the liveness window. A fixed sleep
  was flaky under a loaded machine: transpiling the service can take several seconds, and SIGTERM
  sent before `main()` registers its handlers kills the process instead of shutting it down.

### B2 — one LLM job froze the whole scheduler

`processSpool` is now synchronous and only _starts_ jobs: each promise goes into the existing
`inFlight` map and the tick returns. `tick()` therefore no longer waits for a twelve-minute brief
before reloading routines, enqueuing cron slots or polling the calendar.

`stop()` still drains, through the new `async idle()` helper, which resolves once `inFlight` is
empty. `idle()` is the public seam the tests use.

New test: `tick is never blocked by a running job` — a hanging LLM job (new `FakeRunner.pushPending`
helper, which returns a function that finishes the job) is in flight while a later tick enqueues and
runs a `health` routine and delivers its alert. The test times out without the fix; verified by
temporarily restoring `await Promise.allSettled([...this.inFlight.values()])` inside `tick()`.

### B3 — run logs were committed to git

`.gitignore` gained:

```
vault/runs/**
!vault/runs/README.md
```

### B4 — a restart during delivery re-ran the LLM and re-delivered

New private method `Scheduler.recoverFinishedRun`, called from `executeItem` for `run`-stage items
before any runner is touched. The fix plan put this inside `openRun`; `openRun` returns a run id, so
the check lives in its own method and runs one line earlier — the behaviour is exactly as specified.

- Existing run row is `done`/`needs_input` **and** `delivered_at` is set: the spool item is removed
  and nothing runs.
- Same statuses with `delivered_at` null: the item is moved straight to `stage: 'deliver'` carrying
  the text read back from the run log, so only the send is retried.
- If the run log is missing or unreadable the method logs a warning and returns false, which
  restores the old behaviour of re-running. Delivering a truncated `result_preview` would be worse.

New `readRunLogBody(filePath)` in `runs.ts` reads a run log back with gray-matter.

Two new tests under `crash between finishing a run and clearing the spool item` cover both windows;
both assert the runner call count stays at 1. Both failed before the fix.

## Non-blocking items

- **N1 — `parseReminder` DST bug.** Two-pass offset resolution, matching
  `parseLocalDateTimeInTz`: parse with the offset at `now`, re-resolve the offset at the instant
  that produced, and re-parse only when the two differ. New test crosses the 2026-10-25
  Europe/Prague boundary (`October 26 at 9am` → `2026-10-26T08:00:00.000Z`, was `07:00`).
- **N2 — a health alert could be lost forever.** `runner/health.ts` splits `diffAndStore` into
  `diffHealth` (read only) and `storeHealthStates` (write); `diffAndStore` remains as the two
  together, so no caller signature changed. `Scheduler.sendAlert` now returns whether the alert
  actually went out, and `executeHealth` stores the new probe states and marks the run delivered
  only after a successful send. New test: a failed send leaves the state untouched, so the next slot
  alerts again.
- **N3 — no timeouts on Google REST calls.** All three fetches in `google.ts` now pass
  `AbortSignal.timeout(REQUEST_TIMEOUT_MS)` (15 s), the way `deliver.ts` already did.
- **N4 — same-instant meetings collided.** The spool's dedupe key is now
  `(name, slot, trigger, dedupe)`. `spool` gained a `dedupe TEXT NOT NULL DEFAULT ''` column, the
  table-level `UNIQUE (name, slot, trigger)` was replaced by the unique index `spool_key_idx`, and
  `SCHEMA_VERSION` went to 2. SQLite cannot alter a table constraint in place, so `migrate()` calls
  `upgradeSpool()`, which rebuilds the table when the `dedupe` column is absent and is a no-op
  otherwise. `calendar-trigger.ts` passes the event id as `dedupe`; everything else keeps the empty
  string and therefore the original one-item-per-slot behaviour. New test: two meetings starting at
  the same instant produce two preps.
- **N5 — `meeting-prep.md` promised fields that were never sent.** Chosen option: send them.
  `google.ts` `listEvents` requests `location` and `description` (and narrows the response with a
  `fields` mask), `CalendarEvent` carries them as optional properties, and the JSON payload
  `calendar-trigger.ts` serialises now includes `location` and `description`. Asserted in the same
  new test.
- **N6 — a bad `LOG_LEVEL` crashed startup.** `createLogger` validates against pino's levels plus
  `silent`, falls back to `info`, and logs one warning.
- **N7 — `CXW_ALERT_EMAIL_TO=CHANGEME`.** Commented out in `deploy/hetzner/cxw.env.example`, with a
  note, the way `CXW_ALERT_CMD` already is.
- **N8 — bridge port trap.** `config.ts` `DEFAULT_BRIDGE_PORT` is now **7411**, matching
  `cxw.env.example` and the box. `BRIDGE_URL` remains the override. The repo now has one answer.
  (`apps/scheduler/tests/deliver.test.ts` still uses a literal `http://127.0.0.1:7801` as its fake
  bridge URL; that is an arbitrary test address, not the default, and was left alone.)
- **N9 — `start()` did not align to the minute boundary.** It does now: the first tick still runs
  immediately, then a `setTimeout` waits `intervalMs - (now % intervalMs)` before the first aligned
  tick and the `setInterval` that follows. With the default 60 s cadence every later tick lands on a
  minute boundary. `stop()` clears both handles.
- **N10 — `evening-close.md` ended with a Rules block.** The `STATUS: needs_input` instruction moved
  to the last line, after the Rules. The starter-routine test now asserts the STATUS instruction is
  on the **last non-empty line** of every `kind: llm` routine, not merely present somewhere.
- **N11 — `run <name>` executed a paused routine silently.** Behaviour unchanged; the reply now says
  `Queued <name> (currently paused). Result in about a minute.` New test in
  `apps/brain/tests/routine-commands.test.ts`.

## Existing tests that had to change

- `apps/scheduler/tests/scheduler.test.ts` — every `await scheduler.tick(...)` is now followed by
  `await scheduler.idle()`. Required by B2: `tick()` no longer waits for the jobs it starts, so the
  assertions that follow would otherwise race the work. No expectation was weakened; the same
  outcomes are asserted after the same ticks.
- `apps/scheduler/tests/routine.test.ts` — the starter-routine STATUS assertion was tightened, per
  N10, from "appears in the body" to "is the last non-empty line".

No other test expectation changed.

## Test counts

181 before (146 scheduler + 35 brain) → **189** after (152 scheduler + 37 brain). Eight new tests:
one for B1, one for B2, two for B4, and one each for N1, N2, N4/N5 (combined) and N11.

## Gates

`corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm test` and
`corepack pnpm check-secrets` are all green on Node 22. `format:check` still reports the same
pre-existing files this phase never touched; no new one was added.

## Recorded as deferred (from the fix plan's own "Explicitly deferred" section)

- Retention and pruning of `runs`, `fired_events`, `health_state` and `vault/runs/**`. Section 4 of
  `docs/IMPLEMENTATION_PLAN.md` puts retention in Phase 7. `vault/runs/**` is now gitignored (B3),
  so the logs stay out of git, but nothing deletes them yet.
- Unit tests for `google.ts` and `calendar-trigger.ts` in isolation, beyond what B1–B4 and N1–N11
  required.
- The three extra test files added outside the original Files touched list stay; they are tests
  only. `apps/scheduler/tests/main.test.ts` is a fourth, added by B1.
- The pre-existing `format:check` failures on seven files this phase did not touch.

---

# Second review fixes (fix-plan-2.md, C1–C8)

## Files changed

- `apps/scheduler/src/db.ts`
- `apps/scheduler/src/runs.ts`
- `apps/scheduler/src/scheduler.ts`
- `apps/scheduler/src/main.ts`
- `apps/scheduler/src/index.ts`
- `apps/scheduler/src/runner/health.ts`
- `apps/scheduler/README.md`
- `apps/scheduler/tests/db.test.ts` (new)
- `apps/scheduler/tests/main.test.ts`
- `apps/scheduler/tests/scheduler.test.ts`
- `apps/brain/src/index.ts`
- `apps/bridge/src/index.ts`
- `mcp/google/src/index.ts`
- `mcp/vault/src/index.ts`
- `mcp/whatsapp/src/index.ts`

## C1 — `runs` had no `dedupe` column, so N4 netted out to zero

Blocking. Fixed across all three files the plan named.

**`db.ts`** — `SCHEMA_VERSION` is now **3**. The inline `runs` DDL became a `RUNS_TABLE(name)`
template (mirroring `SPOOL_TABLE`) with a new `dedupe TEXT NOT NULL DEFAULT ''` column, plus a
`RUNS_COLUMNS` list of the v2 columns. A new `upgradeRuns(db)` runs after `upgradeSpool(db)` and
uses the same rebuild pattern: when `PRAGMA table_info(runs)` has no `dedupe`, it creates
`runs_v3`, copies every v2 column (ids included), drops `runs` and renames. A plain
`ALTER TABLE ... ADD COLUMN` would also have worked here, but the plan asked for the rebuild
pattern and it keeps the two migrations shaped alike. `CREATE INDEX ... runs_name_idx` moved out of
`MIGRATIONS` and into `upgradeRuns`, because dropping the table drops its indexes and the index has
to be recreated after the rebuild, not before it.

**`runs.ts`** — `RunRecord` and `RunRow` carry `dedupe`; `RUN_SELECT` and `toRun` include it.
`StartRunInput` and `SkippedInput` gained an optional `dedupe` (default `''`), and both INSERTs
write it. `findRunBySlot` takes a fifth parameter `dedupe = ''` and adds `AND dedupe = ?` to its
WHERE clause. The parameter is optional so the existing `runs.test.ts` call sites, which exercise
the empty-dedupe behaviour, needed no change.

**`scheduler.ts`** — all three `findRunBySlot` call sites (`redeliver`, `recoverFinishedRun`,
`openRun`) pass `item.dedupe`, and `openRun`'s `startRun` writes it. `processSpool` keys `inFlight`
on `${item.name}:${item.dedupe}` instead of `item.name`, so two same-instant meetings are not
serialised across ticks.

**Proof.** The existing N4 test in `scheduler.test.ts` was extended, as the plan required, to
actually execute both spool items: after the `pendingFor` assertions it advances the clock to
`start - lead_minutes`, ticks, awaits `idle()`, and asserts **2 runner calls, 2 deliveries, 2 rows
in `history('meeting-prep')` and an empty spool**. Written first and watched fail on the
pre-fix code with `expected 1 to be 2` at the runner-call assertion; passes after the fix. The
three new `runs rebuild` cases in `db.test.ts` cover the migration itself.

## C2 — a crash on a quiet health run delivered raw probe output

`executeHealth`'s `alert === ''` branch now calls `markDelivered(this.db, runId, ...)` alongside
`storeHealthStates`, before `remove`. A crash between those two lines no longer leaves a `done` row
with a null `delivered_at`, so `recoverFinishedRun` drops the spool item instead of re-staging it
as `deliver` and sending the owner the raw probe lines. Chosen over skipping recovery for
`kind: health`, because the recovery path is still wanted for the alerting branch.

## C3 — `diffAndStore` was dead code

Deleted from `apps/scheduler/src/runner/health.ts`. Nothing imported it; `diffHealth` and
`storeHealthStates` remain and are what `scheduler.ts` uses.

## C4 — `unrefTimer` was a knob nothing turned

Deleted. No test set it, so the flag added an untested branch to the exact path that caused B1.
Gone from `SchedulerDeps`, from the field list, from the constructor, and from `start()`, which now
unconditionally leaves both `alignTimer` and `timer` ref'd. The doc comment on `start()` says so.

## C5 — `main.test.ts` proved liveness and nothing else

The temp vault now contains one `kind: static` routine `smoke.md` on `* * * * *` with
`catch_up_minutes: 5`, so it is due on the first tick. After the liveness window the test opens the
child's SQLite file read-only and polls until a `runs` row appears, then asserts exactly
`[{ name: 'smoke', status: 'done' }]`. A tick that threw inside `tick()`'s catch would now fail the
test. The bridge is deliberately unreachable, so the send fails and the item is re-staged; the run
row is the assertion, not the delivery. The test still spawns and reaps the same single child.

## C6 — the `import.meta.url` entry guard broke on paths containing a space

Seven modules had the identical `new URL(\`file://${entry}\`).href`shape; all seven now use`pathToFileURL(entry).href`from`node:url`, with a comment saying why:

`apps/scheduler/src/main.ts`, `apps/scheduler/src/index.ts`, `apps/brain/src/index.ts`,
`apps/bridge/src/index.ts`, `mcp/whatsapp/src/index.ts`, `mcp/vault/src/index.ts`,
`mcp/google/src/index.ts`.

The last five are Phase 0 stubs that predate this phase; the plan expected them to change.

## C7 — no test covered the spool rebuild

New `apps/scheduler/tests/db.test.ts`, five cases, no `openDb`: it builds the old table shapes by
hand on a raw `:memory:` handle and calls `migrate()` directly.

- _spool rebuild_: v1 table (with the `UNIQUE (name, slot, trigger)` table constraint, no `dedupe`)
  plus two rows at ids 7 and 9; `migrate()` twice; asserts both rows and both ids survive, `dedupe`
  exists, and the version is `SCHEMA_VERSION`. A second case asserts `spool_due_idx` and
  `spool_key_idx` exist and that two rows differing only in `dedupe` now insert.
- _runs rebuild_: v2 table plus two rows at ids 3 and 4; `migrate()` twice; asserts ids, values,
  `dedupe = ''` and the version. Two further cases assert `runs_name_idx` was recreated after the
  rebuild and that two same-slot `calendar` runs coexist on separate rows.

## C8 — documented the alert path that can never fire

New paragraph in the health section of `apps/scheduler/README.md`: with no `CXW_ALERT_EMAIL_TO`,
a `whatsapp` probe failure falls back to the bridge, which is down by definition; the send fails,
the state is not stored, and no "recovered" message is sent either. Stated as accepted behaviour,
with the reason (WhatsApp being down is visible on the phone) and the remedy (set
`CXW_ALERT_EMAIL_TO`).

## Existing tests that changed

- `apps/scheduler/tests/scheduler.test.ts` — the N4 case
  `spools one prep per meeting when two start at the same time` gained the execution half the plan
  asked for (tick at `start - lead`, then 2 runner calls, 2 deliveries, 2 run rows, empty spool).
  Nothing was weakened; the original `pendingFor` assertions are untouched.
- `apps/scheduler/tests/main.test.ts` — retitled to
  `runs a due routine, stays alive past two ticks and exits cleanly on SIGTERM` and given the run-row
  assertion (C5). Both original assertions are unchanged.

No other expectation changed. No test needed updating because of C1's schema change.

## Test counts

189 (152 scheduler + 37 brain) → **194** (157 scheduler + 37 brain). The five new tests are all in
`db.test.ts`; C1's and C5's coverage extended existing tests rather than adding new ones.

## Gates

`corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm test` and
`corepack pnpm check-secrets` are all green on Node 22. `format:check` reports the same eight files
as before this pass (the seven pre-existing ones plus `fix-plan.md`); no file touched here is among
them, and `fix-plan-2.md` is untracked and not reported.

No scheduler process was started by hand during this pass; `main.test.ts` spawns and reaps its own
child, and no `main.ts` process is running now.

## Open risks, not fixed here (out of the C1–C8 scope)

- The two concurrency defects listed here after the C1–C8 pass (a shared lease aborting a healthy
  concurrent job, and two run logs colliding on the same filename) are **now closed**; see the
  "Concurrency fixes (D1, D2)" section below.
- Everything in the "Explicitly deferred" section of `fix-plan.md` stays deferred, per the
  "Out of scope" section of `fix-plan-2.md`.

# Concurrency fixes (D1, D2)

## Files changed

- `apps/scheduler/src/lease.ts`
- `apps/scheduler/src/runs.ts`
- `apps/scheduler/src/scheduler.ts`
- `apps/scheduler/tests/scheduler.test.ts`
- `apps/scheduler/tests/runs.test.ts`
- `feature-research/phase-5-routines/audit.md` (this file)

## D1 — the lease key now matches the concurrency key

`lease.ts` gained one exported helper, `leaseName(routine, dedupe)`, returning
`` `${routine}:${dedupe}` ``. It is the single definition of the key; the module doc no longer
claims the lease is per routine.

`scheduler.ts` uses it in all four places a lease name is constructed or consumed:

- `processSpool` — the `inFlight` key is now `leaseName(item.name, item.dedupe)` instead of the
  inline template, so the concurrency key and the lease key are literally the same expression.
- `executeItem` — `claimLease` and the `finally` `releaseLease` both use the item's lease name.
- `executeJob` — the heartbeat renews the item's own lease instead of `routine.name`.

`runs.ts` holds the only other consumer, the startup stale-run sweep. `markStaleRunning` compared
`runs.name` against `leases.name`; it now compares `(name || ':' || dedupe)`, so a `running` row
whose item still holds its lease is still spared. Both sides carry a comment pointing at the other.

`dedupe` is `''` for cron, once and manual items, so their key is `"<name>:"`: one lease per
routine, exactly the old behaviour. Only calendar items with distinct event ids get separate leases.

**Proof.** New test `does not abort the second prep when the first one releases its lease`
(`scheduler.test.ts`). Two same-instant meetings spool two items; a controlled runner keeps both
jobs hanging and records the `AbortSignal` each was given. The first job is finished, so its
`finally` releases the lease; fake timers then advance 2 s, which is past the heartbeat interval
(the test sets `leaseTtlMs: 3_000`, putting the heartbeat on its 1 s floor). The test asserts the
second job's signal is **not** aborted, then finishes it and asserts two deliveries, two `done` run
rows and an empty spool. Written first; on the pre-fix code it failed with
`expected true to be false` at the abort assertion.

## D2 — two run logs can no longer collide

`runs.ts` gained `runLogName(finished, dedupe)`: the finish stamp alone when `dedupe` is empty, and
`` `${stamp}-${sha1(dedupe).slice(0, 8)}.md` `` otherwise. `RunLogInput` gained an optional
`dedupe`, and `writeRunLog` uses the helper. The digest is a pure function of `dedupe`, so a retry
of the same item overwrites its own log rather than adding another, and every existing path is
byte-for-byte unchanged when `dedupe` is `''`. `scheduler.ts` passes `dedupe: item.dedupe` at all
three `writeRunLog` call sites (the health log and the two job logs).

**Proof.** New test `writes one run log per prep when both finish in the same second`. The clock is
fixed, so both preps finish at the same instant; the runner echoes which meeting it prepared. The
test asserts two files in `vault/runs/meeting-prep`, two distinct `log_path` values, and that each
run row's log file contains the text of _that_ run (matched through the row's `dedupe`). Written
first; on the pre-fix code it failed with `expected 1 to be 2` on the file count.

## Regression test for cron

New test `still refuses a second process the lease while a cron job runs`. Two `Scheduler`
instances share one database with different owners. The first starts a hanging `morning-brief` job;
the second ticks over the same due spool item and must be turned away. It asserts one runner call,
that `getLease(db, leaseName('morning-brief', ''))` is still owned by the first process, and that
the run completes normally once released. It passes before and after the change; its job is to
prove the new key did not weaken one-run-per-routine for cron.

## Existing tests that changed

- `apps/scheduler/tests/runs.test.ts` — the two `markStaleRunning` cases that claim a lease now
  claim it under `leaseName('morning-brief', '')` rather than the bare name. This is a legitimate
  change: the lease key moved, and a lease taken under the bare name is no longer the lease that
  row's item would hold. Their assertions are untouched.

No other expectation changed.

## Test counts

194 (157 scheduler + 37 brain) → **197** (160 scheduler + 37 brain): the three new tests above.

## Gates

`corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm test` and
`corepack pnpm check-secrets` are all green on Node 22. (`check-secrets` prints a BSD-grep usage
warning for one pattern and still exits 0, exactly as before this pass.) `format:check` reports the
same eight files as before — the seven pre-existing ones plus `fix-plan.md` — and none of the files
touched here. No long-lived process was started.

## Open risks

- None from D1 or D2. The remaining deferred items are unchanged: everything in the "Explicitly
  deferred" section of `fix-plan.md` (retention and pruning, isolated unit tests for `google.ts`
  and `calendar-trigger.ts`, the pre-existing `format:check` failures).
- Worth knowing, not a defect: two concurrent preps of one routine each take their own lease, so a
  routine can now hold more than one lease at a time. That is the intent of the calendar change,
  and `markStaleRunning` accounts for it, but any future code that reads the `leases` table must
  use `leaseName`, not the routine name.
