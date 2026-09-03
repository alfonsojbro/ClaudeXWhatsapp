# routines/

One routine per Markdown file. The filename stem **is** the routine name: `morning-brief.md` must
declare `name: morning-brief`. Edit these files in Obsidian; the scheduler re-reads the folder on
every tick (about once a minute), so a saved change takes effect within the minute. A file that
fails to parse is skipped and logged — the other routines keep running.

The authoritative schema is `apps/scheduler/src/routine.ts`. This page describes it.

## Shape

```yaml
---
name: morning-brief            # required; must equal the filename stem
schedule: "0 7 * * 1-5"        # 5-field cron, read in `timezone`
timezone: Europe/Prague        # default: CXW_TZ
model: opus                    # opus | fable | sonnet | haiku
tools: [google, whatsapp, vault]
deliver_to: owner              # 'owner' or a WhatsApp JID
enabled: true
kind: llm                      # llm | static | health
catch_up_minutes: 10
max_turns: 30
description: one line, shown by the `routines` command
---
The prompt body, in Markdown.
```

## Fields

| field | type | default | notes |
| --- | --- | --- | --- |
| `name` | kebab-case string | — | Required. Must match the filename stem and `^[a-z0-9][a-z0-9-]*$`. |
| `schedule` | cron string | — | Five fields, croner syntax, evaluated in `timezone`. Quote it: a bare `0 7 * * 1-5` is not valid YAML in every case. |
| `once` | local datetime | — | `2026-09-05T09:00`, read in `timezone`. An explicit offset or `Z` is allowed. |
| `timezone` | IANA zone | `CXW_TZ` (`Europe/Prague`) | Anything `Intl.DateTimeFormat` accepts. |
| `model` | alias | `opus` | `opus`, `fable`, `sonnet`, `haiku`. See the table below. |
| `tools` | list of strings | `[]` | Keys from `workspace/.mcp.json`. Only the servers listed here are started for the run. A name that is not in `.mcp.json` fails the run. |
| `deliver_to` | string | `owner` | `owner`, or a WhatsApp JID to send somewhere else. |
| `enabled` | boolean | `true` | The `pause` and `resume` commands flip this one line and touch nothing else. |
| `kind` | `llm`/`static`/`health` | `llm` | See "Kinds". |
| `trigger` | object | — | Event-driven firing. See "Calendar triggers". |
| `catch_up_minutes` | integer | `10` for cron, `1440` for `once` | How stale a missed slot may be and still run. |
| `max_turns` | integer | `30` | Agent SDK turn limit for one run. |
| `description` | string | — | One line, shown in the `routines` listing. |

**Set exactly one of `schedule` and `once`.** Neither, or both, is an error.

### Model aliases

| alias | model id |
| --- | --- |
| `opus` | `claude-opus-5` |
| `fable` | `claude-fable-5-1` |
| `sonnet` | `claude-sonnet-5` |
| `haiku` | `claude-haiku-4-5-20251001` |

### Kinds

- **`llm`** — the body is a prompt. It runs as a fresh headless Claude Code session in
  `CXW_WORKSPACE_DIR`, holding only the MCP servers in `tools` plus `Read`, `Grep` and `Glob`.
  `Bash`, `Write`, `Edit`, `WebFetch`, `WebSearch` and `Task` are denied.
- **`static`** — the body is delivered verbatim, with no model call. Reminders use this.
- **`health`** — the scheduler runs its built-in probes instead of the body. There is exactly one
  of these, `health-check.md`; its body is documentation.

### Calendar triggers

```yaml
schedule: "*/5 * * * *"
trigger:
  type: calendar
  lead_minutes: 15
  require_attendees: true
```

With a `trigger`, the `schedule` becomes the **polling cadence only** — the routine never fires on
the cron itself. Every poll, the scheduler looks ahead `lead_minutes` for calendar events, and
queues one run per event timed to `start − lead_minutes`. `require_attendees: true` ignores events
where Alfonso is the only attendee. Each event fires once, ever. The event JSON is injected into
the prompt as trigger context.

### Catch-up and outages

A slot older than `catch_up_minutes` is never run. If the box was down at 07:00 and comes back at
09:00, `morning-brief` does **not** fire two hours late — the missed slot is recorded as `skipped`
so it shows up in `history`. Raise `catch_up_minutes` for a routine that is still useful when late;
lower it for one that is worthless when stale (`health-check` uses `1`).

## The prompt body

The body is the whole prompt, plus a header the scheduler prepends (routine name, local date and
time, timezone) and an output contract it appends. The contract asks for plain WhatsApp text, about
3,500 characters per message, long output written into the vault with a short summary, and a final
line of `STATUS: done`, `STATUS: needs_input` or `STATUS: failed`.

`needs_input` marks the run as awaiting a reply — `evening-close` uses it to ask its journal
question. Write the status instruction into the body as well; being told twice is cheap.

## Run history

Every run writes `vault/runs/<name>/<UTC timestamp>.md` with frontmatter (`routine`, `trigger`,
`scheduled_for`, `started`, `finished`, `status`, `model`, `attempts`, `cost_usd`, `error`) and the
result as the body. `health-check` writes a log only when a probe fails.

## Commands (WhatsApp, owner only)

| command | effect |
| --- | --- |
| `routines` | list every routine with its schedule, next run, state and last result |
| `run <name>` | queue one manual run; it starts within a minute |
| `pause <name>` / `resume <name>` | flip `enabled` in the file |
| `history <name>` | the last five runs with status and log path |
| `new routine <when>: <prompt>` | write a new routine file — for example `new routine every weekday at 7: brief me on the day` |
| `remind me <when> to <what>` | write a one-shot `static` reminder — for example `remind me Friday 9am to call Marco` |

A `once` routine deletes its own file after it is delivered, so reminders do not accumulate.
