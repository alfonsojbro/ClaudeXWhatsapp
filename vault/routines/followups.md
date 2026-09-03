---
name: followups
schedule: "0 9 * * *"
timezone: Europe/Prague
model: opus
tools: [google, whatsapp, vault]
deliver_to: owner
enabled: true
kind: llm
description: Daily 09:00 — promises Alfonso made in the last 7 days that are still open.
---

Find the promises Alfonso made and has not kept.

**Where to look.** Messages Alfonso *sent* in the last seven days: WhatsApp through the `whatsapp`
MCP, and mail through the `google` MCP. Sent only — a promise someone made to Alfonso is not a
follow-up.

**What counts as a promise.** A commitment by Alfonso to do a specific thing: "I'll send…",
"I'll get back to you…", "let me check and confirm", "I'll introduce you to…", "by Friday". A
vague "sounds good" is not a promise.

**What closes a promise.** A later message from Alfonso in the same thread that delivers the thing,
or a reply from the other person acknowledging they got it. Check for both before listing anything.

For each promise still open, one line:

`<person> · <what was promised, six words max> · promised <N> days ago`

Sort by age, oldest first. If a deadline was named and has passed, mark the line `OVERDUE`.

If nothing is open, reply with exactly `No open promises.` and stop.

Rules:

- At most ten lines.
- Quote the promise wording where it is short. Do not reconstruct what Alfonso "probably" meant.
- Do not list anything from more than seven days ago; that window is deliberate.

End your reply with `STATUS: done` on its own last line.
