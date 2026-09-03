import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Db } from '@cxw/scheduler';
import { openDb, pendingFor, setState } from '@cxw/scheduler';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RoutineCommandContext } from '../src/commands/routines.js';
import { handleRoutineCommand } from '../src/commands/routines.js';

const TZ = 'Europe/Prague';
/** Wednesday 2026-09-02, 12:00 Prague. */
const NOW = new Date('2026-09-02T10:00:00.000Z');

let vaultDir: string;
let routinesDir: string;
let db: Db;
let ctx: RoutineCommandContext;

function writeRoutineFile(name: string, frontmatter: string, body: string): string {
  const filePath = path.join(routinesDir, `${name}.md`);
  fs.writeFileSync(filePath, `---\nname: ${name}\n${frontmatter.trim()}\n---\n\n${body}\n`, 'utf8');
  return filePath;
}

beforeEach(() => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxw-brain-'));
  routinesDir = path.join(vaultDir, 'routines');
  fs.mkdirSync(routinesDir, { recursive: true });
  db = openDb(':memory:');
  ctx = { vaultDir, db, defaultTimezone: TZ, now: () => NOW };
});

afterEach(() => {
  db.close();
  fs.rmSync(vaultDir, { recursive: true, force: true });
});

describe('handleRoutineCommand — routing', () => {
  it('returns null for an unrelated message', async () => {
    expect(await handleRoutineCommand('what is on my calendar today?', ctx)).toBeNull();
    expect(await handleRoutineCommand('running late, sorry', ctx)).toBeNull();
    expect(await handleRoutineCommand('   ', ctx)).toBeNull();
  });

  it('is case-insensitive on the verb', async () => {
    writeRoutineFile('morning-brief', 'schedule: "0 7 * * 1-5"', 'brief me');
    const reply = await handleRoutineCommand('  ROUTINES  ', ctx);
    expect(reply).toContain('morning-brief');
  });
});

describe('routines', () => {
  it('lists the next run, state and last result', async () => {
    writeRoutineFile('morning-brief', 'schedule: "0 7 * * 1-5"', 'brief me');
    writeRoutineFile('evening-close', 'schedule: "0 21 * * *"\nenabled: false', 'close the day');
    setState(db, 'morning-brief', {
      lastStatus: 'done',
      lastRunAt: new Date('2026-09-02T05:00:00.000Z').getTime(),
    });

    const reply = await handleRoutineCommand('routines', ctx);
    const lines = (reply ?? '').split('\n');
    expect(lines).toHaveLength(2);

    const brief = lines.find((l) => l.startsWith('morning-brief')) ?? '';
    expect(brief).toContain('0 7 * * 1-5 (weekdays at 07:00)');
    // Next weekday 07:00 Prague after Wednesday noon is Thursday.
    expect(brief).toContain('next Thu 07:00');
    expect(brief).toContain('enabled');
    expect(brief).toContain('last done at 2026-09-02 07:00');

    const evening = lines.find((l) => l.startsWith('evening-close')) ?? '';
    expect(evening).toContain('paused');
    expect(evening).toContain('next —');
    expect(evening).toContain('last never');
  });

  it('shows event-driven routines and one-shots differently', async () => {
    writeRoutineFile(
      'meeting-prep',
      'schedule: "*/5 * * * *"\ntrigger:\n  type: calendar\n  lead_minutes: 15',
      'prep',
    );
    writeRoutineFile('reminder-x', 'once: "2026-09-04T09:00"\nkind: static', 'ping');

    const reply = (await handleRoutineCommand('routines', ctx)) ?? '';
    expect(reply).toContain('meeting-prep · event-driven');
    expect(reply).toContain('reminder-x · once 2026-09-04 09:00');
  });

  it('says so when there are no routines', async () => {
    expect(await handleRoutineCommand('routines', ctx)).toContain('No routines yet');
  });
});

describe('run', () => {
  it('enqueues a manual spool item', async () => {
    writeRoutineFile('weekly-review', 'schedule: "0 18 * * 0"', 'review the week');

    const reply = await handleRoutineCommand('run weekly-review', ctx);
    expect(reply).toBe('Queued weekly-review. Result in about a minute.');

    const pending = pendingFor(db, 'weekly-review');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.trigger).toBe('manual');
    expect(pending[0]?.stage).toBe('run');
    expect(pending[0]?.slot).toBe(NOW.getTime());
  });

  it('says so when the routine it queues is paused', async () => {
    writeRoutineFile('weekly-review', 'schedule: "0 18 * * 0"\nenabled: false', 'review the week');

    const reply = await handleRoutineCommand('run weekly-review', ctx);
    expect(reply).toBe('Queued weekly-review (currently paused). Result in about a minute.');
    expect(pendingFor(db, 'weekly-review')).toHaveLength(1);
  });

  it('lists the available names for an unknown routine', async () => {
    writeRoutineFile('morning-brief', 'schedule: "0 7 * * 1-5"', 'brief me');
    writeRoutineFile('followups', 'schedule: "0 9 * * *"', 'follow up');

    const reply = (await handleRoutineCommand('run nope', ctx)) ?? '';
    expect(reply).toContain('No routine named "nope"');
    expect(reply).toContain('followups, morning-brief');
    expect(pendingFor(db, 'nope')).toHaveLength(0);
  });
});

