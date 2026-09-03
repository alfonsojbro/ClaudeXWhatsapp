# ClaudeXWhatsapp — Architecture

What runs on the box, what each process owns, and the exact contracts every phase must satisfy.
The build plan is [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). The operating procedures are
[RUNBOOK.md](RUNBOOK.md).

Phase 7 (the ops layer, `apps/ops` and `deploy/hetzner`) is built. Phases 1–6 are not. Anything
marked "(Phase N)" below is a contract that phase must implement, not something that exists yet.

---

## 1. System diagram

```
 Phone (WhatsApp)                       Hetzner box (fsn1, Ubuntu 24.04, Tailscale only)
 ┌──────────────┐   WhatsApp Web MD    ┌──────────────────────────────────────────────────┐
 │ Alfonso      │◄────────────────────►│ apps/bridge  (Baileys, TypeScript)   :7411       │
 │ self-chat =  │                      │  • linked device on Alfonso's number             │
 │ command line │                      │  • SQLite store: chats, messages, media, FTS5    │
 └──────────────┘                      │  • inbound bus → brain; outbound send API        │
                                       │  • MCP server: whatsapp_* tools (read + send)    │
                                       ├──────────────────────────────────────────────────┤
                                       │ apps/brain   (Claude Agent SDK)      :7412       │
                                       │  • one Claude session per chat, resumable        │
                                       │  • router: command | question | capture | media  │
                                       │  • handleOpsCommand() BEFORE any LLM call        │
                                       │  • tool policy + owner-confirm gate for sends    │
                                       ├──────────────────────────────────────────────────┤
                                       │ apps/scheduler (routines)                        │
                                       │  • routines/*.md (cron in frontmatter)           │
                                       │  • getPauseState() before claiming a routine     │
                                       │  • lease + spool → runs brain job → sends result │
                                       ├──────────────────────────────────────────────────┤
                                       │ vault/  = this repo's own Obsidian vault         │
                                       │  raw/ (captures) · wiki/ (compiled) · memory/    │
                                       ├══════════════════════════════════════════════════┤
                                       │ OPS LAYER  (apps/ops, Phase 7)                   │
                                       │                                                  │
                                       │  cxw-monitor.timer ──every 10 min──►             │
                                       │    monitor.sh → cxw-ops health                   │
                                       │      6 checks → health.json → alerts.json        │
                                       │      HEAL lines → restart budget → cxw-ctl       │
                                       │                                                  │
                                       │  cxw-purge.timer ──daily 03:30──►                │
                                       │    cxw-ops purge  (180d text / 90d media)        │
                                       │                                                  │
                                       │  cxw-sentinel.service (long-running, no LLM)     │
                                       │    polls bridge.sqlite every 5 s for             │
                                       │    `panic` / `resume` from an owner              │
                                       │                                                  │
                                       │  cxw-backup.timer ──every 6 h──► backup.sh       │
                                       │                                                  │
                                       │        │ sudo -n (sudoers allowlist, one binary) │
                                       │        ▼                                         │
                                       │  /usr/local/bin/cxw-ctl  (root)                  │
                                       │    start|stop|restart|status|is-active × unit    │
                                       │    backup · vacuum-journal · nothing else        │
                                       │        │                                         │
                                       │        ▼  systemctl / journalctl                 │
                                       └──────────────────────────────────────────────────┘
                                              │ Claude Code login (subscription) or API key
                                              ▼           ▲ alerts: WhatsApp → email → Telegram
                                       Anthropic API
```

**Process model.** Three long-running services (`cxw-bridge`, `cxw-brain`, `cxw-scheduler`) plus
one long-running ops service (`cxw-sentinel`), and three timers. Bridge and brain talk over HTTP
on `127.0.0.1`. Nothing listens on a public interface; SSH is Tailscale-only.

**Privilege model.** Everything runs as the unprivileged user `cxw`. The only way to reach root
is `sudo -n /usr/local/bin/cxw-ctl`, which allowlists its own arguments.

---

## 2. Processes and units

