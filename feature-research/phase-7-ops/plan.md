# Plan — Phase 7: Hardening + ops

**Date:** 2026-09-03 · **Branch (intended):** `phase-7-ops` · **Author:** orchestrator (Claude)

## Context and constraints

- Phases 0–6 are being built **right now by sibling sessions in this same working tree**. When this plan was written the tree held only `README.md` and `docs/IMPLEMENTATION_PLAN.md`. There is no git repo yet.
- Therefore Phase 7 is built as a **self-contained ops package** (`apps/ops`) plus deploy scripts and docs. It does not import from `packages/shared`, `apps/bridge`, `apps/brain`, or `apps/scheduler`. It codes against the **contracts in section C** below, which mirror `docs/IMPLEMENTATION_PLAN.md` §2–§4. The other phases must satisfy those contracts; the ARCHITECTURE doc states them.
- Every implementer edits **only** the files in its own "Files touched" list. Do not create root files (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`) — those belong to Phase 0. `apps/ops` must build and test standalone with `cd apps/ops && pnpm install && pnpm test`.
- No code copied from other projects. Node 20+ compatible (box runs Node 22, dev Mac runs 20). ESM TypeScript, `tsx` for running, `vitest` for tests.
- Never touch a production system. Everything is verified locally with stubs.

## Goal

Ship the operations layer: monitor + alerting with fallbacks, retention purge, cost tracking with a monthly cap, kill switch via a privileged helper, security pass, runbook/architecture docs, and a chaos test with a written result.

## A. Files touched

### Implementer A — `apps/ops` package (TypeScript)
- `apps/ops/package.json`
- `apps/ops/tsconfig.json`
- `apps/ops/vitest.config.ts`
- `apps/ops/README.md`
- `apps/ops/src/config.ts`
- `apps/ops/src/logger.ts`
- `apps/ops/src/state.ts`
- `apps/ops/src/db.ts`
- `apps/ops/src/owners.ts`
- `apps/ops/src/health.ts`
- `apps/ops/src/alerts.ts`
- `apps/ops/src/retention.ts`
- `apps/ops/src/costs.ts`
- `apps/ops/src/killswitch.ts`
- `apps/ops/src/commands.ts`
- `apps/ops/src/sentinel.ts`
- `apps/ops/src/cli.ts`
- `apps/ops/src/index.ts`
- `apps/ops/test/alerts.test.ts`
- `apps/ops/test/retention.test.ts`
- `apps/ops/test/costs.test.ts`
- `apps/ops/test/health.test.ts`
- `apps/ops/test/killswitch.test.ts`
- `apps/ops/test/commands.test.ts`
- `apps/ops/test/sentinel.test.ts`
- `apps/ops/test/helpers.ts`

### Implementer B — deploy scripts
- `deploy/hetzner/monitor.sh`
- `deploy/hetzner/cxw-ctl`
- `deploy/hetzner/sudoers.d/cxw-ctl`
- `deploy/hetzner/security-check.sh`
- `deploy/hetzner/chaos.sh`
- `deploy/hetzner/chaos/stub-services.mjs`
- `deploy/hetzner/chaos/fake-ctl.sh`
- `deploy/hetzner/systemd/cxw-monitor.service`
- `deploy/hetzner/systemd/cxw-monitor.timer`
- `deploy/hetzner/systemd/cxw-purge.service`
- `deploy/hetzner/systemd/cxw-purge.timer`
- `deploy/hetzner/systemd/cxw-sentinel.service`
- `deploy/hetzner/ops.env.example`
- `deploy/hetzner/install-ops.sh`
- `deploy/hetzner/test/cxw-ctl.test.sh`

### Implementer C — docs
- `docs/RUNBOOK.md`
- `docs/ARCHITECTURE.md`
- `docs/runs/chaos-2026-09-03.md` (written after the local chaos run; a separate mini-dispatch)
- `README.md` (append an "Operations" section only; do not rewrite other sections)

## B. Config (all read from the process env; on the box systemd loads `/srv/cxw/cxw.env` + `/srv/cxw/google.env`)

| Key | Default | Meaning |
|---|---|---|
| `CXW_DATA_DIR` | `/srv/cxw/data` | bridge data (sqlite, media, session) |
| `CXW_STATE_DIR` | `/srv/cxw/state` | ops state (alerts.json, health.json, panic, cost-paused, last-backup, restart-budget.json) |
| `CXW_OWNERS_FILE` | `/srv/cxw/config/owners.json` | owner JIDs; JSON array of strings **or** `{ "owners": [...] }` |
| `OWNER_JIDS` | — | comma-separated override/addition to the file |
| `BRIDGE_DB` | `$CXW_DATA_DIR/bridge.sqlite` | bridge store |
| `CXW_OPS_DB` | `$CXW_DATA_DIR/ops.sqlite` | ops store (usage table) |
| `MEDIA_DIR` | `$CXW_DATA_DIR/media` | `<jid>/<msgid>.<ext>` |
| `BRIDGE_URL` | `http://127.0.0.1:7801` | bridge HTTP |
| `BRAIN_URL` | `http://127.0.0.1:7802` | brain HTTP |
| `HEALTH_TIMEOUT_MS` | `5000` | per check |
| `DISK_PATH` | `$CXW_DATA_DIR` | filesystem to measure |
| `DISK_MIN_FREE_PCT` | `15` | alert below |
| `BACKUP_MAX_AGE_H` | `8` | alert if last backup older |
| `RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE` | — | if set, backup age comes from `restic snapshots --latest 1 --json`; else from mtime of `$CXW_STATE_DIR/last-backup` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | — | token check; `GOOGLE_TOKEN_URL` default `https://oauth2.googleapis.com/token` (overridable for stubs) |
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` | — | auth check |
| `CLAUDE_CREDENTIALS_FILE` | `~/.claude/.credentials.json` | cheap auth check (exists, `expiresAt` in future) |
| `CLAUDE_AUTH_DEEP_CHECK_MIN` | `60` | run `claude -p ok --model claude-haiku-4-5` at most this often (0 = never) |
| `ALERT_WHATSAPP_JID` | first owner | where WhatsApp alerts go |
| `ALERT_REPEAT_MIN` | `240` | re-alert interval while still failing |
| `ALERT_AFTER_FAILURES` | `1` | consecutive failures before first alert |
| `ALERT_TRANSPORT` | `live` | `live` or `log` (log = print instead of send; used by tests and local chaos) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO` | — | email fallback; disabled if `SMTP_HOST` unset |
| `TELEGRAM_ALERTS` | `false` | Telegram fallback on/off |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | — | Telegram |
| `RETENTION_TEXT_DAYS` | `180` | third-party text |
| `RETENTION_MEDIA_DAYS` | `90` | third-party media |
| `RETENTION_OWNER_FOREVER` | `true` | never purge owner chats |
| `PURGE_EMERGENCY_MEDIA_DAYS` | `14` | used by `purge --emergency` (monitor self-heal on low disk) |
| `PURGE_VACUUM` | `false` | run `VACUUM` after purge |
| `COST_MONTHLY_CAP_USD` | `100` | pause non-essential routines at/over cap |
| `COST_WARN_PCT` | `80` | warn once at this % of cap |
| `CXW_CTL` | `/usr/local/bin/cxw-ctl` | privileged helper path (`sudo -n $CXW_CTL …`); tests/local chaos point it at a fake |
| `CXW_SUDO` | `sudo -n` | prefix; set to empty for tests/local chaos |
| `LOG_LEVEL` | `info` | pino |

## C. Contracts with the other phases (state them in ARCHITECTURE.md; do not implement the other side)

1. **Bridge HTTP** (`BRIDGE_URL`): `GET /health` → 200 `{ "ok": true, "connected": true|false, "jid": "…", "uptime_s": n }`; ops treats WhatsApp as connected only if `ok && connected`. `POST /send` body `{ "jid": "<owner jid>", "text": "…" }` → 200. Ops only ever sends to owner JIDs (enforced in `alerts.ts`: refuse any non-owner JID).
2. **Brain HTTP** (`BRAIN_URL`): `GET /health` → 200 `{ "ok": true, "sessions": n }`.
3. **Bridge SQLite** (`BRIDGE_DB`): table `messages(jid TEXT, id TEXT, ts INTEGER /* unix ms */, from_me INTEGER, sender TEXT, type TEXT, text TEXT, quoted_id TEXT, media_path TEXT)`; optional FTS5 table `messages_fts` (external content on `messages`). Table `media(msg_id TEXT, jid TEXT, path TEXT, ts INTEGER)` is optional; retention handles both `messages.media_path` and files on disk. If `ts` looks like seconds (< 1e12) treat as seconds.
4. **Owners**: `CXW_OWNERS_FILE` as in section B. Group JIDs (`@g.us`) are never owners even if listed.
5. **Brain command hook**: the brain router calls `handleOpsCommand(text, { senderJid, isOwner }) → Promise<string | null>` from `@cxw/ops` **before** any LLM call. Non-null = reply text, command consumed. Commands (case-insensitive, optional leading `/`): `panic`, `resume`, `status`, `purge [--dry-run] [--emergency]`, `costs [today|month]`, `costs unpause`. Non-owners always get `null`.
6. **Usage recording**: brain and scheduler call `recordUsage({ ts?, source: 'chat'|'routine', chatJid?, routine?, model, inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, costUsd? })`. If `costUsd` is absent it is computed from the pricing table. The Agent SDK result message exposes `total_cost_usd` and `usage`; pass them through. `modelUsage` (per-model breakdown) → one row per model when present.
7. **Pause flags**: the scheduler calls `getPauseState() → { paused: boolean, reasons: ('panic'|'cost-cap')[] }` before claiming a routine. While paused it runs only routines whose frontmatter has `essential: true` (health-check, memory-consolidate). `/srv/cxw/state/panic` and `/srv/cxw/state/cost-paused` are the on-disk flags (JSON with `since`, `reason`).
8. **Daily cost line**: the scheduler appends `dailyCostLine()` to the delivery of any routine whose frontmatter has `cost_line: true`; `evening-close` sets it. Format: `💸 Today: $1.23 (12.3k in / 4.5k out, 3 calls) · Month: $23.45 / $100 (23%)`.
9. **Backup marker**: `deploy/hetzner/backup.sh` (Phase 0) must `date -u +%FT%TZ > /srv/cxw/state/last-backup` on success. Ops also accepts restic directly when `RESTIC_REPOSITORY` is set.
10. **systemd unit names**: `cxw-bridge`, `cxw-brain`, `cxw-scheduler`, `cxw-sentinel`, `cxw-monitor.timer`, `cxw-purge.timer`. Services run as user `cxw`; env files root:root 0600 loaded via `EnvironmentFile=`.

## D. Design

### D1. Health (`health.ts`)
`runHealth(cfg) → { ts, ok, checks: Check[] }`, `Check = { name, ok, detail, healAction?: 'restart bridge'|'restart brain'|'purge --emergency'|'backup'|null }`. Checks, each independently try/caught with timeout:
- `whatsapp`: bridge `/health` ok && connected. heal: `restart bridge`.
- `brain`: brain `/health` ok. heal: `restart brain` (skipped if panic flag set; then detail = "panic mode, expected down").
- `google`: POST token endpoint with refresh_token grant; ok on 200 with `access_token`. Missing env → ok=false detail "not configured" unless `GOOGLE_REFRESH_TOKEN` absent AND `GOOGLE_CHECK=off`. No heal.
- `disk`: `statfs` via `fs.statfs` (Node ≥18.15); free% ≥ `DISK_MIN_FREE_PCT`. heal: `purge --emergency`.
- `backup`: age ≤ `BACKUP_MAX_AGE_H`. heal: `backup`.
- `claude_auth`: cheap check every run (token env present, or credentials file exists with `claudeAiOauth.expiresAt` > now); deep check (`claude -p ok --model claude-haiku-4-5 --max-turns 1`, 60 s timeout) at most every `CLAUDE_AUTH_DEEP_CHECK_MIN`, last-run stamp in state. No heal.
Writes `$CXW_STATE_DIR/health.json`. Phone numbers never logged (logger redaction).

### D2. Alerts (`alerts.ts`)
State file `$CXW_STATE_DIR/alerts.json`: `{ [check]: { status: 'ok'|'failing', failures, firstFailedAt, lastAlertAt, alertCount } }`. `reconcile(previous, checks, now, cfg) → { next, toSend: Alert[] }` is pure and unit-tested: alert when failures reach `ALERT_AFTER_FAILURES` and no alert yet; re-alert after `ALERT_REPEAT_MIN`; recovery message on failing→ok once. Message format: `🚨 cxw: <check> FAILING since <t> — <detail>` / `✅ cxw: <check> recovered after <duration>`.
Delivery (`deliver(alerts, checks, cfg)`): if the `whatsapp` check is ok → WhatsApp via bridge `/send` to `ALERT_WHATSAPP_JID` (must be an owner). If WhatsApp is down or the send throws → email (nodemailer, SMTP) then Telegram if `TELEGRAM_ALERTS=true`. `ALERT_TRANSPORT=log` prints `[alert:<channel>] …` to stdout instead. Multiple alerts in one tick are batched into one message per channel.

### D3. Retention (`retention.ts`)
`purge({ dryRun, emergency }) → { textRows, mediaRows, files, bytes }`. Owner chats = `jid ∈ owners` (self-chat included). Third-party = everything else, groups included.
- Text: `DELETE FROM messages WHERE jid NOT IN (owners) AND ts < cutoffText` (cutoff = now − `RETENTION_TEXT_DAYS`). If `messages_fts` exists try `INSERT INTO messages_fts(messages_fts) VALUES('rebuild')` inside try/catch.
- Media: for messages with `media_path` and `ts < cutoffMedia` in non-owner chats → unlink file, `UPDATE messages SET media_path = NULL`; also walk `MEDIA_DIR/<jid>/` for non-owner jids and unlink files older than cutoff by mtime (orphans). `emergency` uses `PURGE_EMERGENCY_MEDIA_DAYS`, text untouched.
- `RETENTION_OWNER_FOREVER=false` makes owner chats subject to the same rules (documented, off by default).
- Optional `VACUUM`. Result written to `$CXW_STATE_DIR/last-purge.json`.

### D4. Costs (`costs.ts`)
ops.sqlite table `usage(id INTEGER PK, ts INTEGER, source TEXT, chat_jid TEXT, routine TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost_usd REAL)`; index on `ts`. Pricing per MTok (input / output / cache read / cache write): `claude-fable-5-1` 10/50/0.25/12.5 · `claude-fable-5` 10/50/1/12.5 · `claude-opus-5` 5/25/0.5/6.25 · `claude-opus-4-8` 5/25/0.5/6.25 · `claude-sonnet-5` 2/10/0.2/2.5 · `claude-haiku-4-5` 1/5/0.1/1.25 · unknown model → opus-5 rates + warn. Match by prefix so dated ids still price.
`recordUsage`, `todayTotals()`, `monthTotals()`, `dailyCostLine()`, `checkCap()`: at ≥ `COST_WARN_PCT` write warn-once marker `$CXW_STATE_DIR/cost-warned-<YYYY-MM>` and return an owner warning text; at ≥ 100 % write `cost-paused` flag `{ since, reason: 'cost-cap', month, total, cap }` and return text. `checkCap` is called by `recordUsage` and by the monitor. Flag auto-clears when month changes or `costs unpause`. Month boundaries in `TZ` of the process (document: set `TZ=Europe/Prague` in cxw.env).

### D5. Kill switch (`killswitch.ts` + `cxw-ctl`)
`panic(reason)`: write `$CXW_STATE_DIR/panic` `{ since, by, reason }`, then `ctl('stop','scheduler')`, then `ctl('stop','brain')` (brain last, and the command handler returns the ack text *before* stopping the brain: the caller sends the ack, then ops runs the stop on a 1 s timer). `resume()`: delete flag, `ctl('start','brain')`, `ctl('start','scheduler')`. `ctl(action, unit)` runs `${CXW_SUDO} ${CXW_CTL} <action> <unit>` with `execFile` (no shell), 30 s timeout, allowlist checked in TS too.
`cxw-ctl` (bash, root via sudoers): `case` allowlist — actions `start|stop|restart|status|is-active` × units `bridge|brain|scheduler|sentinel|monitor.timer|purge.timer` → `systemctl <action> cxw-<unit>`; `backup` → `/srv/cxw/deploy/backup.sh`; `vacuum-journal` → `journalctl --vacuum-size=200M`. Anything else: exit 64 + `logger -t cxw-ctl "denied: $*"`. `SYSTEMCTL` env override only honored when `CXW_CTL_TEST=1` (for the bash test). Sudoers: `cxw ALL=(root) NOPASSWD: /usr/local/bin/cxw-ctl`, `Defaults!/usr/local/bin/cxw-ctl !requiretty`.
**Sentinel** (`sentinel.ts`, service `cxw-sentinel`): long-running, no LLM. Every 5 s polls `messages` for rows with `ts > lastSeen` and (`from_me = 1` OR `sender ∈ owners`) whose trimmed lowercase text (optional `/`) is `panic` or `resume`; executes the kill switch even if the brain is dead or hung, and marks the message id as handled in `$CXW_STATE_DIR/sentinel.json` so the brain's own handler and the sentinel never double-fire (the brain handler also records the message id when given `messageId` in ctx). Sends the ack via bridge `/send` (owner only). Starts from `lastSeen = now` on boot (never replays history).

### D6. Commands (`commands.ts`)
`handleOpsCommand(text, ctx)`: parse; non-owner → null; `status` → one-liner per check from `health.json` (age shown) + pause state + today's cost; `panic` → ack "🛑 Panic: scheduler and brain stopping. Send `resume` to restart." then trigger; `resume` → "▶️ Resumed." ; `purge` → runs purge (dry-run flag) and returns counts; `costs` → today/month lines; `costs unpause` → clears flag.

### D7. CLI (`cli.ts`, bin `cxw-ops`)
`cxw-ops health [--json] [--no-alert]` (exit 1 if any check fails; prints heal actions as `HEAL <action>` lines for monitor.sh), `cxw-ops purge [--dry-run] [--emergency]`, `cxw-ops costs [today|month|line|check]`, `cxw-ops panic|resume|status`, `cxw-ops alert-test <text>`, `cxw-ops sentinel`.

### D8. monitor.sh (bash, runs as `cxw` via timer every 10 min)
`set -euo pipefail`; source nothing (systemd loads env). Runs `cxw-ops health --json > $CXW_STATE_DIR/health.json` capturing `HEAL` lines. Self-heal with a restart budget: `$CXW_STATE_DIR/restart-budget.json` allows max 3 heals per unit per hour; beyond that it alerts "heal budget exhausted" via `cxw-ops alert-test` and stops healing. Heals: `restart bridge`, `restart brain` (never if panic flag), `purge --emergency` + `vacuum-journal`, `backup`. After a heal, re-run `cxw-ops health --no-alert` once after 20 s to log the outcome. Exit 0 always (timer must not go failed).

### D9. security-check.sh (bash, runs on the box; `--repo` mode runs the static parts locally)
Checks and prints PASS/FAIL per line, exit 1 on any FAIL: env files `/srv/cxw/*.env` mode 0600 root:root; `ufw status` shows `Status: active`, default deny incoming, only the Tailscale interface allowed; no public listeners (`ss -tlnp` non-127.0.0.1/non-tailscale) ; pino redaction present (`grep -R "redact" apps/*/src packages/*/src` finds `paths` including phone/text keys); every `send_*`/`gmail_send`/`calendar_create_event` tool implementation references `confirm_token` (`grep -R` in `mcp/`; FAIL if a send tool file exists without it; SKIP if `mcp/` does not exist yet); sudoers file installed and `visudo -c` passes; `cxw-ctl` mode 0755 root:root; state dir owned by `cxw` 0700.

### D10. chaos.sh
`chaos.sh --local` (Mac/dev, no root): creates a temp dir as `CXW_STATE_DIR`/`CXW_DATA_DIR`, starts `chaos/stub-services.mjs` (tiny node http servers for bridge on 17801, brain on 17802, google token stub on 17803 with a toggle file), points env at them, `ALERT_TRANSPORT=log`, `CXW_SUDO=""`, `CXW_CTL=chaos/fake-ctl.sh` (fake-ctl restarts the stub bridge by re-spawning it, records calls to a log). Scenarios, each with expected observations and an actual PASS/FAIL printed: (1) baseline all green; (2) kill bridge → health fails `whatsapp` → alert goes to email/telegram log channel (not WhatsApp) → monitor heals via fake-ctl → recovery alert; (3) unplug google → toggle stub to 401 → `google` fails → alert via WhatsApp channel → restore → recovery; (4) disk: `DISK_MIN_FREE_PCT=100` override → `disk` fails → heal `purge --emergency` runs against a seeded sqlite → recovery when override removed; (5) dedupe: run health three times while failing → exactly one alert. Prints a Markdown summary to stdout that C copies into `docs/runs/chaos-<date>.md`.
`chaos.sh --box` (on Hetzner, root): real versions: `systemctl kill cxw-bridge`, `mv google.env google.env.chaos`, `fallocate -l <free-1GB> /srv/cxw/data/chaos.fill`; waits for the timer or runs monitor.sh directly; restores everything in a `trap` on exit. Requires `--i-know` flag.

### D11. Docs
- `docs/RUNBOOK.md`: deploy (bootstrap → install-ops.sh → pair → verify), update (git pull, pnpm install, restart order bridge→brain→scheduler, sentinel), pairing (QR / pairing code, re-pair after logout), restore from restic (list snapshots, restore session+sqlite+media to /srv/cxw/data, fix perms, restart), rotate tokens (Google refresh token, Claude OAuth token / API key, SMTP, Telegram, restic password), panic/resume, purge, costs and cap, alerts and fallbacks, chaos test, common failures table.
- `docs/ARCHITECTURE.md`: system diagram (from plan §2) + ops layer + contracts C1–C10 + data flow of an alert + state files table + security model.
- `README.md`: append `## Operations` linking RUNBOOK, ARCHITECTURE, `cxw-ops` commands, WhatsApp commands.

## E. Steps
1. A, B in parallel. A runs `pnpm install` inside `apps/ops` (creates its own lockfile) and `pnpm test`. B runs `bash deploy/hetzner/test/cxw-ctl.test.sh` and `bash -n` on every script, `shellcheck` if available.
2. Reviewer on A+B diff; fix loop.
3. Orchestrator runs `deploy/hetzner/chaos.sh --local`; C writes docs incl. the chaos run result.
4. `security-review` skill on the repo; fixes via implementer.
5. Final report.

## F. Tests
- vitest in `apps/ops/test`: alerts reconcile state machine (first alert, dedupe, repeat after interval, recovery), retention against temp sqlite + temp media dir (owner rows preserved, third-party purged, emergency only media, dry-run touches nothing), costs (pricing, cap warn once, pause flag, month rollover, `total_cost_usd` passthrough), health with stub servers spun in-test and `DISK_MIN_FREE_PCT` overrides, killswitch order + allowlist + fake ctl, commands (non-owner null, each command), sentinel matching + dedupe.
- bash: `cxw-ctl` allowlist test with `CXW_CTL_TEST=1 SYSTEMCTL=echo`.

## G. Out of scope
- Anything under `apps/bridge`, `apps/brain`, `apps/scheduler`, `mcp/`, `packages/`, `workspace/`, `vault/`, root config files, `deploy/hetzner/bootstrap.sh`, `backup.sh`, `restore.sh`, other systemd units. Never run `git init`/commit/checkout. Never modify `docs/IMPLEMENTATION_PLAN.md`.

## H. Amendments after scouting the skeleton (2026-09-03, supersede earlier lines where they conflict)

- **Working tree:** all Phase 7 work happens in the git worktree `/Users/alfonsobriceno/ClaudeXWhatsapp/.worktrees/phase-7-ops` (branch `phase-7-ops`, based on the committed skeleton 6508f1c). Never edit files in the main tree `/Users/alfonsobriceno/ClaudeXWhatsapp`. Never run git commands (no add/commit/checkout); the orchestrator commits.
- **Node:** use Node 22: `export PATH=$HOME/.nvm/versions/node/v22.23.2/bin:$PATH` before pnpm/vitest. Root `package.json` engines `>=22 <23`, `packageManager pnpm@10.34.5`, workspace globs `apps/*`, `mcp/*`, `packages/*`; root `tsconfig.base.json` is strict with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, NodeNext. `apps/ops/tsconfig.json` extends `../../tsconfig.base.json` like `apps/bridge/tsconfig.json` does (copy its shape). Package name `@cxw/ops`, `"type": "module"`, scripts `start` (`tsx src/cli.ts sentinel`), `typecheck`, `build`, `test` (`vitest run`), `bin: { "cxw-ops": "./bin/cxw-ops.js" }` where `apps/ops/bin/cxw-ops.js` is a 3-line ESM shim that imports `tsx`-less compiled output? — NO: keep it simple: `bin/cxw-ops.js` = `#!/usr/bin/env node` + `import('../dist/cli.js')`, and the deploy scripts call `pnpm --filter @cxw/ops exec tsx src/cli.ts …` via a wrapper `cxw-ops` shell script installed by `install-ops.sh` to `/usr/local/bin/cxw-ops` (runs `cd /srv/cxw/repo/apps/ops && exec node_modules/.bin/tsx src/cli.ts "$@"`). Add `apps/ops/bin/cxw-ops.js` to Implementer A's files. Dependencies: `better-sqlite3 ^12`, `@types/better-sqlite3`, `pino ^9`, `zod ^4`, `nodemailer ^7`, `@types/nodemailer`, `tsx`, `vitest ^4`, `typescript ^5.9`. Do NOT depend on `@cxw/shared` (it only exports a banner today).
- **Install:** run `pnpm install` from the **worktree root** (it is a pnpm workspace; adding `apps/ops` updates `pnpm-lock.yaml` — that root lockfile change is allowed and expected). `pnpm --filter @cxw/ops test`.
- **Env names (use the existing ones from `deploy/hetzner/cxw.env.example`):** `BRIDGE_HOST`/`BRIDGE_PORT` (default 127.0.0.1:7411) and `BRAIN_HOST`/`BRAIN_PORT` (127.0.0.1:7412) instead of `BRIDGE_URL`/`BRAIN_URL` (still accept `BRIDGE_URL`/`BRAIN_URL` as overrides). `CXW_DISK_LIMIT_PCT` (default 85, **used** percent; alert when used ≥ limit — equals "< 15 % free") instead of `DISK_MIN_FREE_PCT`. `CXW_BACKUP_MAX_AGE_H` (8). `CXW_OWNERS_FILE` default `/srv/cxw/state/owners.json`, shape `{ "owners": [...] }` (also accept a bare array). `CXW_MODEL_FAST` is the model for the deep auth check (default `claude-haiku-4-5-20251001`). All other keys keep their section-B names, prefixed `CXW_` where new: `CXW_ALERT_WHATSAPP_JID`, `CXW_ALERT_REPEAT_MIN`, `CXW_ALERT_AFTER_FAILURES`, `CXW_ALERT_TRANSPORT`, `CXW_RETENTION_TEXT_DAYS`, `CXW_RETENTION_MEDIA_DAYS`, `CXW_RETENTION_OWNER_FOREVER`, `CXW_PURGE_EMERGENCY_MEDIA_DAYS`, `CXW_PURGE_VACUUM`, `CXW_COST_MONTHLY_CAP_USD`, `CXW_COST_WARN_PCT`, `CXW_CTL`, `CXW_SUDO`, `CXW_OPS_DB`, `CXW_CLAUDE_AUTH_DEEP_CHECK_MIN`, `CXW_CLAUDE_CREDENTIALS_FILE`, `CXW_GOOGLE_TOKEN_URL`, `CXW_GOOGLE_CHECK`. SMTP/Telegram/Google keys stay unprefixed (`SMTP_*`, `TELEGRAM_*`, `GOOGLE_*`).
- **Existing Phase 0 files that Phase 7 now owns and replaces on this branch:** `deploy/hetzner/monitor.sh`, `deploy/hetzner/systemd/cxw-monitor.service`, `deploy/hetzner/systemd/cxw-monitor.timer`. Keep Phase 0's behaviour that is still useful (tailscale + ufw + timer active checks, `monitor.status` file, `logger -t cxw-monitor`) inside the new monitor.sh, but the health checks themselves come from `cxw-ops health`. The monitor unit runs as `User=cxw` (not root), `EnvironmentFile=/srv/cxw/cxw.env` and `EnvironmentFile=-/srv/cxw/google.env`, `WorkingDirectory=/srv/cxw/repo`. Also add `deploy/hetzner/alert.sh` (Implementer B) = thin wrapper `exec /usr/local/bin/cxw-ops alert-test "$@"` so the Phase 0 `CXW_ALERT_CMD` hook keeps working.
- **Do not edit** `deploy/hetzner/cxw.env.example` (Phase 0 owns it). Put all new keys in `deploy/hetzner/ops.env.example` with a header comment saying "append these to /srv/cxw/cxw.env". `install-ops.sh` appends missing keys from `ops.env.example` to `/srv/cxw/cxw.env` idempotently (only keys not already present).
- **Backup marker:** `backup.sh` already writes `/srv/cxw/state/last-backup` (UTC ISO). `restic.env` holds `RESTIC_REPOSITORY`/`RESTIC_PASSWORD`; the monitor does not load it, so the backup check uses the marker file only. Drop the restic-snapshot path from health.ts. `cxw-ctl backup` runs `systemctl start cxw-backup.service` (root unit already exists) instead of calling backup.sh directly.
- **Unit names on this branch:** `cxw-bridge`, `cxw-brain`, `cxw-scheduler`, `cxw-backup.service` (+timer), `cxw-monitor.timer`, `cxw-purge.timer`, `cxw-sentinel`. `cxw-ctl` allowlist units: `bridge|brain|scheduler|sentinel|backup|monitor.timer|purge.timer|backup.timer`.
- **Tests location:** package-local (`apps/ops/test/**`, run by `apps/ops`'s own `vitest.config.ts`). The root `vitest.config.ts` only globs `tests/**` and is not touched.
- **Model ids:** the skeleton uses `claude-haiku-4-5-20251001` as fast model; pricing must match by prefix (`claude-haiku-4-5`).
