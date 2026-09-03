# Audit — Phase 10 Stage B: the setup wizard (`apps/console/src/setup/`)

**Date:** 2026-09-03 · **Branch:** `phase-10-installer` · **Worktree:** `/Users/alfonsobriceno/ClaudeXWhatsapp-phase-10-installer`
**Plan:** `feature-research/phase-10-installer/plan.md`, rev 3 plus rev 4 (rev 4 affects docs only for this stage).
**Scope:** Stage B only. `apps/installer/**`, `deploy/**` and `.github/**` belong to the peer implementer and were not touched.

## Files changed

Scaffolding — **byte-identical copies** from `ClaudeXWhatsapp-phase-8-console`, verified with `diff -q`:

- `apps/console/package.json` (new)
- `apps/console/tsconfig.json` (new)
- `apps/console/vitest.config.ts` (new)

New source and tests, all under `apps/console/src/setup/`:

- `state.ts`, `state.test.ts`
- `mode.ts`, `mode.test.ts`
- `envfile.ts`, `envfile.test.ts`
- `access-verify.ts`, `access-verify.test.ts`
- `escape.ts`, `escape.test.ts`
- `styles.ts`
- `render.ts`, `render.test.ts`
- `router.ts`, `router.test.ts`
- `standalone.ts`, `standalone.test.ts`
- `guardrails.test.ts`
- `steps/owner.ts`, `steps/owner.test.ts`
- `steps/whatsapp.ts`, `steps/whatsapp.test.ts`
- `steps/claude.ts`, `steps/claude.test.ts`
- `steps/google.ts`, `steps/google.test.ts`
- `steps/routines.ts`, `steps/routines.test.ts`
- `steps/vault.ts`, `steps/vault.test.ts`
- `steps/done.ts`, `steps/done.test.ts`

Docs:

- `docs/INSTALLER.md` (new)
- `docs/RUNBOOK.md` (modified: new `## 8` appended, sections 8.0–8.7)
- `docs/IMPLEMENTATION_PLAN.md` (modified: new `### 3.9` before the `---` ending section 3; one new row in the section 6 phase table)
- `feature-research/phase-10-installer/audit-stage-b.md` (this file)

Nothing else was created or edited.

## The scaffolding check the brief asked for

`tests/workspace-test-wiring.test.ts` was read first. It asserts three things per workspace package:
the package exists, its `test` script contains `vitest`, and its `vitest.config.ts` `include` globs
match every `src/**/*.test.ts` it owns. The copied files satisfy all three unchanged:
`"test": "vitest run --passWithNoTests"` and `include: ['src/**/*.test.ts']`, which matches
`src/setup/*.test.ts` and `src/setup/steps/*.test.ts`.

**No change to `apps/console/package.json` was needed**, so the merge cost is zero: phase 8 and this
branch add the identical file and git resolves it without a conflict. As expected, `exports` and the
`start`/`dev` scripts point at `src/main.ts`, which does not exist here. Nothing imports
`@cxw/console`, and CI runs only `typecheck`, `test` and `lint`, none of which resolve `exports` or
run `start`, so all four commands pass. `standalone.ts` is the runnable entry on this branch.

## Verification, verbatim

Run with `export PATH=$HOME/.nvm/versions/node/v22.23.2/bin:$PATH` in
`/Users/alfonsobriceno/ClaudeXWhatsapp-phase-10-installer`. All four green.

```
$ pnpm --filter @cxw/console typecheck

> @cxw/console@0.0.1 typecheck /Users/alfonsobriceno/ClaudeXWhatsapp-phase-10-installer/apps/console
> tsc --noEmit -p tsconfig.json

```

```
$ pnpm --filter @cxw/console test

> @cxw/console@0.0.1 test /Users/alfonsobriceno/ClaudeXWhatsapp-phase-10-installer/apps/console
> vitest run --passWithNoTests

▲ [WARNING] Duplicate key "test:root" in object literal [duplicate-object-key]

    ../../package.json:22:4:
      22 │     "test:root": "vitest run --passWithNoTests"
         ╵     ~~~~~~~~~~~

  The original key "test:root" is here:

    ../../package.json:16:4:
      16 │     "test:root": "vitest run --passWithNoTests",
         ╵     ~~~~~~~~~~~


 RUN  v4.1.11 /Users/alfonsobriceno/ClaudeXWhatsapp-phase-10-installer/apps/console


 Test Files  16 passed (16)
      Tests  273 passed (273)
   Start at  16:44:45
   Duration  30.68s (transform 95.70s, setup 0ms, import 120.23s, tests 20.34s, environment 245ms)
```

