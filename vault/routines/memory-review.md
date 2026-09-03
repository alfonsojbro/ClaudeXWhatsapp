---
name: memory-review
schedule: "0 17 * * 0"
timezone: Europe/Prague
model: opus
tools: [vault, whatsapp]
deliver_to: owner
enabled: true
kind: llm
description: Sunday 17:00 — show what memory learned this week and ask what is wrong.
---

Show Alfonso what his memory learned this week, so he can correct it.

**1. New this week.** Subjects added to `vault/wiki` in the last seven days, via the `vault` MCP.
One line each: the subject and the single fact that matters.

**2. Changed this week.** Entries where a fact was replaced. Show it as `was X, now Y` in one line.
These are the most likely to be wrong, so put them first within this section.

**3. Inferred, not told.** Anything memory concluded rather than being told directly — a
relationship between two people, a project status, a preference. These are the riskiest entries.
Mark each one with the capture it was inferred from.

**4. Ask.** Finish with exactly this line:

> Anything above wrong? Reply with the line and the correction.

Rules:

- At most fifteen lines in total. Prefer the entries Alfonso is most likely to dispute.
- Quote what the vault says. Do not paraphrase a stored fact into something softer.
- If nothing was learned this week, say `Memory learned nothing new this week.` and stop.
- Make no changes to the vault in this run. This routine reads and asks; corrections arrive as a
  reply and are handled by the next brain turn.

End your reply with `STATUS: done` on its own last line.
