import { describe, expect, it } from 'vitest';
import { parseSchedulePhrase } from '../src/commands/schedule-phrase.js';

describe('parseSchedulePhrase', () => {
  it('reads the four canonical forms', () => {
    expect(parseSchedulePhrase('every weekday at 7')?.cron).toBe('0 7 * * 1-5');
    expect(parseSchedulePhrase('every day at 7:30pm')?.cron).toBe('30 19 * * *');
    expect(parseSchedulePhrase('every monday and thursday at 9')?.cron).toBe('0 9 * * 1,4');
    expect(parseSchedulePhrase('every 30 minutes')?.cron).toBe('*/30 * * * *');
  });

  it('returns null for nonsense', () => {
    expect(parseSchedulePhrase('bananas whenever')).toBeNull();
    expect(parseSchedulePhrase('')).toBeNull();
    expect(parseSchedulePhrase('every blursday at 9')).toBeNull();
    expect(parseSchedulePhrase('at 9')).toBeNull();
  });

  it('defaults day forms to 09:00 when no time is given', () => {
    expect(parseSchedulePhrase('every day')?.cron).toBe('0 9 * * *');
    expect(parseSchedulePhrase('every weekday')?.cron).toBe('0 9 * * 1-5');
    expect(parseSchedulePhrase('every weekend')?.cron).toBe('0 9 * * 0,6');
  });

  it('accepts 12-hour and 24-hour times', () => {
    expect(parseSchedulePhrase('every day at 7')?.cron).toBe('0 7 * * *');
    expect(parseSchedulePhrase('every day at 7am')?.cron).toBe('0 7 * * *');
    expect(parseSchedulePhrase('every day at 12am')?.cron).toBe('0 0 * * *');
    expect(parseSchedulePhrase('every day at 12pm')?.cron).toBe('0 12 * * *');
    expect(parseSchedulePhrase('every day at 21:15')?.cron).toBe('15 21 * * *');
  });

  it('rejects impossible times', () => {
    expect(parseSchedulePhrase('every day at 25')).toBeNull();
    expect(parseSchedulePhrase('every day at 13pm')).toBeNull();
    expect(parseSchedulePhrase('every day at 9:99')).toBeNull();
  });

  it('supports several times of day when the minute matches', () => {
    expect(parseSchedulePhrase('every day at 12 and 6pm')?.cron).toBe('0 12,18 * * *');
    expect(parseSchedulePhrase('every day at 12:00 and 18:30')).toBeNull();
  });

  it('supports day lists in any separator style', () => {
    expect(parseSchedulePhrase('every mon, wed and fri at 8')?.cron).toBe('0 8 * * 1,3,5');
    expect(parseSchedulePhrase('every sunday at 18')?.cron).toBe('0 18 * * 0');
  });

  it('supports interval forms and rejects a time on them', () => {
    expect(parseSchedulePhrase('every hour')?.cron).toBe('0 * * * *');
    expect(parseSchedulePhrase('every 2 hours')?.cron).toBe('0 */2 * * *');
    expect(parseSchedulePhrase('every 5 mins')?.cron).toBe('*/5 * * * *');
    expect(parseSchedulePhrase('every 30 minutes at 9')).toBeNull();
    expect(parseSchedulePhrase('every 90 minutes')).toBeNull();
  });

  it('is case and whitespace insensitive', () => {
    expect(parseSchedulePhrase('  EVERY   Weekday   AT   7 ')?.cron).toBe('0 7 * * 1-5');
  });

  it('returns a human rendering alongside the cron', () => {
    expect(parseSchedulePhrase('every weekday at 7')?.human).toBe('weekdays at 07:00');
    expect(parseSchedulePhrase('every 30 minutes')?.human).toBe('every 30 minutes');
  });
});
