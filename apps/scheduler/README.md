# `@cxw/scheduler`

Runs the routines in `vault/routines/` on their schedule, delivers the output to WhatsApp through
the bridge, and keeps a run log in `vault/runs/`.

Entry point: `src/main.ts` (`pnpm --filter @cxw/scheduler start`). Importing `src/index.ts` has no
side effects; it is the library surface the brain's routine commands use.

## Routine file format

One file per routine, `vault/routines/<name>.md`. The stem of the filename must equal `name`.

```yaml
---
name: morning-brief # kebab-case; must equal the filename stem
schedule: '0 7 * * 1-5' # 5-field cron, evaluated in `timezone`. Omit when `once` is set.
once: 2026-09-05T09:00 # ISO local datetime. Mutually exclusive with `schedule`.
timezone: Europe/Prague # default: CXW_TZ
model: opus # opus | fable | sonnet | haiku (default opus)
tools: [google, whatsapp, vault] # MCP server keys from workspace/.mcp.json (default [])
deliver_to: owner # 'owner' or a WhatsApp JID (default owner)
enabled: true # `pause` / `resume` flip this line
kind: llm # llm | static | health (default llm)
trigger: # optional, event-driven
  type: calendar
  lead_minutes: 15
  require_attendees: true
catch_up_minutes: 10 # default 10 for cron, 1440 for once
max_turns: 30 # Agent SDK maxTurns (default 30)
description: one line # optional, shown by `routines`
---
The prompt body, in Markdown.
```

Model aliases resolve to `claude-opus-5`, `claude-fable-5-1`, `claude-sonnet-5` and
`claude-haiku-4-5-20251001`.

Kinds:

- `llm` — the body becomes the prompt of a fresh headless Claude Code session.
- `static` — the body is the message. No model is called. Reminders use this.
- `once` — a `once:` routine deletes its own file after the message is delivered.
- `health` — the built-in health probes, no model. See below.

One bad file never stops the scheduler: it is logged and skipped, and the other routines run.

## The STATUS marker

Every `llm` routine must end its reply with exactly one of:

```
STATUS: done
STATUS: needs_input
STATUS: failed
```

The scheduler strips that line, stores the status on the run row, and delivers the rest. A missing
or unrecognised marker is treated as `done`. `needs_input` means the routine asked the owner a
question and expects the next WhatsApp turn to answer it.

The prompt also asks for plain WhatsApp text, about 3500 characters per section, and long output
written to a file under `vault/` with a summary of at most five lines returned instead.

## Bridge contract

- `POST ${BRIDGE_URL}/send` with JSON `{ "to": "owner" | "<jid>", "text": "..." }` → 2xx.
- `GET ${BRIDGE_URL}/health` → `{ "connected": boolean }`.

Text longer than 3500 characters is split on a blank line, then a line break, then a hard cut.
Chunks go out two seconds apart, each with a 10-second timeout. `Authorization: Bearer
${BRIDGE_TOKEN}` is sent only when `BRIDGE_TOKEN` is set.

## Outages and retries

- **Due detection.** A cron slot only fires when it is inside its `catch_up_minutes` window. An
  outage therefore never releases a pile of stale jobs. The first slot missed during the outage is
  written to `runs` as `skipped`, so the gap is visible in `history`.
- **One run at a time.** Each routine is guarded by a lease in SQLite. The lease is renewed every
  `LEASE_TTL_MS / 3` while a job runs; a lost lease aborts the job.
- **Restart.** Any run left `running` by a crash, with no live lease, is closed as `failed` with
  `stale after restart`. It is not re-run.
- **Job failure.** The spool item is retried with backoff `min(60 s · 2^attempts, 30 min)`, up to
  three attempts. The run row is reused, so retries never duplicate history.
- **Delivery failure.** The item is re-staged as `deliver` carrying the produced text, and retried
  up to ten times. The model is never called again because of a delivery problem.
- **Concurrency.** At most `MAX_CONCURRENT_JOBS` LLM jobs run at once. `health` and `static`
  routines are never blocked behind them.

## Health check

`kind: health` runs four probes, with no model:

