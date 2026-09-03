# Plan addendum — Phase 5 reconciled with the committed skeleton

The plan in `plan.md` was written before the repo skeleton (commit `6508f1c`) existed. `plan.md` stays
authoritative for the **design**. This addendum overrides it wherever it conflicts with the repo as it
actually is. Read both; on conflict, this file wins.

## 1. Repo skeleton already exists — skip plan.md step 1 entirely

Already present and NOT to be recreated or rewritten: root `package.json`, `pnpm-workspace.yaml`,
`tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.prettierrc`,
`eslint.config.js`, `.github/workflows/ci.yml`, `.githooks/pre-commit`, `scripts/check-secrets.sh`,
`packages/shared`, `apps/bridge`, `mcp/{whatsapp,google,vault}`, the `vault/` tree with READMEs,
`workspace/README.md`, and all of `deploy/hetzner/`.

`apps/scheduler` and `apps/brain` exist as stubs: `src/index.ts` (exports `SERVICE`, `describe()`,
`main()`, with an `import.meta.url` entry guard) and `src/index.test.ts`. Extend them; do not delete
the stub exports other packages may later import.

## 2. Dependencies — already installed, do not re-run install

`apps/scheduler/package.json` now declares `@anthropic-ai/claude-agent-sdk ^0.3.0`,
`better-sqlite3 ^13.0.0`, `croner ^10.0.0`, `gray-matter ^4.0.3`, `pino ^10.0.0`, `zod ^4.5.4`,
`@cxw/shared workspace:*`, devDep `@types/better-sqlite3 ^7.6.13`.
`apps/brain/package.json` adds `@cxw/scheduler workspace:*` and `chrono-node ^2.10.0`.
`pnpm-workspace.yaml` gained `onlyBuiltDependencies: [better-sqlite3, esbuild]`.
`pnpm install` has been run; `better-sqlite3` loads. Installed SDK version is **0.3.259**.

## 3. Test location — `tests/`, not `test/`

The root `vitest.config.ts` sets `include: ["tests/**/*.test.ts"]` and per-package `vitest run` inherits
it with the package dir as root. Therefore scheduler tests go in **`apps/scheduler/tests/*.test.ts`**
and brain tests in **`apps/brain/tests/*.test.ts`** (plural). Do NOT add per-package vitest configs and
do NOT edit the root `vitest.config.ts`. Co-located `src/*.test.ts` files are not picked up — never put
a new test there.

Rename from plan.md: `test/helpers.ts` -> `tests/helpers.ts`, and so on for every test file.

## 4. Agent SDK — option names verified against the installed `sdk.d.ts` (0.3.259)

All names in plan.md section "Brain job runner" are correct as written. Confirmed present on `Options`:
`abortController`, `cwd`, `model`, `maxTurns`, `mcpServers`, `permissionMode`, `allowedTools`,
`disallowedTools`, `settingSources`, `systemPrompt`, `env`, `maxBudgetUsd`.

- `permissionMode: 'dontAsk'` is a valid `PermissionMode` member. Use it.
- `settingSources?: SettingSource[]` where `SettingSource = 'user' | 'project' | 'local'`. Pass `[]`.
- `systemPrompt` accepts `{ type: 'preset'; preset: 'claude_code'; append?: string }`. Use that form
  with `append` = contents of `<CXW_WORKSPACE_DIR>/CLAUDE.md` when the file exists. The `.d.ts`
  confirms this shape, so the plan's fallback to `settingSources: ['project']` is NOT needed.
- `mcpServers?: Record<string, McpServerConfig>`; the stdio variant is
  `{ type?: 'stdio'; command: string; args?: string[]; env?: Record<string,string>; timeout?: number }`.
- `query({ prompt, options })` returns `Query extends AsyncGenerator<SDKMessage, void>`.
- Result message: `type: 'result'`, `subtype: 'success'` carries `result: string`, `total_cost_usd: number`,
  `num_turns: number`, `session_id: string`, `is_error: boolean`. Error subtypes carry no `result` field,
  so narrow on `subtype === 'success'` before reading `result`. Treat any non-success subtype as an error
  whose message is the subtype string; if the iterator finishes with no result message, error `no_result`.

## 5. Config and env — align with the names the box already uses

`deploy/hetzner/cxw.env.example` already defines `TZ`, `LOG_LEVEL`, `CXW_DATA_DIR`, `CXW_STATE_DIR`,
`CXW_VAULT_DIR`, `CXW_WORKSPACE_DIR`, `BRIDGE_HOST`, `BRIDGE_PORT` (7411), `CLAUDE_CODE_OAUTH_TOKEN`,
`ANTHROPIC_API_KEY`, `CXW_DISK_LIMIT_PCT`, `CXW_BACKUP_MAX_AGE_H`. Reuse those rather than inventing
parallel names:

| plan.md name               | use instead                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CXW_TZ`                   | `CXW_TZ`, falling back to `TZ`, default `Europe/Prague`                                                                                                 |
| `SCHEDULER_DB`             | `SCHEDULER_DB`, default `<CXW_DATA_DIR>/scheduler.sqlite` — **`.sqlite`, not `.db`**, because `.gitignore` covers `*.sqlite*` and does not cover `*.db` |
| `DISK_MIN_FREE_PCT` (10)   | `CXW_DISK_LIMIT_PCT` (max used %, default 85) — the check fails when used % exceeds it                                                                  |
| `BACKUP_MAX_AGE_HOURS` (8) | `CXW_BACKUP_MAX_AGE_H` (default 8)                                                                                                                      |
| `BRIDGE_URL`               | `BRIDGE_URL` if set; otherwise `http://${BRIDGE_HOST ?? '127.0.0.1'}:${BRIDGE_PORT ?? 7801}`                                                            |

