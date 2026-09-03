# ADR 0001 — Google Workspace MCP: reuse `taylorwilsdon/google_workspace_mcp` or write our own?

**Status:** accepted · **Date:** 2026-09-03 · **Phase:** 4 · **Decides:** open question 3 of the implementation plan

## Context

Phase 4 needs Gmail, Calendar and Contacts tools for the brain, running headless on the Hetzner box
with a refresh token obtained once on the Mac. `gmail_send` and calendar writes with third-party
attendees must go through the owner confirm gate (plan §3.2). The plan allowed a one-hour spike on an
existing server before writing our own.

## Spike (1 h, 2026-09-03)

Candidate: `workspace-mcp` 1.25.2 on PyPI (`taylorwilsdon/google_workspace_mcp`, Python ≥3.10,
launched with `uvx workspace-mcp`, 94 packages).

What was verified:

- **Runs over stdio** with `--transport stdio --single-user --tools gmail calendar contacts --tool-tier core`.
  `initialize` and `tools/list` answered; `serverInfo.name = google_workspace`, version 4.0.2.
- **Credential storage:** one JSON file per account in `WORKSPACE_MCP_CREDENTIALS_DIR`
  (`<email>.json`: `token, refresh_token, token_uri, client_id, client_secret, scopes, expiry`).
  `MCP_SINGLE_USER_MODE=1` bypasses session mapping and picks up that file. The code refreshes an
  expired access token with the stored refresh token without a browser
  (`credentials.refresh(Request())`), so a pre-seeded file is a plausible headless path.
- **Tool surface (core tier):** `search_gmail_messages`, `get_gmail_message_content`,
  `get_gmail_messages_content_batch`, `send_gmail_message`, `list_calendars`, `get_events`,
  `manage_event`, `list_contacts`, `get_contact`, `search_contacts`, `manage_contact`.

What failed or does not fit:

1. **No confirm gate.** `send_gmail_message` and `manage_event` send immediately. Gating would have to
   live outside the tool (brain `PreToolUse` interception) and the preview + token would be invented
   by the brain from tool arguments, against plan §3.2 ("the tool returns a preview and a token; nothing
   else can mint tokens"). Phase 7's security pass also greps `mcp/` for `confirm_token` in every send tool.
2. **Headless verification incomplete.** With a seeded credential file whose refresh token is invalid
   the first tool call fell back to the interactive flow: it tried to open a browser and returned an
   authorization URL with a `localhost:8000` redirect. With a *valid* token this path is not taken, but
   the fallback means a token problem on the box degrades into a hang waiting for a browser instead of
   a clean error the health monitor can act on.
3. **Scopes are the server's, not ours.** It requests ~14 scopes (readonly + modify + compose + send +
   labels + settings + contacts write + userinfo + openid). The plan wants exactly
   `gmail.modify`, `calendar`, `contacts.readonly`.
4. **Second runtime on the box.** Python + `uv` next to Node 22, a second set of updates to track, and
   the credential file format is theirs (a refresh-token rotation writes back to disk in their schema).
5. **Tool names differ** from the plan (`gmail_search`, `calendar_list_events`, …) and the routines in
   Phase 5 are written against the plan's names.

## Decision

Write a thin MCP server in `mcp/google` with `@modelcontextprotocol/sdk` + `googleapis` (TypeScript,
same runtime as everything else). ~11 tools, exactly the three scopes, refresh token from
`/srv/cxw/google.env`, confirm gate built into `gmail_send`, `calendar_create_event` and
`calendar_update_event` via the shared `ConfirmStore`. A `google_token_check` (CLI + tool) exists for
the health monitor and fails loudly instead of opening a browser.

## Consequences

- Own code to maintain (~1,200 lines incl. tests) instead of a dependency. Acceptable: the surface is
  small and pinned to three Google APIs.
- No Drive/Docs/Sheets for now. Adding Drive/Tasks later means new scopes → re-run `pnpm google:auth`.
- The external server remains a fallback: seed `WORKSPACE_MCP_CREDENTIALS_DIR/<email>.json` from
  `google.env` and run `uvx workspace-mcp --single-user --transport stdio`, gating sends in the brain.