| Unit                    | Type    | User | Runs                                 | Purpose                                        | Phase |
| ----------------------- | ------- | ---- | ------------------------------------ | ---------------------------------------------- | ----- |
| `cxw-bridge.service`    | simple  | cxw  | `pnpm --filter @cxw/bridge start`    | Baileys link, SQLite store, `/health`, `/send` | 1     |
| `cxw-brain.service`     | simple  | cxw  | `pnpm --filter @cxw/brain start`     | Agent SDK loop, router, confirm gate           | 2     |
| `cxw-scheduler.service` | simple  | cxw  | `pnpm --filter @cxw/scheduler start` | routine leases and runs                        | 5     |
| `cxw-sentinel.service`  | simple  | cxw  | `cxw-ops sentinel`                   | `panic`/`resume` watcher, no LLM               | 7     |
| `cxw-monitor.service`   | oneshot | cxw  | `deploy/hetzner/monitor.sh`          | health, alerts, self-heal                      | 7     |
| `cxw-monitor.timer`     | timer   | —    | every 10 min, `OnBootSec=2min`       | drives the monitor                             | 7     |
| `cxw-purge.service`     | oneshot | cxw  | `cxw-ops purge`                      | retention purge                                | 7     |
| `cxw-purge.timer`       | timer   | —    | daily `03:30`, `Persistent=true`     | drives the purge                               | 7     |
| `cxw-backup.service`    | oneshot | root | `deploy/hetzner/backup.sh`           | restic to the Storage Box                      | 0     |
| `cxw-backup.timer`      | timer   | —    | every 6 h at `:15`                   | drives the backup                              | 0     |

`cxw-monitor.service` and `cxw-sentinel.service` are the only units with `NoNewPrivileges=false`
and `RestrictSUIDSGID=false`. Both call `sudo -n cxw-ctl`, and `sudo` is setuid. Every other
hardening directive matches `cxw-brain.service`.

Every unit loads `EnvironmentFile=/srv/cxw/cxw.env`. `cxw-monitor.service` additionally loads
`EnvironmentFile=-/srv/cxw/google.env` (optional). `cxw-backup.service` loads
`/srv/cxw/restic.env`.

---

## 3. Cross-phase contracts (C1–C10)

`apps/ops` imports no other workspace package. It codes against these contracts. The other phases
must implement their side exactly.

### C1. Bridge HTTP (Phase 1)

`GET {BRIDGE_URL}/health` → 200 with a JSON body. Ops reads two fields and tolerates the rest:

```json
{
  "ok": true,
  "connected": true,
  "selfJid": "…",
  "uptimeSec": 1234,
  "sentToday": 0,
  "dailyCap": 200
}
```

WhatsApp counts as connected **iff `ok === true && connected === true`**. Ops also tolerates
`jid` for `selfJid` and `uptime_s` for `uptimeSec`.

`POST {BRIDGE_URL}/send` with body `{ "jid": "<owner jid>", "text": "…" }`. When `BRIDGE_TOKEN`
is set, ops sends `Authorization: Bearer <BRIDGE_TOKEN>`. Empty (the value `ops.env.example`
ships) or the literal `CHANGEME` both count as **unset**: no `Authorization` header is sent at
all, rather than one carrying a value published in this repo. Success = HTTP 2xx and, if the response
is JSON, `ok !== false`. **Ops only ever sends to an owner JID**; `deliver()` refuses anything
else, twice over.

Default address: `BRIDGE_HOST=127.0.0.1`, `BRIDGE_PORT=7411`; `BRIDGE_URL` overrides both.

### C2. Brain HTTP (Phase 2)

`GET {BRAIN_URL}/health` → 200 `{ "ok": true, "sessions": 0 }`. Default `127.0.0.1:7412`;
`BRAIN_URL` overrides.

### C3. Bridge SQLite (Phase 1)

`BRIDGE_DB` defaults to `$CXW_DATA_DIR/bridge.sqlite`. Required table:

```sql
messages(jid TEXT, id TEXT, ts INTEGER, from_me INTEGER, sender TEXT,
         type TEXT, text TEXT, quoted_id TEXT, media_path TEXT)
-- primary key (jid, id)
```