describe('pause and resume', () => {
  it('flips the enabled line on disk', async () => {
    const filePath = writeRoutineFile('morning-brief', 'schedule: "0 7 * * 1-5"', 'brief me');

    const paused = (await handleRoutineCommand('pause morning-brief', ctx)) ?? '';
    expect(paused).toContain('Paused morning-brief');
    expect(fs.readFileSync(filePath, 'utf8')).toContain('enabled: false');

    const resumed = (await handleRoutineCommand('resume morning-brief', ctx)) ?? '';
    expect(resumed).toContain('Resumed morning-brief');
    expect(resumed).toContain('Next run Thu 07:00');
    expect(fs.readFileSync(filePath, 'utf8')).toContain('enabled: true');
  });

  it('reports an unknown name', async () => {
    expect(await handleRoutineCommand('pause nope', ctx)).toContain('No routine named "nope"');
  });
});

describe('history', () => {
  it('says so when a routine has never run', async () => {
    writeRoutineFile('followups', 'schedule: "0 9 * * *"', 'follow up');
    expect(await handleRoutineCommand('history followups', ctx)).toBe('No runs yet for followups.');
  });

  it('lists the recent runs newest first', async () => {
    writeRoutineFile('followups', 'schedule: "0 9 * * *"', 'follow up');
    const insert = db.prepare(
      `INSERT INTO runs (name, slot, trigger, started_at, finished_at, status, attempts,
                         log_path, error, result_preview)
       VALUES (?, ?, 'cron', ?, ?, ?, 1, ?, NULL, ?)`,
    );
    insert.run(
      'followups',
      NOW.getTime(),
      new Date('2026-09-01T07:00:00.000Z').getTime(),
      new Date('2026-09-01T07:01:00.000Z').getTime(),
      'done',
      '/vault/runs/followups/a.md',
      'two open promises',
    );
    insert.run(
      'followups',
      NOW.getTime(),
      new Date('2026-09-02T07:00:00.000Z').getTime(),
      new Date('2026-09-02T07:01:00.000Z').getTime(),
      'done',
      '/vault/runs/followups/b.md',
      'nothing open',
    );

    const lines = ((await handleRoutineCommand('history followups', ctx)) ?? '').split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('2026-09-02 09:00');
    expect(lines[0]).toContain('nothing open');
    expect(lines[0]).toContain('/vault/runs/followups/b.md');
    expect(lines[1]).toContain('two open promises');
  });
});

describe('new routine', () => {
  it('creates a file from a schedule phrase and a prompt', async () => {
    const reply =
      (await handleRoutineCommand('new routine every weekday at 7: brief me on the day', ctx)) ??
      '';
    expect(reply).toContain('Created brief-me-on-the — 0 7 * * 1-5 (weekdays at 07:00).');
    expect(reply).toContain('Next run Thu 07:00.');
    expect(reply).toContain('File: vault/routines/brief-me-on-the.md');

    const text = fs.readFileSync(path.join(routinesDir, 'brief-me-on-the.md'), 'utf8');
    expect(text).toContain('schedule: "0 7 * * 1-5"');
    expect(text).toContain('timezone: Europe/Prague');
    expect(text).toContain('model: opus');
    expect(text).toContain('tools: [google, whatsapp, vault]');
    expect(text).toContain('brief me on the day');
  });

  it('suffixes a name that is already taken', async () => {
    await handleRoutineCommand('new routine every day at 8: check the news feed', ctx);
    await handleRoutineCommand('new routine every day at 9: check the news feed', ctx);
    expect(fs.existsSync(path.join(routinesDir, 'check-the-news-feed.md'))).toBe(true);
    expect(fs.existsSync(path.join(routinesDir, 'check-the-news-feed-2.md'))).toBe(true);
  });

  it('explains the supported forms for an unparseable phrase', async () => {
    const reply = (await handleRoutineCommand('new routine whenever: do a thing', ctx)) ?? '';
    expect(reply).toContain('I could not read "whenever" as a schedule');
    expect(reply).toContain('every weekday at 7');
    expect(fs.readdirSync(routinesDir)).toHaveLength(0);
  });
});

describe('remind me', () => {
  it('writes a once + static routine file', async () => {
    const reply = await handleRoutineCommand('remind me Friday 9am to call Marco', ctx);
    expect(reply).toBe('Reminder set for 2026-09-04 09:00: call Marco');

    const files = fs.readdirSync(routinesDir);
    expect(files).toEqual(['reminder-call-marco-20260904-0900.md']);
    const text = fs.readFileSync(path.join(routinesDir, files[0] ?? ''), 'utf8');
    expect(text).toContain('once: "2026-09-04T09:00"');
    expect(text).toContain('kind: static');
    expect(text).toContain('timezone: Europe/Prague');
    expect(text).toContain('⏰ Reminder: call Marco');
  });

  it('explains itself for a past or unreadable time', async () => {
    const past =
      (await handleRoutineCommand('remind me yesterday at 9am to call Marco', ctx)) ?? '';
    expect(past).toContain('I could not set that reminder');
    const vague = (await handleRoutineCommand('remind me to call Marco', ctx)) ?? '';
    expect(vague).toContain('I could not set that reminder');
    expect(fs.readdirSync(routinesDir)).toHaveLength(0);
  });
});
