# @cxw/brain

The brain: the Claude Agent SDK chat loop, the router, the confirm gate, and the media pipeline.
Most of that is Phase 2. What exists today is the **routine command handler** from Phase 5.

## Routine commands

`handleRoutineCommand(text, ctx)` answers the deterministic routine commands without spending an
LLM turn. It returns the reply to send, or `null` when the message is not a routine command.

```ts
import { handleRoutineCommand } from '@cxw/brain';
import { loadConfig, openDb } from '@cxw/scheduler';

const config = loadConfig();
const db = openDb(config.dbPath);

const reply = await handleRoutineCommand(text, {
  vaultDir: config.vaultDir,
  db,
  defaultTimezone: config.timezone,
});
if (reply !== null) {
  await send(reply);
} else {
  await runLlmLoop(text);
}
```

### Two rules the router must follow

1. **Call this before the LLM loop.** It is cheap, deterministic and side-effect-free for anything
   it does not recognise. Calling the model first would burn a turn and answer `routines` with a
   paraphrase.
2. **Owner only.** This module never checks who is asking. It writes files into the vault, flips
   routines on and off, and queues runs. The router must reject a non-owner sender _before_ it gets
   here.

`null` means "not mine" — fall through to the LLM loop. A returned string is final: send it as-is.

### Commands

| message                        | effect                                                              |
| ------------------------------ | ------------------------------------------------------------------- |
| `routines`                     | list every routine: schedule, next run, enabled/paused, last result |
| `run <name>`                   | queue a manual run; the scheduler picks it up within a minute       |
| `pause <name>`                 | set `enabled: false` in the routine file                            |
| `resume <name>`                | set `enabled: true` and report the next run                         |
| `history <name>`               | the last five runs: time, status, preview, log path                 |
| `new routine <when>: <prompt>` | write a new routine file from a schedule phrase                     |
| `remind me <when> to <what>`   | write a one-shot `static` reminder routine                          |

The verb is case-insensitive and the text is trimmed. An unknown routine name is answered with the
list of names that do exist. Nothing else is treated as a command: `running late` is not `run`.

### Context

```ts
interface RoutineCommandContext {
  vaultDir: string; // routines live in <vaultDir>/routines
  db: Db; // the scheduler database, already migrated
  defaultTimezone: string; // used when a routine file sets none
  now?: () => Date; // injected clock; defaults to the system clock
}
```

## Schedule phrases

`parseSchedulePhrase(phrase)` turns a phrase into `{ cron, human }`, or `null`. It is a
deterministic grammar — no model call, so the same phrase always produces the same cron.

```
every (day | weekday[s] | weekend[s] | <daynames> | hour | N minutes | N hours)
      [ at H[:MM][am|pm] [ and H[:MM][am|pm] … ] ]
```

| phrase                           | cron            |
| -------------------------------- | --------------- |
| `every weekday at 7`             | `0 7 * * 1-5`   |
| `every day at 7:30pm`            | `30 19 * * *`   |
| `every monday and thursday at 9` | `0 9 * * 1,4`   |
| `every day at 12 and 6pm`        | `0 12,18 * * *` |
| `every 30 minutes`               | `*/30 * * * *`  |
| `every 2 hours`                  | `0 */2 * * *`   |

Day forms default to 09:00 when no time is given. Interval forms take no time at all. Cron has one
minute field, so several times of day must share a minute — `at 12:00 and 18:30` is rejected rather
than silently rounded. Anything outside the grammar returns `null`, and the caller shows
`SUPPORTED_FORMS`.

## Reminders

`parseReminder(text, now, tz)` reads a phrase with chrono-node (`forwardDate`, resolved against the
zone's UTC offset at `now`) and returns `{ when, what }`. A leading `remind me` is stripped, and
both orders work: `Friday 9am to call Marco` and `call Marco on Friday at 9am`.

A time in the past returns `null`, so the caller can explain rather than silently scheduling next
year. So does a phrase with no readable time, or with no subject left after the time is removed.

A reminder becomes a routine file: `once` plus `kind: static`, named
`reminder-<slug>-<yyyymmdd-hhmm>.md`, with the body `⏰ Reminder: <what>`. The scheduler delivers
the body verbatim with no model call and then deletes the file.

## Tests

```
corepack pnpm --filter @cxw/brain test
```

In-memory databases, a temp vault and an injected clock. No network, no credentials, no real time.