Add, and document in `cxw.env.example` with placeholder values: `CXW_TZ`, `SCHEDULER_DB`,
`BRIDGE_URL`, `BRIDGE_TOKEN`, `SCHEDULER_TICK_MS`, `MAX_CONCURRENT_JOBS`, `LEASE_TTL_MS`,
`JOB_TIMEOUT_MS`, `CALENDAR_POLL_MINUTES`, `CXW_BACKUP_STAMP_FILE`, `CXW_ALERT_EMAIL_TO`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`. Any secret-looking value must use
the literal `CHANGEME` — `scripts/check-secrets.sh` blocks the commit otherwise.

**Bridge port discrepancy, resolved as above:** the task brief says 7801, `cxw.env.example` says 7411,
and the Phase-1 bridge plan says 8787. The derived default keeps the code honest to the brief while the
env file on the box (which sets `BRIDGE_HOST`/`BRIDGE_PORT`) stays the single source of truth.

**Bridge auth:** the Phase-1 plan puts a bearer token on `POST /send`. Send
`Authorization: Bearer ${BRIDGE_TOKEN}` when `BRIDGE_TOKEN` is set, and omit the header when it is not.

## 6. systemd unit already exists and is correct — do not rewrite it

`deploy/hetzner/systemd/cxw-scheduler.service` is a complete unit matching the style of the other units.
Its `ExecStart` is `/usr/bin/pnpm --filter @cxw/scheduler start`, so the package's `start` script is the
service entry point. Change that script to `tsx src/main.ts`. Touch the unit file only if a concrete
need appears (for example adding `EnvironmentFile=-/srv/cxw/google.env`); if you change it, say so in the
audit and keep the existing hardening block intact.

## 7. Starter routines — nine files, including the two memory ones

The task brief and `docs/IMPLEMENTATION_PLAN.md` section 3.6 both list the memory routines, which
plan.md deferred to Phase 6. Create all nine files in `vault/routines/`:

`morning-brief`, `evening-close`, `weekly-review`, `meeting-prep`, `inbox-digest`,
`memory-consolidate` (`0 2 * * *`), `memory-review` (`0 17 * * 0`), `followups`, `health-check`.

`memory-consolidate` and `memory-review` are ordinary `kind: llm` routines whose bodies drive the vault
MCP. They must not import or assume any Phase-6 code. `vault/routines/README.md` already fixes the
frontmatter contract — extend that README rather than contradicting it.

## 8. Repo conventions that will fail the build if ignored

- `tsconfig.base.json` is strict: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`, `isolatedModules`, NodeNext.
  Every relative import needs a `.js` suffix. `exactOptionalPropertyTypes` means an optional property
  must be omitted, not set to `undefined`.
- ESLint enforces `@typescript-eslint/consistent-type-imports` as an error: type-only imports must use
  `import type`. Unused args need a leading `_`. `no-console` is off.
- Prettier: single quotes, trailing comma `all`, print width 100, semicolons. Every new file must be
  prettier-clean. Do not reformat files you did not otherwise change — `format:check` already fails on
  seven pre-existing files and fixing those is out of scope for this phase.
- `vault/**` and `deploy/**` are excluded from both ESLint and Prettier.

## 9. Files touched — the contract for this phase

Modify (already done, listed for the reviewer's diff scope):

- `apps/scheduler/package.json`, `apps/brain/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`

Modify:

- `apps/scheduler/src/index.ts` (library exports), `apps/brain/src/index.ts` (re-export the command handler)
- `deploy/hetzner/cxw.env.example` (append the scheduler block)
- `vault/routines/README.md` (extend with the full frontmatter reference)

Create — `apps/scheduler/src/`: `main.ts`, `config.ts`, `log.ts`, `types.ts`, `routine.ts`, `schedule.ts`,
`db.ts`, `lease.ts`, `spool.ts`, `runs.ts`, `chunk.ts`, `deliver.ts`, `google.ts`, `prompt.ts`,
`calendar-trigger.ts`, `scheduler.ts`, `runner/brain.ts`, `runner/health.ts`, `runner/static.ts`

Create — `apps/scheduler/tests/`: `helpers.ts`, `routine.test.ts`, `schedule.test.ts`, `lease.test.ts`,
`spool.test.ts`, `chunk.test.ts`, `scheduler.test.ts`

Create — `apps/brain/src/commands/`: `routines.ts`, `schedule-phrase.ts`, `reminder.ts`
Create — `apps/brain/tests/`: `routine-commands.test.ts`, `schedule-phrase.test.ts`, `reminder.test.ts`

Create — docs and vault: `apps/scheduler/README.md`, `apps/brain/README.md`,
`vault/routines/{morning-brief,evening-close,weekly-review,meeting-prep,inbox-digest,memory-consolidate,memory-review,followups,health-check}.md`

Create — paper trail: `feature-research/phase-5-routines/audit.md`

Out of scope, unchanged: `packages/shared/**`, `apps/bridge/**`, `mcp/**`, root configs,
`.github/**`, `deploy/hetzner/*.sh`, the systemd units.

## 10. Acceptance

`corepack pnpm lint`, `corepack pnpm typecheck` and `corepack pnpm test` all green, and a test proves
`run weekly-review` works on demand end to end against the fakes. Node 22 via
`export PATH=$HOME/.nvm/versions/node/v22.23.2/bin:$PATH`. No network in tests; no Google or Anthropic
credentials required to run them.
