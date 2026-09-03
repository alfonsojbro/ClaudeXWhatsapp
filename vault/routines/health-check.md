---
name: health-check
schedule: "*/10 * * * *"
timezone: Europe/Prague
model: haiku
tools: []
deliver_to: owner
enabled: true
kind: health
catch_up_minutes: 1
description: Every 10 minutes — WhatsApp, Google, disk and backup probes. No LLM.
---

This routine runs no model. `kind: health` makes the scheduler execute four built-in probes in
code, so this body is documentation only. Editing the text below changes nothing; the checks live
in `apps/scheduler/src/runner/health.ts`.

**What is checked, every ten minutes:**

| probe | passes when |
| --- | --- |
| `whatsapp` | the bridge answers `GET /health` with `connected: true` inside 5 seconds |
| `google` | an OAuth token refresh returns 200 — "not configured" also passes, with a note |
| `disk` | used space on `CXW_DATA_DIR` is at or below `CXW_DISK_LIMIT_PCT` (default 85%) |
| `backup` | `CXW_BACKUP_STAMP_FILE` was touched within `CXW_BACKUP_MAX_AGE_H` (default 8h) |

**How it alerts.** Only on a change of state. A probe that starts failing sends one message; the
same probe failing again ten minutes later sends nothing. When it passes again, a short "recovered"
note follows. That is deliberate — a broken bridge must not produce 144 messages a day.

**Which channel.** WhatsApp normally. When the failing probe is `whatsapp` itself, the alert goes
by e-mail to `CXW_ALERT_EMAIL_TO` instead, since WhatsApp is the thing that is down.

**Run logs.** A log under `vault/runs/health-check/` is written only when at least one probe fails.
Healthy runs leave no trace, so the folder stays readable.

`catch_up_minutes: 1` keeps this honest: a health result from an hour ago is worthless, so a run
missed during an outage is dropped rather than replayed.