`ts` is unix **seconds** in Phase 1. Ops normalises with the rule "if `ts < 1e12`, treat it as
seconds", so milliseconds also work. Optional: `media(jid, msg_id, path, mime, size,
downloaded_at)` — when it exists, the purge deletes its rows for removed files. Optional:
`messages_fts` (FTS5, `content='messages'`) — after a bulk delete the purge runs
`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')` inside a try/catch.

Ops opens this database read-write only during a purge, and never writes to any other table.

### C4. Owners (Phase 1)

`CXW_OWNERS_FILE` defaults to `/srv/cxw/state/owners.json` and holds either
`{ "owners": [...] }` or a bare array. Entries may be a full JID or bare digits; digits are
normalised to `<digits>@s.whatsapp.net` and device suffixes are stripped. `OWNER_JIDS` (comma
separated) adds more from the environment. **A `@g.us` group JID is never an owner**, even if
listed.

WhatsApp may address the self-chat and contacts by LID (`<digits>@lid`) instead of a phone-number
JID; the Phase 1 live test saw exactly that on the self-chat. The bridge SHOULD store phone-number
JIDs in `messages.jid` and `messages.sender`, resolving LIDs through Baileys' LID mapping. Until it
does, the owner must also list their LID in `owners.json`: ops accepts a `@lid` entry verbatim (only
the device suffix is stripped) and matches it exactly, so the LID and the phone-number JID are two
separate entries.

```ts
loadOwners(cfg: Config): string[];
```

### C5. Brain command hook (Phase 2)

The brain router calls this **before any LLM call**. A non-null return is the reply and the
message is consumed.

```ts
handleOpsCommand(
  text: string,
  ctx: { senderJid: string; isOwner: boolean; messageId?: string },
): Promise<string | null>;
```

Commands, case-insensitive, optional leading `/`: `panic`, `resume`, `status`,
`purge [--dry-run] [--emergency]`, `costs [today|month]`, `costs unpause`. A non-owner always
gets `null`. Pass `messageId` when you have it: it is deduped against the sentinel's handled-id
state so the brain and the sentinel never both act on the same message.

`panic` returns its ack **before** the stop runs (the stop is scheduled 1 second later), so the
caller must send the returned text immediately.

### C6. Usage recording (Phases 2 and 5)

```ts
recordUsage(u: {
  ts?: number;
  source: 'chat' | 'routine';
  chatJid?: string;
  routine?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}): number;
```

Pass the Agent SDK result message's `total_cost_usd` as `costUsd` and its `usage` counts. When
`costUsd` is absent it is computed from the price table (§7), matched by longest model-id prefix.
When the SDK reports `modelUsage` (per-model breakdown), write **one row per model**.

### C7. Pause flags (Phase 5)

```ts
getPauseState(): { paused: boolean; reasons: Array<'panic' | 'cost-cap'> };
```

The scheduler calls this before claiming a routine. While `paused` is true it must run **only
essential routines** and skip everything else.

**What ops expects, and what the scheduler must do.** The ops contract treats a routine as
essential when its frontmatter has `essential: true` **or** `kind: health`. The Phase 5 plan uses
`kind: health` for the health-check routine and does not define `essential`. So:

- The scheduler MUST evaluate `essential: true || kind: health` as "essential". Either marker
  alone is enough.
- The scheduler SHOULD add `essential: true` to `memory-consolidate` as well, which has no
  `kind: health` to fall back on.
- Ops itself never reads routine frontmatter. It only publishes the flags; the classification
  lives entirely in the scheduler.

The on-disk flags are `/srv/cxw/state/panic` and `/srv/cxw/state/cost-paused`, both JSON with at
least `since` and `reason`. A `cost-paused` flag from a previous month is ignored.

### C8. Daily cost line (Phase 5)

```ts
dailyCostLine(): string;
// 💸 Today: $1.23 (12.3k in / 4.5k out, 3 calls) · Month: $23.45 / $100 (23%)
```

The scheduler appends this to the delivery of any routine whose frontmatter has
`cost_line: true`. Phase 5 sets it on `evening-close`.

