/**
 * Pure timezone helpers. Google Calendar wants offset-qualified timestamps, and
 * "today" has to mean the owner's local day, DST transitions included.
 */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/u;

/** Relative day words the calendar tools accept. */
export type DayWord = 'today' | 'tomorrow' | 'yesterday';

function partsOf(date: Date, tz: string): Record<string, number> {
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
  const out: Record<string, number> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type === 'literal') continue;
    out[part.type] = Number(part.value);
  }
  return out;
}

/** Offset of `tz` at the given instant, in milliseconds east of UTC. */
export function tzOffsetMs(date: Date, tz: string): number {
  const p = partsOf(date, tz);
  const asUtc = Date.UTC(
    p['year'] ?? 1970,
    (p['month'] ?? 1) - 1,
    p['day'] ?? 1,
    (p['hour'] ?? 0) % 24,
    p['minute'] ?? 0,
    p['second'] ?? 0,
  );
  return asUtc - date.getTime();
}

/** `+02:00` / `-05:00` / `Z` for an offset in milliseconds. */
export function formatOffset(offsetMs: number): string {
  if (offsetMs === 0) return 'Z';
  const sign = offsetMs > 0 ? '+' : '-';
  const total = Math.round(Math.abs(offsetMs) / 60_000);
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

/** The instant at which local wall-clock `YYYY-MM-DD 00:00:00` happens in `tz`. */
export function zonedMidnight(day: string, tz: string): Date {
  if (!DAY_RE.test(day)) throw new Error(`bad day ${JSON.stringify(day)}: use YYYY-MM-DD`);
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, 0, 0, 0);
  let instant = wall - tzOffsetMs(new Date(wall), tz);
  // One correction pass covers the DST jump around the candidate instant.
  instant = wall - tzOffsetMs(new Date(instant), tz);
  return new Date(instant);
}

/** ISO 8601 with the zone's own offset, e.g. `2026-03-29T00:00:00+01:00`. */
export function toZonedIso(date: Date, tz: string): string {
  const offset = tzOffsetMs(date, tz);
  const local = new Date(date.getTime() + offset);
  const iso = local.toISOString().slice(0, 19);
  return `${iso}${formatOffset(offset)}`;
}

/** Local midnight to next local midnight, as Calendar-ready timestamps. */
export function zonedDayRange(day: string, tz: string): { timeMin: string; timeMax: string } {
  const start = zonedMidnight(day, tz);
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const nextWall = new Date(Date.UTC(y, m - 1, d + 1));
  const next = `${String(nextWall.getUTCFullYear()).padStart(4, '0')}-${String(
    nextWall.getUTCMonth() + 1,
  ).padStart(2, '0')}-${String(nextWall.getUTCDate()).padStart(2, '0')}`;
  const end = zonedMidnight(next, tz);
  return { timeMin: toZonedIso(start, tz), timeMax: toZonedIso(end, tz) };
}

/** `YYYY-MM-DD` of an instant, as seen in `tz`. */
export function dayInTz(date: Date, tz: string): string {
  const p = partsOf(date, tz);
  const y = String(p['year'] ?? 1970).padStart(4, '0');
  const m = String(p['month'] ?? 1).padStart(2, '0');
  const d = String(p['day'] ?? 1).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Turn `today` / `tomorrow` / `yesterday` / `YYYY-MM-DD` into `YYYY-MM-DD`. */
export function resolveDay(word: string, now: Date, tz: string): string {
  const value = word.trim().toLowerCase();
  if (DAY_RE.test(value)) return value;
  const today = dayInTz(now, tz);
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const shift =
    value === 'tomorrow' ? 1 : value === 'yesterday' ? -1 : value === 'today' ? 0 : null;
  if (shift === null) {
    throw new Error(
      `bad day ${JSON.stringify(word)}: use today, tomorrow, yesterday or YYYY-MM-DD`,
    );
  }
  const shifted = new Date(Date.UTC(y, m - 1, d + shift));
  return shifted.toISOString().slice(0, 10);
}

/** `Wed 2026-09-04 14:00` in the owner's timezone. */
export function formatInTz(iso: string, tz: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(date);
  const p = partsOf(date, tz);
  const y = String(p['year'] ?? 1970).padStart(4, '0');
  const m = String(p['month'] ?? 1).padStart(2, '0');
  const d = String(p['day'] ?? 1).padStart(2, '0');
  const hh = String((p['hour'] ?? 0) % 24).padStart(2, '0');
  const mm = String(p['minute'] ?? 0).padStart(2, '0');
  return `${weekday} ${y}-${m}-${d} ${hh}:${mm}`;
}

/** `HH:MM` in the owner's timezone. */
export function timeInTz(iso: string, tz: string): string {
  return formatInTz(iso, tz).slice(-5);
}

/**
 * True when a datetime string names an instant on its own — it ends in `Z` or in a
 * `±HH:MM` / `±HHMM` / `±HH` UTC offset. A "naive" value such as
 * `2026-09-04T14:00:00` does not, so it must never be fed through `new Date()`:
 * that would resolve it in the *process* timezone rather than the owner's.
 */
export function hasExplicitOffset(value: string): boolean {
  const trimmed = value.trim();
  const at = trimmed.indexOf('T');
  // Without a time part there is nothing an offset could qualify — and a bare
  // `2026-09-04` would otherwise look like it ended in a `-04` offset.
  if (at === -1) return false;
  return /(?:[Zz]|[+-]\d{2}(?::?\d{2})?)$/u.test(trimmed.slice(at + 1));
}

/** Case- and whitespace-insensitive comparison against the owner's address. */
export function isOwner(email: string | null | undefined, ownerEmail: string): boolean {
  if (email === null || email === undefined) return false;
  return email.trim().toLowerCase() === ownerEmail.trim().toLowerCase();
}

/** True when at least one attendee is somebody other than the owner. */
export function hasThirdParty(
  attendees: readonly (string | { email?: string | null })[] | null | undefined,
  ownerEmail: string,
): boolean {
  if (!Array.isArray(attendees)) return false;
  return attendees.some((a) => {
    const email = typeof a === 'string' ? a : (a.email ?? '');
    if (email.trim() === '') return false;
    return !isOwner(email, ownerEmail);
  });
}
