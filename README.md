# ClaudeXWhatsapp

**New here?** Start with the step-by-step guide: [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)

Personal Claude assistant on a Hetzner box, driven from WhatsApp.
Reads WhatsApp, Gmail, and Calendar. Understands images and voice notes.
Runs routines. Grows a git-backed Obsidian second brain.

Plan: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)

## Operations

- [docs/RUNBOOK.md](docs/RUNBOOK.md) — install, update, pair, restore, rotate tokens, panic,
  purge, costs, alerts, chaos, common failures.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system diagram, units, cross-phase contracts,
  state files, security model, known limitations.
- [docs/runs/chaos-2026-09-03.md](docs/runs/chaos-2026-09-03.md) — the last chaos-test result.

**`cxw-ops` (SSH, as the `cxw` user):** `health [--json] [--no-alert]` ·
`purge [--dry-run] [--emergency]` · `costs [today|month|line|check|unpause]` · `panic [reason]` ·
`resume` · `status` · `alert-test <text>` · `sentinel`.

**WhatsApp, owners only** (optional leading `/`): `panic`, `resume`, `status`,
`purge [--dry-run] [--emergency]`, `costs [today|month]`, `costs unpause`.

**Env files**, all root:root 0600 on the box and never committed: `/srv/cxw/cxw.env` (services
and ops), `/srv/cxw/google.env` (Google OAuth), `/srv/cxw/restic.env` (backups). Examples live in
`deploy/hetzner/*.example`.

Never commit a secret, a phone number, a SQLite database, media, or the Baileys session. They
live under `/srv/cxw/` and go to restic backups only.
