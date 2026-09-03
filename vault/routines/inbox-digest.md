---
name: inbox-digest
schedule: "0 12,18 * * *"
timezone: Europe/Prague
model: opus
tools: [google, vault]
deliver_to: owner
enabled: true
kind: llm
description: Midday and evening digest of important new mail only.
---

Digest the important new mail.

**Window.** Only mail that arrived since the previous digest. The previous digest ran at the last
12:00 or 18:00 Europe/Prague, whichever came last; the 12:00 run therefore covers from 18:00
yesterday, and the 18:00 run covers from 12:00 today. Never repeat a mail from an earlier digest.

**Important means one of these:**

- a person is waiting on a reply from Alfonso
- money, a contract, or a deadline is named
- it comes from a thread already tracked in `vault/wiki`

**Not important, and never listed:** newsletters, marketing, receipts, calendar invitations,
notifications from tools, and anything already answered.

For each important mail, one line: sender, subject in at most six words, and the action needed as
a verb phrase.

If nothing qualifies, reply with exactly `Nothing important since the last digest.` and stop.

Rules:

- At most eight lines. If more qualify, list the eight most urgent and give the remaining count.
- Do not summarise the mail bodies. One line each, no exceptions.

End your reply with `STATUS: done` on its own last line.
