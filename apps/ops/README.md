# @cxw/ops

The operations layer for ClaudeXWhatsapp. It watches the box, alerts the owner, purges old
history, tracks model cost against a monthly cap, and provides the kill switch.

It is self-contained: it imports no other workspace package and talks to the bridge and the
brain over HTTP and to the bridge SQLite store read-only. SQLite access uses Node's built-in
`node:sqlite`, so there is no native build step.

## Commands

Run through the installed wrapper (`/usr/local/bin/cxw-ops`) or locally with
`node_modules/.bin/tsx apps/ops/src/cli.ts <command>`.

| Command                                      | Output                                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `health [--json] [--no-alert]`               | `OK/FAIL <name> - <detail>` per check, then `HEAL <action>` lines. Writes `health.json`. Exit 1 on any failure. |
| `purge [--dry-run] [--emergency]`            | one JSON line `{ dryRun, emergency, textRows, mediaRows, files, bytes, skipped }`; exit 2 on refusal            |
| `costs [today\|month\|line\|check\|unpause]` | totals JSON, the daily cost line, or the cap warning (`check` also delivers it)                                 |
| `panic [reason]` / `resume`                  | raises/clears the panic flag and drives `cxw-ctl`                                                               |
| `status`                                     | the same text the WhatsApp `status` command returns                                                             |
| `alert-test <text...>`                       | pushes text through the delivery chain; exit 0 if a channel accepted it                                         |
| `sentinel`                                   | long-running kill-switch watcher (no LLM)                                                                       |

Heal action strings are exactly `restart bridge`, `restart brain`, `purge --emergency`,
`backup`. `restart brain` is never emitted while the panic flag exists.

All logging goes to **stderr**, so the stdout of `health --json` and of `purge` is pure
machine-readable output that `jq` can read.

`costs check` is the one caller allowed to tell the owner about the monthly cap. It runs
`notifyCap()`, which delivers the warning through the alert chain (WhatsApp → email →
Telegram) **once per month per level** — once at `CXW_COST_WARN_PCT`, once at 100 % — and
prints the text only when it actually delivered. `recordUsage()` calls `checkCap()` for its
`cost-paused` flag side effect only; it can no longer swallow the owner's warning. The
monitor tick calls `costs check` after the health run. Exit code is always 0.

