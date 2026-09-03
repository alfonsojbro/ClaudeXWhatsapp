import { describe, expect, it } from 'vitest';
import {
  dayInTz,
  formatInTz,
  formatOffset,
  hasExplicitOffset,
  hasThirdParty,
  isOwner,
  resolveDay,
  timeInTz,
  toZonedIso,
  tzOffsetMs,
  zonedDayRange,
  zonedMidnight,
} from './range.js';

const TZ = 'Europe/Prague';

describe('tzOffsetMs / formatOffset', () => {
  it('knows winter and summer time', () => {
    expect(tzOffsetMs(new Date('2026-01-15T12:00:00Z'), TZ)).toBe(3_600_000);
    expect(tzOffsetMs(new Date('2026-07-15T12:00:00Z'), TZ)).toBe(7_200_000);
    expect(tzOffsetMs(new Date('2026-07-15T12:00:00Z'), 'UTC')).toBe(0);
  });

  it('renders offsets', () => {
    expect(formatOffset(0)).toBe('Z');
    expect(formatOffset(7_200_000)).toBe('+02:00');
    expect(formatOffset(-5 * 3_600_000)).toBe('-05:00');
    expect(formatOffset(5.5 * 3_600_000)).toBe('+05:30');
  });
});

describe('zonedDayRange', () => {
  it('covers an ordinary day', () => {
    expect(zonedDayRange('2026-09-04', TZ)).toEqual({
      timeMin: '2026-09-04T00:00:00+02:00',
      timeMax: '2026-09-05T00:00:00+02:00',
    });
  });

  it('covers the spring-forward day', () => {
    expect(zonedDayRange('2026-03-29', TZ)).toEqual({
      timeMin: '2026-03-29T00:00:00+01:00',
      timeMax: '2026-03-30T00:00:00+02:00',
    });
  });

  it('covers the fall-back day', () => {
    expect(zonedDayRange('2026-10-25', TZ)).toEqual({
      timeMin: '2026-10-25T00:00:00+02:00',
      timeMax: '2026-10-26T00:00:00+01:00',
    });
  });

  it('crosses a month end', () => {
    expect(zonedDayRange('2026-01-31', TZ).timeMax).toBe('2026-02-01T00:00:00+01:00');
  });

  it('rejects junk', () => {
    expect(() => zonedDayRange('tomorrow', TZ)).toThrow(/YYYY-MM-DD/u);
  });

  it('places midnight at the right instant', () => {
    expect(zonedMidnight('2026-09-04', TZ).toISOString()).toBe('2026-09-03T22:00:00.000Z');
    expect(toZonedIso(new Date('2026-09-03T22:00:00Z'), TZ)).toBe('2026-09-04T00:00:00+02:00');
  });
});

describe('resolveDay', () => {
  const now = new Date('2026-09-04T21:30:00Z'); // 23:30 local

  it('handles the relative words', () => {
    expect(resolveDay('today', now, TZ)).toBe('2026-09-04');
    expect(resolveDay('tomorrow', now, TZ)).toBe('2026-09-05');
    expect(resolveDay('yesterday', now, TZ)).toBe('2026-09-03');
  });

  it('passes an explicit date through', () => {
    expect(resolveDay('2026-12-24', now, TZ)).toBe('2026-12-24');
  });

  it('crosses a month end', () => {
    expect(resolveDay('tomorrow', new Date('2026-01-31T10:00:00Z'), TZ)).toBe('2026-02-01');
    expect(resolveDay('tomorrow', new Date('2026-12-31T10:00:00Z'), TZ)).toBe('2027-01-01');
    expect(resolveDay('yesterday', new Date('2026-03-01T10:00:00Z'), TZ)).toBe('2026-02-28');
  });

  it('uses the local day, not the UTC one', () => {
    expect(resolveDay('today', new Date('2026-09-04T22:30:00Z'), TZ)).toBe('2026-09-05');
    expect(dayInTz(new Date('2026-09-04T22:30:00Z'), TZ)).toBe('2026-09-05');
  });

  it('rejects junk', () => {
    expect(() => resolveDay('next week', now, TZ)).toThrow(/today, tomorrow/u);
  });
});

describe('formatInTz', () => {
  it('renders weekday, date and local time', () => {
    expect(formatInTz('2026-09-04T12:00:00Z', TZ)).toBe('Fri 2026-09-04 14:00');
    expect(timeInTz('2026-09-04T12:00:00Z', TZ)).toBe('14:00');
  });

  it('shows midnight as 00:00', () => {
    expect(formatInTz('2026-09-03T22:00:00Z', TZ)).toBe('Fri 2026-09-04 00:00');
  });

  it('passes an unparseable value through', () => {
    expect(formatInTz('not-a-date', TZ)).toBe('not-a-date');
  });
});

describe('isOwner / hasThirdParty', () => {
  const owner = 'me@example.com';

  it('compares case- and space-insensitively', () => {
    expect(isOwner(' Me@Example.COM ', owner)).toBe(true);
    expect(isOwner('other@example.com', owner)).toBe(false);
    expect(isOwner(undefined, owner)).toBe(false);
  });

  it('detects third parties in both shapes', () => {
    expect(hasThirdParty(undefined, owner)).toBe(false);
    expect(hasThirdParty([], owner)).toBe(false);
    expect(hasThirdParty(['ME@example.com'], owner)).toBe(false);
    expect(hasThirdParty([{ email: 'me@example.com' }, { email: '' }], owner)).toBe(false);
    expect(hasThirdParty(['ana@example.com'], owner)).toBe(true);
    expect(hasThirdParty([{ email: 'me@example.com' }, { email: 'ana@example.com' }], owner)).toBe(
      true,
    );
  });
});

describe('hasExplicitOffset', () => {
  it('accepts Z and every offset spelling', () => {
    expect(hasExplicitOffset('2026-09-04T14:00:00Z')).toBe(true);
    expect(hasExplicitOffset('2026-09-04T14:00:00z')).toBe(true);
    expect(hasExplicitOffset('2026-09-04T14:00:00+02:00')).toBe(true);
    expect(hasExplicitOffset('2026-09-04T14:00:00-0500')).toBe(true);
    expect(hasExplicitOffset('2026-09-04T14:00:00.123+02:00')).toBe(true);
    expect(hasExplicitOffset(' 2026-09-04T14:00:00+02 ')).toBe(true);
  });

  it('rejects naive wall-clock values', () => {
    expect(hasExplicitOffset('2026-09-04T14:00:00')).toBe(false);
    expect(hasExplicitOffset('2026-09-04T14:00')).toBe(false);
    expect(hasExplicitOffset('2026-09-04T14:00:00.123')).toBe(false);
    expect(hasExplicitOffset('2026-09-04')).toBe(false);
  });
});
