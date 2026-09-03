# Plan — Phase 0 skeleton + Phase 1 bridge (`phase-1-bridge`)

Source of truth: `docs/IMPLEMENTATION_PLAN.md` sections 2, 3.1, 4, 5, 6. Everything is written from scratch in this repo. Do not copy code from any other project on this machine.

## Goal
A Baileys bridge with a SQLite/FTS5 store, owner allowlist, media download, local HTTP API, echo mode, plus an MCP server over the store, so that "ping" in the self-chat returns "pong" and `search_messages` finds old chats.

## Environment facts (verified 2026-09-03)
- Local Mac: Node **20.19.6**. Box: Node 22. No global pnpm; use **`corepack pnpm`** (do NOT run `corepack enable`, do not install globally). pnpm 10.34.5.
- Pins (exact versions, no caret): `@whiskeysockets/baileys@6.7.24` (dist-tag `legacy`, the stable line; 7.x is still rc), `better-sqlite3@12.11.1` (13.x needs Node ≥22; 12.x supports 20–26), `@modelcontextprotocol/sdk@1.30.0`, `pino@10.3.1`, `pino-pretty@13.1.3`, `zod@4.5.4`, `vitest@4.1.11`, `tsx@4.23.13`, `typescript@7.0.2` (if 7.x causes trouble, pin `5.9.x`), `qrcode-terminal@0.12.0`, `@types/better-sqlite3` latest, `@types/node@20`.
- pnpm 10 blocks postinstall builds by default: add `onlyBuiltDependencies: [better-sqlite3]` in `pnpm-workspace.yaml`.
- No build step in v1: every package runs from TS source with `tsx`. `"type": "module"`, tsconfig `module: ESNext`, `moduleResolution: Bundler`, `strict: true`, `target: ES2022`. Workspace packages point `main`/`types` at `src/index.ts`.
- Baileys 6.7.24 is CJS. Prefer the named export `import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage, jidNormalizedUser, isJidGroup, isJidBroadcast, isJidStatusBroadcast, proto, type WAMessage } from '@whiskeysockets/baileys'`. Verify against `node_modules/@whiskeysockets/baileys/lib/index.d.ts` after install; if `makeWASocket` is default-only, use `import baileys from ...; const makeWASocket = (baileys as any).default ?? baileys`.

## Git
1. `git init -b main` in the repo root. Commit the Phase 0 skeleton as `chore: phase 0 repo skeleton`.
2. `git checkout -b phase-1-bridge`. All Phase 1 work is committed on this branch at the end of the implementation as `feat: phase 1 bridge, store, MCP server, echo mode`.
3. Never commit `config/owners.json`, `data/`, `*.env`.

## Files touched (create unless marked "modify")

Root / Phase 0
- `package.json` (name `claudexwhatsapp`, private, `packageManager: "pnpm@10.34.5"`, engines node ≥20, scripts: `test` = `vitest run`, `typecheck` = `tsc -b` or per-package `pnpm -r typecheck`, `bridge` = `pnpm --filter @cxw/bridge dev`, `pair` = `pnpm --filter @cxw/bridge pair`, `mcp:whatsapp` = `pnpm --filter @cxw/mcp-whatsapp start`; devDeps: vitest, typescript, tsx, @types/node, @types/better-sqlite3, better-sqlite3 (for tests), and `@cxw/shared`, `@cxw/bridge`, `@cxw/mcp-whatsapp` as `workspace:*`)
- `pnpm-workspace.yaml` (`packages: [apps/*, mcp/*, packages/*]`, `onlyBuiltDependencies: [better-sqlite3]`)
- `tsconfig.base.json`, `tsconfig.json` (root, for tests)
- `vitest.config.ts` (include `tests/**/*.test.ts`; `resolve.alias` `@cxw/shared` → `packages/shared/src/index.ts`, `@cxw/bridge` → `apps/bridge/src/index.ts`, `@cxw/mcp-whatsapp` → `mcp/whatsapp/src/index.ts`)
- `.gitignore` (node_modules, data/, dist/, `*.env`, `.env`, `config/owners.json`, `*.sqlite*`, `.DS_Store`)
- `.env.example`
- `.npmrc` (only if needed; otherwise omit)
- `config/owners.example.json` → `{ "owners": ["4207XXXXXXXX"] }` with a comment-free schema note in RUNBOOK
- `README.md` (modify: short "how to run" pointer to RUNBOOK)
- `docs/RUNBOOK.md` (pairing steps, env vars, commands, re-pair procedure, echo test, MCP wiring)
- `.github/workflows/ci.yml` (pnpm install + typecheck + test on Node 22) — small

