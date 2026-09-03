# Audit — Phase 7, Implementer A (`apps/ops`)

Date: 2026-09-03 · Branch: `phase-7-ops` (worktree `/Users/alfonsobriceno/ClaudeXWhatsapp/.worktrees/phase-7-ops`)

## Files changed

Created:

- `apps/ops/package.json`
- `apps/ops/tsconfig.json`
- `apps/ops/vitest.config.ts`
- `apps/ops/README.md`
- `apps/ops/bin/cxw-ops.js`
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
- `apps/ops/test/helpers.ts`
- `apps/ops/test/alerts.test.ts`
- `apps/ops/test/retention.test.ts`
- `apps/ops/test/costs.test.ts`
- `apps/ops/test/health.test.ts`
- `apps/ops/test/killswitch.test.ts`
- `apps/ops/test/commands.test.ts`
- `apps/ops/test/sentinel.test.ts`

Modified:

- `pnpm-lock.yaml` (root lockfile, updated by `pnpm install` after adding `apps/ops`; expected per plan §H)

Nothing else was touched. The `deploy/**` entries visible in `git status` belong to
Implementer B, running in parallel on the same branch.

## What changed, per file

- **`config.ts`** — one `loadConfig(env = process.env)` producing a fully typed `Config`.
  Env names follow plan §H/§I: `BRIDGE_HOST`/`BRIDGE_PORT` and `BRAIN_HOST`/`BRAIN_PORT`
  with `BRIDGE_URL`/`BRAIN_URL` as overrides, `CXW_DISK_LIMIT_PCT` (used %),
  `CXW_BACKUP_MAX_AGE_H`, the `CXW_*` prefixed alert/retention/cost/ctl keys, unprefixed
  `SMTP_*`/`TELEGRAM_*`/`GOOGLE_*`. Optional values are typed `T | undefined` (not `?:`)
  for `exactOptionalPropertyTypes`. `CXW_SUDO` unset means `sudo -n`; set-but-empty means
  no prefix, split on whitespace by `splitPrefix`. Every path is overridable so tests point
  the package at a temp dir.
- **`logger.ts`** — pino with the exact `redact` path list and censor `[redacted]`, plus
  `maskJid()` for the rare case an alert needs to name a chat.
- **`state.ts`** — state-dir path helpers, atomic JSON write (tmp + rename, mode 0600),
  flag file helpers, `monthKey`/`dayKey`/`startOfDay`/`startOfMonth` in the process TZ, and
  `formatDuration`.
- **`db.ts`** — `node:sqlite` (`DatabaseSync`), the `TS_MS_SQL` normaliser (`ts < 1e12` →
  seconds) and `toMs`, plus `tableExists`/`columnExists`.
- **`owners.ts`** — zod-parsed owners file (`{ owners: [...] }` or bare array), digits
  normalised to `<digits>@s.whatsapp.net`, device suffixes stripped, `@g.us` never an owner,
  `OWNER_JIDS` added on top.
- **`health.ts`** — `runHealth()` with the six checks, each `guard()`ed by a per-check
  timeout and try/catch. Panic mode rewrites the brain check to
  `ok:false, detail 'panic mode, expected down', healAction null, noAlert true`. Writes
  `health.json`; `healActions()` dedupes heal strings.
- **`alerts.ts`** — pure `reconcile()` state machine plus `deliver()`. `deliver()` refuses a
  non-owner JID twice over (`alertTargetJid` and a second check inside `sendWhatsApp`), and
  in log transport prints `[alert:<channel>] <text>` for the one channel that accepts.
- **`retention.ts`** — `purge({ dryRun, emergency })` with owner-forever, media-first then
  text, optional `media` table cleanup, FTS rebuild in try/catch, orphan walk of
  `MEDIA_DIR/<jid>/` by mtime, optional VACUUM, result written to `last-purge.json`. A
  single `takeFile()` helper guarantees each file is counted exactly once across both paths.
- **`costs.ts`** — `usage` table in ops.sqlite (created on demand, `ts` index), longest-prefix
  pricing table, `recordUsage` (which also calls `checkCap`), `todayTotals`, `monthTotals`,
  `dailyCostLine` in the exact C8 format, `checkCap` with the warn-once marker and the
  `cost-paused` flag, month-rollover clearing, and `unpause`.
