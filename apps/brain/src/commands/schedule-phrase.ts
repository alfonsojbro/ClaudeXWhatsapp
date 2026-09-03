/**
 * The deterministic schedule grammar behind `new routine <phrase>: <prompt>`.
 *
 * No LLM is involved. A phrase either matches the grammar exactly and becomes a cron expression,
 * or it does not match and the caller shows the supported forms.
 *
 * Grammar:
 * `every (day|weekday[s]|weekend[s]|<dayname>[, <dayname>][ and <dayname>]|hour|N minutes|N hours)`
 * followed by an optional `at H[:MM][am|pm][ and H[:MM][am|pm]…]`.
 * The day forms default to 09:00 when no time is given; the interval forms take no time at all.
 */
import { describeCron } from '@cxw/scheduler';

/** A phrase resolved to a cron expression plus a short human rendering. */
export interface ParsedSchedule {
  /** Five-field cron expression. */
  cron: string;
  /** Short human string, for example `weekdays at 07:00`. */
  human: string;
}

const DAY_NUMBERS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

/** The forms this parser accepts, for the "I did not understand" reply. */
export const SUPPORTED_FORMS = [
  'every day at 7:30am',
  'every weekday at 7',
  'every monday and thursday at 9',
  'every weekend at 10',
  'every day at 12 and 6pm',
  'every 30 minutes',
  'every 2 hours',
];

interface TimeOfDay {
  hour: number;
  minute: number;
}

/** Split `a, b and c` into its parts. */
function splitList(text: string): string[] {
  return text
    .split(/\s*,\s*|\s+and\s+|\s*&\s*/i)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function parseTime(text: string): TimeOfDay | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(text.trim());
  if (m === null) return null;
  const rawHour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  const suffix = m[3]?.toLowerCase();
  if (!Number.isInteger(rawHour) || minute < 0 || minute > 59) return null;

  let hour = rawHour;
  if (suffix === undefined) {
    if (hour > 23) return null;
  } else {
    if (hour < 1 || hour > 12) return null;
    if (suffix === 'am') hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  }
  return { hour, minute };
}

function parseTimes(text: string): TimeOfDay[] | null {
  const times: TimeOfDay[] = [];
  for (const part of splitList(text)) {
    const time = parseTime(part);
    if (time === null) return null;
    times.push(time);
  }
  return times.length === 0 ? null : times;
}

/** Cron `minute hour` fields for one or more times of day. */
function minuteAndHourFields(times: TimeOfDay[]): { minute: string; hour: string } | null {
  const first = times[0];
  if (first === undefined) return null;
  // Cron has a single minute field, so every listed time must share the same minute.
  if (times.some((t) => t.minute !== first.minute)) return null;
  const hours = [...new Set(times.map((t) => t.hour))].sort((a, b) => a - b);
  return { minute: String(first.minute), hour: hours.join(',') };
}

function parseDayOfWeek(spec: string): string | null {
  if (spec === 'day' || spec === 'days') return '*';
  if (spec === 'weekday' || spec === 'weekdays') return '1-5';
  if (spec === 'weekend' || spec === 'weekends') return '0,6';

  const parts = splitList(spec);
  if (parts.length === 0) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    const num = DAY_NUMBERS[part];
    if (num === undefined) return null;
    if (!numbers.includes(num)) numbers.push(num);
  }
  return numbers.sort((a, b) => a - b).join(',');
}

/** `every N minutes` / `every N hours` / `every hour` — none of which take a time of day. */
function parseInterval(spec: string): string | null {
  if (spec === 'hour') return '0 * * * *';
  if (spec === 'minute') return '* * * * *';

  const m = /^(\d{1,3})\s+(minutes?|mins?|hours?|hrs?)$/.exec(spec);
  if (m === null) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? '';
  if (unit.startsWith('min')) {
    if (n < 1 || n > 59) return null;
    return `*/${String(n)} * * * *`;
  }
  if (n < 1 || n > 23) return null;
  return `0 */${String(n)} * * *`;
}

/**
 * Turn a natural schedule phrase into a cron expression.
 *
 * @returns the cron and a short human rendering, or `null` when the phrase is not in the grammar.
 */
export function parseSchedulePhrase(phrase: string): ParsedSchedule | null {
  const text = phrase.trim().replace(/\s+/g, ' ').toLowerCase();
  if (text === '') return null;

  const m = /^every\s+(.+?)(?:\s+at\s+(.+))?$/.exec(text);
  if (m === null) return null;
  const spec = m[1]?.trim() ?? '';
  const timeText = m[2];

  const interval = parseInterval(spec);
  if (interval !== null) {
    // `every 30 minutes at 7` is not meaningful.
    if (timeText !== undefined) return null;
    return { cron: interval, human: describeCron(interval) };
  }

  const dow = parseDayOfWeek(spec);
  if (dow === null) return null;

  const times = timeText === undefined ? [{ hour: 9, minute: 0 }] : parseTimes(timeText);
  if (times === null) return null;
  const fields = minuteAndHourFields(times);
  if (fields === null) return null;

  const cron = `${fields.minute} ${fields.hour} * * ${dow}`;
  return { cron, human: describeCron(cron) };
}