`packages/shared` (`@cxw/shared`)
- `packages/shared/package.json`, `packages/shared/tsconfig.json`
- `packages/shared/src/index.ts` (re-exports)
- `packages/shared/src/config.ts` — zod env loader `loadConfig(env = process.env)`:
  `DATA_DIR` (default `./data`, resolved absolute), `DB_PATH` (default `<DATA_DIR>/bridge.sqlite`), `OWNERS_FILE` (default `./config/owners.json`), `BRIDGE_HOST` (default `127.0.0.1`; refuse anything that is not a loopback address), `BRIDGE_PORT` (default 8787), `BRIDGE_TOKEN` (required, min 16 chars), `BRAIN_INBOUND_URL` (optional URL; when unset, inbound events are only logged / handled by echo), `ECHO_MODE` (`1`/`true` → true), `SEND_MIN_INTERVAL_MS` (default 2000), `SEND_DAILY_CAP` (default 200, required-ish: keep the default but log it at startup), `MEDIA_RETENTION_DAYS_OTHERS` (default 90), `MEDIA_RETENTION_DAYS_OWNER` (default 0 = forever), `LOG_LEVEL` (default `info`), `PAIRING_PHONE` (optional digits, used by pairing-code login), `WA_BROWSER_NAME` (default `ClaudeXWhatsapp`).
