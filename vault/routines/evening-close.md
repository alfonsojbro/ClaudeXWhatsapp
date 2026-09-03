---
name: evening-close
schedule: "0 21 * * *"
timezone: Europe/Prague
model: opus
tools: [google, whatsapp, vault]
deliver_to: owner
enabled: true
kind: llm
description: 21:00 close of day — what happened, what is still open, one journal question.
---

Close out Alfonso's day. Three short sections, then one question.

**1. What happened**
Meetings that actually took place today (from the `google` MCP) and the people Alfonso sent
messages to today (from the `whatsapp` MCP). Names and counts, not transcripts.

**2. Still open**
Anything from today that has no closing move yet: an unanswered message where Alfonso spoke last
and asked for something, a meeting with an action item and no follow-up, a mail in the reply
bucket that is still unanswered. Maximum five items, each one line.

**3. Tomorrow's first thing**
The single earliest commitment tomorrow, and the one preparation it needs tonight. One line.

**Then ask.** Finish with exactly this question on its own line:

> One line: what mattered today?

**Note for the next brain turn.** Alfonso's reply to that question is a journal entry. Store it
verbatim as `vault/raw/note-journal-<YYYY-MM-DD>.md` using today's date, with the two header lines
`source: evening-close` and `captured: <YYYY-MM-DD>`. Do not summarise it, do not edit it, and do
not put it in `vault/wiki`.

Rules:

- No greeting, no praise, no encouragement.
- Under 1,200 characters before the question.

Because you are asking a question, end your reply with `STATUS: needs_input` on its own last line,
not `STATUS: done`.
