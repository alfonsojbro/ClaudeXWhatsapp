# Audit — Phase 10 Stage A: the installer (`apps/installer`)

**Branch:** `phase-10-installer` · **Date:** 2026-09-03
**Written by:** the orchestrator, after the Stage A implementer was stopped by the harness with its
work on disk but its own audit unwritten. Everything below was re-verified against the files and the
test output rather than taken from the agent's report, because that report was never delivered.

## Files changed

New, all under `apps/installer` unless noted:

| File | What it is |
| --- | --- |
| `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` | package scaffolding, strict TS |
| `wrangler.toml` | so the mirrored public repository deploys as-is |
| `src/index.ts` | the browser entry: wires the DOM to `steps.ts` |
| `src/steps.ts` | the nine operations in order, each with a fallback string |
| `src/cloudflare.ts` | zone, tunnel, tunnel config, DNS, Access app, Access policy |
| `src/hetzner.ts` | firewall, server create, poll to running |
| `src/providers/types.ts` | the `ServerProvider` interface |
| `src/providers/hetzner.ts` | Hetzner behind that interface |
| `src/providers/manual.ts` | bring-your-own-server, no network call at all |
| `src/cloud-init.ts`, `src/cloud-init-core.ts`, `src/cloud-init.template.yml` | the user-data builder |
| `src/bootstrap-command.ts` | the single root SSH command for an existing server |
| `src/ssh-key.ts` | Ed25519 deploy key generation and OpenSSH encoding |
| `src/health.ts` | `classifyHealthProbe`, readiness behind Access |
| `src/redact.ts` | secret redaction for anything shown or thrown |
| `functions/api/[[route]].ts` | the stateless Pages Function proxy |
| `public/index.html`, `public/app.js`, `public/styles.css` | the page, no bundler, no framework |
| `README.md` | how to deploy it to your own Cloudflare account |
| `.github/workflows/mirror-installer.yml` *(repo root)* | the public mirror, inert until set up |
| `deploy/hetzner/bootstrap.sh` *(modified)* | accepts tunnel token and setup mode, deletes user-data |
| `deploy/hetzner/cxw.env.example` *(modified)* | the new Access and setup-mode keys |
| `deploy/hetzner/cloud-init.example.yml` *(new)* | a rendered example with every secret replaced |

Twelve test files, 148 tests.

## Verification

Run from the worktree root on Node 22.23.2, pnpm 10.34.5. All output below is real.

- `pnpm -r typecheck` — clean across all nine packages
- `pnpm lint` — clean
- `pnpm --filter @cxw/installer test` — **12 files, 148 tests passed**
- `pnpm --filter @cxw/console test` — 16 files, 273 tests passed
- `pnpm test:root` — 19 passed
- `bash -n deploy/hetzner/bootstrap.sh` — OK

**No real Cloudflare or Hetzner resource was created.** Every test injects `fetchImpl`. The manual
provider has no `fetch` at all, and a test asserts the file contains none.

## Acceptance, item by item

| Item | Status | How it is held |
| --- | --- | --- |
| No token stored anywhere | **met** | `no-storage.test.ts` walks the real import graph from the page entry and asserts no `localStorage`, `sessionStorage`, `indexedDB`, cache or KV reference, no `env` binding read, no cookie set and nothing logged. The graph walker is itself tested against a file that *does* import `node:`, so a silently-empty walk cannot pass. |
| Payload never leaks a secret | **met** | `assertNoSecretLeaks` runs inside both `buildCloudInit` and `buildBootstrapScript` and throws `CloudInitLeakError`. Secrets appear only as base64 blobs written to `cxw.env`, the deploy-key path, or the Tailscale command. |
| Every step has a fallback | **met** | `steps.test.ts` asserts all nine steps have a title, a detail and a non-empty fallback, and that a mid-flight failure surfaces as the step id plus that fallback, never a stack trace. |
| Provider interface holds | **met** | A test asserts no module outside `src/providers/` imports the Hetzner client, and that `steps.ts` names no provider and no provider error type. |
| SSH one-liner is safe | **met** | Exactly one line; base64-decodes an embedded payload and runs it; fetches nothing from a third party. Verified by grep as well as by test: the only `curl` in the file is the comment explaining why there is no `curl`. |
| No repo, token or resource created | **met** | The mirror workflow gates on `MIRROR_TOKEN` and exits cleanly with an explanation when absent, so it never fails a build. |

## What is deliberately not done, and who must do it

1. **The public repository does not exist.** `alfonsojbro/cxw-installer` is a proposal. Until Alfonso
   creates it and adds a `MIRROR_TOKEN` secret, the workflow no-ops and the landing page's deploy link
   does not resolve. The one-time steps are in the workflow header and in `docs/RUNBOOK.md`.
2. **Nothing has been run against a real account.** The runbook is the only place real resources are
   made, and Alfonso runs it.
3. **`apps/site`, the landing page, is another session's.** Nothing here writes to it.

## Risks the reviewer should look at hardest

1. **`printf %s '<base64>' | base64 -d | bash -s`** — the payload is single-quoted and base64 is
   quote-free, so the quoting is sound, but this is the one place where a change to the encoder could
   become shell injection. The blobs-within-blobs design means neither the deploy key nor the env
   fragment is ever a shell word even after the outer decode; that property deserves a hostile read.
2. **`classifyHealthProbe` treats a 200 as ready-with-a-warning**, on the reasoning that a 200 means
   Access is not enforcing. Confirm the warning is loud enough, because it is the one case where the
   person could proceed with an unprotected wizard.
3. **The Ed25519 OpenSSH private-key encoder** is hand-written. It is tested against a fixed vector and
   by a generate-and-reparse round trip, but a real `ssh-keygen -y` check has not been run.
4. **`bootstrap.sh` deletes the user-data after first boot**, which is right, but Hetzner keeps its own
   copy server-side by design. The page says so; check that it says so plainly enough.
