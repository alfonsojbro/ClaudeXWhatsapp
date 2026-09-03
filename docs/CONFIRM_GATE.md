# The confirm gate

Contract between the tools that mint pending actions (`mcp/google`, later `mcp/whatsapp`)
and the brain that routes the owner's reply (Phase 2). Implementation:
`packages/shared/src/confirm.ts`.

## Why it is a file, not a variable

The brain and every MCP server are separate processes. The store is therefore a
directory of JSON files, one per pending action, that all of them open.

- Directory: `CXW_CONFIRM_DIR`, default `${CXW_STATE_DIR:-./state}/confirm`
  (on the box: `/srv/cxw/state/confirm`).
- The directory is created `0700`, each file is written `0600` through a temp file
  plus `rename`, so a half-written action is never read.
- File name: `<TOKEN>.json`. The token is validated against `TOKEN_RE` before any
  path is built, so a token from a message can never escape the directory.

## File format

```json
{
  "token": "AB3D9K",
  "kind": "gmail_send",
  "preview": "📧 Send email\nTo: ana@example.com\nSubject: Invoice\n\n…",
  "payload": { "to": ["ana@example.com"], "subject": "Invoice", "body": "…" },
  "source": "mcp-google",
  "createdAt": "2026-09-04T09:00:00.000Z",
  "expiresAt": "2026-09-04T09:10:00.000Z"
}
```

- `token`: 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no `0`, `O`, `1`, `I`,
  because it is typed back on a phone).
- TTL: 10 minutes (`CONFIRM_TTL_MS`). `peek` and `take` delete an expired file and
  return `null`.
- `take()` claims the file with an atomic `rename` first, so a token is consumed
  exactly once even if two processes race.

## The invariant

**The tool executes `payload`, never the arguments supplied together with the token.**

That is the whole point. The preview the owner approved and the bytes that go out have
to be the same thing; otherwise an injected instruction could change the recipient
between the preview and the send.

## Gated tools

| Tool                    | `kind`                  | Gated when                                                |
| ----------------------- | ----------------------- | --------------------------------------------------------- |
| `gmail_send`            | `gmail_send`            | always                                                    |
| `calendar_create_event` | `calendar_create_event` | an attendee is not the owner                              |
| `calendar_update_event` | `calendar_update_event` | the event has, or gains, an attendee who is not the owner |

`gmail_draft`, `gmail_label` and `gmail_archive` are not gated: nothing leaves the
mailbox and everything is reversible.

## What the brain has to do (Phase 2)

1. Every inbound owner message goes through `parseConfirmReply(text)` **before** the
   model sees it. It returns `{ verb: 'yes' | 'no', token }` or `null`.
   Accepted: `yes|y|ok|okay|confirm|si|sí|send` and `no|n|cancel|abort|stop`, any case,
   trailing punctuation tolerated, whole message only.
2. On `no <TOKEN>`: call `ConfirmStore.cancel(token)` and reply "cancelled". Do not
   involve the model.
3. On `yes <TOKEN>`: `ConfirmStore.peek(token)` tells you the `kind` and the preview.
   Pass the message to the session with the instruction to call that tool once with
   `confirm_token: <TOKEN>` and no other arguments. The tool does the `take()`.
   If `peek` returns `null`, reply that the request expired and ask for a new preview.
4. Never let the model mint or guess a token. The only source of a token is a tool
   preview; the only authority to use it is the owner's own message.
5. A sweep on start-up (`ConfirmStore.sweep()`) keeps the directory tidy.

## Owner-facing wording

`formatConfirmPrompt(action)` renders:

```
<preview>

Reply `yes AB3D9K` within 10 min to go ahead, or `no AB3D9K` to cancel.
```