- **`killswitch.ts`** — `ctl(action, unit?)` via `execFile` (no shell) with the allowlist
  enforced in TS before spawning, `panic()` (flag → stop scheduler → stop brain),
  `resume()` (clear flag → start brain → start scheduler), and `getPauseState()` which
  ignores a `cost-paused` flag from a past month.
- **`commands.ts`** — `handleOpsCommand(text, ctx, deps?)`. Non-owner → null; unknown verb →
  null; `messageId` deduped through the shared sentinel handled-id state. The panic ack is
  returned before the stop runs, via an injectable `schedule` (default `setTimeout(...).unref()`).
- **`sentinel.ts`** — `isKillSwitchText` and `pollOnce(db, state, owners)` exported as pure
  pieces; `runSentinel()` polls every 5 s, starts from `lastSeen = now`, and never touches
  an LLM. Handled ids are shared with the brain handler.
- **`cli.ts`** — the §I1 contract exactly: text/JSON output shapes, `HEAL` lines, exit codes,
  alert reconciliation and delivery unless `--no-alert`, delivery errors logged and never
  affecting the exit code. The SQLite `ExperimentalWarning` is filtered here only.
- **`index.ts`** — the public API for the other phases (`handleOpsCommand`, `recordUsage`,
  `getPauseState`, `dailyCostLine`, `checkCap`, `purge`, `runHealth`, `loadOwners`, types).
- **`README.md`** — what it is, the env key table (pointing at the plan as authoritative),
  the CLI and WhatsApp commands, state files, and the integration contract table.

## Deviations from the plan, and why

1. **`Check` gained an optional `noAlert` field.** The plan requires the panic-mode brain
   check to be excluded from alerts, but the `--json` output shape is fixed at
   `{ name, ok, detail, healAction }`. The flag lives on the in-memory type; `cli.ts`
   projects only the four contract fields into JSON, so the shell-side contract is unchanged.
2. **`deliver()` signature is `deliver(texts, { whatsappOk, owners? }, cfg)`** rather than
   the plan's sketch `deliver(alerts, checks, cfg)`. Same behaviour, but it does not need to
   re-derive the WhatsApp state from a checks array and is far easier to unit-test.
3. **`ctl()` takes an optional unit** so the bare actions `backup` and `vacuum-journal` are
   representable. The allowlist rejects a unit for a bare action and a bare action with a
   unit.
4. **`recordUsage` calls `checkCap` and discards its text.** The plan says `checkCap` is
   called by `recordUsage` and by the monitor; the warning text is the monitor's to deliver.
   Consequence worth noting: whichever caller crosses a threshold first consumes the
   once-only text. The `cost-paused` flag and the `cost-warned-<month>` marker are the
   durable signal, so nothing is lost.
5. **Restic dropped from the backup check**, as directed by plan §H; the marker file is the
   only source.
6. **`checkBackup` prefers the marker file's ISO contents and falls back to its mtime.**
   `backup.sh` writes the ISO timestamp; the mtime fallback keeps an empty or truncated
   marker usable.
7. **`zod` is used only for the owners file.** Everything else is small hand-rolled env
   coercion, which reads better than a schema for scalar defaults. `zod` stays a dependency
   as the plan lists it.

## Test results

`pnpm --filter @cxw/ops test` — **7 files, 63 tests, all passing, 3.1 s**, no open handles.

| File                 | Tests | Covers                                                                                                                                                                                                                                                                      |
| -------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `alerts.test.ts`     | 10    | first alert, `afterFailures` threshold, dedupe (3 ticks → 1 alert), repeat after interval, recovery once, no recovery for a never-alerted outage, channel selection, non-owner refusal                                                                                      |
| `retention.test.ts`  | 7     | owner rows preserved, third-party purged, media unlinked, seconds timestamps, emergency = media only, dry-run changes nothing, optional `media` table rows, orphan walk, `last-purge.json`                                                                                  |
| `costs.test.ts`      | 10    | prefix pricing incl. `claude-haiku-4-5-20251001`, longest-prefix wins, unknown → opus-5, token maths, `costUsd` passthrough, exact cost-line format, warn once, pause flag at cap, month rollover clears, unpause, row per model                                            |
| `health.test.ts`     | 10    | all green against stubs, bridge down → `restart bridge`, connected:false, google 401, google off, `CXW_DISK_LIMIT_PCT=0` → `purge --emergency`, stale backup → `backup`, panic → no `restart brain` + `noAlert`, deep check never spawned at interval 0, missing auth fails |
| `killswitch.test.ts` | 7     | ctl call order, action and unit allowlist rejection (nothing spawned), bare-action rules, sudo prefix, panic/resume order, pause state                                                                                                                                      |
| `commands.test.ts`   | 9     | non-owner → null, non-command → null, panic ack before stop, resume, status, dry-run purge, costs today/month/line, unpause, messageId dedupe                                                                                                                               |
| `sentinel.test.ts`   | 10    | `panic`/`/Resume ` matching, non-matches, owner filter, `lastSeen` filter, handled-id filter, seconds timestamps, shared handled state                                                                                                                                      |