```
$ pnpm lint

> claudexwhatsapp@0.0.1 lint /Users/alfonsobriceno/ClaudeXWhatsapp-phase-10-installer
> eslint .

```

```
$ pnpm test:root
      16 │     "test:root": "vitest run --passWithNoTests",
         ╵     ~~~~~~~~~~~


 RUN  v4.1.11 /Users/alfonsobriceno/ClaudeXWhatsapp-phase-10-installer


 Test Files  1 passed (1)
      Tests  19 passed (19)
   Start at  16:50:43
   Duration  7.89s (transform 1.53s, setup 0ms, import 2.17s, tests 628ms, environment 0ms)
```

Two things in that output are **not mine and were already on the branch**:

1. The root `package.json` declares `"test:root"` twice (lines 16 and 22, identical values). Harmless,
   but esbuild warns on every run. I did not fix it: the brief forbids editing root config.
2. During the run I hit one transient lint error in `apps/installer/src/cloud-init.test.ts`
   (`'_drop' is assigned a value but never used`). It is the peer implementer's file; I did not touch
   it, and it was fixed at their end before the final run above.

## Design decisions the plan left open

1. **`google.env` holds the client secret between `start` and `callback`.** The plan says `setup.json`
   never holds a secret, but the OAuth flow needs the client id and secret to survive a round trip
   through Google. I write them to `google.env` (mode 0600, its designated home) at the start of the
   flow with an empty `GOOGLE_REFRESH_TOKEN`, and the callback reads them back and rewrites the file
   with the token. A test asserts the secret never appears in `setup.json` and never in a redirect URL.
2. **`GET /setup/google/start` exists as the plan's route list says, and `POST` does too.** The listed
   route cannot carry the client id and secret, so the POST form is the real entry point and the GET
   re-runs the consent redirect from details already on the box. Both are tested.
3. **`POST /setup/whatsapp/pair-code` does not invent a pairing-code API.** `scripts/pair-qr` publishes
   a QR and a status, not a pairing code. Rather than fake one, the route renders the step with a note
   naming the exact command that offers the code path in its terminal output. Flagged as IP-3.
4. **The owner step cannot be skipped.** With no owner the assistant answers nobody, so a box that came
   out of setup without one would be unusable. Every other step is skippable. Tested.
5. **`mergedPhases` is injected, not detected.** Detecting which phases exist would mean probing for
   files that are present in a worktree but not on the branch — exactly the guess that would put a
   false promise on the done page. It defaults to `[]`, so nothing is claimed unless a caller says so.
6. **Setup mode has a second trigger: a missing or empty owners file.** A box restored from a backup
   without its owners file is unusable, and offering setup again is the honest response.
7. **A corrupt `setup.json` starts over rather than throwing.** `readSetupState` returns a fresh state
   flagged `recovered`, which is never persisted.
8. **Shape checks on the Anthropic credentials warn, they do not block.** A prefix is a convention, not
   a promise; a wizard that refuses a valid token because Anthropic changed a prefix is unusable on the
   day it changes.
9. **`envfile.ts` rewrites every occurrence of a duplicated key**, not just the last, so the file never
   ends up saying two different things about one variable.
10. **A body over the cap answers 413**, not a rendered error page, so a client can tell "too big" from
    "you typed something wrong".
11. **The wizard sets its own CSP** (`default-src 'none'`, `form-action 'self'`, `frame-ancestors 'none'`).
    The page loads nothing external; the stylesheet and the one script are inline.
12. **Fonts are not copied.** `styles.ts` copies phase 8's token *names* and its font *stacks*, but the
    `@font-face` blocks point at `apps/console-ui`'s self-hosted files, which do not exist during setup.
    The stacks fall through to the same system faces phase 8 lists as fallbacks. The wizard therefore
    makes no third-party request, but it is not pixel-identical to the console.

## Integration points — the exact change each merge must make

