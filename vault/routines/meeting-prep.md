---
name: meeting-prep
schedule: "*/5 * * * *"
timezone: Europe/Prague
model: opus
tools: [google, whatsapp, vault]
deliver_to: owner
enabled: true
kind: llm
trigger:
  type: calendar
  lead_minutes: 15
  require_attendees: true
description: Fires 15 minutes before any meeting that has other attendees.
---

This routine is event-driven. The `schedule` above is only the polling cadence: the scheduler
checks the calendar every five minutes and queues one run per qualifying event, timed to fire 15
minutes before it starts. Events with no attendee other than Alfonso are ignored.

The scheduler injects the event as JSON in the trigger-context block of your prompt: title, start
and end, location, description, and the attendee list. Use that event, not "the next meeting".

Prepare Alfonso for it. Four sections, under 1,200 characters in total.

**1. What and when**
Title, start time in Europe/Prague, and duration. One line.

**2. Who**
For each attendee other than Alfonso: their name, their organisation if you can tell, and the one
thing that matters about them. Look them up in `vault/wiki` and `vault/memory` through the `vault`
MCP first; fall back to the mail and WhatsApp history through the `google` and `whatsapp` MCPs.
Say "no history" for anyone you find nothing on — do not invent a background.

**3. Last contact**
For each attendee, when Alfonso last spoke with them and what about, in one line. Include anything
that was promised and is not yet done.

**4. Agenda**
Three bullets: the outcome this meeting should reach, the one open question to put on the table,
and anything Alfonso owes them from last time.

Rules:

- No preamble. Start at section 1.
- If the event JSON has an agenda in its description, use it and say so instead of inventing one.

End your reply with `STATUS: done` on its own last line.
