# @cxw/mcp-google

A thin MCP server over `googleapis`: Gmail, Calendar and Contacts for one owner,
with the confirm gate built into the tools that can reach other people.
Decision record: [`docs/adr/0001-google-mcp.md`](../../docs/adr/0001-google-mcp.md).

Runs on stdio. **stdout is the protocol channel** — every log line goes to stderr.

## Tools

| Tool                    | Arguments                                                                                                                                                     | Gated                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `gmail_search`          | `q`, `from`, `to`, `subject`, `text`, `after`, `before`, `newer_than_days`, `unread`, `label`, `has_attachment`, `in_inbox`, `max_results` (1–50, default 10) | no                                               |
| `gmail_read`            | `id`, `max_chars` (default 20000)                                                                                                                             | no                                               |
| `gmail_draft`           | `to[]`, `subject`, `body`, `cc[]`, `bcc[]`, `reply_to_message_id`                                                                                             | no                                               |
| `gmail_send`            | same as draft, plus `confirm_token`                                                                                                                           | **yes**                                          |
| `gmail_label`           | `id`, `add[]`, `remove[]`                                                                                                                                     | no                                               |
| `gmail_archive`         | `id`                                                                                                                                                          | no                                               |
| `calendar_list_events`  | `day` (`today`/`tomorrow`/`yesterday`/`YYYY-MM-DD`), `time_min`, `time_max`, `calendar_id`, `q`, `include_description`, `max_results`                         | no                                               |
| `calendar_freebusy`     | `time_min`, `time_max`, `calendar_ids[]`                                                                                                                      | no                                               |
| `calendar_create_event` | `summary`, `start`, `end`, `all_day`, `attendees[]`, `description`, `location`, `calendar_id`, `confirm_token`                                                | **when an attendee is not the owner**            |
| `calendar_update_event` | `event_id`, plus the same fields, `confirm_token`                                                                                                             | **when the event has or gains such an attendee** |
| `contacts_lookup`       | `query`, `max_results` (default 10)                                                                                                                           | no                                               |
| `google_token_check`    | —                                                                                                                                                             | no                                               |

On the three gated tools every argument is optional in the JSON schema, because the
confirming call carries `confirm_token` and nothing else. `gmail_send` requires `body`,
`calendar_create_event` requires `summary`/`start`/`end` and `calendar_update_event`
requires `event_id` — but only on the first, tokenless call, checked inside the handler.

Every handler returns text. Failures come back as `isError: true` with the Google
message; nothing throws out of a tool. Third-party text — message headers and snippets,
bodies, event summaries, locations and attendee lists, contact names and job titles — is
wrapped in `<<<UNTRUSTED … >>>` markers. Ids and labels the model has to quote back stay
outside the markers.

## Environment

| Variable                            | Meaning                                                     |
| ----------------------------------- | ----------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`                  | OAuth desktop client id                                     |
| `GOOGLE_CLIENT_SECRET`              | OAuth desktop client secret                                 |
| `GOOGLE_REFRESH_TOKEN`              | from `pnpm google:auth`                                     |
| `GOOGLE_OWNER_EMAIL`                | the owner's address: `From` on sends, and the attendee rule |
| `GOOGLE_TOKEN_URL`                  | optional, default `https://oauth2.googleapis.com/token`     |
| `CXW_CONFIRM_DIR` / `CXW_STATE_DIR` | confirm store location, default `./state/confirm`           |
| `CXW_TZ` / `TZ`                     | owner timezone, default `Europe/Prague`                     |

Scopes: `gmail.modify`, `calendar`, `contacts.readonly` — nothing else.

## How the gate works

```
model → gmail_send { to, subject, body }            (no confirm_token)
          │
          ├─ builds the payload, resolves reply headers
          ├─ ConfirmStore.mint → state/confirm/AB3D9K.json   (0600)
          └─ returns preview + "confirm_token: AB3D9K"       ← nothing is sent

owner → "yes AB3D9K"        (the brain routes it; see docs/CONFIRM_GATE.md)

model → gmail_send { confirm_token: "AB3D9K" }
          │
          ├─ ConfirmStore.take → consumes the file exactly once
          ├─ kind must be gmail_send, otherwise error
          └─ sends THE STORED PAYLOAD; any other argument is ignored
```

The last line is the security property: the bytes the owner approved are the bytes
that go out, so an instruction hidden in an email cannot swap the recipient between
the preview and the send.

## Commands

```bash
pnpm google:auth --client-secret ~/Downloads/client_secret_*.json   # once, on the Mac
pnpm --filter @cxw/mcp-google token-check [--quiet]                 # 0 ok / 1 dead / 2 no env
pnpm --filter @cxw/mcp-google start                                 # stdio MCP server
pnpm --filter @cxw/mcp-google typecheck
pnpm --filter @cxw/mcp-google test
```

Tests are colocated (`src/**/*.test.ts`) and fully offline: the Google clients and
`fetch` are mocked, and the confirm store runs on a temp directory.
