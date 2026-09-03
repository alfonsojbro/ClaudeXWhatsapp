# Audit A2 — fix loop 1, Implementer A (`apps/ops`)

Branch `phase-7-ops`, worktree `/Users/alfonsobriceno/ClaudeXWhatsapp/.worktrees/phase-7-ops`.
Source: `feature-research/phase-7-ops/fix-plan-1.md` §"Files touched — Implementer A", against
`review-1.md` (B2, B3, B5, S1, S2, S4, S5, S6, S7, S9 + media-path containment).
No git commands run. Nothing outside `apps/ops/` touched.

## Files changed

| File                              | Kind     |
| --------------------------------- | -------- |
| `apps/ops/src/config.ts`          | modified |
| `apps/ops/src/logger.ts`          | modified |
| `apps/ops/src/db.ts`              | modified |
| `apps/ops/src/retention.ts`       | modified |
| `apps/ops/src/costs.ts`           | modified |
| `apps/ops/src/killswitch.ts`      | modified |
| `apps/ops/src/sentinel.ts`        | modified |
| `apps/ops/src/cli.ts`             | modified |
| `apps/ops/src/commands.ts`        | modified |
| `apps/ops/src/index.ts`           | modified |
| `apps/ops/README.md`              | modified |
| `apps/ops/test/helpers.ts`        | modified |
| `apps/ops/test/retention.test.ts` | modified |
| `apps/ops/test/costs.test.ts`     | modified |
| `apps/ops/test/sentinel.test.ts`  | modified |
| `apps/ops/test/alerts.test.ts`    | modified |
| `apps/ops/test/health.test.ts`    | modified |

No files created, none deleted. `feature-research/phase-7-ops/audit-a2.md` is this document.

## Verification (from the worktree root, Node v22.23.2)

```
$ pnpm --filter @cxw/ops typecheck
> tsc --noEmit -p tsconfig.json
(no output, exit 0)

$ pnpm --filter @cxw/ops test
 Test Files  7 passed (7)
      Tests  83 passed (83)
   Duration  4.19s (transform 526ms, import 1.68s, tests 10.41s)
(no open-handle warning; 83 tests, up from 63)

$ pnpm exec eslint apps/ops
(no output, exit 0)

$ pnpm exec prettier --write apps/ops && pnpm exec prettier --check apps/ops
apps/ops/README.md 40ms
apps/ops/src/cli.ts 21ms
apps/ops/src/sentinel.ts 32ms
(rest unchanged)
Checking formatting...
All matched files use Prettier code style!

$ pnpm -r typecheck
apps/bridge typecheck: Done
apps/brain typecheck: Done
apps/scheduler typecheck: Done
mcp/google typecheck: Done
mcp/whatsapp typecheck: Done
mcp/vault typecheck: Done
(exit 0)

$ pnpm lint
> eslint .
(no output, exit 0)
```

## Per review item

### B2 — missing/corrupt `owners.json` deleted the owner's history

`retention.ts`: added `OpsError` and `PURGE_EMPTY_OWNERS_MESSAGE`. `purge()` now refuses,
before opening any database, when `retention.ownerForever` is true and `loadOwners()` is
empty. Dry runs refuse too. `cli.ts` catches `OpsError`, prints it on **stderr** and exits
**2** with empty stdout; `commands.ts` `purgeText()` returns `⚠️ <message>` to the owner
instead of throwing at the WhatsApp router.

Reproduced with a temp dir, no owners file, one owner + one stranger row 400 days old:

```
BEFORE  B2 purge result {"dryRun":false,...,"textRows":2,...}
        B2 rows left []
        B2 last-purge.json exists true

AFTER   B2 purge result "THREW: refusing to purge: owner list is empty (check CXW_OWNERS_FILE)"
        B2 rows left [{"jid":"10000000000@…","id":"o1",…},{"jid":"19998887777@…","id":"s1",…}]
        B2 last-purge.json exists false
```

CLI path:

