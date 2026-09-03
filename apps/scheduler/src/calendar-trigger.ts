/**
 * Event-driven triggers: spool a run shortly before a calendar meeting starts.
 *
 * Each event fires at most once per routine; `fired_events` is the dedupe ledger.
 */
import type { Db } from './db.js';
import { enqueue } from './spool.js';
import type { CalendarEvent, CalendarSource, Routine } from './types.js';

const MINUTE_MS = 60_000;
const DEFAULT_POLL_MINUTES = 5;

/** Options for {@link pollCalendarTriggers}. */
export interface PollOptions {
  /** How often the scheduler polls, in minutes. Widens the look-ahead window. */
  pollMinutes?: number;
}

/** What one poll produced. */
export interface PollResult {
  /** Events that were spooled by this call. */
  spooled: CalendarEvent[];
  /** Events already seen before and therefore skipped. */
  skipped: number;
}

/** True when the event has at least one attendee who is not the calendar owner. */
export function hasOtherAttendees(event: CalendarEvent): boolean {
  return event.attendees.some((a) => !a.self);
}

function alreadyFired(db: Db, name: string, eventId: string): boolean {
  const row = db
    .prepare('SELECT 1 AS hit FROM fired_events WHERE name = ? AND event_id = ?')
    .get(name, eventId) as { hit: number } | undefined;
  return row !== undefined;
}

function recordFired(db: Db, name: string, eventId: string, at: Date): void {
  db.prepare('INSERT OR IGNORE INTO fired_events (name, event_id, fired_at) VALUES (?, ?, ?)').run(
    name,
    eventId,
    at.getTime(),
  );
}

/**
 * Find meetings about to start and spool a `calendar` run for each new one.
 *
 * The look-ahead window is `[now, now + lead_minutes + pollMinutes]`, so an event is seen at least
 * one poll before its lead time. The spooled item becomes due at `start - lead_minutes`, and its
 * payload is the event as JSON — title, times, location, description and attendees — so the prompt
 * can inject it. The event id is the spool item's dedupe key, so two meetings starting at the same
 * instant each get their own prep.
 *
 * @returns which events were spooled, and how many were already known.
 */
export async function pollCalendarTriggers(
  routine: Routine,
  calendar: CalendarSource,
  db: Db,
  now: Date,
  options: PollOptions = {},
): Promise<PollResult> {
  const trigger = routine.frontmatter.trigger;
  if (trigger === undefined || !routine.frontmatter.enabled) return { spooled: [], skipped: 0 };

  const pollMinutes = options.pollMinutes ?? DEFAULT_POLL_MINUTES;
  const leadMs = trigger.lead_minutes * MINUTE_MS;
  const to = new Date(now.getTime() + leadMs + pollMinutes * MINUTE_MS);

  const events = await calendar.listEvents(now, to);
  const spooled: CalendarEvent[] = [];
  let skipped = 0;

  for (const event of events) {
    if (trigger.require_attendees && !hasOtherAttendees(event)) continue;
    if (event.start.getTime() < now.getTime()) continue;
    if (event.start.getTime() > to.getTime()) continue;
    if (alreadyFired(db, routine.name, event.id)) {
      skipped += 1;
      continue;
    }

    const payload = JSON.stringify({
      id: event.id,
      summary: event.summary,
      start: event.start.toISOString(),
      end: event.end.toISOString(),
      location: event.location ?? null,
      description: event.description ?? null,
      attendees: event.attendees,
    });

    enqueue(db, {
      name: routine.name,
      slot: event.start,
      trigger: 'calendar',
      stage: 'run',
      dedupe: event.id,
      payload,
      nextAttemptAt: new Date(event.start.getTime() - leadMs),
      now,
    });
    recordFired(db, routine.name, event.id, now);
    spooled.push(event);
  }

  return { spooled, skipped };
}
