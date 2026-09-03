# ClaudeXWhatsapp — Implementation Plan

**Status:** draft v2 · 2026-09-03 · self-contained in this repo · author: Claude (for Alfonso)
**One line:** a personal Claude assistant that lives on a Hetzner box, talks to Alfonso over WhatsApp, reads his WhatsApp / Gmail / Calendar, understands images and voice notes, runs daily and weekly routines, and grows an Obsidian-style second brain the more it is used.

---

## 0. Ground rule: everything lives in this repo

- All code, deploy scripts, routines, and the memory vault are hosted in `ClaudeXWhatsapp`. No code is copied from or shared with other projects (wa-gpt, ThePath, NobleAdmin, the Second Brain repo).
- A dedicated Hetzner box runs only this project.
- The vault is `vault/` inside this repo (its own Obsidian vault). It can get its own git remote later; nothing else writes to it.
- Patterns known from earlier work (Baileys session handling, lease + retry spool for jobs, allowlist-as-data) are re-implemented here from scratch.

---

## 1. Goals and non-goals

**Goals**
1. Chat with Claude from WhatsApp, with full tool use, from anywhere.
2. Read and search my own WhatsApp history, Gmail, and Calendar on request and inside routines.
3. Understand images, PDFs, and voice notes sent to the chat.
4. Run scheduled routines (daily brief, weekly review, custom ones) and review them from WhatsApp.
5. Memory that compounds: facts, preferences, people, projects, decisions, all stored as Markdown in a git-backed Obsidian vault.
6. Use the Claude subscription on the box (Claude Code login), with an API-key fallback.

**Non-goals (v1)**
- Replying to other people automatically. The assistant only talks to Alfonso. Drafts for others require an explicit "send".
- Serving other users or businesses. That is wa-gpt's job.
- A web UI. WhatsApp is the UI. Obsidian on the Mac is the memory browser.

---

## 2. Architecture

```
 Phone (WhatsApp)                       Hetzner box (fsn1, Ubuntu 24.04, Tailscale only)
 ┌──────────────┐   WhatsApp Web MD    ┌──────────────────────────────────────────────────┐
 │ Alfonso      │◄────────────────────►│ apps/bridge  (Baileys, TypeScript)               │
 │ self-chat =  │                      │  • linked device on Alfonso's number             │
 │ command line │                      │  • SQLite store: chats, messages, media, FTS5    │
 └──────────────┘                      │  • inbound bus → brain; outbound send API        │
                                       │  • MCP server: whatsapp_* tools (read + send)    │
                                       ├──────────────────────────────────────────────────┤
                                       │ apps/brain   (Claude Agent SDK, TypeScript)      │
                                       │  • one Claude session per chat, resumable        │
                                       │  • router: command | question | capture | media  │
                                       │  • tool policy + owner-confirm gate for sends    │
                                       │  • MCPs: whatsapp, google (gmail+calendar),      │
                                       │          vault (memory), routines, web           │
                                       ├──────────────────────────────────────────────────┤
                                       │ apps/scheduler (routines)                        │
                                       │  • routines/*.md (cron in frontmatter)           │
                                       │  • lease + spool → runs brain job → sends result │
                                       ├──────────────────────────────────────────────────┤
                                       │ vault/  = this repo's own Obsidian vault          │
                                       │  raw/ (captures) · wiki/ (compiled) · memory/    │
                                       │  commit after every write; Obsidian on Mac pulls │
                                       └──────────────────────────────────────────────────┘
                                                 │ Claude Code login (subscription) or API key
                                                 ▼
                                          Anthropic API
```

**Process model:** three long-running systemd services (`bridge`, `brain`, `scheduler`) on the host. Bridge and brain talk over a local Unix socket / HTTP on `127.0.0.1`. Docker is optional; host-native systemd is the default because Claude Code runs on the host.

**Why Baileys and not the official Cloud API:** the official API cannot read Alfonso's personal chats. Reading history needs a linked device. Baileys is mature, TypeScript, and well documented. Alternative if Baileys becomes painful: `lharries/whatsapp-mcp` (Go whatsmeow bridge + Python MCP). Same linked-device model.

---

## 3. Components in detail