`purge` **refuses** to run when `CXW_RETENTION_OWNER_FOREVER` is on and the owner list is
empty (missing, truncated or unparsable `owners.json`): an empty allowlist would delete the
owner's whole archive. The CLI prints `refusing to purge: owner list is empty (check
CXW_OWNERS_FILE)` on stderr and exits **2**, writing nothing; the WhatsApp `purge` command
returns the same sentence. A dry run refuses too, and never overwrites `last-purge.json`.

Only files under `MEDIA_DIR` are ever unlinked. `CXW_DATA_DIR` itself is off limits: it
holds `bridge.sqlite`, `ops.sqlite` and the Baileys `session/`. Rows pointing anywhere else
— `../bridge.sqlite`, `../../etc/x`, or an absolute path elsewhere on the box — are
skipped, counted in `skipped`, and logged as a count only (never the path). Both sides of
the comparison go through `realpath`, so a symlinked data volume still purges normally.

## WhatsApp commands

Owners only, optional leading `/`: `panic`, `resume`, `status`, `purge [--dry-run]
[--emergency]`, `costs [today|month]`, `costs unpause`. Everything from a non-owner is
ignored.

The `sentinel` watcher fires the kill switch only inside an **owner conversation**: the
chat JID must be an owner, and the message must be ours (`from_me`) or from an owner. The
word "panic" typed to a third party or in a group never stops production. The action runs
**before** the acknowledgement, so an unreachable bridge cannot turn `panic` into a no-op;
a failed action is still marked handled (no retry storm) but is logged and re-alerted.

## Environment

Every key is read from the process environment; systemd loads `/srv/cxw/cxw.env` and
`/srv/cxw/google.env`. The authoritative table is in
`feature-research/phase-7-ops/plan.md` sections B, H and I. The keys in short:

| Key                                                                                                                                        | Default                                     | Meaning                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ----------------------------------------------------- |
| `CXW_DATA_DIR`, `CXW_STATE_DIR`                                                                                                            | `/srv/cxw/data`, `/srv/cxw/state`           | bridge data, ops state                                |
| `CXW_OWNERS_FILE`, `OWNER_JIDS`                                                                                                            | `/srv/cxw/state/owners.json`                | owner allowlist (file + env addition)                 |
| `BRIDGE_HOST`/`BRIDGE_PORT`, `BRAIN_HOST`/`BRAIN_PORT`                                                                                     | `127.0.0.1:7411`, `:7412`                   | services (`BRIDGE_URL`/`BRAIN_URL` override)          |
| `BRIDGE_TOKEN`                                                                                                                             | —                                           | bearer token for `POST /send`                         |
| `BRIDGE_DB`, `CXW_OPS_DB`, `MEDIA_DIR`, `DISK_PATH`                                                                                        | under `CXW_DATA_DIR`                        | stores and the measured filesystem                    |
| `HEALTH_TIMEOUT_MS`, `CXW_DISK_LIMIT_PCT`, `CXW_BACKUP_MAX_AGE_H`                                                                          | `5000`, `85` (used %), `8`                  | health thresholds                                     |
| `CXW_GOOGLE_CHECK`, `CXW_GOOGLE_TOKEN_URL`, `GOOGLE_*`                                                                                     | `on`, Google's endpoint                     | refresh-token check                                   |
| `CXW_CLAUDE_AUTH_DEEP_CHECK_MIN`, `CXW_CLAUDE_BIN`, `CXW_MODEL_FAST`, `CXW_CLAUDE_CREDENTIALS_FILE`                                        | `60`, `claude`, `claude-haiku-4-5-20251001` | auth check (0 = never spawn `claude`)                 |
| `CXW_ALERT_TRANSPORT`, `CXW_ALERT_WHATSAPP_JID`, `CXW_ALERT_REPEAT_MIN`, `CXW_ALERT_AFTER_FAILURES`                                        | `live`, first owner, `240`, `1`             | alerting                                              |
| `SMTP_*`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO`, `TELEGRAM_*`                                                                               | —                                           | fallback channels                                     |
| `CXW_RETENTION_TEXT_DAYS`, `CXW_RETENTION_MEDIA_DAYS`, `CXW_RETENTION_OWNER_FOREVER`, `CXW_PURGE_EMERGENCY_MEDIA_DAYS`, `CXW_PURGE_VACUUM` | `180`, `90`, `true`, `14`, `false`          | retention                                             |
| `CXW_COST_MONTHLY_CAP_USD`, `CXW_COST_WARN_PCT`                                                                                            | `100`, `80`                                 | cost cap                                              |
| `CXW_CTL`, `CXW_SUDO`                                                                                                                      | `/usr/local/bin/cxw-ctl`, `sudo -n`         | privileged helper (`CXW_SUDO=""` disables the prefix) |
| `LOG_LEVEL`, `TZ`                                                                                                                          | `info`, box time zone                       | logging; `TZ` decides cost months                     |

## State files (`$CXW_STATE_DIR`)

`health.json`, `alerts.json`, `last-purge.json`, `sentinel.json`, `claude-auth-deep.json`,
`panic`, `cost-paused`, `cost-warned-<YYYY-MM>`, `cost-paused-alerted-<YYYY-MM>`,
`last-backup` (written by `backup.sh`).

## Integration with the other phases

| Caller            | Function                                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| brain router      | `handleOpsCommand(text, { senderJid, isOwner, messageId? }) → Promise<string \| null>` — call it **before** any LLM call; a non-null result is the reply and consumes the message |
| brain + scheduler | `recordUsage({ ts?, source, chatJid?, routine?, model, inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, costUsd? })` — one row per model                           |
| scheduler         | `getPauseState() → { paused, reasons }` before claiming a routine; while paused run only `essential: true` routines                                                               |
| scheduler         | `dailyCostLine()` appended to routines with `cost_line: true`                                                                                                                     |
| monitor + CLI     | `runHealth()`, `purge()`, `checkCap() → { pct, total, cap, level, text }`, `notifyCap(deliver)`                                                                                   |

## Privacy

The pino logger redacts `jid`, `chatJid`, `senderJid`, `targetJid`, `remoteJid`, `text`,
`body`, `caption`, `preview` and their nested forms with `[redacted]`, and writes to
stderr. The panic reason is owner message text, so it is never logged — only its length —
and lives in the 0600 `panic` flag file. Alerts name checks,
never chats; use `maskJid()` if a JID is ever unavoidable. Alerts are only ever sent to an
owner JID — `deliver()` refuses anything else.

## Development

```sh
pnpm install                        # from the repo root
pnpm --filter @cxw/ops typecheck
pnpm --filter @cxw/ops test
```
