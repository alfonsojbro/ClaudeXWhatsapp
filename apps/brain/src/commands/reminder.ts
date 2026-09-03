/**
 * `remind me …` — turn a natural phrase into an instant plus the thing to be reminded of.
 *
 * chrono-node does the date reading. The timezone is applied as a numeric UTC offset. The offset
 * is resolved twice — once at `now` and once at the instant the first pass produced — so a
 * reminder set across a DST boundary lands on the right wall-clock time, the same two-pass trick
 * `parseLocalDateTimeInTz` uses in the scheduler.
 */
import { tzOffsetMinutes } from '@cxw/scheduler';
import * as chrono from 'chrono-node';

/** A reminder resolved to an instant and a subject. */
export interface ParsedReminder {
  /** The instant the reminder fires. Always in the future relative to `now`. */
  when: Date;
  /** What to be reminded of, with the time words and filler removed. */
  what: string;
}

/** Words that glue the time to the subject and should not survive into `what`. */
const LEADING_FILLER = /^(?:to|that|about|for|:|-|,|\.)\s*/i;
const TRAILING_FILLER = /\s*(?:on|at|by|:|-|,|\.)$/i;

function clean(text: string): string {
  let out = text.replace(/\s+/g, ' ').trim();
  let previous = '';
  while (out !== previous) {
    previous = out;
    out = out.replace(LEADING_FILLER, '').replace(TRAILING_FILLER, '').trim();
  }
  return out;
}

/**
 * Parse a reminder phrase.
 *
 * Accepts both orders: `Friday 9am to call Marco` and `call Marco on Friday at 9am`. A leading
 * `remind me` is optional and is stripped.
 *
 * @param text the phrase, with or without the `remind me` prefix.
 * @param now the reference instant.
 * @param tz the owner's timezone, used to read wall-clock times in the phrase.
 * @returns the reminder, or `null` when no time could be read or the time is in the past.
 */
export function parseReminder(text: string, now: Date, tz: string): ParsedReminder | null {
  const phrase = text
    .trim()
    .replace(/^remind\s+me\b\s*/i, '')
    .trim();
  if (phrase === '') return null;

  const parseAt = (offsetMinutes: number): chrono.ParsedResult | undefined =>
    chrono.parse(phrase, { instant: now, timezone: offsetMinutes }, { forwardDate: true })[0];

  const offsetNow = tzOffsetMinutes(tz, now);
  const first = parseAt(offsetNow);
  if (first === undefined) return null;

  const firstDate = first.date();
  if (Number.isNaN(firstDate.getTime())) return null;

  // Second pass: the offset at the target instant may differ from the offset at `now`.
  const offsetThen = tzOffsetMinutes(tz, firstDate);
  const hit = offsetThen === offsetNow ? first : parseAt(offsetThen);
  if (hit === undefined) return null;

  const when = hit.date();
  if (Number.isNaN(when.getTime())) return null;
  if (when.getTime() <= now.getTime()) return null;

  const before = phrase.slice(0, hit.index);
  const after = phrase.slice(hit.index + hit.text.length);
  const what = clean(`${clean(before)} ${clean(after)}`);
  if (what === '') return null;

  return { when, what };
}