### 3.1 WhatsApp bridge (`apps/bridge`)
- Baileys multi-device, auth state in `/srv/cxw/data/session/`, backed up every 6 h by `deploy/hetzner/backup.sh` (written here).
- Pairing: `pnpm pair` prints the QR in the SSH terminal (Tailscale). Also supports Baileys pairing-code login, which needs no QR.
- **Store:** SQLite via `better-sqlite3`. Tables: `chats`, `contacts`, `messages` (jid, id, ts, from_me, sender, type, text, quoted_id, media_path), `media`. FTS5 virtual table on `messages.text`. Sync history on first link (Baileys `syncFullHistory`), then live.
- **Media:** download on arrival for owner chats; lazy for others. Store under `/srv/cxw/data/media/<jid>/<msgid>.<ext>`. Retention: 90 days for non-owner media, forever for owner chat (configurable).
- **Command channel:** Alfonso's self-chat ("Message yourself") and an allowlist of owner numbers (`config/owners.json`). Only messages from those senders reach the brain. Group messages and third-party DMs are stored, never acted on.
- **MCP server (`mcp/whatsapp`)** exposing: `list_chats`, `get_chat(jid, since, limit)`, `search_messages(query, jid?, since?)`, `get_contact`, `download_media(msgid)`, `send_message(jid, text)`, `send_media(jid, path, caption)`, `mark_read`. `send_*` to any JID other than an owner requires a `confirm_token` issued by the confirm gate (3.2).

### 3.2 Brain (`apps/brain`)
- **Runtime:** `@anthropic-ai/claude-agent-sdk` (TypeScript) `query()` with `resume` per chat. Working directory = `/srv/cxw/workspace` containing `CLAUDE.md` (persona, rules, memory instructions), `.mcp.json` (servers), and `.claude/agents/` (subagents).
- **Auth:** Claude Code login on the box using the Max subscription (`claude login` device flow, or `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` in the env file). Fallback: `ANTHROPIC_API_KEY` with a daily spend cap. **Verify Anthropic's current terms for subscription use in headless/SDK mode before relying on it; keep the API-key path wired from day one.**
- **Models:** Fable 5.1 or Opus 5 for conversation and routines; Haiku 4.5 for the router, transcription clean-up, and classification.
- **Router** (Haiku, 1 call): `command` (`/new`, `/routines`, `/remember`, …) → `capture` ("remember that…", "idea:", "note:") → `media` → `question/chat`. Commands never reach the LLM loop.
- **Session policy:** one resumable session per chat; `/new` resets; auto-reset after 12 h idle; before reset, the agent writes a session summary to `memory/sessions/YYYY-MM-DD-<slug>.md`.
- **Confirm gate:** any tool that leaves the box towards a third party (send WhatsApp to non-owner, send email, create/modify calendar event with attendees) returns a preview and a 6-char token. Alfonso replies `yes <token>` within 10 min or it expires. Nothing else can mint tokens.
- **Chunked replies:** WhatsApp caps message size; split on paragraphs at ~3,500 chars. Long outputs go to a file in the vault plus a 5-line summary.
- **Typing indicator + read receipts** so the chat feels alive. Reaction emoji (👀) on receipt, (✅) when done, (❌) on failure.

### 3.3 Memory / second brain (the "growing kid")
Three layers, all Markdown, all in `vault/`, all in git:

1. **Captures (`vault/raw/`)** — `raw/<type>-<kebab-topic>.md` with `source:` and `captured:` lines. Types: idea, bookmark, article, note, braindump, person, decision, email. Written by the assistant whenever Alfonso shares something worth keeping or says `remember:`.
2. **Compiled knowledge (`vault/wiki/`)** — the nightly `compile` routine reads new `raw/` files and updates topic pages (`wiki/Projects/…`, `wiki/People/…`, `wiki/Decisions.md`) with `[[links]]`, so Obsidian's graph grows on its own.
3. **Assistant memory (`vault/memory/`)** — one fact per file with frontmatter `name / description / type: user|feedback|project|reference|person`, plus `memory/MEMORY.md` as the index loaded into every session. Same schema Claude Code uses for its own memory.

**Retrieval** — v1: `rg` + SQLite FTS over the vault, top-k files injected by the router. v2: embeddings in `sqlite-vec` (Voyage `voyage-3` or a local model), rebuilt nightly. Retrieval always cites the file path so Alfonso can open it in Obsidian.

**Learning loop**
- Explicit: `remember: …`, `forget …`, `what do you know about <x>?`, `who is <person>?`.
- Implicit: after every conversation the agent runs a cheap "worth keeping?" pass and proposes 0–3 memory writes. Feedback-type memories ("don't do X") are written immediately.
- Nightly `memory-consolidate` routine: dedupe, merge, fix stale facts, prune the index. Nightly `compile` routine: raw → wiki.
- Weekly `memory-review` routine sends a WhatsApp digest: "12 new facts, 3 updated, 2 doubtful — reply with numbers to delete".