| ID | Where | What has to happen |
| --- | --- | --- |
| **IP-1** | `apps/console/src/server.ts` (phase 8) | In `handle()`, after the `/api/health` early return and **before** its own Access check, add: `const setup = createSetupHandler({ …deps.config, verifyAccess: deps.verifier.verifyToken });` (hoisted out of `handle` into `createRequestHandler`) and `if (await setup(request, response)) return;`. The handler returns `false` for everything it did not answer, so no console route is lost. It does its own Access check, which is why it must come first. |
| **IP-2** | `apps/console/src/setup/access-verify.ts`, `apps/console/src/setup/standalone.ts` | **Delete both files** in the phase 8 merge commit. Pass phase 8's `AccessVerifier` into `createSetupHandler` as the `verifyAccess` dep — it is a plain `(req) => Promise<{email}>` precisely so the swap is one line. Also delete `access-verify.test.ts` and `standalone.test.ts`, and remove the two entries from `guardrails.test.ts`'s expectations if the file count assertion trips (it asserts `> 20` files, so it will not). |
| **IP-3** | `apps/console/src/setup/steps/whatsapp.ts` | When `docs-getting-started` merges, `scripts/pair-qr/` exists and nothing in this module changes — it is already written against the published HTTP contract. Only `PAIR_ARGV` / `PAIR_COMMAND` need revisiting if the script is renamed. If pair-qr ever grows a pairing-code endpoint, replace the placeholder response in `router.ts`'s `/setup/whatsapp/pair-code` case. |
| **IP-4** | `apps/console/src/setup/steps/google.ts` | When phase 4 merges, `SCOPES` and `DEFAULT_TOKEN_URL` here must be replaced by imports from `mcp/google/src/scopes.ts`, or kept identical. They are byte-identical today. The four `GOOGLE_` key names in `renderGoogleEnv` must never drift from `mcp/google/src/auth.ts`, because phase 4's server reads that file. |
| **IP-5** | `apps/console/src/setup/steps/routines.ts` | When phase 5 merges, replace `setRoutineEnabled` with an import of `apps/scheduler/src/routine.ts`'s `setEnabled`. It is a deliberate, marked duplicate — same regexp, same byte-preserving behaviour — not a fork. `listRoutines`'s `present: false` branch then stops firing on a real box; keep it, since a box can still be missing its vault. |
| **IP-6** | `docs/INSTALLER.md` | When `docs-getting-started` merges, splice this file into `docs/GETTING_STARTED.md` as a new section immediately after "2. What you need", and renumber the existing manual sections beneath it. The file already says in two places that the manual path still works and is the fallback. |

## What I could not do, and why

- **`docs/IMPLEMENTATION_PLAN.md` section 6 now jumps from phase 7 to phase 10.** Phases 8 and 9 are
  owned by their own branches; inventing rows for them would be a guess about someone else's
  deliverable and would conflict on merge. The gap is deliberate and the merge order should be
  8 → 9 → 10 so the table fills in.
- **The `"test:root"` duplicate key in the root `package.json`** is left alone; the brief forbids
  editing root config. Worth a one-line fix by whoever owns it.
- **No real Cloudflare, Hetzner or Google resource was created.** Every network call is an injected
  `fetchImpl` and every test mocks it. `docs/RUNBOOK.md` §8 is the only place real ones are made, and
  it says so at the top of the section.
- **No git state was changed.** No `add`, `commit`, `checkout` or `stash` was run.

## Risks the reviewer should look at hardest

1. **`getGoogleCallback` clears the nonce by building a copy and `delete`-ing the key** because
   `exactOptionalPropertyTypes` forbids assigning `undefined`. Check that a replayed callback really
   cannot land twice — the nonce is only persisted by the `advance()` write that follows, so an error
   thrown between the exchange and the write would leave the old nonce on disk. The window is small and
   the exchange is already spent by then, but it is the sharpest edge in the file.
2. **The CSRF value lives in `setup.json` and never rotates.** That matches the plan ("a CSRF token held
   in `setup.json`") and the file is 0600 root-only, but it is weaker than phase 8's per-session,
   identity-bound tokens. On merge, consider binding it to the Access identity the way phase 8 does.
3. **`originAllowed` accepts a request with no `Origin` header**, which is what a no-JavaScript form POST
   from an older browser sends. Phase 8's console does the same, so this is consistent, but it means the
   CSRF value is the only defence for those requests.
4. **The device-flow parser is deliberately loose.** `parseDeviceFlow` finds the first https URL and a
   short alphanumeric code. It is tested against a realistic shape and against a URL-only output, but
   `claude setup-token`'s real output was not available to test against on this branch. Worth one manual
   check during RUNBOOK §8.4 step 4.
5. **`guardrails.test.ts` reasons about source text, not an AST.** Its write-path assertion is
   "no writing module contains an absolute path literal, and every write target is a bare identifier",
   which is a proxy for "the target flows from an injected dep". A sufficiently creative future edit
   could satisfy the letter and not the spirit. It is still the strongest check available without adding
   a parser dependency, which the package's zero-dependency rule forbids.
6. **`standalone.ts` refuses a non-loopback bind**, but the check is against a fixed list of three
   spellings. An IPv6 form such as `[::1]` would be refused rather than accepted — fail-closed, which is
   the right direction, but worth knowing.
7. **The wizard's error path renders the current step with a banner and answers 200.** A reviewer may
   prefer 4xx for a validation failure. I chose 200 because these are ordinary form re-renders that a
   person reads, and every one of them is behind Access.
