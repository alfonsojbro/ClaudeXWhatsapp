---
name: morning-brief
schedule: "0 7 * * 1-5"
timezone: Europe/Prague
model: opus
tools: [google, whatsapp, vault]
deliver_to: owner
enabled: true
kind: llm
description: Weekday 07:00 brief — calendar, mail triage, stale threads, project focus.
---

Write Alfonso's morning brief for today. Four sections, in this order, nothing else.

**1. Today**
Every calendar event for today from the `google` MCP. For each one: start time, title, and who
else is on it. Flag any event with no agenda and more than two attendees. If the day is empty,
say so in one line.

**2. Mail**
Unread mail since yesterday morning. Sort each into exactly one bucket and say why in five words
or fewer:

- **reply** — someone is waiting on Alfonso specifically
- **read** — useful, no action
- **ignore** — newsletters, receipts, automated notices

List the **reply** bucket in full. Give the **read** bucket as titles only. Give the **ignore**
bucket as a count.

**3. Waiting on a reply**
WhatsApp threads from the `whatsapp` MCP where the last message is not Alfonso's and is more than
24 hours old. Name the person and quote at most eight words of their last message.

**4. Focus**
The top three items from the current projects in `vault/wiki/Projects` (via the `vault` MCP). If
that folder is empty, use `vault/memory` instead. One line each, phrased as the next physical
action, not as a topic.

Rules:

- Facts only. If a tool returns nothing, say "nothing" rather than guessing.
- No greeting, no sign-off, no motivational line.
- Times in Europe/Prague, 24-hour.
- Keep the whole brief under 2,000 characters.

End your reply with `STATUS: done` on its own last line.