- `packages/shared/src/logger.ts` — `createLogger({ level, name })` with pino. At `info` and above, redact: `jid`, `sender`, `chatJid`, `senderJid`, `remoteJid`, `participant`, `phone`, `text`, `body`, `caption`, and the same keys one level nested (`*.jid`, `*.text`, …) using pino `redact` with `censor: '[redacted]'`. At `debug`/`trace`, no redaction. Export `maskJid(jid)` → keeps server and last 3 digits of the user part (`…789@s.whatsapp.net`) for use in human-readable log lines.
- `packages/shared/src/chunker.ts` — `chunkText(text, max = 3500): string[]`. Split on blank lines first, then single newlines, then whitespace, then hard cut. Trim chunks, drop empties, never exceed `max`, preserve order. Empty input → `[]`.
- `packages/shared/src/pacing.ts` — `class SendPacer { constructor(opts: { minIntervalMs; dailyCap; now?: () => number; sleep?: (ms) => Promise<void> }) ; tryAcquire(): { ok: true } | { ok: false; reason: 'wait'; waitMs } | { ok: false; reason: 'daily-cap' }; acquire(): Promise<void> (waits for the interval, throws DailyCapExceededError); stats(): { sentToday, dayKey, lastSentAt } }`. Day key = UTC `YYYY-MM-DD`; counter resets on rollover. `acquire()` must serialize concurrent callers (simple promise chain / mutex) so two callers cannot both pass the interval check.
- `packages/shared/src/allowlist.ts` — `loadOwners(path): string[]` reads `{ owners: string[] }`, each must match `/^\d{6,15}$/`, throws a clear error otherwise; empty list allowed but logged as a warning by the caller. `class OwnerAllowlist { constructor(numbers: string[]); has(number): boolean; isOwnerJid(jid): boolean; }` where `isOwnerJid` returns true only for `<digits>[:device]@s.whatsapp.net` with the digits in the set. `@g.us`, `@broadcast`, `status@broadcast`, `@lid`, `@newsletter` → always false. Also export `classifyInbound({ remoteJid, fromMe, participant, selfJid }, allowlist): { isOwnerCommand: boolean; senderJid: string; isSelfChat: boolean }`: group/broadcast → false; sender = participant ?? (fromMe ? selfJid : remoteJid); `isOwnerCommand` = `allowlist.isOwnerJid(remoteJid) && allowlist.isOwnerJid(sender)`; `isSelfChat` = normalized(remoteJid) === normalized(selfJid). Normalization strips the `:device` suffix. (An owner's outgoing message to a non-owner chat is therefore never a command.)
- `packages/shared/src/types.ts` — zod schemas + types: `InboundEvent` `{ type: 'message'; chatJid; senderJid; isSelfChat; fromMe; msgId; ts (unix seconds); msgType; text; quotedId?; mediaPath?; mime? }`, `SendRequest` `{ jid; text?; mediaPath?; caption?; confirmToken? }` (exactly one of text/mediaPath), `SendResponse` `{ ok: true; ids: string[] } | { ok: false; error: string }`, `HealthResponse`.
- `packages/shared/src/confirm.ts` — `class ConfirmTokenStore { mint(jid, preview, ttlMs = 10*60*1000): string (6 upper-case alnum chars, no ambiguous chars); consume(token, jid): boolean (single use, checks jid + expiry); peek(token) }`. Phase 1: exists and is tested, nothing calls `mint` in production paths. Note in a comment that the brain's confirm gate (Phase 2) is the only minter.

`apps/bridge` (`@cxw/bridge`)
- `apps/bridge/package.json` (deps: @cxw/shared, @whiskeysockets/baileys, better-sqlite3, pino, pino-pretty, qrcode-terminal, zod; scripts `dev`/`start` = `tsx src/main.ts`, `pair` = `tsx src/pair.ts`, `typecheck` = `tsc --noEmit`), `apps/bridge/tsconfig.json`
- `apps/bridge/src/index.ts` — library exports (store, migrate, normalizeMessage, gate, echo, http server factory) for tests and the MCP package; no side effects.
- `apps/bridge/src/main.ts` — process entry: load config, logger, owners, store (+migrate), pacer, confirm store, WA client, HTTP server, media purge timer (startup + every 6 h), graceful shutdown on SIGINT/SIGTERM.
- `apps/bridge/src/pair.ts` — pairing entry: same client; prints QR in terminal (qrcode-terminal, `small: true`) or, when `--code` / `PAIRING_PHONE` is set and creds are not registered, requests a pairing code via `sock.requestPairingCode(phone)` and prints it. Exits 0 after `connection === 'open'` and creds saved; exits 1 on `loggedOut`.
- `apps/bridge/src/db/migrations/001_init.sql` — tables:
  `schema_migrations(id TEXT PK, applied_at INT)`;
  `chats(jid TEXT PK, name TEXT, is_group INT NOT NULL DEFAULT 0, last_ts INT, unread INT DEFAULT 0, archived INT DEFAULT 0, updated_at INT)`;
  `contacts(jid TEXT PK, name TEXT, notify TEXT, phone TEXT, updated_at INT)`;
  `messages(jid TEXT NOT NULL, id TEXT NOT NULL, ts INT NOT NULL, from_me INT NOT NULL, sender TEXT, type TEXT NOT NULL, text TEXT, quoted_id TEXT, media_path TEXT, mime TEXT, origin TEXT NOT NULL DEFAULT 'wa' /* 'wa' | 'bridge' */, raw TEXT /* JSON of the WAMessage, needed for lazy media download */, PRIMARY KEY (jid, id))` + index on `(jid, ts)` and `(ts)`;
  `media(jid TEXT, msg_id TEXT, path TEXT NOT NULL, mime TEXT, size INT, downloaded_at INT NOT NULL, PRIMARY KEY (jid, msg_id))`;
  `messages_fts` = `CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2')` with the three standard external-content triggers (ai/ad/au). `PRAGMA journal_mode=WAL` is set by `openStore`, not in the migration.
- `apps/bridge/src/db/migrate.ts` — reads `migrations/*.sql` sorted by filename, applies each once inside a transaction, records in `schema_migrations`. Resolve the directory relative to the module (`import.meta.url`), so it works from tests and from tsx.
- `apps/bridge/src/db/store.ts` — `openStore(path | ':memory:')` → `Store` (better-sqlite3, WAL, `foreign_keys` on, runs migrate). Methods, all synchronous prepared statements:
  `upsertChat`, `upsertContact`, `insertMessage(msg): boolean` (INSERT OR IGNORE on (jid,id); returns whether inserted), `insertMessages(batch)` in one transaction, `getMessage(jid, id)`, `getMessageRaw(jid, id)`, `setMediaPath(jid, id, path, mime, size)`, `listChats({ limit = 50, since? })` (ordered by last_ts desc, joins contact name), `getChat(jid, { since?, limit = 50 })` (messages, newest last), `searchMessages(query, { jid?, since?, limit = 20 })` (FTS5 MATCH, `bm25` order; sanitize the query by splitting on whitespace and double-quoting each term, join with space (implicit AND); catch FTS syntax errors and return `[]`), `getContact(jidOrPhone)`, `listMediaOlderThan(ts, { ownerJids, includeOwners })`, `deleteMediaRow`, `markBridgeSent(jid, id)`, `close()`.
- `apps/bridge/src/wa/normalize.ts` — pure `normalizeMessage(m: WAMessage, selfJid): NormalizedMessage | null`. Unwrap `ephemeralMessage`, `viewOnceMessage(V2)`, `documentWithCaptionMessage`. Map: `conversation` / `extendedTextMessage.text` → `text`; image/video/document/audio/sticker → `type` + caption as `text` + `mime` + `hasMedia`; `audioMessage.ptt` → type `voice`; `reactionMessage`, `protocolMessage`, `senderKeyDistributionMessage` → `null` (skip). `quotedId` from `contextInfo.stanzaId`. `ts` = `messageTimestamp` (Long or number → number). `id` = `key.id`, `jid` = `key.remoteJid`, `sender` = `key.participant ?? (fromMe ? selfJid : remoteJid)`, all via `jidNormalizedUser`.
- `apps/bridge/src/wa/client.ts` — `createWaClient({ config, logger, store, onMessage })`:
  `useMultiFileAuthState(<DATA_DIR>/session)`; `fetchLatestBaileysVersion()`; `makeWASocket({ version, auth, logger: pino child at 'warn' (silent in tests), printQRInTerminal: false, syncFullHistory: true, markOnlineOnConnect: false, browser: [WA_BROWSER_NAME, 'Chrome', '1.0.0'], generateHighQualityLinkPreview: false, getMessage: (key) => store.getMessageRaw(...) })`.
  Events: `creds.update` → save; `connection.update`: `qr` → emit to a `onQr` callback (pair.ts prints it; main.ts prints it too, with a log line telling the operator to run `pnpm pair`); `close` → if `DisconnectReason.loggedOut` → log FATAL "session logged out; delete DATA_DIR/session and re-pair" and stop (never delete the session, never call `logout()`), else reconnect with exponential backoff 1 s → 60 s (+jitter), reset on `open`; `open` → set `selfJid = jidNormalizedUser(sock.user.id)`, log masked. `messaging-history.set` → batch upsert chats/contacts/messages (normalize each; `origin='wa'`); `messages.upsert` (`type === 'notify'` and `'append'`) → normalize, insert, then if the id is in the bridge-sent set or `origin='bridge'` skip events; else `classifyInbound`; if owner command → download media eagerly, build `InboundEvent`, call `onMessage`; for non-owner chats: store only, no media download. `chats.upsert/update`, `contacts.upsert/update` → store. Expose `{ sendText(jid, text): Promise<string id>, sendMedia(jid, path, caption?), markRead(jid, ids[]), downloadMedia(jid, id), isConnected(), selfJid, stop() }`. After every `sock.sendMessage`, add the returned `key.id` to an in-memory `Set` (bounded, e.g. last 1000) and `store.markBridgeSent`.
- `apps/bridge/src/media.ts` — `mediaPathFor(dataDir, jid, msgId, mime)` → `<DATA_DIR>/media/<jid>/<msgId>.<ext>` (ext from a small mime map: jpeg→jpg, png, webp, mp4, ogg (audio/ogg; codecs=opus → ogg), mpeg→mp3, pdf, else from mime subtype, fallback `bin`; sanitize jid for the filesystem). `downloadMessageMedia(sock, rawMessage, target)` uses `downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })`, writes the file, returns `{ path, size }`. `purgeExpiredMedia(store, { ownerJids, ownerDays, othersDays, now })` deletes files + rows past retention (0 = keep forever).
- `apps/bridge/src/gate.ts` — `checkSendAllowed({ jid, confirmToken }, allowlist, confirmStore): { ok: true } | { ok: false; status: 403; error }`: owner jid → ok; group or non-owner without token → `confirm_token required for non-owner recipient`; with token → `confirmStore.consume(token, jid)` else `invalid or expired confirm_token`. Phase 1 never mints, so all non-owner sends are refused; comment this.
- `apps/bridge/src/echo.ts` — `makeEchoHandler({ enabled, send })` → `(event) => Promise<void>`: when enabled and `event.isSelfChat` and `event.text.trim().toLowerCase() === 'ping'` → `send(event.chatJid, 'pong')`.
- `apps/bridge/src/inbound.ts` — `InboundBus`: `publish(event)` → runs local handlers (echo) and, if `BRAIN_INBOUND_URL` is set, `POST`s the event JSON with `Authorization: Bearer <BRIDGE_TOKEN>`; retry 3× with 1 s/3 s/9 s backoff; on final failure log at warn (redacted) and drop. Delivery is sequential per process (a simple promise queue) to preserve order.
- `apps/bridge/src/http.ts` — `createHttpServer({ config, logger, wa, store, allowlist, pacer, confirmStore, bus })` on `node:http`, bound to `BRIDGE_HOST` only. Auth: `Authorization: Bearer <BRIDGE_TOKEN>`, compared with `crypto.timingSafeEqual` on equal-length buffers; missing/invalid → 401. Body limit 1 MB, JSON only. Routes:
  `GET /health` (no auth, loopback only) → `{ ok, connected, selfJid: masked, uptimeSec, sentToday, dailyCap }`;
  `POST /send` → validate `SendRequest` → `checkSendAllowed` → for text: `chunkText` then for each chunk `pacer.acquire()` + `wa.sendText`; for media: `pacer.acquire()` + `wa.sendMedia` → `{ ok: true, ids }`; daily cap → 429; not connected → 503;
  `POST /read` `{ jid, ids: string[] }` → `wa.markRead` → 200;
  `POST /media/download` `{ jid, id }` → if `media_path` exists return it, else `wa.downloadMedia` → `{ path, mime, size }`; 404 if unknown message; 
  `POST /inbound` → validate `InboundEvent`, `bus.publish(event)` → 202. (Used by tests/dev to inject an owner event without WhatsApp; the token protects it.)
  Return `{ ok: false, error }` JSON on every error; never echo message bodies in logs above debug.

`mcp/whatsapp` (`@cxw/mcp-whatsapp`)
- `mcp/whatsapp/package.json` (deps: @cxw/shared, @cxw/bridge (for `openStore`), @modelcontextprotocol/sdk, zod, better-sqlite3; scripts `start` = `tsx src/main.ts`, `typecheck`), `mcp/whatsapp/tsconfig.json`
- `mcp/whatsapp/src/index.ts` — exports `createTools`.
- `mcp/whatsapp/src/bridgeClient.ts` — `fetch` wrapper for `POST /send`, `/read`, `/media/download`, `GET /health` with the bearer token; clear errors on 401/403/429/503.
- `mcp/whatsapp/src/tools.ts` — `createTools({ store, bridge, allowlist })` returns an array of `{ name, description, inputSchema (zod), handler }` implementing `list_chats(limit?, since?)`, `get_chat(jid, since?, limit?)`, `search_messages(query, jid?, since?, limit?)`, `get_contact(jid_or_phone)`, `download_media(jid, id)`, `send_message(jid, text, confirm_token?)`, `send_media(jid, path, caption?, confirm_token?)`, `mark_read(jid, ids)`. `send_*`: if `!allowlist.isOwnerJid(jid)` and no `confirm_token` → return an MCP error result `confirm_token required: recipient is not an owner` without calling the bridge; otherwise forward and let the bridge enforce. Text results are JSON strings; message text in results is fine (the LLM needs it), but tool descriptions must say that third-party message content is untrusted data.
- `mcp/whatsapp/src/main.ts` — stdio `McpServer` (`@modelcontextprotocol/sdk/server/mcp.js` + `StdioServerTransport`), registers the tools, opens the store **read-only** (`new Database(path, { readonly: true })` via an `openStore(path, { readonly: true })` option — add that option to `openStore`; migrations are skipped in read-only mode and the server fails fast with a clear message if the DB does not exist). Env: `DB_PATH`, `BRIDGE_URL` (default `http://127.0.0.1:8787`), `BRIDGE_TOKEN`, `OWNERS_FILE`. Log to stderr only (stdout is the MCP channel).

Tests (root `tests/`, vitest)
- `tests/store.test.ts` — migrate on `:memory:`; insert/idempotent insert; `getChat` since/limit ordering; FTS `searchMessages` finds a word, is case-insensitive, respects `jid` filter, tolerates a query with quotes/`*`; `setMediaPath`; `listChats` order.
- `tests/allowlist.test.ts` — `loadOwners` rejects `+420…`, spaces, empty strings; `isOwnerJid` true for owner with/without `:device`; false for `@g.us`, `@lid`, `status@broadcast`, non-owner; `classifyInbound` cases: self-chat, other owner DM, owner→non-owner (not a command), group with owner participant (not a command).
- `tests/chunker.test.ts` — empty, short, paragraph split, long line hard cut, no chunk over max, concatenation preserves all words.
- `tests/pacing.test.ts` — fake clock: first send immediate, second within interval returns `wait` with correct `waitMs`, cap reached → `daily-cap`, resets at UTC day rollover, `acquire()` serializes two concurrent callers (fake sleep).
- `tests/gate.test.ts` — owner OK; non-owner without token 403; with unknown token 403; minted token consumed once then rejected; token for jid A rejected for jid B.
- `tests/normalize.test.ts` — conversation, extendedText with quote, image with caption, ptt audio → `voice`, reaction → null, ephemeral unwrap.
- `tests/echo.test.ts` — ping in self-chat → pong; ping in another owner chat → nothing; "PING " trims/case.
- `tests/http.test.ts` — start `createHttpServer` on port 0 with a fake `wa`; `/health` without token 200; `/send` without token 401; `/send` to owner sends and returns ids (text chunked); `/send` to non-owner 403; `/inbound` 202 triggers echo handler.

## Steps
1. Phase 0: root files, workspace, tsconfigs, vitest config, `.gitignore`, `.env.example`, CI. `git init -b main`, `corepack pnpm install`, commit. Branch `phase-1-bridge`.
2. `packages/shared`: config, logger, chunker, pacing, allowlist, confirm, types. Tests: chunker, pacing, allowlist, gate-adjacent confirm.
3. `apps/bridge` store + migration; store tests green.
4. `apps/bridge` normalize, media, gate, echo, inbound, http; tests green.
5. `apps/bridge` WA client, `main.ts`, `pair.ts`. Typecheck against Baileys types. Do not attempt to pair or connect in this session.
6. `mcp/whatsapp`: bridge client, tools, main. Smoke: start with `DB_PATH` pointing at a test DB created by a script and confirm the process starts and lists tools (use `@modelcontextprotocol/sdk` `Client` over `StdioClientTransport` in a small `tests/mcp.test.ts` if it is quick; otherwise a manual smoke noted in the audit).
7. `docs/RUNBOOK.md`, `config/owners.example.json`, README pointer.
8. Run `corepack pnpm -r typecheck` and `corepack pnpm test`. All green. Commit on `phase-1-bridge`.
9. Write `feature-research/phase-1-bridge/audit.md` starting with a "Files changed" list, then decisions, deviations, test output summary, and what could not be verified (real WhatsApp link).

## Tests to run
`corepack pnpm install`, `corepack pnpm -r typecheck`, `corepack pnpm test`.

## Out of scope (do NOT do)
- No `apps/brain`, `apps/scheduler`, `mcp/google`, `mcp/vault`, `deploy/`, `vault/`, `workspace/`.
- No confirm-token minting path, no brain router, no reactions/typing indicators.
- No real pairing/connection in this session; no network calls except `pnpm install`.
- No repo-wide formatter/linter runs. No dependency other than the pinned list without noting it in the audit.
- Do not read or copy code from `wa-gpt`, `ThePath`, `NobleAdmin`, or the Second Brain repo.