### C9. Backup marker (Phase 0)

`deploy/hetzner/backup.sh` writes a UTC ISO timestamp to `/srv/cxw/state/last-backup` on
success. This marker is the **only** source for the `backup` health check; ops does not talk to
restic. The check prefers the file's contents and falls back to its mtime.

### C10. systemd unit names

`cxw-bridge`, `cxw-brain`, `cxw-scheduler`, `cxw-sentinel`, `cxw-monitor.timer`,
`cxw-purge.timer`, `cxw-backup.service`, `cxw-backup.timer`. Services run as user `cxw`; env
files are root:root 0600 and loaded with `EnvironmentFile=`. `cxw-ctl`'s unit allowlist is
`bridge | brain | scheduler | sentinel | backup | monitor.timer | purge.timer | backup.timer`.

### The `cxw-ops` CLI contract

The boundary between the TypeScript package and the shell scripts.

| Command                                      | Output                                                                                              | Exit                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------- |
| `health [--json] [--no-alert]`               | `OK/FAIL <name> - <detail>` per check, then one `HEAL <action>` line per healable failure (deduped) | 0 all ok, 1 any failure |
| `health --json`                              | one object `{ ts, ok, checks: [{ name, ok, detail, healAction }], heals: [] }` and nothing else     | same                    |
| `purge [--dry-run] [--emergency]`            | one JSON line `{ dryRun, emergency, textRows, mediaRows, files, bytes, skipped }`                   | 0, **2** on refusal     |
| `costs [today\|month\|line\|check\|unpause]` | totals JSON, the C8 line, the `check` status line, or `unpaused`                                    | 0                       |
| `panic [reason]` / `resume` / `status`       | the same text the WhatsApp command returns                                                          | 0                       |
| `alert-test <text...>`                       | pushes text through the delivery chain                                                              | 0 if a channel accepted |
| `sentinel`                                   | long-running                                                                                        | on SIGTERM              |

Heal action strings are exactly `restart bridge`, `restart brain`, `purge --emergency`,
`backup`. Alert-delivery errors are logged and never change the `health` exit code.

`costs check` always prints one status line —
`cost: <level> $<total> / $<cap> (<pct>%) — notified | already notified this month | delivery failed | no alert needed` —
and then the owner-facing text only on the run that actually delivered it.

`purge` exits **2** and writes nothing when it refuses (`CXW_RETENTION_OWNER_FOREVER` on and an
empty or unreadable owner list); stdout is empty and the reason goes to stderr. `skipped` counts
media rows whose `media_path` did not resolve inside `MEDIA_DIR` — those files are never
unlinked. `monitor.sh` treats a non-zero `purge` as a logged heal failure and still exits 0.

---

## 4. Data flow: an alert

```
cxw-monitor.timer (every 10 min)
   └─► monitor.sh
        └─► cxw-ops health                                    [HEALTH]
             ├─ whatsapp   GET bridge /health   → ok && connected?   heal: restart bridge
             ├─ brain      GET brain  /health   → ok?                heal: restart brain
             ├─ google     POST token endpoint, refresh_token grant  heal: none
             ├─ disk       fs.statfs → used % vs CXW_DISK_LIMIT_PCT  heal: purge --emergency
             ├─ backup     age of state/last-backup vs max age       heal: backup
             └─ claude_auth token env / credentials file, deep probe heal: none
                  │
                  ├─► writes $CXW_STATE_DIR/health.json (always)
                  │
                  ▼                                            [RECONCILE]
             reconcile(previous alerts.json, checks, now)
               • failures reach CXW_ALERT_AFTER_FAILURES and no alert sent yet → alert
               • still failing and CXW_ALERT_REPEAT_MIN elapsed               → re-alert
               • failing → ok, and an alert was sent                          → recovery, once
               • check marked noAlert (brain during panic)                    → excluded
                  │
                  ├─► writes $CXW_STATE_DIR/alerts.json
                  │
                  ▼                                            [DELIVER]
             deliver(texts, { whatsappOk, owners })
               1. WhatsApp  POST bridge /send   ← skipped when the whatsapp check failed
               2. email     SMTP via nodemailer ← skipped when SMTP_HOST is empty
               3. Telegram                      ← only when TELEGRAM_ALERTS=true
               first channel that accepts wins; all alerts in a tick are one message
               CXW_ALERT_TRANSPORT=log prints `[alert:<channel>] <text>` instead
                  │
                  ▼                                            [HEAL]
        monitor.sh parses `^HEAL ` lines
          → restart budget: max 3 per action per rolling hour (state/restart-budget.log)
             exhausted → cxw-ops alert-test "heal budget exhausted for <action>", stop healing
          → $CXW_SUDO $CXW_CTL restart bridge | restart brain (never while panic exists)
          → cxw-ops purge --emergency, then $CXW_CTL vacuum-journal
          → $CXW_CTL backup
          → sleep CXW_HEAL_RECHECK_S, re-run `cxw-ops health --no-alert`
          → write state/monitor.status, always exit 0
```

