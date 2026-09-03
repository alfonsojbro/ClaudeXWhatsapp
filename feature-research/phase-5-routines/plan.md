# Plan — Phase 5: routines scheduler (`phase-5-routines`)

## Goal
Add `apps/scheduler` (routine files, SQLite lease + retry spool, brain job runner, run logs, delivery, health-check), the brain-side routine commands, seven starter routines, the `cxw-scheduler` systemd unit, and vitest coverage — self-contained in this repo.

## Context and assumptions (read first)
- The repo currently contains only `README.md` and `docs/IMPLEMENTATION_PLAN.md`. No git repo, no Phase 0/2/4 code. This plan therefore also creates the **minimal pnpm workspace skeleton** the scheduler needs. Nothing is copied from other projects.
- `apps/bridge`, `apps/brain` (LLM loop), `mcp/*` do not exist. The scheduler talks to them through small **ports** with real implementations against the contracts below, plus fakes for tests:
  - **Bridge send API** (contract, to be implemented in Phase 1/2): `POST ${BRIDGE_URL}/send` JSON `{ "to": "owner" | "<jid>", "text": string }` → 200; `GET ${BRIDGE_URL}/health` → `{ "connected": boolean }`. Default `BRIDGE_URL=http://127.0.0.1:7801`.
  - **Brain job**: `@anthropic-ai/claude-agent-sdk` `query()` in a fresh session, `cwd = CXW_WORKSPACE_DIR` (contains `CLAUDE.md`, `.mcp.json`). MCP servers named in a routine's `tools` list are taken from `.mcp.json` by key.
  - **Google**: OAuth refresh token from env (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`). The scheduler uses raw Google REST (token refresh, calendar list, gmail send) for the health check, meeting-prep polling and the email fallback only. The LLM routines reach Gmail/Calendar via the `google` MCP named in `tools`.
- Toolchain: Node 20 locally (unit targets Node 22 on the box), pnpm via `corepack pnpm` (pnpm 10). TypeScript ESM (`module: NodeNext`, `.js` import suffixes). Package versions: croner ^10, gray-matter ^4.0.3, zod ^4, better-sqlite3 ^13, pino ^10, chrono-node ^2.10, @anthropic-ai/claude-agent-sdk ^0.3, vitest ^4, tsx ^4, typescript ^5.9.
- Default timezone `Europe/Prague` (`CXW_TZ`), per plan section 3.6.

## Files touched (complete list — the contract)
Repo skeleton
- `package.json` (private root: workspaces scripts `test`, `typecheck`, `build`; devDeps typescript, vitest, tsx, @types/node)
- `pnpm-workspace.yaml` (`apps/*`, `packages/*`)
- `tsconfig.base.json` (strict, NodeNext, ES2022, paths `@cxw/scheduler` → `apps/scheduler/src/index.ts`)
- `vitest.config.ts` (root; include `apps/**/test/**/*.test.ts`; alias `@cxw/scheduler`)
- `.gitignore` (node_modules, dist, *.db, *.env, .DS_Store, vault/runs/**/*.md except .gitkeep)

Scheduler (`apps/scheduler`)
- `apps/scheduler/package.json` (`@cxw/scheduler`, type module, main `dist/index.js`, scripts `dev` (tsx src/main.ts), `build` (tsc), `test`)
- `apps/scheduler/tsconfig.json`
- `apps/scheduler/README.md` (routine format, env vars, bridge contract, STATUS marker, how outages/retries behave)
- `apps/scheduler/src/index.ts` — library exports used by the brain: routine load/parse/write/setEnabled/delete, nextRun, openDb, spool enqueue, runs history, formatting helpers.
- `apps/scheduler/src/main.ts` — service entry: load config, open db, start `Scheduler`, SIGTERM handling.
- `apps/scheduler/src/config.ts` — zod env config (see Env below).
- `apps/scheduler/src/log.ts` — pino logger (redact nothing sensitive is logged: no message bodies at info).
- `apps/scheduler/src/types.ts` — shared types: `Routine`, `RunStatus`, `JobResult`, `Trigger`, ports `JobRunner`, `Deliverer`, `CalendarSource`, `Clock`.
- `apps/scheduler/src/routine.ts` — zod frontmatter schema, `parseRoutine(text, filePath)`, `loadRoutines(dir)` (skips invalid files with a logged reason, never throws for one bad file), `writeRoutine(dir, fm, body)`, `setEnabled(filePath, enabled)` (edits only the `enabled:` line, preserves formatting), `deleteRoutine(filePath)`, `routineFilePath(dir, name)`.
- `apps/scheduler/src/schedule.ts` — croner wrappers: `nextRun(routine, now)`, `dueSlot(routine, now, lastSlot)` (window logic below), `describeCron(expr)` (short human string), `tzOffsetMinutes(tz, date)`, `formatInTz(date, tz)`.
- `apps/scheduler/src/db.ts` — `openDb(path | ':memory:')`, WAL, `PRAGMA busy_timeout=5000`, migrations (tables below).
- `apps/scheduler/src/lease.ts` — `claimLease`, `heartbeatLease`, `releaseLease`.
- `apps/scheduler/src/spool.ts` — `enqueue`, `dueItems`, `markFailed` (backoff + max attempts), `remove`, `pendingFor(name)`.
- `apps/scheduler/src/runs.ts` — `startRun`, `finishRun`, `recordSkipped`, `history(name, limit)`, `getState/setState` (routine_state), `writeRunLog(vaultDir, …)`.
- `apps/scheduler/src/chunk.ts` — `chunkText(text, max=3500)` split on paragraph, then line, then hard cut.
- `apps/scheduler/src/deliver.ts` — `BridgeDeliverer` (HTTP send, chunked, 2 s pacing, 10 s timeout) and `isBridgeConnected()`.
- `apps/scheduler/src/google.ts` — `GoogleClient` (`getAccessToken`, `listEvents(from,to)`, `sendEmail(to, subject, body)`); returns `null` client when env is incomplete.
- `apps/scheduler/src/runner/brain.ts` — `BrainJobRunner` over the Agent SDK (details below).
- `apps/scheduler/src/runner/health.ts` — `runHealthCheck(deps)` returning `{ ok, checks[] }` and alert text; no LLM.
- `apps/scheduler/src/runner/static.ts` — `StaticRunner`: returns the routine body verbatim (used by reminders).
- `apps/scheduler/src/calendar-trigger.ts` — `pollCalendarTriggers(routine, calendar, db, now)`: finds events with ≥1 non-self attendee in `[now, now + lead + poll]`, dedupes via `fired_events`, spools a `calendar` run whose `next_attempt_at = start − lead_minutes`, payload = event JSON.
- `apps/scheduler/src/scheduler.ts` — the `Scheduler` class: `tick(now)`, `start(intervalMs)`, `stop()`, `executeItem(item)`; wires ports; concurrency limit; heartbeat; once-file deletion; needs_input marker parsing; health alerting with state change dedupe.
- `apps/scheduler/src/prompt.ts` — `buildJobPrompt(routine, now, extraContext?)`: context header (routine name, local date/time, tz), the routine body, and the output contract (plain WhatsApp text, ≤ ~3,500 chars per section, long output to `vault/…` + 5-line summary, end with `STATUS: done|needs_input|failed` on the last line).
- `apps/scheduler/test/routine.test.ts`
- `apps/scheduler/test/schedule.test.ts`
- `apps/scheduler/test/lease.test.ts`
- `apps/scheduler/test/spool.test.ts`
- `apps/scheduler/test/scheduler.test.ts` (integration with fakes + temp vault)
- `apps/scheduler/test/chunk.test.ts`
- `apps/scheduler/test/helpers.ts` (fakes: `FakeRunner`, `FakeDeliverer`, `FakeCalendar`, `FixedClock`, temp vault builder)

Brain commands (`apps/brain`) — only the command handlers; the LLM loop is Phase 2 and out of scope
- `apps/brain/package.json` (`@cxw/brain`, deps `@cxw/scheduler` workspace:*, chrono-node)
- `apps/brain/tsconfig.json`
- `apps/brain/README.md` (how the Phase-2 router must call `handleRoutineCommand` before the LLM loop; owner-only)
- `apps/brain/src/commands/routines.ts` — `handleRoutineCommand(text, ctx): Promise<string | null>`
- `apps/brain/src/commands/schedule-phrase.ts` — `parseSchedulePhrase(phrase): { cron, human } | null`
- `apps/brain/src/commands/reminder.ts` — `parseReminder(text, now, tz): { when: Date, what: string } | null` (chrono-node, forwardDate, tz offset)
- `apps/brain/test/routine-commands.test.ts`
- `apps/brain/test/schedule-phrase.test.ts`
- `apps/brain/test/reminder.test.ts`

Vault
- `vault/routines/README.md` (format reference for Obsidian editing)
- `vault/routines/morning-brief.md`
- `vault/routines/evening-close.md`
- `vault/routines/weekly-review.md`
- `vault/routines/meeting-prep.md`
- `vault/routines/inbox-digest.md`
- `vault/routines/followups.md`
- `vault/routines/health-check.md`
- `vault/runs/.gitkeep`

Deploy
- `deploy/hetzner/systemd/cxw-scheduler.service`
- `deploy/hetzner/cxw.env.example`

Paper trail
- `feature-research/phase-5-routines/audit.md` (written by the implementer)

## Design

### Routine file format (`vault/routines/<name>.md`)
```yaml
---
name: morning-brief            # must equal the filename stem; kebab-case
schedule: "0 7 * * 1-5"        # cron (5 fields, croner syntax), in `timezone`. Omit when `once` is set.
once: 2026-09-05T09:00         # ISO local datetime in `timezone` (optional offset). Mutually exclusive with schedule. File is deleted after a delivered run.
timezone: Europe/Prague        # default CXW_TZ
model: opus                    # opus | fable | sonnet | haiku (default opus)
tools: [google, whatsapp, vault]   # MCP server keys from workspace/.mcp.json (default [])
deliver_to: owner              # 'owner' or a WhatsApp JID (default owner)
enabled: true                  # default true; `pause`/`resume` flip this line
kind: llm                      # llm | static | health (default llm)
trigger:                       # optional, event-driven
  type: calendar
  lead_minutes: 15
  require_attendees: true
catch_up_minutes: 10           # default 10 for cron, 1440 for once
max_turns: 30                  # Agent SDK maxTurns (default 30)
description: one line          # optional, shown by `routines`
---
Prompt body (Markdown).
```
Model ids: opus→`claude-opus-5`, fable→`claude-fable-5-1`, sonnet→`claude-sonnet-5`, haiku→`claude-haiku-4-5-20251001`.
Zod: exactly one of `schedule`/`once`; cron validated by constructing a croner `Cron`; timezone validated with `Intl.DateTimeFormat`; `name` regex `^[a-z0-9][a-z0-9-]*$`.

### Due detection and outage semantics (`schedule.ts`, `scheduler.ts`)
- `dueSlot(routine, now, lastSlot)`: for cron, `slot = Cron(expr,{timezone}).nextRun(now − catch_up)`; due when `slot ≤ now` and `slot > lastSlot`. Slots older than the catch-up window are never run (an outage does not fire a pile of stale jobs). If `lastSlot` exists and `Cron.nextRun(lastSlot) < slot`, insert one `skipped` run row for that first missed slot (error `missed while scheduler was down`) so `history` shows the gap.
- For `once`: due when `once ≤ now`, `now − once ≤ catch_up` and not yet fired.
- Every fired slot is recorded in `routine_state.last_slot` at enqueue time and in `spool`/`runs` with `UNIQUE(name, slot, trigger)`; a restart mid-flight cannot enqueue or run the same slot twice.
- Tick every 60 s (`start()` aligns to the minute boundary). Each tick: reload routine files; enqueue due cron/once slots; poll calendar triggers (throttled to `CALENDAR_POLL_MINUTES`, default 5); process due spool items subject to `MAX_CONCURRENT_JOBS` (default 2) and one-run-per-routine via the lease; health routines never block LLM jobs.

### SQLite (`db.ts`), file `SCHEDULER_DB` (default `<CXW_DATA_DIR>/scheduler.db`)
- `leases(name TEXT PK, owner TEXT, expires_at INTEGER)`
- `spool(id INTEGER PK, name, slot INTEGER, trigger TEXT, stage TEXT CHECK(stage IN ('run','deliver')), payload TEXT, attempts INTEGER DEFAULT 0, next_attempt_at INTEGER, last_error TEXT, created_at INTEGER, UNIQUE(name, slot, trigger))`
- `runs(id INTEGER PK, name, slot INTEGER, trigger TEXT, started_at, finished_at, status TEXT CHECK(status IN ('running','done','failed','needs_input','skipped')), attempts INTEGER, log_path TEXT, error TEXT, result_preview TEXT, cost_usd REAL, delivered_at INTEGER)`
- `routine_state(name TEXT PK, last_slot INTEGER, last_status TEXT, last_run_at INTEGER)`
- `fired_events(name TEXT, event_id TEXT, fired_at INTEGER, PRIMARY KEY(name, event_id))`
- `health_state(check_name TEXT PK, ok INTEGER, detail TEXT, changed_at INTEGER)`
- `schema_version(version INTEGER)`

### Lease (`lease.ts`)
- `claimLease(db, name, owner, ttlMs, now)`: single `INSERT … ON CONFLICT(name) DO UPDATE SET owner, expires_at WHERE leases.expires_at < ?now OR leases.owner = excluded.owner`; claimed iff `changes === 1`.
- `heartbeatLease(db, name, owner, ttlMs, now)`: `UPDATE … WHERE name=? AND owner=?`; returns false if lost. Scheduler heartbeats every `LEASE_TTL_MS/3` (TTL default 90 s) while a job runs; a lost lease aborts the job's AbortController.
- `releaseLease(db, name, owner)`.
- On startup, any `runs.status='running'` row whose lease is absent or expired is marked `failed` with error `stale after restart` (not rerun).

### Retry spool (`spool.ts`)
- `enqueue({name, slot, trigger, stage, payload, nextAttemptAt})` → `INSERT OR IGNORE`; returns whether inserted.
- `dueItems(now)` ordered by `next_attempt_at`.
- `markFailed(id, error, now)`: `attempts += 1`; backoff `min(60 s · 2^attempts, 30 min)`; when `attempts ≥ max` (run stage 3, deliver stage 10) the item is removed and the run row is set to `failed` (run stage) or keeps `done` with `delivered_at NULL` (deliver stage).
- Execution flow in `scheduler.executeItem`: claim lease → `startRun` → run job (`kind` picks runner) → parse trailing `STATUS:` marker → `writeRunLog` → `finishRun(status)` → deliver → set `delivered_at` → if `once`, delete the routine file → release lease → `remove(item)`. A delivery failure after a successful job converts the spool item to `stage='deliver'` with `payload = result text` so the LLM is never re-run for a delivery problem. A job failure re-spools the same `run` item.
- `run <name>` from the brain = `enqueue({trigger:'manual', slot: now, stage:'run'})`, picked up on the next tick (≤ 60 s).

### Run logs
`vault/runs/<name>/<YYYY-MM-DDTHH-mm-ssZ>.md` (UTC stamp) with frontmatter `routine, trigger, scheduled_for, started, finished, status, model, attempts, cost_usd, error` and the result text as body. Health-check writes a log only when at least one check is not ok.

### Brain job runner (`runner/brain.ts`) — Agent SDK
- `query({ prompt, options })` with: `model` (mapped id), `cwd: CXW_WORKSPACE_DIR`, `maxTurns`, `permissionMode: 'bypassPermissions'` (headless; tools are already restricted), `allowedTools: tools.map(t => \`mcp__${t}\`)` plus `Read`, `Grep`, `Glob` scoped by the workspace, `disallowedTools: ['Bash','Write','Edit','MultiEdit','NotebookEdit','WebFetch','WebSearch']`, `mcpServers` = entries from `workspace/.mcp.json` filtered by `tools`, `settingSources: ['project']` (so `CLAUDE.md` loads), `abortController`. No `resume`: every run is a fresh session.
  - **The implementer must verify the option names and the result-message shape against the installed SDK's `.d.ts`** (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`) and adjust; the plan's names come from the docs snapshot in `feature-research/phase-5-routines/sdk-notes.md`.
- Iterate the async generator; on `type:'result'`: `subtype:'success'` → `{ text: result, costUsd: total_cost_usd, numTurns, sessionId }`; any other subtype → `{ isError: true, error: subtype }`.
- Wall-clock limit `JOB_TIMEOUT_MS` (default 15 min) via AbortController.

### Health check (`runner/health.ts`), no LLM
Checks: `whatsapp` (GET bridge `/health`, 5 s timeout, `connected===true`), `google` (token refresh 200; `not configured` counts as ok with a note), `disk` (`fs.statfs(CXW_DATA_DIR)`; ok when free % ≥ `DISK_MIN_FREE_PCT`, default 10), `backup` (mtime of `BACKUP_STAMP_FILE` ≤ `BACKUP_MAX_AGE_HOURS`, default 8; missing file = not ok). Alert only on state change (fail → alert, recover → "recovered" note), via `health_state`. If `whatsapp` is down, alerts go by email (`ALERT_EMAIL_TO`) through `GoogleClient.sendEmail`; otherwise by WhatsApp. `health-check.md` has `kind: health`, `schedule: "*/10 * * * *"`, `catch_up_minutes: 1`.

### Delivery (`deliver.ts`)
`BridgeDeliverer.send(to, text)`: `chunkText` at 3,500 → POST `/send` per chunk, 2 s apart, 10 s timeout; throws on non-2xx (→ spool `deliver` stage).

### Brain commands (`apps/brain/src/commands/routines.ts`)
`handleRoutineCommand(text, ctx)` with `ctx = { vaultDir, db, defaultTimezone, now?: () => Date }`. Trim, case-insensitive on the verb. Returns `null` when the text is not a routine command. Owner-only enforcement is the router's job (documented).
- `routines` → one line per routine: `name · cron (human) · next <Mon 07:00> · enabled|paused · last <status at time>`; once routines show the fire time; meeting-prep shows `event-driven`.
- `run <name>` → unknown name → list of names; else enqueue manual and reply `Queued <name>. Result in about a minute.`
- `pause <name>` / `resume <name>` → `setEnabled`; reply with the new state and next run.
- `history <name>` → last 5 runs: `<local time> · status · <60-char preview> · <log path>`; none → say so.
- `new routine <schedule phrase>: <prompt>` → `parseSchedulePhrase` → cron; name = slug of the first 4 words of the prompt (suffix `-2`, `-3` if taken); write file with `model: opus`, `tools: [google, whatsapp, vault]`, default tz; reply `Created <name> — <cron> (<human>). Next run <time>. File: vault/routines/<name>.md`. Unparseable phrase → reply with the supported forms.
- `remind me <when> to <what>` (also `remind me to <what> <when>`) → `parseReminder`; write `vault/routines/reminder-<slug>-<yyyymmdd-hhmm>.md` with `once`, `kind: static`, body `⏰ Reminder: <what>`; reply `Reminder set for <local time>: <what>`. Past or unparseable → explain.

`parseSchedulePhrase` grammar (deterministic, no LLM): `every (day|weekday|weekdays|weekend|weekends|<dayname>[, <dayname>…][ and <dayname>]|hour|N minutes|N hours)[ at H[:MM][am|pm][ and H[:MM][am|pm]…]]`. Default time when omitted for day forms: 09:00. Returns `{ cron, human }`.

### Starter routines (bodies written for an Opus agent with `google`, `whatsapp`, `vault` MCPs; each ends with the STATUS instruction)
1. `morning-brief` — `0 7 * * 1-5`, tools google/whatsapp/vault: today's calendar; unread mail triaged reply/read/ignore; WhatsApp threads unanswered > 24 h (via whatsapp MCP); top 3 items from current projects in `vault/wiki/Projects` (or `vault/memory` if wiki is empty).
2. `evening-close` — `0 21 * * *`: sent messages + meetings today, open loops, ask for a 1-line journal entry; instruct the agent to end with `STATUS: needs_input`; the body tells the next brain turn to store the reply as `vault/raw/note-journal-<date>.md`.
3. `weekly-review` — `0 18 * * 0`: week in numbers, decisions captured, memory changes (`git log` is not available to the agent — use vault file listings), next week's calendar, 3 questions.
4. `meeting-prep` — `schedule: "*/5 * * * *"`, `trigger: {type: calendar, lead_minutes: 15}`: the scheduler injects the event JSON; the prompt asks for who the attendees are (vault + WhatsApp + email history), last contact, agenda.
5. `inbox-digest` — `0 12,18 * * *`: new important email only, since the previous digest.
6. `followups` — `0 9 * * *`: promises in sent WhatsApp/email ("I'll send…") in the last 7 days not yet done.
7. `health-check` — `*/10 * * * *`, `kind: health`, `catch_up_minutes: 1`, body describes what is checked (documentation only).
(`memory-consolidate` and `memory-review` belong to Phase 6 and are not created.)

### systemd (`deploy/hetzner/systemd/cxw-scheduler.service`)
`[Unit]` After=network-online.target cxw-bridge.service; Wants=network-online.target. `[Service]` Type=simple, User=cxw, Group=cxw, WorkingDirectory=/srv/cxw/app, EnvironmentFile=/srv/cxw/cxw.env, EnvironmentFile=-/srv/cxw/google.env, ExecStart=/usr/bin/node apps/scheduler/dist/main.js, Restart=always, RestartSec=5, KillSignal=SIGTERM, TimeoutStopSec=120, hardening (NoNewPrivileges, ProtectSystem=full, ProtectHome=read-only, ReadWritePaths=/srv/cxw/data /srv/cxw/app/vault, PrivateTmp). `[Install]` WantedBy=multi-user.target.

### Env (`config.ts`, documented in `deploy/hetzner/cxw.env.example`)
`CXW_TZ` (Europe/Prague), `CXW_VAULT_DIR` (`<repo>/vault`), `CXW_DATA_DIR` (`/srv/cxw/data`), `SCHEDULER_DB`, `CXW_WORKSPACE_DIR` (`<repo>/workspace`), `BRIDGE_URL`, `OWNER_JID` (optional; `owner` is resolved by the bridge), `SCHEDULER_TICK_MS` (60000), `MAX_CONCURRENT_JOBS` (2), `LEASE_TTL_MS` (90000), `JOB_TIMEOUT_MS` (900000), `CALENDAR_POLL_MINUTES` (5), `DISK_MIN_FREE_PCT` (10), `BACKUP_STAMP_FILE`, `BACKUP_MAX_AGE_HOURS` (8), `ALERT_EMAIL_TO`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` (passed through to the SDK).

## Steps (ordered)
1. Root skeleton: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`. `corepack pnpm install`.
2. `apps/scheduler`: package files, `types.ts`, `config.ts`, `log.ts`, `routine.ts`, `schedule.ts` + tests `routine.test.ts`, `schedule.test.ts`. Run tests.
3. `db.ts`, `lease.ts`, `spool.ts`, `runs.ts`, `chunk.ts` + tests `lease.test.ts`, `spool.test.ts`, `chunk.test.ts`. Run tests.
4. `deliver.ts`, `google.ts`, `runner/static.ts`, `runner/health.ts`, `runner/brain.ts` (verify SDK types from the installed `.d.ts`), `prompt.ts`, `calendar-trigger.ts`, `scheduler.ts`, `main.ts`, `index.ts` + `test/helpers.ts`, `scheduler.test.ts`. Run tests.
5. `apps/brain`: package files, `schedule-phrase.ts`, `reminder.ts`, `commands/routines.ts` + 3 test files. Run tests.
6. Vault: 7 routine files + README + `runs/.gitkeep`. Verify each parses with `loadRoutines` (add an assertion in `routine.test.ts` that loads `vault/routines` and expects 7 valid routines).
7. Deploy: unit file + env example. READMEs.
8. `corepack pnpm typecheck` and `corepack pnpm test` green. Write `audit.md`.

## Tests (vitest, all deterministic, no network)
- Frontmatter: valid parse + defaults; schedule/once exclusivity; invalid cron; invalid tz; name/filename mismatch; `setEnabled` preserves other lines; all 7 starter files parse.
- Next run across timezones: `0 7 * * 1-5` from `2026-09-03T00:00Z` → Prague `2026-09-03T05:00Z`, `America/Managua` → `13:00Z`; DST: Prague after `2026-10-25` → `06:00Z`; `dueSlot` inside/outside catch-up window; once due/expired; skipped-slot detection.
- Lease: claim, contention, expiry takeover, heartbeat extend, heartbeat after loss = false, release.
- Spool: idempotent enqueue, due ordering, backoff growth, max attempts drop + run failed, deliver-stage payload preserved, reopen same DB file → item still pending, no duplicate.
- Scheduler integration (fakes): 07:00 tick runs morning-brief once and writes a run log; tick again at 07:00:30 → no second run; runner failure → spooled with backoff, no duplicate run rows; deliverer failure after success → `deliver` stage, runner call count stays 1; once routine deleted after delivery; `STATUS: needs_input` → status `needs_input`; health kind uses health runner and alerts only on change.
- Brain: schedule phrases (`every weekday at 7` → `0 7 * * 1-5`; `every day at 7:30pm` → `30 19 * * *`; `every monday and thursday at 9` → `0 9 * * 1,4`; `every 30 minutes` → `*/30 * * * *`; nonsense → null); reminders (`Friday 9am to call Marco` from a Wednesday in Prague → correct UTC instant, what = `call Marco`); `routines` lists next run; `run x` enqueues; `pause x` flips the file; unknown command → null.

## Out of scope (do NOT do)
- No Baileys/bridge, no LLM chat loop, no MCP servers, no `workspace/` content beyond what tests need (tests must not require `workspace/`).
- No `memory-consolidate` / `memory-review` routines (Phase 6). No bootstrap.sh/backup.sh (Phase 0/7).
- No git commands (init/commit/branch) — the orchestrator handles the branch after review.
- No repo-wide formatters or linters. No `packages/shared` (defer until a second consumer exists).
- Do not call the network in tests; do not require Google or Anthropic credentials to run tests or `typecheck`.