**Sync:** the box commits after every write (`capture: …`) and pushes to the vault's remote. On the Mac, Obsidian opens `vault/` and the Obsidian Git plugin pulls every 10 min. Conflict rule: the box writes `raw/`, `wiki/`, `memory/`; Alfonso edits anything; the box always pulls `--rebase` before writing.

### 3.4 Google: Gmail + Calendar (`mcp/google`)
- OAuth desktop flow run once on the Mac; the refresh token is copied to `/srv/cxw/google.env` (0600). Scopes: `gmail.modify`, `calendar` (read + write), `contacts.readonly`. Add Drive/Tasks later.
- **Gotcha:** a Google Cloud OAuth app left in *Testing* status expires refresh tokens after 7 days. Set the consent screen to *Production* (unverified is fine for a single personal account).
- Tools: `gmail_search`, `gmail_read`, `gmail_draft`, `gmail_send` (confirm gate), `gmail_label/archive`, `calendar_list_events`, `calendar_freebusy`, `calendar_create_event` (confirm gate when attendees ≠ Alfonso), `contacts_lookup`.
- Option: use an existing server (`taylorwilsdon/google_workspace_mcp` or the Anthropic Gmail/Calendar connectors) instead of writing one. Decide in Phase 4 after a 1-hour spike; write our own only if the existing one fails headless.

### 3.5 Media understanding
| Input | Pipeline |
| --- | --- |
| Image | download → resize ≤1568 px → Claude vision image block + caption as the question. Also OCR-free: Claude reads text in images natively. |
| PDF / DOCX | PDF → Claude document block (native PDF support). DOCX → `pandoc` → Markdown. |
| Voice note | OGG/Opus → `ffmpeg` → Whisper (OpenAI API, or `whisper.cpp` on the box) → text → normal flow. Reply with text; optional voice reply via TTS as a WhatsApp voice note (`ptt: true`). |
| Video | `ffmpeg` keyframes every N s (max 8) → vision. Audio track → Whisper. |
| Location | reverse-geocode → memory ("Alfonso was at …" only if he asks). |
| Contact card / link | parse vCard; links → fetch + summarize → `raw/bookmark-…` capture offered. |

### 3.6 Routines (`apps/scheduler`)
- A routine is a Markdown file in `vault/routines/` with frontmatter:
  ```yaml
  name: morning-brief
  schedule: "0 7 * * 1-5"      # cron, in the timezone below
  timezone: Europe/Prague
  model: opus
  tools: [google, whatsapp, vault]
  deliver_to: owner
  enabled: true
  ```
  and the body is the prompt. Because routines are files in the vault, Alfonso can edit them in Obsidian and the assistant can create them from chat.
- Scheduler ticks every minute, claims due routines with a lease, runs a brain job with a fresh session, writes the run log to `vault/runs/<name>/<ts>.md`, sends the result.
- WhatsApp commands: `routines` (list + next run), `run <name>`, `pause|resume <name>`, `history <name>`, `new routine every weekday at 7: <prompt>` (agent writes the file and confirms).
- **Starter routines**
  1. `morning-brief` (07:00 weekdays): today's calendar, unread email triaged into reply/read/ignore, WhatsApp messages unanswered > 24 h, top 3 from the vault's current projects.
  2. `evening-close` (21:00): what happened today (sent messages, meetings), open loops, prompt for a 1-line journal → stored in `raw/note-journal-<date>.md`.
  3. `weekly-review` (Sunday 18:00): the week in numbers, decisions captured, memory changes, next week's calendar, questions for Alfonso.
  4. `meeting-prep` (15 min before each event with attendees): who they are (vault + WhatsApp + email history), last contact, agenda.
  5. `inbox-digest` (12:00 and 18:00): new important email only.
  6. `memory-consolidate` (02:00) and `memory-review` (Sunday 17:00), see 3.3.
  7. `followups` (09:00): promises found in sent WhatsApp/email ("I'll send you…") not yet done.
  8. `health-check` (every 10 min, no LLM): WhatsApp connected? Google token valid? Disk? Alerts by WhatsApp, and by email as fallback when WhatsApp itself is down.

