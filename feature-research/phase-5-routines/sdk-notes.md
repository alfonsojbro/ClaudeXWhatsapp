# Agent SDK notes (doc snapshot, 2026-09-03, from code.claude.com/docs/en/agent-sdk/typescript.md, mcp.md, agent-loop.md)

- `import { query } from "@anthropic-ai/claude-agent-sdk"`; `query({ prompt, options })` returns an async iterable of `SDKMessage`.
- Options of interest: `model`, `cwd`, `allowedTools`, `disallowedTools`, `permissionMode`, `maxTurns`, `maxBudgetUsd`, `settingSources`, `systemPrompt` (string, or preset form — verify exact shape in `sdk.d.ts`), `mcpServers` (record keyed by server name: `{type:'stdio'|'http'|'sse', command/args/env or url/headers}`), `effort`, `env`, `abortController`. Omit `resume`/`sessionId` for a fresh session.
- Allow all tools of one MCP server: `allowedTools: ["mcp__<server>__*"]` (wildcard). Bare `mcp__<server>` is not documented as sufficient.
- `.mcp.json` in `cwd` loads automatically when `settingSources` includes `"project"`; the documented default when omitted is `["user","project","local"]`. To control exactly which servers start, pass `mcpServers` explicitly and set `settingSources: []` (then `CLAUDE.md` is not auto-loaded: pass its text via `systemPrompt` preset/append).
- Headless permission modes: `"dontAsk"` (unlisted tools are denied, no prompt) — preferred; `"bypassPermissions"` needs `allowDangerouslySkipPermissions: true`.
- Result message: `type:'result'`, `subtype: 'success' | 'error_max_turns' | 'error_max_budget_usd' | 'error_during_execution' | 'error_max_structured_output_retries'`; on success `result` (string); always `total_cost_usd`, `usage`, `num_turns`, `duration_ms`, `session_id`, `is_error`.
- Assistant messages: `type:'assistant'`, `message.content` = text + tool_use blocks.
- Auth: `ANTHROPIC_API_KEY` from process env. `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) is honoured by the bundled Claude Code binary; the guide flagged that MCP behaviour under OAuth should be verified on the box (plan section 3.2 already says to verify subscription terms).
- Package `@anthropic-ai/claude-agent-sdk` 0.3.x, Node 18+.