```
AFTER   $ cxw-ops purge          # owners.json = "not json"
        exit=2
        stdout=[]
        stderr: refusing to purge: owner list is empty (check CXW_OWNERS_FILE)
```

Tests: `retention.test.ts` → "throws and touches nothing when the owners file is missing",
"refuses on a dry run too", "still purges when the owner exemption is switched off on purpose".

### B3 — a `panic` was dropped when the ack could not be sent

`sentinel.ts` `executeHit()` now runs `panic()`/`resume()` **first** and then sends the ack
with `.catch()`, so delivery can never gate the action. `runSentinel()` persists the state
**after** the actions ran (a crash mid-action retries), wraps each `executeHit` in its own
try/catch, logs a failed action at error and re-alerts it best-effort through the alert
chain (`alertActionFailure`), while still marking the id handled so there is no retry storm.

Reproduced with a fake `CXW_CTL` script and `BRIDGE_URL=http://127.0.0.1:1`:

```
BEFORE  B3 executeHit THREW: fetch failed
        B3 panic flag exists: false
        B3 ctl calls: (none)

AFTER   B3 panic flag exists: true
        B3 ctl calls: stop scheduler
                      stop brain
```

Tests: `sentinel.test.ts` → "runs panic even when the acknowledgement cannot be delivered"
and a full `runSentinel` test (seeded row, fake ctl, closed port) asserting the panic flag,
the ctl call order and `sentinel.json.handled` containing the id.

### B5 — `CHANGEME` accepted as a real secret

`config.ts`: new `secret()` reader treats `changeme` / `change-me` / `change_me` / `todo` /
`xxx` (case-insensitive, after trim) exactly like an unset key. Applied to `BRIDGE_TOKEN`,
`SMTP_USER`, `SMTP_PASS`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
`ANTHROPIC_API_KEY`. Consequence: no `Authorization: Bearer CHANGEME` is ever sent.

```
BEFORE  B5 bridgeToken = "CHANGEME"   smtp.pass = "CHANGEME"   telegram.botToken = "CHANGEME"
        google.clientId = "CHANGEME"  claude.oauthToken = "CHANGEME"

AFTER   B5 bridgeToken = undefined    smtp.pass = undefined    telegram.botToken = undefined
        google.clientId = undefined   claude.oauthToken = undefined
```

Tests: `alerts.test.ts` → "treats CHANGEME exactly like an unset key", "keeps a real secret
untouched", "sends no Authorization header when the token is a placeholder".

### S1 — the cost warning never reached the owner

`costs.ts` split in two:

- `checkCap(cfg, now) → { pct, total, cap, level: 'ok'|'warn'|'paused', text }` — pure state:
  it keeps the `cost-paused` flag in step (idempotent) and **always** returns the text. It
  writes no "already told them" marker and suppresses nothing.
- `notifyCap(deliver, cfg, now)` — the only notifier: writes `cost-warned-<YYYY-MM>` /
  `cost-paused-alerted-<YYYY-MM>` and calls `deliver(text)` once per month per level.

`recordUsage()` still calls `checkCap()` for the flag side effect only, so the hot path can
no longer eat the warning. `cli.ts` `costs check` calls `notifyCap` with the real alert chain
(`deliver([text], { whatsappOk }, cfg)`), prints the text only when it delivered, exit 0.

```
BEFORE  S1 later checkCap() = null
        S1 warn marker written by recordUsage: [ 'cost-warned-2026-09' ]

AFTER   S1 later checkCap() = {"pct":90,"total":9,"cap":10,"level":"warn",
                               "text":"⚠️ cxw: 90% of the monthly cost cap used ($9.00 / $10)."}
        S1 warn marker written by recordUsage: []
```

End-to-end through the CLI (seeded `usage` row `cost_usd=0.02`, cap `0.01`, log transport) —
this is the shape Implementer B's chaos scenario 6 asserts:

```
$ cxw-ops costs check
[alert:email] 🛑 cxw: monthly cost cap reached ($0.02 / $0.01). Non-essential routines are paused…
🛑 cxw: monthly cost cap reached ($0.02 / $0.01). Non-essential routines are paused…
exit=0
$ cxw-ops costs check      # second run
exit=0                     # no alert line
```

