# ClaudeXWhatsapp

A private Claude assistant that lives on a small Hetzner box and talks to its owner over WhatsApp.
It reads the owner's WhatsApp history, Gmail, and Calendar on request. It understands photos, PDFs,
voice notes, and video. It runs routines on a schedule (morning brief, evening close, weekly review).
It grows a second brain: Markdown notes in the git-backed Obsidian vault at `vault/`, inside this repo.
Three services: `apps/bridge` (Baileys WhatsApp link), `apps/brain` (Claude Agent SDK loop),
`apps/scheduler` (routines). Only owner numbers can command it. Anything that leaves the box to a
third party needs a `yes <TOKEN>` reply first.

## Where to read

- `docs/GETTING_STARTED.md` — the setup guide, in order, for someone new to the project.
- `docs/RUNBOOK.md` — the box: bootstrap, login, backups, restore, day-to-day.
- `docs/IMPLEMENTATION_PLAN.md` — the design and the phases.
- `workspace/CLAUDE.md` is the assistant's own persona on the box. Setup work never edits it.

## The one rule for setup

Follow the guide's order. Never skip a step marked **Needs you at the keyboard**: stop, give the
person the exact link or command, and wait for them. Never type a password, token, auth key, or
code for them. Never store one in this repo, in the vault, or in a memory file. Steps marked
**Lands with phase N** are not on `main` yet: say so, do not promise them.

## Trigger

When the user says anything like "set this up", "let's set this up", "get started", "install",
"connect WhatsApp", "pair", "onboard me", or asks how to run the assistant, run the `/setup` skill
(`.claude/skills/setup/SKILL.md`). It walks the guide one section at a time and skips what is done.
