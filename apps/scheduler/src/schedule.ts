/**
 * Cron and timezone helpers built on croner.
 *
 * Everything here is pure: pass `now` in, get a decision out. No timers, no ambient clock.
 */
import { Cron } from 'croner';
import type { Routine } from './types.js';

const MINUTE_MS = 60_000;

/** True when the string is a timezone the runtime understands. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** True when the string is a cron expression croner accepts. */
export function isValidCron(expr: string, timezone?: string): boolean {
  try {
    const cron = timezone === undefined ? new Cron(expr) : new Cron(expr, { timezone });
    return cron.nextRun(new Date(0)) !== null;
  } catch {
    return false;
  }
}

interface TzParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  const cached = partsCache.get(tz);
  if (cached !== undefined) return cached;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  partsCache.set(tz, fmt);
  return fmt;
}

function partsIn(tz: string, date: Date): TzParts {
  const out: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(date)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  // `hour12: false` can render midnight as hour 24 on some ICU builds.
  const hour = (out.hour ?? 0) % 24;
  return {
    year: out.year ?? 1970,
    month: out.month ?? 1,
    day: out.day ?? 1,
    hour,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

/**
 * Offset of `tz` from UTC, in minutes east of UTC, at the given instant.
 * Prague in winter is +60, in summer +120.
 */
export function tzOffsetMinutes(tz: string, date: Date): number {
  const p = partsIn(tz, date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = date.getTime() - date.getMilliseconds();
  return Math.round((asUtc - truncated) / MINUTE_MS);
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Formatting styles for {@link formatInTz}. */
export type TzFormat = 'weekday-time' | 'datetime' | 'date' | 'time';

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Render an instant in a timezone.
 *
 * - `weekday-time` (default): `Mon 07:00`
 * - `datetime`: `2026-09-03 07:00`
 * - `date`: `2026-09-03`
 * - `time`: `07:00`
 */
export function formatInTz(date: Date, tz: string, style: TzFormat = 'weekday-time'): string {
  const p = partsIn(tz, date);
  const ymd = `${String(p.year)}-${pad(p.month)}-${pad(p.day)}`;
  const hm = `${pad(p.hour)}:${pad(p.minute)}`;
  switch (style) {
    case 'datetime':
      return `${ymd} ${hm}`;
    case 'date':
      return ymd;
    case 'time':
      return hm;
    case 'weekday-time': {
      const utcMidday = new Date(Date.UTC(p.year, p.month - 1, p.day, 12));
      const weekday = DAY_NAMES[utcMidday.getUTCDay()] ?? '';
      return `${weekday} ${hm}`;
    }
  }
}

/**
 * Interpret an ISO-ish local datetime string in `tz`.
 *
 * Strings that already carry `Z` or an explicit offset are parsed as-is. Otherwise the wall-clock
 * time is resolved against the zone's offset at that moment.
 *
 * @returns the instant, or `null` when the string is not a datetime.
 */
export function parseLocalDateTimeInTz(input: string, tz: string): Date | null {
  const text = input.trim();
  if (text === '') return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  if (hasZone) {
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (m === null) return null;
  const [, y, mo, d, h, mi, s] = m;
  if (
    y === undefined ||
    mo === undefined ||
    d === undefined ||
    h === undefined ||
    mi === undefined
  ) {
    return null;
  }
  const naive = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    s === undefined ? 0 : Number(s),
  );
  // Two passes: the first offset guess may straddle a DST boundary.
  let guess = new Date(naive - tzOffsetMinutes(tz, new Date(naive)) * MINUTE_MS);
  guess = new Date(naive - tzOffsetMinutes(tz, guess) * MINUTE_MS);
  return Number.isNaN(guess.getTime()) ? null : guess;
}

/** Build a croner instance for a routine's schedule. */
function cronFor(routine: Routine): Cron | null {
  const expr = routine.frontmatter.schedule;
  if (expr === undefined) return null;
  return new Cron(expr, { timezone: routine.frontmatter.timezone });
}

/**
 * The next time this routine should fire after `now`.
 *
 * @returns `null` for a disabled routine, a one-shot already in the past, or a cron with no
 * further occurrence.
 */
export function nextRun(routine: Routine, now: Date): Date | null {
  if (!routine.frontmatter.enabled) return null;
  if (routine.onceAt !== undefined) {
    return routine.onceAt.getTime() > now.getTime() ? routine.onceAt : null;
  }
  const cron = cronFor(routine);
  if (cron === null) return null;
  return cron.nextRun(now);
}

/** The outcome of a due check. */
export interface DueSlot {
  /** The scheduled instant that is now due. */
  slot: Date;
  /**
   * The first slot that was missed while the scheduler was down, if any. The caller records a
   * `skipped` run for it so the gap is visible in `history`.
   */
  missedSlot: Date | null;
}

/**
 * Decide whether `routine` is due at `now`.
 *
 * Cron: the candidate slot is the first occurrence after `now - catch_up_minutes`. It is due when
 * it has already passed and is newer than `lastSlot`. Slots older than the catch-up window are
 * never run, so an outage does not fire a pile of stale jobs.
 *
 * Once: due when the instant has passed, is still inside the catch-up window, and has not fired.
 *
 * @param lastSlot the last slot already enqueued for this routine, or `null`.
 */
export function dueSlot(routine: Routine, now: Date, lastSlot: Date | null): DueSlot | null {
  if (!routine.frontmatter.enabled) return null;
  const catchUpMs = routine.frontmatter.catch_up_minutes * MINUTE_MS;
  const nowMs = now.getTime();
  const lastMs = lastSlot === null ? null : lastSlot.getTime();

  if (routine.onceAt !== undefined) {
    const at = routine.onceAt.getTime();
    if (at > nowMs) return null;
    if (nowMs - at > catchUpMs) return null;
    if (lastMs !== null && lastMs >= at) return null;
    return { slot: routine.onceAt, missedSlot: null };
  }

  const cron = cronFor(routine);
  if (cron === null) return null;

  const windowStart = new Date(nowMs - catchUpMs);
  const slot = cron.nextRun(windowStart);
  if (slot === null) return null;
  if (slot.getTime() > nowMs) return null;
  if (lastMs !== null && slot.getTime() <= lastMs) return null;

  let missedSlot: Date | null = null;
  if (lastSlot !== null) {
    const afterLast = cron.nextRun(lastSlot);
    if (afterLast !== null && afterLast.getTime() < slot.getTime()) missedSlot = afterLast;
  }
  return { slot, missedSlot };
}

function describeDays(dow: string): string | null {
  if (dow === '*' || dow === '?') return 'every day';
  if (dow === '1-5') return 'weekdays';
  if (dow === '0,6' || dow === '6,0') return 'weekends';
  const parts = dow.split(',');
  const names: string[] = [];
  for (const part of parts) {
    if (!/^\d$/.test(part)) return null;
    const name = DAY_NAMES[Number(part) % 7];
    if (name === undefined) return null;
    names.push(name);
  }
  return names.join(', ');
}

/**
 * A short human string for a cron expression, for example `weekdays at 07:00`.
 * Falls back to the raw expression when the shape is not one of the common ones.
 */
export function describeCron(expr: string): string {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = fields;
  if (min === undefined || hour === undefined || dom === undefined) return expr;
  if (mon !== '*' || dow === undefined) return expr;

  const everyN = /^\*\/(\d+)$/;
  const minEvery = everyN.exec(min);
  if (minEvery?.[1] !== undefined && hour === '*' && dom === '*' && dow === '*') {
    return `every ${minEvery[1]} minutes`;
  }
  const hourEvery = everyN.exec(hour);
  if (hourEvery?.[1] !== undefined && /^\d+$/.test(min) && dom === '*' && dow === '*') {
    return `every ${hourEvery[1]} hours`;
  }
  if (!/^\d+$/.test(min)) return expr;

  const hours = hour.split(',');
  if (!hours.every((h) => /^\d+$/.test(h))) return expr;
  const times = hours.map((h) => `${pad(Number(h))}:${pad(Number(min))}`).join(' and ');

  if (dom !== '*') return `day ${dom} at ${times}`;
  const days = describeDays(dow);
  if (days === null) return expr;
  return `${days} at ${times}`;
}