Tests: `costs.test.ts` → "recordUsage never consumes the owner warning", "delivers once at
warn and once at pause, never twice in the same month", "says nothing below the warn
threshold", plus the reshaped `checkCap` assertions.

### S2 — pino wrote to stdout, breaking `health --json`

`logger.ts`: `pino({…}, destination({ dest: 2, sync: true }))`. Sync avoids a stream to flush
at exit, so the vitest suite still reports no open handles.

```
BEFORE  $ cxw-ops health --json 1>out 2>err     (corrupt owners.json, LOG_LEVEL=info)
        PARSE FAILED: Unexpected non-whitespace character after JSON at position 632
        stderr bytes: 0

AFTER   exit=1
        stdout parses as JSON
        stderr lines: 2
```

Test: `health.test.ts` → "prints one JSON object and nothing else on stdout, with logs on
stderr" spawns the real CLI through `tsx` with `LOG_LEVEL=info` and a corrupt owners file.

### S4 — kill-switch words fired from any chat

`sentinel.ts` `pollOnce()` now requires the **chat** to be an owner chat:
`isOwnerJid(row.jid) && (row.from_me === 1 || isOwnerJid(row.sender ?? row.jid))`.

```
BEFORE  S4 hits from a third-party chat: ["19998887777@s.whatsapp.net"]
AFTER   S4 hits from a third-party chat: []
```

Tests: `sentinel.test.ts` → "ignores from_me messages sent to a third party" (with
`sender = OWNER`, the realistic outgoing-row shape) and "accepts from_me messages in the
owner self-chat". See deviation 1 below.

### S5 — dangling `media_path`, and dry runs overwriting `last-purge.json`

The orphan walk now receives the open database and, after each unlink, runs
`UPDATE messages SET media_path = NULL WHERE media_path = ?` for both the absolute path and
the `MEDIA_DIR`-relative spelling. `purge()` writes `last-purge.json` only when
`dryRun === false`.

```
BEFORE  S5 rows left [{"id":"r1","media_path":"…/media/19998887777@…/orphan.jpg"}]
        S5b last-purge overwritten by dry run: true

AFTER   S5 rows left [{"id":"r1","media_path":null}]
        S5b last-purge overwritten by dry run: false
```

Tests: "clears the media_path of a surviving row whose file it removed", "clears the
media-dir-relative spelling too", "a dry run never overwrites the record of the last real
purge".

### S6 — no SQLite busy timeout

`db.ts`: `openDb()` runs `PRAGMA busy_timeout = 5000` (exported as `BUSY_TIMEOUT_MS`) on
every open, read-only and read-write, wrapped in try/catch. Both the bridge store and the ops
store go through `openDb`, so both are covered. No behavioural test (it needs a real writer
holding a lock); verified by inspection and by the suite still passing.

### S7 — the panic reason was logged unredacted

`killswitch.ts`: `logger.warn({ by, reasonLength: reason.length }, …)`. The reason still goes
into the 0600 `panic` flag file. Confirmed in the test-run output: the old
`"reason":"test reason"` line is gone, replaced by `"reasonLength":11`.

### S9 — test gaps

Closed the three that are mine: `runSentinel`/`executeHit` coverage (B3), `purge` with an
empty/missing owners file (B2), and the TZ gap — `helpers.ts` no longer passes the dead
`TZ: 'UTC'` config key, and `costs.test.ts` has "the cost month follows the process TZ, not
UTC" which flips `process.env.TZ` between `UTC` and `America/Los_Angeles` around
`2026-09-01T00:30:00Z` and asserts `2026-09` vs `2026-08`. The `monitor.sh` and `cxw-ctl`
gaps belong to Implementer B.

### Containment (security pass)

