# Audit A4 — Phase 7 ops final pass

## Files changed

- `apps/ops/src/retention.ts` (modified)
- `apps/ops/src/sentinel.ts` (modified)
- `apps/ops/test/retention.test.ts` (modified)
- `apps/ops/test/sentinel.test.ts` (modified)
- `apps/ops/test/owners.test.ts` (new)
- `docs/ARCHITECTURE.md` (modified)

No other file was touched. Prettier `--write` ran over `apps/ops` and `docs/ARCHITECTURE.md`
and reformatted nothing outside the list above (`git status` unchanged for every other path).

## Item 1 — `realOrResolve` climbs to the deepest existing ancestor

`apps/ops/src/retention.ts`: `realOrResolve` now resolves `path.resolve(p)`, then walks up
until `fs.realpathSync` succeeds, re-appending the missing tail with `path.join`. It falls
back to the lexical resolve only at the filesystem root (`path.dirname(dir) === dir`).
Before, a non-existent parent fell straight through to `path.resolve`, so under a symlinked
media dir the lexical candidate never matched the realpath'd root and the row was skipped.

Test added in `apps/ops/test/retention.test.ts`, "accepts a relative path whose parent dir
does not exist yet under a symlinked media dir": `mediaDir` is a symlink to another temp
dir, stored path `sub/a.jpg` with no `sub/` on disk → `resolveMediaPath` returns non-null
and its grandparent realpaths to the real media dir. The same test re-asserts
`resolveMediaPath(cfg, '../bridge.sqlite')` is null, and the existing test "refuses a
media_path that climbs out of the media dir into the data dir" still passes unchanged.
Verified the new case fails on the old helper by inspection: `realpath` throws for
`link/sub`, the lexical `link/sub/a.jpg` does not start with `real + sep`, so the old code
returned null.

## Item 2 — LID owners

New file `apps/ops/test/owners.test.ts`:

- `normalizeOwnerJid('123456789012345@lid')` → the same string verbatim; whitespace is
  trimmed and a Baileys device suffix (`:7`) is still stripped.
- An owners file listing only the LID loads as `['123456789012345@lid']`;
  `isOwnerJid('123456789012345@lid', owners)` is true and
  `isOwnerJid('123456789012345@s.whatsapp.net', owners)` is false.
- Documented in the test and in the docs paragraph that both spellings may be listed; a
  second case asserts both match when both are in the file.

No source change was needed: `normalizeOwnerJid` already passes through any non-`@g.us`
domain.

## Item 3 — the tick re-reads persisted state

`apps/ops/src/sentinel.ts`: extracted the body of the `runSentinel` loop into an exported
`sentinelTick(cfg, state, owners): Promise<SentinelState>` (open db → `pollOnce(db, state,
owners, cfg)` → run hits → persist when there were hits → return next state). `runSentinel`
now calls `state = await sentinelTick(cfg, state, loadOwners(cfg))` inside the same
try/catch. Behaviour is unchanged: the same order, the same per-hit error handling, the same
"persist only after the actions ran" rule, and the same `fileExists(cfg.bridgeDb)` guard
(now an early return).

Deviation from the plan: the signature is `(cfg, state, owners)` rather than
`(db, state, owners, cfg)`, so the tick owns opening and closing the read-only handle
exactly as the loop did. Testing it at that boundary is what proves the running sentinel
passes `cfg` into `pollOnce`.

Tests added in `apps/ops/test/sentinel.test.ts`, `describe('sentinelTick')`:

- an owner `panic` row is seeded, `markHandled(cfg, 't1')` writes the id to disk _after_
  `emptySentinelState(base)` is created → the tick fires nothing (no `panic` file, no ctl
  calls), returns `handled` containing `t1` and advances `lastSeen`.
- a control case: the same row with nothing marked → the `panic` file exists and the fake
  ctl recorded `['stop scheduler', 'stop brain']`.

No timers, no open handles; the existing `runSentinel` end-to-end test is untouched.

## Item 4 — ARCHITECTURE.md

One paragraph added under "C4. Owners (Phase 1)", above the `loadOwners` signature block:
WhatsApp may address the self-chat and contacts by LID; the bridge SHOULD store
phone-number JIDs in `messages.jid` / `messages.sender` by resolving LIDs through Baileys'
LID mapping; until then the owner must also list the LID in `owners.json`, which ops accepts
verbatim (device suffix stripped) and matches exactly, so the two spellings are two entries.

## Gates

All run with `PATH=$HOME/.nvm/versions/node/v22.23.2/bin:$PATH`, no server touched.

- `pnpm --filter @cxw/ops typecheck` — clean.
- `pnpm --filter @cxw/ops test` — 8 files, 93 tests passed, 3.5–4.2 s, no open-handle
  warning (re-run after the prettier pass, same result).
- `pnpm exec eslint apps/ops` — clean, no output.
- `pnpm exec prettier --write apps/ops docs/ARCHITECTURE.md` then `--check` — "All matched
  files use Prettier code style!".

## Open risks

- `sentinelTick` is now part of the module's exported surface. It is documented as the loop
  body; nothing outside the tests calls it.
- The LID tests assume `OWNER_JIDS` is unset in the test environment (as `makeConfig` does
  not set it). The suite passes locally; a CI runner exporting `OWNER_JIDS` would break the
  `expect(owners).toEqual([LID])` assertion, as it already would for other owner tests.
- Media retention for LID-addressed chats still depends on the owner listing the LID: the
  orphan walk exempts a directory only when its name normalises to a listed owner.
