# Phase 0 — Repo + box hardening

Spec: `docs/IMPLEMENTATION_PLAN.md` §6 row 0 and §3.7.
Base: `6508f1c` (repo skeleton). Branch: `phase-0-foundation`.

## Goal

Make the repo's own guard rails real before any phase branch builds on them: tests that
actually run, a secrets check that actually scans, a deploy script that actually
reinstalls units, and a runbook a person can follow top to bottom without getting stuck.

## Files touched

- `.gitignore`, `.prettierignore`
- `apps/{brain,bridge,scheduler}/vitest.config.ts` (new)
- `mcp/{google,vault,whatsapp}/vitest.config.ts` (new)
- `packages/shared/vitest.config.ts` (new)
- `packages/shared/src/index.ts`
- `deploy/hetzner/update.sh` (new)
- `deploy/hetzner/{backup.sh,restore.sh,bootstrap.sh}`
- `docs/RUNBOOK.md`
- `package.json`, `tsconfig.json`, `vitest.config.ts`
- `scripts/check-secrets.sh`
- `tests/workspace-test-wiring.test.ts` (new)
- `feature-research/phase-0-foundation/{plan.md,audit.md}` (new)

## Steps

1. Give every workspace package its own `vitest.config.ts` so it stops inheriting the
   root config and finding zero suites.
2. Add `tests/workspace-test-wiring.test.ts` so the point above is enforced, not a
   convention a future package can quietly break.
3. Fix `scripts/check-secrets.sh`. Treat it as a security control: it must be
   impossible for the content scan to pass while doing nothing.
4. Add `deploy/hetzner/update.sh` (pull, install, reinstall changed units, restart).
5. Make the CI shellcheck step pass on the existing deploy scripts.
6. Write `docs/RUNBOOK.md` §0, a numbered manual checklist for the box bootstrap.

## Out of scope

- Merging to `main`. Alfonso approves that.
- Pushing the branch to origin.
- `docs/IMPLEMENTATION_PLAN.md` §3.7's deploy key path. It contradicts the working
  layout; flagged for Alfonso rather than changed unilaterally.