`resolveMediaPath()` is now exported and returns `string | null`: a stored `media_path`
resolves only when `path.resolve` lands strictly under `path.resolve(cfg.mediaDir)` or
`path.resolve(cfg.dataDir)`. Absolute paths get the same test. Skipped rows increment a new
`skipped` field on `PurgeResult`, are never unlinked and never have their row rewritten; one
`logger.warn({ skipped })` per purge carries the **count only**, never the path.

```
BEFORE  CONTAINMENT purge result {…,"mediaRows":2,"files":1,"bytes":6}
        CONTAINMENT outside file still exists: false     ← file outside dataDir was deleted

AFTER   CONTAINMENT purge result {…,"mediaRows":0,"files":0,"bytes":0,"skipped":2}
        CONTAINMENT outside file still exists: true
```

Tests: "skips rows whose media_path escapes the data directory" (one `../../outside.txt`, one
absolute path outside `dataDir`), "accepts a well-formed relative path under the media dir".

## §I1 contract

Unchanged: `health` text/JSON shapes and exit codes, heal action strings, `alert-test`,
`costs` subcommands and the C8 cost line, one `[alert:<channel>]` line per delivered batch,
dedupe. Two deliberate, fix-plan-mandated extensions are noted as deviations 2 and 3.

## Deviations from fix-plan-1

1. **S4 boolean.** The plan writes the rule as `isOwnerJid(sender ?? jid) OR (from_me = 1 AND
isOwnerJid(jid))`, but states the intent as "`from_me` in a third-party or group chat never
   counts". The plan's OR does not achieve that: the bridge stamps our own JID on the `sender`
   of outgoing rows, so "panic" sent to a stranger still matched (my first test caught it). I
   implemented review-1's rule instead — the chat JID must be an owner — which satisfies the
   plan's stated intent and review-1 §S4 both.
2. **`purge` exit code 2** contradicts §I1's "exit 0", but is explicitly required by the fix
   plan ("purge refusal exit code 2"). Only the refusal path is non-zero; a successful purge
   still exits 0 and prints its JSON line. `monitor.sh` must not treat a non-zero `purge` as a
   crash — flagged to Implementer B.
3. **`skipped` added to the purge JSON line**, a superset of the §I1 field list, as the fix
   plan requires. Any consumer reading the six documented fields is unaffected.
4. **`OpsError` lives in `retention.ts`**, not in a new module: the fix plan lists it as an
   `index.ts` export without naming a home, and creating an unlisted `src/errors.ts` would
   have gone outside the "Files touched" list. It is re-exported from `index.ts`.
5. **`notifyCap` at the paused level also claims the warn marker.** The plan's wording
   ("writes `cost-warned-…` when level ≥ warn … writes `cost-paused-alerted-…` when paused")
   would deliver the same paused text twice when the spend jumps straight past the cap. It now
   delivers once per level: at `paused` it writes the paused marker, delivers once, and
   back-fills the warn marker (the spend only grows, so the warn level can never return).
6. **Config placeholder list** is slightly wider than `CHANGEME` (`change-me`, `change_me`,
   `todo`, `xxx`) and also covers `SMTP_USER`/`TELEGRAM_CHAT_ID`, both of which the plan lists.

## Open risks

- `PLACEHOLDER_SECRETS` would reject a genuine secret whose literal value is `xxx` or `todo`.
  Acceptable for this threat model; documented in the code comment.
- The busy-timeout fix (S6) is untested behaviourally — a real `SQLITE_BUSY` needs a competing
  writer. The chaos run does not exercise concurrent bridge writes either.
- `alertActionFailure` sends with `whatsappOk: false`, so a failed kill-switch action alerts
  by email/Telegram only. That is deliberate (the action just failed, WhatsApp is suspect) but
  means a box with no SMTP and no Telegram gets no owner-visible signal beyond the journal.
- `purgeMedia` clears only the row it processed. Two rows pointing at the same file leave the
  second with a dangling path. Pre-existing, out of scope for this fix loop.
- Implementer B's `monitor.sh` must tolerate `purge` exiting 2 (deviation 2) and must run
  `costs check` for S1's fix to reach the owner in production.
