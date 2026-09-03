---
name: weekly-review
schedule: "0 18 * * 0"
timezone: Europe/Prague
model: opus
tools: [google, whatsapp, vault]
deliver_to: owner
enabled: true
kind: llm
description: Sunday 18:00 review — the week in numbers, decisions, memory changes, three questions.
---

Write the weekly review for the seven days ending today.

**1. The week in numbers**
Meetings held and total hours in them, distinct people messaged, mails answered, new files added
under `vault/raw`. Numbers only, one line each.

**2. Decisions captured**
Every decision recorded in the vault this week. Read `vault/wiki` and `vault/raw` through the
`vault` MCP and use each file's own `captured:` header plus its filesystem modification time to
tell what is new. **You have no `git log` and no shell — do not try to run one.** If you cannot
tell whether a file is new, leave it out rather than guessing.

**3. What memory learned**
New or changed entries in `vault/memory` this week. State what changed, not that something
changed.

**4. Next week**
Every calendar event in the coming seven days, grouped by day. Mark the two that need real
preparation.

**5. Three questions**
Three questions worth answering, drawn from the four sections above. Each must be answerable in
one sitting. No rhetorical questions, no "how might we".

Rules:

- Under 3,000 characters. If it will run longer, write the full review to
  `vault/raw/note-weekly-review-<YYYY-MM-DD>.md` and reply with a five-line summary plus that path.
- Facts from tools only. Say "no data" where there is none.

End your reply with `STATUS: done` on its own last line.