The message the owner sees:

```
🚨 cxw: whatsapp FAILING since 2026-09-03T04:10:00.000Z — bridge not connected
✅ cxw: whatsapp recovered after 22m
```

**Why the fallback chain matters:** the most likely single failure is the bridge, which is also
the WhatsApp alert channel. When `whatsapp` is the failing check, ops never tries to send the
alert through it.

---

## 5. Data flow: `panic`

Two independent paths reach the same kill switch, deduped by message id.

```
Owner sends `panic` in WhatsApp
   │
   ├── PATH A: the brain is alive
   │     bridge stores the message → brain router
   │       → handleOpsCommand('panic', { senderJid, isOwner: true, messageId })
   │         → markHandled(messageId) in state/sentinel.json
   │         → returns the ack text  🛑 Panic: scheduler and brain stopping…
   │         → brain sends the ack
   │         → 1 s later: panic('owner request', 'owner')
   │
   └── PATH B: the brain is dead, hung, or never saw it
         cxw-sentinel (no LLM) polls bridge.sqlite every 5 s
           → rows with ts > lastSeen AND (sender ∈ owners OR (from_me = 1 AND jid ∈ owners))
             i.e. an owner sender, or your own message in an owner chat (the self-chat).
             `from_me` in a third-party or group chat never counts.
           → trimmed lowercase text, optional leading `/`, equals `panic` or `resume`
           → re-reads state/sentinel.json at the top of every poll, so an id the brain
             handled while the sentinel was already running is seen
           → isHandled(messageId)? skip : markHandled(messageId)
           → panic(...) runs FIRST; the ack via bridge POST /send (owner JID only) is
             best-effort and never gates the action — a bridge that cannot send must not
             turn the kill switch into a no-op.

Both converge on killswitch.panic():
   1. write $CXW_STATE_DIR/panic  { since, by, reason }
   2. ctl('stop', 'scheduler')     → sudo -n cxw-ctl stop scheduler   → systemctl stop cxw-scheduler
   3. ctl('stop', 'brain')         → sudo -n cxw-ctl stop brain       → systemctl stop cxw-brain
      (brain last, so the ack has already left)

While the panic flag exists:
   • the brain health check reports `panic mode, expected down`, emits no heal, raises no alert
   • monitor.sh refuses the `restart brain` heal
   • getPauseState() → { paused: true, reasons: ['panic'] }

`resume` reverses it:
   1. delete $CXW_STATE_DIR/panic
   2. ctl('start', 'brain')
   3. ctl('start', 'scheduler')
```

The dedupe is the `sentinel.json` handled-id set, and the sentinel re-reads that file on every
poll rather than trusting the copy it loaded at boot — otherwise a long-running sentinel would
never see the ids the brain wrote, and both paths would fire. Whichever path marks the id first
wins; the other skips the row.

The sentinel starts from `lastSeen = now` on boot, so restarting it never replays an old `panic`
out of history. It keeps running during a panic, which is what makes `resume` from WhatsApp work
with the brain stopped.

---

## 6. State files

