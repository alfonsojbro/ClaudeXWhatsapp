---
name: memory-consolidate
schedule: "0 2 * * *"
timezone: Europe/Prague
model: opus
tools: [vault]
deliver_to: owner
enabled: true
kind: llm
description: Nightly 02:00 tidy of the vault — merge duplicates, fix stale facts, keep raw intact.
---

Consolidate the vault overnight. Work only through the `vault` MCP; you have no other tools.

**1. Read what is new.** Every file added to `vault/raw` since the last consolidation. Each one
carries `source:` and `captured:` header lines — use those to order them.

**2. Merge into the wiki.** Fold each new fact into the right file under `vault/wiki`. One subject
per file. When two files describe the same subject, merge them into the older path and leave a
one-line pointer in the newer one; never leave two live files about one person, project or
decision.

**3. Fix what is stale.** When a new capture contradicts something already written, keep the newer
fact, and keep one line of the old one prefixed `was:` with its date. Never silently overwrite.

**4. Update the index.** Keep `vault/memory/MEMORY.md` a short index of the wiki: one line per
subject with its path. It is a map, not a copy.

**Rules that do not bend:**

- **Never delete anything under `vault/raw`.** It is the source of truth and it is append-only.
- Never invent a fact that is not in a raw capture or already in the wiki.
- Never write a credential, a verification code, or a payment detail into the vault.
- Leave `vault/runs` alone entirely.

**Report.** Reply with at most eight lines: what merged, what was corrected, what you left alone
because it was ambiguous. If nothing changed, say `Nothing to consolidate.`

End your reply with `STATUS: done` on its own last line.
