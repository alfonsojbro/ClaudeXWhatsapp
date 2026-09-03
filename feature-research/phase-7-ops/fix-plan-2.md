# Fix plan 2 — after review-2 (verdict: fix-then-ship)

Source: `feature-research/phase-7-ops/review-2.md` (B-1, S-1..S-6). Same rules as `plan.md`/`fix-plan-1.md`.

## Files touched — Implementer A (apps/ops only)

- `apps/ops/src/retention.ts` — (B-1) containment root is **only** `mediaDir`; drop `dataDir` from the roots. (S-4) compare with `fs.realpathSync` on the root (fall back to `path.resolve` if it does not exist) and `path.resolve` + `realpathSync` on the candidate's parent dir when it exists; a legitimate absolute path inside a symlinked media dir must not be skipped. Add tests: `../bridge.sqlite` is skipped and the file survives; a symlinked media dir with absolute stored paths purges normally.
- `apps/ops/src/sentinel.ts` — (S-1) the running loop re-reads `sentinel.json` (handled ids) from disk at the start of every poll so a message the brain handler already consumed is never fired again; keep the in-memory set as a union. Add a test: mark an id handled through the exported helper _after_ the sentinel state object was created, then `pollOnce` must skip it.
- `apps/ops/src/costs.ts` — (S-2) `notifyCap` writes the month marker **only after** `deliver` reports success (`channel !== null`); on delivery failure return `{ delivered: false }` and leave the marker absent so the next tick retries. Test it.
- `apps/ops/src/cli.ts` — (S-3) `costs check` always prints one status line to stdout: `cost: <level> $<total> / $<cap> (<pct>%) — notified|already notified this month|delivery failed`.
- `apps/ops/README.md` — containment wording: "only files under `MEDIA_DIR` are ever unlinked".
- Tests as listed; keep suite < 30 s, no open handles. Gates: typecheck, test, eslint, prettier, root `pnpm -r typecheck && pnpm lint`.

## Files touched — Implementer B (deploy + docs)

- `deploy/hetzner/security-check.sh` — (S-6) box mode: FAIL if any `/srv/cxw/*.env` contains `CHANGEME`; repo mode: FAIL if any `deploy/hetzner/*.env.example` other than `cxw.env.example`/`restic.env.example` contains `CHANGEME` (those two are Phase 0's and are only warned about with a `WARN` line).
- `docs/ARCHITECTURE.md` — (S-5) purge JSON shows `skipped` and the exit-2 refusal; state-file table: `cost-warned-<YYYY-MM>` and `cost-paused-alerted-<YYYY-MM>` are written by `notifyCap` (`costs check`), not `checkCap`; containment sentence says `MEDIA_DIR` only; sentinel dedupe sentence says the sentinel re-reads `sentinel.json` every poll.
- `docs/RUNBOOK.md` — (S-5) §14 purge JSON with `skipped`, exit 2 meaning; §15 `costs check` prints a status line; §17 six scenarios; §13 dedupe wording.
- Run `bash deploy/hetzner/chaos.sh --local` once after A lands (retry up to 3× 2 min apart) and confirm the table in `docs/runs/chaos-2026-09-03.md` still matches; prettier on docs.

## Steps

A and B in parallel; then reviewer round 3 limited to B-1, S-1..S-6 and regressions.