All under `$CXW_STATE_DIR` (`/srv/cxw/state`, 0700 `cxw:cxw`). JSON files are written atomically
(temp file + rename, mode 0600).

| File                            | Written by                        | Read by                                 | Purpose                                                                  |
| ------------------------------- | --------------------------------- | --------------------------------------- | ------------------------------------------------------------------------ |
| `health.json`                   | `cxw-ops health` (every run)      | `status` command, `alert-test`          | last `{ ts, ok, checks[] }`                                              |
| `alerts.json`                   | `cxw-ops health`                  | `cxw-ops health`                        | per-check `{ status, failures, firstFailedAt, lastAlertAt, alertCount }` |
| `panic`                         | `panic()` / removed by `resume()` | health, monitor.sh, `getPauseState`     | `{ since, by, reason }` — the kill-switch flag                           |
| `cost-paused`                   | `checkCap()` at 100 % of the cap  | `getPauseState`, scheduler (Phase 5)    | `{ since, reason: 'cost-cap', month, total, cap }`                       |
| `cost-warned-<YYYY-MM>`         | `notifyCap()` (`costs check`)     | `notifyCap()`                           | warn-once marker; written only after the alert was actually delivered    |
| `cost-paused-alerted-<YYYY-MM>` | `notifyCap()` (`costs check`)     | `notifyCap()`                           | paused-once marker; also claims the warn marker so 80 % cannot follow    |
| `last-purge.json`               | `purge()` (not on dry runs)       | operator                                | `{ at, dryRun, emergency, textRows, mediaRows, files, bytes, skipped }`  |
| `sentinel.json`                 | sentinel and `handleOpsCommand`   | both (the sentinel re-reads every poll) | `lastSeen` plus handled message ids — the brain/sentinel dedupe          |
| `claude-auth-deep.json`         | health `claude_auth` deep probe   | health                                  | `{ at, ok, detail }` — throttles the `claude -p` probe                   |
| `restart-budget.log`            | `monitor.sh`                      | `monitor.sh`                            | `<epoch> <action>` lines; max 3 per action per hour                      |
| `monitor.status`                | `monitor.sh`                      | operator                                | `ok <utc>` / `fail <utc>` plus one line per problem                      |
| `last-backup`                   | `backup.sh` (Phase 0)             | health `backup` check                   | UTC ISO timestamp of the last successful backup                          |
| `owners.json`                   | operator                          | ops, bridge (Phase 1), brain (Phase 2)  | the owner allowlist                                                      |

Databases live under `$CXW_DATA_DIR` (`/srv/cxw/data`): `bridge.sqlite` (Phase 1, owned by the
bridge), `ops.sqlite` (the `usage` table, owned by ops), `media/<jid>/<msgid>.<ext>`, and
`session/` (Baileys auth state, Phase 1).

---

## 7. Retention and cost

### Retention

| Data                         | Kept     | Env key                            | Purged by                       |
| ---------------------------- | -------- | ---------------------------------- | ------------------------------- |
| Third-party message text     | 180 days | `CXW_RETENTION_TEXT_DAYS`          | `cxw-purge.timer`, daily 03:30  |
| Third-party media            | 90 days  | `CXW_RETENTION_MEDIA_DAYS`         | same                            |
| Third-party media, emergency | 14 days  | `CXW_PURGE_EMERGENCY_MEDIA_DAYS`   | `purge --emergency` on low disk |
| Owner chats (text + media)   | forever  | `CXW_RETENTION_OWNER_FOREVER=true` | never, unless set to `false`    |

Owner chats include the self-chat. Groups count as third-party. `--emergency` touches media only
and leaves all text alone. A media file is unlinked **only** when its `media_path` resolves
inside `MEDIA_DIR` — nothing else under `CXW_DATA_DIR` is ever a purge target, so `bridge.sqlite`,
`ops.sqlite` and `session/` are out of reach even for a `media_path` a remote sender chose. Rows
that resolve elsewhere are counted in `skipped` and logged as a count only, never as a path. `CXW_PURGE_VACUUM=true` runs `VACUUM` afterwards; it is off by
default because it locks the database.

### Cost

