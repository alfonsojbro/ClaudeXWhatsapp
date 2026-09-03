import { describe, expect, it } from 'vitest';
import { parseReminder } from '../src/commands/reminder.js';

const TZ = 'Europe/Prague';
/** Wednesday 2026-09-02, 12:00 in Prague (CEST, UTC+2). */
const WEDNESDAY = new Date('2026-09-02T10:00:00.000Z');

describe('parseReminder', () => {
  it('reads "Friday 9am to call Marco" from a Wednesday in Prague', () => {
    const parsed = parseReminder('Friday 9am to call Marco', WEDNESDAY, TZ);
    expect(parsed).not.toBeNull();
    // Friday 2026-09-04 09:00 Prague (UTC+2) is 07:00 UTC.
    expect(parsed?.when.toISOString()).toBe('2026-09-04T07:00:00.000Z');
    expect(parsed?.what).toBe('call Marco');
  });

  it('strips a leading "remind me"', () => {
    const parsed = parseReminder('remind me Friday 9am to call Marco', WEDNESDAY, TZ);
    expect(parsed?.when.toISOString()).toBe('2026-09-04T07:00:00.000Z');
    expect(parsed?.what).toBe('call Marco');
  });

  it('accepts the subject first', () => {
    const parsed = parseReminder('call Marco on Friday at 9am', WEDNESDAY, TZ);
    expect(parsed?.when.toISOString()).toBe('2026-09-04T07:00:00.000Z');
    expect(parsed?.what).toBe('call Marco');
  });

  it('resolves the time in the given timezone', () => {
    const prague = parseReminder('Friday 9am to call Marco', WEDNESDAY, TZ);
    const managua = parseReminder('Friday 9am to call Marco', WEDNESDAY, 'America/Managua');
    expect(prague?.when.toISOString()).toBe('2026-09-04T07:00:00.000Z');
    // Managua is UTC-6 all year.
    expect(managua?.when.toISOString()).toBe('2026-09-04T15:00:00.000Z');
  });

  it('looks forward: "9am" on a Wednesday afternoon means tomorrow', () => {
    const parsed = parseReminder('at 9am to stretch', WEDNESDAY, TZ);
    expect(parsed?.when.toISOString()).toBe('2026-09-03T07:00:00.000Z');
    expect(parsed?.what).toBe('stretch');
  });

  it('handles relative phrases', () => {
    const parsed = parseReminder('in 2 hours to drink water', WEDNESDAY, TZ);
    expect(parsed?.when.getTime()).toBe(WEDNESDAY.getTime() + 2 * 60 * 60 * 1000);
    expect(parsed?.what).toBe('drink water');
  });

  it('returns null for a time in the past', () => {
    expect(parseReminder('yesterday at 9am to call Marco', WEDNESDAY, TZ)).toBeNull();
  });

  it('returns null when there is no time', () => {
    expect(parseReminder('to call Marco', WEDNESDAY, TZ)).toBeNull();
    expect(parseReminder('', WEDNESDAY, TZ)).toBeNull();
  });

  it('resolves a time across the 2026-10-25 Prague DST boundary', () => {
    // Tuesday 2026-10-20 12:00 Prague is still CEST (UTC+2); 2026-10-26 is CET (UTC+1).
    const beforeDst = new Date('2026-10-20T10:00:00.000Z');
    const parsed = parseReminder('October 26 at 9am to call Marco', beforeDst, TZ);
    expect(parsed).not.toBeNull();
    expect(parsed?.when.toISOString()).toBe('2026-10-26T08:00:00.000Z');
    expect(parsed?.what).toBe('call Marco');
  });

  it('returns null when there is no subject', () => {
    expect(parseReminder('Friday 9am', WEDNESDAY, TZ)).toBeNull();
  });
});
