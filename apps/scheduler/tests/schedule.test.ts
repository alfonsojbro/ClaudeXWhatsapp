import { describe, expect, it } from 'vitest';
import { parseRoutine } from '../src/routine.js';
import {
  describeCron,
  dueSlot,
  formatInTz,
  isValidCron,
  isValidTimeZone,
  nextRun,
  parseLocalDateTimeInTz,
  tzOffsetMinutes,
} from '../src/schedule.js';
import type { Routine } from '../src/types.js';

/** Build a routine from frontmatter lines, without touching the filesystem. */
function routine(name: string, lines: string[]): Routine {
  const text = `---\nname: ${name}\n${lines.join('\n')}\n---\nbody\n`;
  return parseRoutine(text, `/virtual/${name}.md`);
}

const cron = (name: string, expr: string, extra: string[] = []): Routine =>
  routine(name, [`schedule: "${expr}"`, ...extra]);

describe('tzOffsetMinutes', () => {
  it('tracks DST for Europe/Prague', () => {
    expect(tzOffsetMinutes('Europe/Prague', new Date('2026-09-03T00:00:00Z'))).toBe(120);
    expect(tzOffsetMinutes('Europe/Prague', new Date('2026-12-01T00:00:00Z'))).toBe(60);
  });

  it('is constant for a zone without DST', () => {
    expect(tzOffsetMinutes('America/Managua', new Date('2026-09-03T00:00:00Z'))).toBe(-360);
    expect(tzOffsetMinutes('America/Managua', new Date('2026-12-01T00:00:00Z'))).toBe(-360);
  });

  it('is zero for UTC', () => {
    expect(tzOffsetMinutes('UTC', new Date('2026-09-03T12:34:56Z'))).toBe(0);
  });
});

describe('formatInTz', () => {
  const instant = new Date('2026-09-03T05:00:00Z');

  it('renders the weekday and time by default', () => {
    expect(formatInTz(instant, 'Europe/Prague')).toBe('Thu 07:00');
  });

  it('renders other styles', () => {
    expect(formatInTz(instant, 'Europe/Prague', 'datetime')).toBe('2026-09-03 07:00');
    expect(formatInTz(instant, 'Europe/Prague', 'date')).toBe('2026-09-03');
    expect(formatInTz(instant, 'Europe/Prague', 'time')).toBe('07:00');
  });

  it('renders midnight as 00:00', () => {
    expect(formatInTz(new Date('2026-09-02T22:00:00Z'), 'Europe/Prague', 'time')).toBe('00:00');
  });
});

describe('parseLocalDateTimeInTz', () => {
  it('reads a bare local datetime in the given zone', () => {
    expect(parseLocalDateTimeInTz('2026-09-05T09:00', 'Europe/Prague')?.toISOString()).toBe(
      '2026-09-05T07:00:00.000Z',
    );
    expect(parseLocalDateTimeInTz('2026-12-05 09:00', 'Europe/Prague')?.toISOString()).toBe(
      '2026-12-05T08:00:00.000Z',
    );
  });

  it('respects an explicit offset', () => {
    expect(parseLocalDateTimeInTz('2026-09-05T09:00:00Z', 'Europe/Prague')?.toISOString()).toBe(
      '2026-09-05T09:00:00.000Z',
    );
  });

  it('returns null for nonsense', () => {
    expect(parseLocalDateTimeInTz('next tuesday', 'Europe/Prague')).toBeNull();
    expect(parseLocalDateTimeInTz('', 'Europe/Prague')).toBeNull();
  });
});