Root-wide: `pnpm -r typecheck` clean (8 packages), `pnpm lint` clean, `pnpm exec prettier
--check apps/ops` clean, `pnpm -r test` clean.

## Smoke run

```
$ CXW_STATE_DIR=/tmp/cxw-ops-smoke CXW_DATA_DIR=/tmp/cxw-ops-smoke \
  CXW_OWNERS_FILE=/tmp/cxw-ops-smoke/owners.json CXW_ALERT_TRANSPORT=log \
  CXW_CLAUDE_AUTH_DEEP_CHECK_MIN=0 CXW_GOOGLE_CHECK=off \
  node_modules/.bin/tsx apps/ops/src/cli.ts health
FAIL whatsapp - fetch failed
FAIL brain - fetch failed
OK google - disabled
FAIL disk - 90.4% used (limit 85%)
FAIL backup - no last-backup marker
FAIL claude_auth - no token env and no usable credentials file
HEAL restart bridge
HEAL restart brain
HEAL purge --emergency
HEAL backup
{"level":50,...,"errors":[],"msg":"alert delivery failed on every channel"}
exit=1
```

As expected: no `[alert:...]` line because `SMTP_HOST` is unset and Telegram is off, so no
channel is configured; that condition is logged and the run still exits 1 without throwing.
Two environment-specific extras beyond the plan's prediction: `disk` fails because the dev
Mac is 90.4 % full, and `claude_auth` fails because the smoke shell has no
`CLAUDE_CODE_OAUTH_TOKEN`. Both are correct behaviour.

`node --input-type=module -e "import('./apps/ops/src/index.ts')..."` ran without output, as
expected (Node cannot execute TS directly here; the guarded catch swallows it).

## Open risks and questions for the reviewer

1. **Disk check uses `statfs().bfree`, not `bavail`.** `bfree` includes root-reserved blocks,
   so the reported used % is slightly lower than `df` shows for a non-root user. Worth a
   decision: match `df` (`bavail`) or keep the true fill level (`bfree`).
2. **Orphan media walk deletes by mtime alone.** A non-owner file older than the cutoff is
   unlinked even if a still-live message row references it (possible when a row's `ts` is
   newer than the file's mtime). The plan specifies this; flagging it as a real, if narrow,
   data-loss path.
3. **Warn/pause text is consumed by whichever caller crosses the threshold first**
   (deviation 4 above). If the owner must always see the warning in WhatsApp, `checkCap`
   would need a "peek" mode or the marker would need to record undelivered text.
4. **`purge` opens the bridge DB read-write for a real run** while the bridge itself is
   running. SQLite handles the concurrency, but a `SQLITE_BUSY` under load is possible; no
   busy timeout is set. Worth a `PRAGMA busy_timeout` if the reviewer agrees.
5. **`monthKey`/`startOfMonth` use the process time zone**, per plan §D4. The box must set
   `TZ` in `cxw.env` (it already sets `TZ=Europe/Prague`) or cost months drift for anyone
   running the CLI in another zone.
6. **`bin/cxw-ops.js` imports `../dist/src/cli.js`**, which only exists after
   `pnpm --filter @cxw/ops build`. Per plan §H the deploy path uses the `tsx` wrapper
   installed by `install-ops.sh`, so the bin shim is a convenience only.
7. **The health check for `claude_auth` reads the credentials file's `claudeAiOauth.expiresAt`
   as epoch ms.** If Claude Code ever writes seconds there, the check would report expired.