| probe      | passes when                                                                 |
| ---------- | --------------------------------------------------------------------------- |
| `whatsapp` | the bridge `/health` reports `connected: true` (5 s timeout)                |
| `google`   | a token refresh succeeds; "not configured" also passes, with a note         |
| `disk`     | used percentage of `CXW_DATA_DIR` is at most `CXW_DISK_LIMIT_PCT`           |
| `backup`   | the backup stamp file is younger than `CXW_BACKUP_MAX_AGE_H`; missing fails |

An alert is sent only when a probe changes state — down, or recovered. It goes over WhatsApp,
except when the `whatsapp` probe itself is the failing one, in which case it goes by e-mail to
`CXW_ALERT_EMAIL_TO`. A run log is written only when at least one probe is not ok.

The new probe state is stored only after the alert has actually gone out, so a failed send does
not silence that failure for good. One consequence is deliberate: with no `CXW_ALERT_EMAIL_TO`
configured, a `whatsapp` probe failure has no channel left — the fallback is the bridge, which is
down by definition. The send fails, the state is not stored, and no "recovered" message is ever
sent either, because as far as the database is concerned nothing ever changed. WhatsApp being down
is visible on the phone itself, so this is accepted rather than worked around. Set
`CXW_ALERT_EMAIL_TO` to get the alert by e-mail instead.

## Calendar triggers

A routine with `trigger.type: calendar` uses its cron only as a poll cadence. Every
`CALENDAR_POLL_MINUTES` the scheduler lists the events starting inside
`[now, now + lead_minutes + poll]`, keeps the ones with at least one attendee who is not the
calendar owner, and spools a `calendar` run that becomes due `lead_minutes` before the meeting.
Each event fires at most once per routine.

## Manual runs

`run <name>` from the brain enqueues `{ trigger: 'manual', slot: now, stage: 'run' }`. The next
tick picks it up, so the result arrives within about a minute.

## Run logs

`vault/runs/<name>/<YYYY-MM-DDTHH-mm-ssZ>.md` (UTC), with frontmatter `routine`, `trigger`,
`scheduled_for`, `started`, `finished`, `status`, `model`, `attempts`, `cost_usd`, `error`, and the
result text as the body.

## Environment

| variable                                                             | default                                | meaning                                     |
| -------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------- |
| `CXW_TZ` / `TZ`                                                      | `Europe/Prague`                        | default timezone for routines               |
| `LOG_LEVEL`                                                          | `info`                                 | pino level                                  |
| `CXW_VAULT_DIR`                                                      | `<repo>/vault`                         | routines and run logs                       |
| `CXW_DATA_DIR`                                                       | `/srv/cxw/data`                        | database and disk probe                     |
| `CXW_WORKSPACE_DIR`                                                  | `<repo>/workspace`                     | agent `cwd`; holds `CLAUDE.md`, `.mcp.json` |
| `SCHEDULER_DB`                                                       | `<CXW_DATA_DIR>/scheduler.sqlite`      | SQLite file                                 |
| `BRIDGE_URL`                                                         | `http://${BRIDGE_HOST}:${BRIDGE_PORT}` | bridge base URL                             |
| `BRIDGE_TOKEN`                                                       | unset                                  | bearer token for the bridge                 |
| `OWNER_JID`                                                          | unset                                  | resolved by the bridge when unset           |
| `SCHEDULER_TICK_MS`                                                  | `60000`                                | tick interval                               |
| `MAX_CONCURRENT_JOBS`                                                | `2`                                    | parallel LLM jobs                           |
| `LEASE_TTL_MS`                                                       | `90000`                                | lease lifetime                              |
| `JOB_TIMEOUT_MS`                                                     | `900000`                               | wall-clock limit for one job                |
| `CALENDAR_POLL_MINUTES`                                              | `5`                                    | calendar trigger poll cadence               |
| `CXW_DISK_LIMIT_PCT`                                                 | `85`                                   | maximum used disk percentage                |
| `CXW_BACKUP_STAMP_FILE`                                              | unset                                  | file whose mtime the backup probe reads     |
| `CXW_BACKUP_MAX_AGE_H`                                               | `8`                                    | maximum backup age                          |
| `CXW_ALERT_EMAIL_TO`                                                 | unset                                  | e-mail fallback for health alerts           |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | unset                                  | Google REST access                          |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`                      | unset                                  | passed through to the Agent SDK             |

Startup fails when neither Anthropic credential is set and at least one enabled routine is
`kind: llm`.