describe('isValidCron / isValidTimeZone', () => {
  it('accepts good values', () => {
    expect(isValidCron('0 7 * * 1-5')).toBe(true);
    expect(isValidTimeZone('Europe/Prague')).toBe(true);
  });

  it('rejects bad values', () => {
    expect(isValidCron('not a cron')).toBe(false);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('nextRun', () => {
  it('resolves 07:00 weekdays in Europe/Prague', () => {
    const r = cron('morning-brief', '0 7 * * 1-5', ['timezone: Europe/Prague']);
    expect(nextRun(r, new Date('2026-09-03T00:00:00Z'))?.toISOString()).toBe(
      '2026-09-03T05:00:00.000Z',
    );
  });

  it('resolves the same expression in America/Managua', () => {
    const r = cron('morning-brief', '0 7 * * 1-5', ['timezone: America/Managua']);
    expect(nextRun(r, new Date('2026-09-03T00:00:00Z'))?.toISOString()).toBe(
      '2026-09-03T13:00:00.000Z',
    );
  });

  it('shifts by an hour after the Prague DST change', () => {
    const r = cron('morning-brief', '0 7 * * 1-5', ['timezone: Europe/Prague']);
    // 2026-10-25 is the last Sunday of October: Prague falls back to UTC+1.
    expect(nextRun(r, new Date('2026-10-26T00:00:00Z'))?.toISOString()).toBe(
      '2026-10-26T06:00:00.000Z',
    );
  });

  it('returns null for a disabled routine', () => {
    const r = cron('morning-brief', '0 7 * * 1-5', ['enabled: false']);
    expect(nextRun(r, new Date('2026-09-03T00:00:00Z'))).toBeNull();
  });

  it('returns the once instant while it is still in the future, then null', () => {
    const r = routine('reminder-x', ['once: "2026-09-05T09:00"', 'timezone: Europe/Prague']);
    expect(nextRun(r, new Date('2026-09-04T00:00:00Z'))?.toISOString()).toBe(
      '2026-09-05T07:00:00.000Z',
    );
    expect(nextRun(r, new Date('2026-09-06T00:00:00Z'))).toBeNull();
  });
});

describe('dueSlot (cron)', () => {
  const r = cron('morning-brief', '0 7 * * 1-5', [
    'timezone: Europe/Prague',
    'catch_up_minutes: 10',
  ]);

  it('fires inside the catch-up window', () => {
    const due = dueSlot(r, new Date('2026-09-03T05:05:00Z'), null);
    expect(due?.slot.toISOString()).toBe('2026-09-03T05:00:00.000Z');
    expect(due?.missedSlot).toBeNull();
  });

  it('does not fire before the slot arrives', () => {
    expect(dueSlot(r, new Date('2026-09-03T04:59:00Z'), null)).toBeNull();
  });

  it('does not fire once the catch-up window has passed', () => {
    expect(dueSlot(r, new Date('2026-09-03T05:15:00Z'), null)).toBeNull();
  });

  it('does not fire the same slot twice', () => {
    const slot = new Date('2026-09-03T05:00:00Z');
    expect(dueSlot(r, new Date('2026-09-03T05:05:00Z'), slot)).toBeNull();
  });

  it('reports the first slot missed during an outage', () => {
    const due = dueSlot(r, new Date('2026-09-03T05:05:00Z'), new Date('2026-09-01T05:00:00Z'));
    expect(due?.slot.toISOString()).toBe('2026-09-03T05:00:00.000Z');
    expect(due?.missedSlot?.toISOString()).toBe('2026-09-02T05:00:00.000Z');
  });

  it('reports no missed slot when the previous run was the previous slot', () => {
    const due = dueSlot(r, new Date('2026-09-03T05:05:00Z'), new Date('2026-09-02T05:00:00Z'));
    expect(due?.missedSlot).toBeNull();
  });

  it('never fires a disabled routine', () => {
    const off = cron('morning-brief', '0 7 * * 1-5', ['timezone: Europe/Prague', 'enabled: false']);
    expect(dueSlot(off, new Date('2026-09-03T05:05:00Z'), null)).toBeNull();
  });
});

describe('dueSlot (once)', () => {
  const r = routine('reminder-x', [
    'once: "2026-09-05T09:00"',
    'timezone: Europe/Prague',
    'catch_up_minutes: 60',
  ]);

  it('does not fire early', () => {
    expect(dueSlot(r, new Date('2026-09-05T06:59:00Z'), null)).toBeNull();
  });

  it('fires inside the window', () => {
    const due = dueSlot(r, new Date('2026-09-05T07:30:00Z'), null);
    expect(due?.slot.toISOString()).toBe('2026-09-05T07:00:00.000Z');
  });

  it('expires after the window', () => {
    expect(dueSlot(r, new Date('2026-09-05T08:30:00Z'), null)).toBeNull();
  });

  it('does not fire again once recorded', () => {
    const fired = new Date('2026-09-05T07:00:00Z');
    expect(dueSlot(r, new Date('2026-09-05T07:30:00Z'), fired)).toBeNull();
  });
});

describe('describeCron', () => {
  it('renders the common shapes', () => {
    expect(describeCron('0 7 * * 1-5')).toBe('weekdays at 07:00');
    expect(describeCron('0 21 * * *')).toBe('every day at 21:00');
    expect(describeCron('0 12,18 * * *')).toBe('every day at 12:00 and 18:00');
    expect(describeCron('0 9 * * 1,4')).toBe('Mon, Thu at 09:00');
    expect(describeCron('*/10 * * * *')).toBe('every 10 minutes');
    expect(describeCron('0 */2 * * *')).toBe('every 2 hours');
    expect(describeCron('0 18 * * 0')).toBe('Sun at 18:00');
  });

  it('falls back to the raw expression', () => {
    expect(describeCron('5 4 3 2 1-3')).toBe('5 4 3 2 1-3');
    expect(describeCron('nonsense')).toBe('nonsense');
  });
});