### 3.7 GitHub as the source of truth
- **One private GitHub repo, `ClaudeXWhatsapp`**, holds everything: code, deploy scripts, `workspace/` (the assistant's `CLAUDE.md`, `.mcp.json`, `.claude/agents/`, and `.claude/skills/`), and `vault/`.
- **Skills are versioned.** Skills the assistant learns or that Alfonso writes live in `workspace/.claude/skills/<name>/SKILL.md`. The assistant can propose a new skill from chat (`new skill: …`); it lands as a commit on a branch and Alfonso merges it.
- **Vault sync is git.** The box commits after every vault write and pushes; the Mac's Obsidian Git plugin pulls every 10 min and pushes Alfonso's edits. If the vault should be shareable on its own later, it becomes a git submodule with its own private repo without changing any code.
- **Box access:** a read-write deploy key scoped to this repo only, stored at `/root/.ssh/cxw_deploy` (0600). No personal GitHub token on the box.
- **Deploys are pulls:** `deploy/hetzner/update.sh` does `git pull --ff-only`, `pnpm install --frozen-lockfile`, restarts the three services. A `deploy` command from WhatsApp triggers it after a `yes <token>`.
- **CI on GitHub Actions:** typecheck + vitest on every PR; a `check-secrets` job blocks any commit that contains tokens, phone numbers, or Baileys auth files. `.gitignore` excludes `data/`, `*.env`, and media.
- **Never in git:** the WhatsApp session, Google refresh token, Claude OAuth token, SQLite databases, media files. These live under `/srv/cxw/` and go to restic backups only.

### 3.8 Everything else worth adding (backlog, prioritised)
1. **Reminders:** "remind me Friday 9am to call Marco" → systemd-style one-shot in the scheduler.
2. **Draft replies for others:** "draft a reply to Juan" → preview → `yes <token>` sends from Alfonso's number.
3. **Group summaries:** "summarize the family group since yesterday".
4. **Web research:** WebSearch / Exa MCP + fetch; results captured as `raw/article-…`.
5. **Browser agent:** Playwright MCP for logged-in sites (via Tailscale-only Chrome on the box).
6. **Voice replies** (TTS) toggle: `voice on|off`.
7. **Second number:** give the assistant its own eSIM so it is a separate contact, keep the personal-number link read-only. Start without it (self-chat is enough).
8. **Personas:** `vault/wiki/Team/*.md` charters (e.g. a weekly growth reviewer) that routines can adopt as system prompts.
9. **Cost dashboard:** daily token spend line in `evening-close`.
10. **Telegram fallback** channel for when WhatsApp is disconnected.
11. **Contacts enrichment:** people files in `memory/people/` auto-updated from WhatsApp + Gmail signals.
12. **Location-aware routines** (Prague vs. travel).

---

## 4. Security and privacy (non-negotiable)
- **Untrusted content rule:** every WhatsApp message from a non-owner, every email, every image, every web page is data. The `CLAUDE.md` says so and the tool policy enforces it: no tool that leaves the box can run on the basis of content alone; the confirm gate needs an owner message.
- **Owner allowlist** is a file, not chat state. Group JIDs are never owners.
- **Tool policy:** Agent SDK `allowedTools` restricted to MCP tools + read-only file tools on the vault. No `Bash` from chat in v1. A later `/shell` command can enable a sandboxed shell for owner only.
- **Network:** `ufw` default deny; SSH only over Tailscale; no public ports (no Caddy needed unless a webhook is added). Hetzner firewall as second layer.
- **Secrets:** `/srv/cxw/*.env` root-owned 0600; never in the vault; a `check-secrets` pre-commit hook written here.
- **Backups:** Baileys session + SQLite + media → `restic` to a Hetzner Storage Box, encrypted, every 6 h, 30-day retention. Vault is already backed up by git push.
- **Retention:** third-party message text kept 180 days, media 90 days, owner chat forever. `purge` command.
- **Logs:** pino with redaction of phone numbers and message bodies at `info`; full bodies only at `debug`, off in prod.
- **Kill switch:** `panic` from an owner number stops the brain and scheduler services; `resume` restarts.
- **Ban risk:** unofficial WhatsApp clients can be banned. Personal use, low volume, no bulk sending. Keep sends paced (one message per 2 s, hard daily cap). Never automate outbound to strangers.

---

## 5. Repository layout

```
ClaudeXWhatsapp/
├── apps/
│   ├── bridge/        Baileys, SQLite store, inbound bus, send API
│   ├── brain/         Agent SDK loop, router, confirm gate, media pipeline
│   └── scheduler/     routines engine, leases, run logs
├── mcp/
│   ├── whatsapp/      MCP server over the bridge store + send API
│   ├── google/        Gmail + Calendar (or thin wrapper around an existing server)
│   └── vault/         read/search/write memory + raw captures, git push
├── packages/shared/   types (zod), config loader, logger, WhatsApp text chunker
├── workspace/         CLAUDE.md, .mcp.json, .claude/agents/ used by the brain on the box
├── vault/             Obsidian vault: raw/, wiki/, memory/, routines/, runs/
├── deploy/hetzner/    bootstrap.sh, systemd units, backup.sh/restore.sh, monitor.sh, env examples
├── docs/              this plan, runbooks, ADRs
└── tests/             vitest: router, chunker, confirm gate, scheduler, store
```
Stack: TypeScript, pnpm workspaces, Node 22, `tsx`, `better-sqlite3`, `@whiskeysockets/baileys`, `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, `zod`, `pino`, `croner`, `vitest`.

---

## 6. Phases, deliverables, acceptance

| # | Phase | Deliverable | Done when | Est. |
| --- | --- | --- | --- | --- |
| 0 | Repo + box | Private GitHub repo + deploy key + Actions CI, repo skeleton (pnpm workspaces, tests), new Hetzner CX33 (4 vCPU / 8 GB) in fsn1, Ubuntu 24.04, Tailscale, ufw, Node 22, Claude Code logged in, restic to Storage Box | `claude -p "hi"` works on the box; SSH only via Tailscale; first backup restored in a test | 0.5 d |
| 1 | Bridge + echo | Baileys link, SQLite store with history sync, owner allowlist, echo bot in self-chat | Send "ping" to yourself, get "pong"; `search_messages` returns old chats | 1 d |
| 2 | Brain v0 | Agent SDK loop, session per chat, `/new`, chunked replies, reactions, `CLAUDE.md` persona, vault MCP with `remember:` and captures committed to `vault/` | 10-turn conversation with memory recall across `/new`; a capture appears in `vault/raw/` and is committed within 1 min | 2 d |
| 3 | Media | Images, PDFs, voice notes, video keyframes | Send a photo of a whiteboard, get a structured summary; voice note transcribed and answered | 1 d |
| 4 | Google | Gmail + Calendar MCP, confirm gate for send/create | "What's on tomorrow?" and "reply to Ana's mail: …" → preview → `yes <token>` sends | 1.5 d |
| 5 | Routines | Scheduler, routine files, WhatsApp commands, morning-brief + evening-close + weekly-review + health-check | Morning brief arrives at 07:00 three days in a row; `run weekly-review` works on demand | 1.5 d |
| 6 | Memory maturity | Implicit capture pass, nightly compile (raw → wiki) and consolidation, weekly memory review, FTS retrieval, people files | "who is X?" answers from memory built only by usage; consolidation reduces duplicates in a seeded test | 1.5 d |
| 7 | Hardening + ops | Monitor, alert fallback, retention purge, cost line, kill switch, restore runbook, docs | Chaos test: kill bridge, unplug Google token, fill disk → alerts arrive, services self-heal | 1 d |

Total ≈ 10 working days of focused build. Phases 3 and 4 can run in parallel (disjoint files).

---

## 7. Decisions

**Decided (2026-09-03):** everything is hosted in this repo; a dedicated Hetzner box; the vault is `vault/` inside this repo.

**Still open**
1. **Auth:** Claude Max subscription via Claude Code login on the box (cheap, terms to verify) vs. API key (metered, clean)? Recommendation: subscription first, API key fallback wired.
2. **Number:** personal number + self-chat (recommended for v1) vs. a second eSIM for the assistant?
3. **Google server:** reuse an open-source Google Workspace MCP vs. own thin server? Decide after a 1-hour spike in Phase 4.
4. **Timezone and languages:** Europe/Prague? Reply in the language of the message (ES/EN)?

---

## 8. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| WhatsApp account ban (unofficial client) | Lose personal number access | Personal volume only, paced sends, no outbound to strangers, keep phone online (14-day rule) |
| Subscription auth not allowed / revoked headless | Assistant stops | API-key fallback with spend cap; alert on auth failure |
| Prompt injection via other people's messages, email, images | Data leak or unwanted send | Untrusted-content rule, confirm gate, no shell from chat, owner allowlist |
| Google refresh token expiry (Testing status) | Gmail/Calendar silently die | Consent screen in Production; health-check tests token every 10 min |
| Vault merge conflicts (box vs. Mac) | Lost notes | Folder ownership rule; pull --rebase before write; conflicts alert to WhatsApp |
| Baileys breaking changes | Bridge down | Pin version; session-monitor alerts; fallback plan to whatsmeow bridge |
| Cost creep from routines | Surprise bill | Haiku for cheap steps, daily cost line, per-routine model choice, monthly cap |

---

## 9. First 3 commands to run (Phase 0)

```bash
# on the Mac — create the repo skeleton
git init && pnpm init
```
```bash
# on the new box (as root) — run deploy/hetzner/bootstrap.sh; first step is Tailscale
curl -fsSL https://tailscale.com/install.sh | sh && tailscale up
```
```bash
# on the box — Claude Code login with the subscription
npm i -g @anthropic-ai/claude-code && claude login
```