Price per million tokens, matched against the model id by **longest prefix**, so dated ids such
as `claude-haiku-4-5-20251001` still price correctly. An unknown id prices at opus-5 rates and
logs a warning.

| Model              | Input | Output | Cache read | Cache write |
| ------------------ | ----- | ------ | ---------- | ----------- |
| `claude-fable-5-1` | 10    | 50     | 0.25       | 12.5        |
| `claude-fable-5`   | 10    | 50     | 1          | 12.5        |
| `claude-opus-5`    | 5     | 25     | 0.5        | 6.25        |
| `claude-opus-4-8`  | 5     | 25     | 0.5        | 6.25        |
| `claude-sonnet-5`  | 2     | 10     | 0.2        | 2.5         |
| `claude-haiku-4-5` | 1     | 5      | 0.1        | 1.25        |

| Threshold                                 | Effect                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `CXW_COST_WARN_PCT` (80 %) of the cap     | one warning for the month; marker `cost-warned-<YYYY-MM>`                           |
| 100 % of `CXW_COST_MONTHLY_CAP_USD` (100) | writes `cost-paused`; the scheduler runs essential routines only. Chat still works. |
| 100 %, owner notified                     | marker `cost-paused-alerted-<YYYY-MM>`; both markers are written by `notifyCap()`   |
| Month rollover                            | the flag clears itself                                                              |
| `costs unpause`                           | removes the flag for the rest of the month                                          |

Day and month boundaries use the **process time zone**. `TZ=Europe/Prague` is set in
`/srv/cxw/cxw.env` and loaded by every unit.

---

## 8. Security model

- **Owner allowlist is a file, not chat state.** `/srv/cxw/state/owners.json`. Group JIDs
  (`@g.us`) are never owners. Ops sends alerts and acks to owner JIDs only — `deliver()` refuses
  any other target, and `sendWhatsApp()` checks again before the request goes out.
- **Untrusted content rule.** Every message from a non-owner, every email, every image and every
  web page is data, never instructions. `handleOpsCommand` returns `null` for non-owners before
  it parses anything.
- **One unprivileged user.** All five services run as `cxw`. `/srv/cxw/state` is 0700 `cxw:cxw`.
- **One privileged binary.** `/usr/local/bin/cxw-ctl`, 0755 root:root, reachable only through
  `cxw ALL=(root) NOPASSWD: /usr/local/bin/cxw-ctl` in `/etc/sudoers.d/cxw-ctl` (0440
  root:root, validated with `visudo -c` at install time).

  | The ops user CAN                                                         | The ops user CANNOT                                        |
  | ------------------------------------------------------------------------ | ---------------------------------------------------------- |
  | `start\|stop\|restart\|status\|is-active` one of the eight `cxw-*` units | touch any other unit — `stop sshd` exits 64                |
  | `cxw-ctl backup` → `systemctl start cxw-backup.service`                  | pass arguments to `backup` or `vacuum-journal`             |
  | `cxw-ctl vacuum-journal` → `journalctl --vacuum-size=200M`               | pass more than two arguments                               |
  | read `bridge.sqlite`; write only during a purge                          | edit the env files (root:root 0600)                        |
  |                                                                          | run an arbitrary shell — `cxw-ctl` uses `case`, not `eval` |

  The allowlist is enforced twice: in `killswitch.ts` before `execFile` spawns anything (no
  shell), and again in `cxw-ctl` itself. Denials exit 64 and log `denied: $*` through `logger`.

- **Network.** `ufw` default deny incoming; SSH only over Tailscale; no public listeners; the
  Hetzner Cloud firewall is a second layer. `security-check.sh` verifies all of it, and excludes
  only sshd on port 22, which ufw already fences off.
- **Secrets.** `/srv/cxw/*.env` are root:root 0600 and never in git. systemd reads them as root
  and drops to `cxw`. `check-secrets` in CI blocks tokens, phone numbers and Baileys auth files.
- **Redaction.** The pino logger censors `jid`, `chatJid`, `senderJid`, `targetJid`, `remoteJid`,
  `text`, `body`, `caption`, `preview` and their nested forms as `[redacted]`. Alerts name checks
  and never chats; `maskJid()` exists for the rare case a JID is unavoidable.
