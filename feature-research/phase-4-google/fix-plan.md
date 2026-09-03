# Fix plan — Phase 4 review round 1

Branch: `phase-4-google`. Worktree: `/Users/alfonsobriceno/ClaudeXWhatsapp-phase-4-google` (work ONLY here).
This is a follow-up to `plan.md` after the reviewer's pass. Implement exactly these items.
Node 22: `export PATH=$HOME/.nvm/versions/node/v22.23.2/bin:$PATH`.

## Files touched (complete list — the contract)

- `mcp/google/src/calendar/tools.ts` (F1, F2)
- `mcp/google/src/calendar/tools.test.ts` (tests for F1, F2)
- `mcp/google/src/calendar/range.ts` (F2 helper, only if a helper is needed)
- `mcp/google/src/calendar/range.test.ts` (F2 helper tests)
- `mcp/google/src/gmail/tools.ts` (F3)
- `mcp/google/src/gmail/tools.test.ts` (tests for F3)
- `mcp/google/src/gmail/query.ts` (F4)
- `mcp/google/src/gmail/query.test.ts` (tests for F4)
- `mcp/google/src/contacts/tools.ts` (F3)
- `mcp/google/src/contacts/tools.test.ts` (tests for F3)
- `packages/shared/src/index.ts` (F5)
- `workspace/.mcp.json` (F6)
- `workspace/CLAUDE.md` (F7)
- `mcp/google/README.md` (only if a tool's documented arguments change)
- `feature-research/phase-4-google/audit.md` (update; see F8)

Anything else is out of scope. Do NOT touch `vitest.config.ts` — the orchestrator already fixed it
and verified the fix; the audit's claim about it is resolved.

## F1 (BLOCKING). Calendar confirm calls are rejected before the handler

`docs/CONFIRM_GATE.md` tells the brain to call a gated tool with `confirm_token` **and no other
arguments**. But `createEventShape` marks `summary`, `start`, `end` required
(`calendar/tools.ts:39-41`) and `updateEventShape` marks `event_id` required (line 54). The MCP SDK
validates `inputSchema` before the handler runs, so the confirming call fails with
`InvalidParams` and the event is never created. The pending action is left unconsumed.

Fix: make `summary`, `start`, `end` and `event_id` **optional** in the two zod shapes, then validate
them inside the no-token branch of each handler and return a normal tool error when missing —
exactly the pattern `gmail_send` already uses for `body`. The token branch must keep reading
`action.payload` only.

Tests: for both `calendar_create_event` and `calendar_update_event`, a confirming call carrying
**only** `{ confirm_token }` must reach the handler and insert/patch the stored payload. Also assert
the no-token call still errors cleanly when a required field is missing, without minting anything.

## F2 (should-fix). Naive datetimes are parsed in the process timezone

`calendar/tools.ts:92-94` does `new Date(value).toISOString()` and also sets `timeZone: tz`. A
model-supplied `"2026-09-04T14:00:00"` with no offset is parsed as **process-local** time, and
because the result then carries `Z`, Google ignores the `timeZone` field. So "book 14:00 tomorrow"
lands at the wrong instant whenever `CXW_TZ` differs from the process `TZ`, or `TZ` is unset
(systemd defaults to UTC).

Fix: if the value has no UTC offset and no trailing `Z`, pass it through unchanged as
`{ dateTime: value, timeZone: tz }` and let Google resolve it in the owner's zone. Only normalize
through `Date` when an explicit offset is present. Keep `all_day` handling as it is.

Tests: a naive `"2026-09-04T14:00:00"` produces `{ dateTime: '2026-09-04T14:00:00', timeZone: tz }`
with no `Z`, and the assertion must hold under at least two different `process.env.TZ` values so a
regression cannot hide. A value with an explicit offset keeps its instant.

## F3 (should-fix). Attacker-controlled short strings escape the untrusted fence

Only bodies, snippets and event descriptions are fenced today. These are not, and a subject line is
a fine injection carrier:

- `gmail/tools.ts:219-222` — `From:` and `Subject:` in search results
- `gmail/tools.ts:235-246` — the `gmail_read` header block
- `calendar/tools.ts:138-147` — event `summary`, `location`, attendee addresses
- `contacts/tools.ts:60-67` — contact display names and organisation titles

Fix: wrap the whole per-item rendered block in the existing `untrusted(...)` helper rather than only
the snippet or description, using the label already used for that surface. Do not fence the tool's
own framing text (counts, ids the model needs to pass back, "No results" lines) — only third-party
content. Keep output compact; do not nest one fence inside another.

Tests: for each of the four surfaces, a fixture whose subject/summary/display name contains the
literal text `IGNORE PREVIOUS INSTRUCTIONS` must come back inside the fence markers.

## F4 (should-fix). `encodeHeaderValue` corrupts non-plain addresses

`gmail/query.ts:116-120` runs `encodeHeaderValue` over each whole entry of `to`/`cc`/`bcc` and over
`from`. For `Name <addr@x>` with a non-ASCII display name it emits one RFC 2047 encoded-word
covering the angle brackets, producing an unparseable `To:` and a Gmail 400 **after** the owner has
already confirmed the send. The zod `email` type at `gmail/tools.ts:19` is only
`z.string().trim().min(3)`, so that form is accepted today.

Fix: encode only the display-name part, leaving the `<addr>` untouched. Keep the existing `\r`/`\n`
header-injection rejection on the whole value.

Tests: `Ana Ramírez <ana@example.com>` yields an encoded display name with a bare, unencoded
`<ana@example.com>`; a plain `ana@example.com` is unchanged; the CRLF injection guard still throws.

## F5 (nit). Gratuitous reflow in a file three other phases also edit

`packages/shared/src/index.ts:9-10` — the `ServiceName` union got reflowed onto one line as a
prettier side effect. Phases 2, 5 and 7 all add exports here. Restore the original line breaks and
keep only the intended addition, `export * from './confirm.js';`.

## F6 (nit). `workspace/.mcp.json` should launch pnpm with `--silent`

stdout is the MCP protocol channel. Add `--silent` to the `pnpm` args so no lifecycle output can
ever reach it.

## F7 (nit). Tell the model the send preview is truncated

`gmail/tools.ts` truncates the preview body at 800 characters with a visible marker. Add one line to
the `workspace/CLAUDE.md` confirm-gate section telling the model to say so when the marker is
present, so the owner knows they are approving more text than they can see.

## Deliberately NOT doing in this pass

Reviewer items 6, 7, 8 and 12 (the `mint` zero-byte window, `source`/payload validation on `take`,
the OAuth loopback `state` and timeout, and `TRASH`/`SPAM` reachable from ungated `gmail_label`).
All are defence-in-depth on an already-compromised host or a one-shot manual script. They are
recorded here and belong to Phase 7's security sweep. Do not implement them now.

## F8. Update the audit

Rewrite the "Open risks" section of `feature-research/phase-4-google/audit.md`: the vitest claim is
**wrong and resolved** (each package's vitest discovers the root config by walking up, which is why
the base `include: ['tests/**/*.test.ts']` matched nothing from a package dir; the orchestrator
added `'src/**/*.test.ts'` and 131 tests now run). Record F1–F7 as done.

## Gates (must pass)

```
export PATH=$HOME/.nvm/versions/node/v22.23.2/bin:$PATH
pnpm --filter @cxw/shared --filter @cxw/mcp-google typecheck
pnpm --filter @cxw/shared --filter @cxw/mcp-google test
pnpm lint
pnpm format:check
```

`format:check` currently reports 6 pre-existing failures owned by other phases
(`docs/IMPLEMENTATION_PLAN.md`, the phase 1/3/5 plans, root `tsconfig.json`). Leave those alone; the
count must not grow. Format only files you touch, by explicit path.

Re-run the stdio smoke test and confirm all 12 tools still register. No git commits.