- **Confirm gate (Phase 2).** Any tool that leaves the box towards a third party — a WhatsApp
  send to a non-owner, an email, a calendar event with attendees — returns a preview and a
  6-character token that only an owner message can redeem, within 10 minutes. `security-check.sh`
  fails if an MCP `send_*` / `gmail_send` / `calendar_create*` implementation exists without a
  `confirm` reference. See IMPLEMENTATION_PLAN §3.2 and §4.
- **Kill switch.** `panic` from an owner stops the two components that can act. The bridge stays
  linked, so nothing is lost, and the sentinel stays up so `resume` still works.

---

## 9. Known limitations

Drawn from the Phase 7 implementation audits. None of these blocks the phase; all are worth a
decision before the box carries real traffic.

1. **The disk check uses `statfs().bfree`, not `bavail`.** `bfree` counts root-reserved blocks,
   so the used percentage reads slightly lower than `df` shows a non-root user. The alert fires
   a little later than `df` would suggest.
2. **A purge refuses to run when the owner allowlist is empty.** With
   `CXW_RETENTION_OWNER_FOREVER=true`, an empty or unreadable `owners.json` would make the
   "not an owner" SQL clause match every row, so the purge would delete exactly the history it
   is meant to protect. `purge()` therefore refuses (exit 2 from the CLI, an explanatory reply
   from the WhatsApp command) and touches nothing, dry run included. The cost is that retention
   stops until the owners file is fixed — a stall is recoverable, deleted history is not.
3. **The cost cap is notified from one place only.** Recording usage evaluates the cap and
   writes the `cost-paused` flag but never notifies. `notifyCap()` — called by
   `cxw-ops costs check`, which the monitor runs every 10 minutes — is what delivers the warn
   and the paused text down the alert chain, once per month per level. The consequence is a
   delay of up to one monitor tick between crossing the cap and hearing about it.
   The once-a-month marker is written **after** the delivery succeeds, never before: an alert
   chain that is down (the likeliest moment for it to be down is exactly when the cap trips)
   would otherwise burn the month's only notification. A failed delivery leaves no marker, so
   the next tick tries again.
4. **CI's shellcheck step is already red** on `backup.sh`, `restore.sh` and `bootstrap.sh`
   (SC1090/SC1091), independent of Phase 7. CI also does not shellcheck `deploy/hetzner/cxw-ctl`
   (no `.sh` extension), `deploy/hetzner/chaos/*.sh` or `deploy/hetzner/test/*.sh`, and does not
   run `deploy/hetzner/test/cxw-ctl.test.sh`.
5. **`install-ops.sh` has never been executed** — there is no box yet. It is `bash -n`- and
   shellcheck-clean only; the `visudo -c -f`, `install` and `systemctl enable --now` paths are
   unverified end to end.
6. **`chaos.sh --box` has never been run.** It is guarded twice (`--i-know` plus a root check)
   and restores in a trap, but the first real run must be watched by a human.
7. **`bin/cxw-ops.js` imports `../dist/src/cli.js`**, which exists only after
   `pnpm --filter @cxw/ops build`. The deployed path is the `tsx` wrapper that `install-ops.sh`
   writes, so the bin shim is a convenience only.
8. **The `claude_auth` check reads `claudeAiOauth.expiresAt` as epoch milliseconds.** If Claude
   Code ever writes seconds there, the check would report the credentials expired.
9. **The restart budget is per action, not per unit** (`restart bridge` and `restart brain` have
   independent budgets). That matches the plan's wording; here the two are the same thing.
10. **Optional secrets ship empty, not as placeholders.** `ops.env.example` sets
    `BRIDGE_TOKEN=`, `SMTP_PASS=` and `TELEGRAM_BOT_TOKEN=` with no value, and ops treats an
    empty or `CHANGEME` value as unset. A fresh install therefore has no bridge auth header, no
    email fallback and no Telegram fallback until the operator fills them in — silence, rather
    than a credential published in this repo.
