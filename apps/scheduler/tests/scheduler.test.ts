import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import type { Db } from '../src/db.js';
import { createLogger } from '../src/log.js';
import { openDb } from '../src/db.js';
import { buildJobPrompt, parseStatusMarker } from '../src/prompt.js';
import { getRun, history } from '../src/runs.js';
import { Scheduler } from '../src/scheduler.js';
import type { SchedulerDeps } from '../src/scheduler.js';
import { enqueue, pendingFor } from '../src/spool.js';
import { StaticRunner } from '../src/runner/static.js';
import type { CalendarEvent } from '../src/types.js';
import {
  FakeCalendar,
  FakeDeliverer,
  FakeRunner,
  FixedClock,
  fakeHealthDeps,
  makeTempVault,
  testConfig,
  type TempVault,
} from './helpers.js';

/** Thursday 2026-09-03, 07:00 in Europe/Prague. */
const T0 = new Date('2026-09-03T05:00:00Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);
const MINUTE = 60_000;

let vault: TempVault;
let db: Db;
let clock: FixedClock;
let runner: FakeRunner;
let deliverer: FakeDeliverer;
let config: Config;

beforeEach(() => {
  vault = makeTempVault();
  db = openDb(':memory:');
  clock = new FixedClock(T0);
  runner = new FakeRunner();
  deliverer = new FakeDeliverer();
  config = testConfig(vault);
});

afterEach(() => {
  db.close();
  vault.cleanup();
});

function build(overrides: Partial<SchedulerDeps> = {}): Scheduler {
  const deps: SchedulerDeps = {
    db,
    config,
    clock,
    llmRunner: runner,
    staticRunner: new StaticRunner(),
    health: fakeHealthDeps(),
    deliverer,
    logger: createLogger('test', { LOG_LEVEL: 'silent' }),
    ...overrides,
  };
  return new Scheduler(deps);
}

function writeMorningBrief(): void {
  vault.writeRoutine(
    'morning-brief',
    ['schedule: "0 7 * * 1-5"', 'timezone: Europe/Prague', 'tools: []'].join('\n'),
    'Summarise today.',
  );
}

describe('cron runs', () => {
  it('runs morning-brief once at its 07:00 slot and writes a run log', async () => {
    writeMorningBrief();
    runner.pushText('Three meetings today.\n\nSTATUS: done');
    const scheduler = build();

    await scheduler.tick(T0);

    await scheduler.idle();

    expect(runner.calls.map((c) => c.routine)).toEqual(['morning-brief']);
    expect(deliverer.sends).toEqual([{ to: 'owner', text: 'Three meetings today.' }]);

    const logs = vault.runLogs('morning-brief');
    expect(logs.length).toBe(1);
    const logText = fs.readFileSync(
      path.join(vault.dir, 'runs', 'morning-brief', logs[0] ?? ''),
      'utf8',
    );
    expect(logText).toContain('status: done');
    expect(logText).toContain('Three meetings today.');

    const runs = history(db, 'morning-brief');
    expect(runs.length).toBe(1);
    expect(runs[0]?.status).toBe('done');
    expect(runs[0]?.deliveredAt).not.toBeNull();
    expect(runs[0]?.logPath).toContain('morning-brief');
    expect(pendingFor(db, 'morning-brief')).toEqual([]);
  });

  it('does not run the same slot again 30 seconds later', async () => {
    writeMorningBrief();
    const scheduler = build();

    await scheduler.tick(T0);

    await scheduler.idle();
    clock.set(at(30_000));
    await scheduler.tick(at(30_000));
    await scheduler.idle();

    expect(runner.calls.length).toBe(1);
    expect(deliverer.sends.length).toBe(1);
    expect(history(db, 'morning-brief').length).toBe(1);
  });

  it('passes a prompt carrying the routine body and the output contract', async () => {
    writeMorningBrief();
    const scheduler = build();

    await scheduler.tick(T0);

    await scheduler.idle();

    const prompt = runner.calls[0]?.prompt ?? '';
    expect(prompt).toContain('Routine: morning-brief');
    expect(prompt).toContain('Summarise today.');
    expect(prompt).toContain('STATUS: done');
  });
});

describe('failure handling', () => {
  it('spools a failed run with backoff and creates no duplicate run rows', async () => {
    writeMorningBrief();
    runner.pushFailure('rate_limit');
    const scheduler = build();

    await scheduler.tick(T0);

    await scheduler.idle();

    const runs = history(db, 'morning-brief');
    expect(runs.length).toBe(1);
    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.error).toBe('rate_limit');
    expect(deliverer.sends).toEqual([]);

    const pending = pendingFor(db, 'morning-brief');
    expect(pending.length).toBe(1);
    expect(pending[0]?.stage).toBe('run');
    expect(pending[0]?.attempts).toBe(1);
    expect(pending[0]?.lastError).toBe('rate_limit');
    expect(pending[0]?.nextAttemptAt).toBeGreaterThan(T0.getTime());

    // A tick before the backoff expires must not retry.
    clock.set(at(30_000));
    await scheduler.tick(at(30_000));
    await scheduler.idle();
    expect(runner.calls.length).toBe(1);
    expect(history(db, 'morning-brief').length).toBe(1);
  });

  it('retries the failed run after the backoff, reusing the same run row', async () => {
    writeMorningBrief();
    runner.pushFailure('rate_limit').pushText('Recovered.\n\nSTATUS: done');
    const scheduler = build();

    await scheduler.tick(T0);

    await scheduler.idle();
    clock.set(at(5 * MINUTE));
    await scheduler.tick(at(5 * MINUTE));
    await scheduler.idle();

    expect(runner.calls.length).toBe(2);
    const runs = history(db, 'morning-brief');
    expect(runs.length).toBe(1);
    expect(runs[0]?.status).toBe('done');
    expect(deliverer.sends.length).toBe(1);
  });

  it('moves the item to the deliver stage when delivery fails, without re-running the job', async () => {
    writeMorningBrief();
    runner.pushText('Three meetings today.\n\nSTATUS: done');
    deliverer.failNext(1);
    const scheduler = build();

    await scheduler.tick(T0);

    await scheduler.idle();

    expect(runner.calls.length).toBe(1);
    expect(deliverer.sends).toEqual([]);

    const pending = pendingFor(db, 'morning-brief');
    expect(pending.length).toBe(1);
    expect(pending[0]?.stage).toBe('deliver');
    expect(pending[0]?.payload).toBe('Three meetings today.');

    const runs = history(db, 'morning-brief');
    expect(runs[0]?.status).toBe('done');
    expect(runs[0]?.deliveredAt).toBeNull();

    // The next tick delivers from the payload and never touches the runner again.
    clock.set(at(MINUTE));
    await scheduler.tick(at(MINUTE));
    await scheduler.idle();
    expect(runner.calls.length).toBe(1);
    expect(deliverer.sends).toEqual([{ to: 'owner', text: 'Three meetings today.' }]);
    expect(getRun(db, runs[0]?.id ?? 0)?.deliveredAt).not.toBeNull();
    expect(pendingFor(db, 'morning-brief')).toEqual([]);
  });
});

describe('statuses and once routines', () => {
  it('records STATUS: needs_input as the run status', async () => {
    vault.writeRoutine(
      'evening-close',
      ['schedule: "0 7 * * *"', 'timezone: Europe/Prague'].join('\n'),
      'Close the day.',
    );
    runner.pushText('How did today go?\n\nSTATUS: needs_input');
    const scheduler = build();

    await scheduler.tick(T0);

    await scheduler.idle();

    const runs = history(db, 'evening-close');
    expect(runs[0]?.status).toBe('needs_input');
    expect(deliverer.sends[0]?.text).toBe('How did today go?');
  });

  it('deletes a once routine file after it is delivered', async () => {
    vault.writeRoutine(
      'reminder-call-marco',
      ['once: 2026-09-03T07:00', 'timezone: Europe/Prague', 'kind: static'].join('\n'),
      'Reminder: call Marco',
    );
    const scheduler = build();

    await scheduler.tick(T0);

    await scheduler.idle();

    expect(deliverer.sends).toEqual([{ to: 'owner', text: 'Reminder: call Marco' }]);
    expect(vault.hasRoutine('reminder-call-marco')).toBe(false);
    expect(history(db, 'reminder-call-marco')[0]?.status).toBe('done');
    expect(runner.calls).toEqual([]);
  });
});

describe('health routines', () => {
  function writeHealthCheck(): void {
    vault.writeRoutine(
      'health-check',
      [
        'schedule: "*/10 * * * *"',
        'timezone: Europe/Prague',
        'kind: health',
        'catch_up_minutes: 1',
      ].join('\n'),
      'Check the box.',
    );
  }

  it('uses the health runner, never the LLM, and alerts only when a check changes state', async () => {
    writeHealthCheck();
    const scheduler = build({
      health: fakeHealthDeps({ statfs: () => Promise.resolve({ blocks: 100, bfree: 1 }) }),
    });

    await scheduler.tick(T0);

    await scheduler.idle();

    expect(runner.calls).toEqual([]);
    expect(deliverer.sends.length).toBe(1);
    expect(deliverer.sends[0]?.text).toContain('disk is down');

    // The next slot: still failing, so no second alert.
    clock.set(at(10 * MINUTE));
    await scheduler.tick(at(10 * MINUTE));
    await scheduler.idle();
    expect(deliverer.sends.length).toBe(1);
    expect(history(db, 'health-check').length).toBe(2);
  });

  it('alerts again when a check recovers', async () => {
    writeHealthCheck();
    let free = 1;
    const scheduler = build({
      health: fakeHealthDeps({ statfs: () => Promise.resolve({ blocks: 100, bfree: free }) }),
    });

    await scheduler.tick(T0);

    await scheduler.idle();
    free = 90;
    clock.set(at(10 * MINUTE));
    await scheduler.tick(at(10 * MINUTE));
    await scheduler.idle();

    expect(deliverer.sends.length).toBe(2);
    expect(deliverer.sends[1]?.text).toContain('Recovered');
  });

  it('stays quiet and writes no run log while everything is healthy', async () => {
    writeHealthCheck();
    const scheduler = build();

    await scheduler.tick(T0);

    await scheduler.idle();

    expect(deliverer.sends).toEqual([]);
    expect(vault.runLogs('health-check')).toEqual([]);
    expect(history(db, 'health-check')[0]?.status).toBe('done');
  });

  it('sends the alert by e-mail when the whatsapp check itself is down', async () => {
    writeHealthCheck();
    const emails: { subject: string; body: string }[] = [];
    const scheduler = build({
      health: fakeHealthDeps({ checkBridge: () => Promise.resolve(false) }),
      emailAlert: (subject, body): Promise<void> => {
        emails.push({ subject, body });
        return Promise.resolve();
      },
    });

    await scheduler.tick(T0);

    await scheduler.idle();

    expect(deliverer.sends).toEqual([]);
    expect(emails.length).toBe(1);
    expect(emails[0]?.body).toContain('whatsapp is down');
  });
});

describe('calendar triggers', () => {
  it('spools a run one lead time before a meeting with other attendees', async () => {
    vault.writeRoutine(
      'meeting-prep',
      [
        'schedule: "*/5 * * * *"',
        'timezone: Europe/Prague',
        'trigger:',
        '  type: calendar',
        '  lead_minutes: 15',
        '  require_attendees: true',
      ].join('\n'),
      'Prepare for the meeting.',
    );

    const withGuest: CalendarEvent = {
      id: 'evt-1',
      summary: 'Design sync',
      start: at(18 * MINUTE),
      end: at(48 * MINUTE),
      attendees: [
        { email: 'me@example.com', self: true },
        { email: 'guest@example.com', self: false },
      ],
    };
    const solo: CalendarEvent = {
      id: 'evt-2',
      summary: 'Focus block',
      start: at(19 * MINUTE),
      end: at(49 * MINUTE),
      attendees: [{ email: 'me@example.com', self: true }],
    };
    const calendar = new FakeCalendar([withGuest, solo]);
    const scheduler = build({ calendar });

    await scheduler.tick(T0);

    await scheduler.idle();

    const pending = pendingFor(db, 'meeting-prep');
    expect(pending.length).toBe(1);
    expect(pending[0]?.trigger).toBe('calendar');
    expect(pending[0]?.nextAttemptAt).toBe(at(3 * MINUTE).getTime());
    expect(pending[0]?.payload).toContain('Design sync');
    expect(runner.calls).toEqual([]);

    // At the lead time the run happens, with the event injected into the prompt.
    clock.set(at(3 * MINUTE));
    await scheduler.tick(at(3 * MINUTE));
    await scheduler.idle();
    expect(runner.calls.length).toBe(1);
    expect(runner.calls[0]?.prompt).toContain('Design sync');
    expect(deliverer.sends.length).toBe(1);
  });
});

describe('manual runs', () => {
  it('`run weekly-review` on demand: the queued run executes, logs and delivers', async () => {
    vault.writeRoutine(
      'weekly-review',
      ['schedule: "0 18 * * 0"', 'timezone: Europe/Prague'].join('\n'),
      'Review the week.',
    );
    runner.pushText('Week in numbers.\n\nSTATUS: done');
    const scheduler = build();

    // This is exactly what the brain's `run <name>` command does.
    const queued = enqueue(db, {
      name: 'weekly-review',
      slot: T0,
      trigger: 'manual',
      stage: 'run',
      now: T0,
    });
    expect(queued.inserted).toBe(true);

    await scheduler.tick(T0);

    await scheduler.idle();

    expect(runner.calls.map((c) => c.routine)).toEqual(['weekly-review']);
    expect(deliverer.sends).toEqual([{ to: 'owner', text: 'Week in numbers.' }]);

    const logs = vault.runLogs('weekly-review');
    expect(logs.length).toBe(1);
    const logText = fs.readFileSync(
      path.join(vault.dir, 'runs', 'weekly-review', logs[0] ?? ''),
      'utf8',
    );
    expect(logText).toContain('trigger: manual');
    expect(logText).toContain('Week in numbers.');

    const runs = history(db, 'weekly-review');
    expect(runs[0]?.status).toBe('done');
    expect(runs[0]?.trigger).toBe('manual');
    expect(runs[0]?.deliveredAt).not.toBeNull();
    expect(pendingFor(db, 'weekly-review')).toEqual([]);
  });
});

describe('routine loading', () => {
  it('ignores a disabled routine and survives an invalid file', async () => {
    vault.writeRoutine(
      'morning-brief',
      ['schedule: "0 7 * * 1-5"', 'timezone: Europe/Prague', 'enabled: false'].join('\n'),
      'Summarise today.',
    );
    fs.writeFileSync(path.join(vault.routinesDir, 'broken.md'), '---\nname: broken\n---\nnope\n');
    const scheduler = build();

    await scheduler.tick(T0);

    await scheduler.idle();

    expect(runner.calls).toEqual([]);
    expect(scheduler.loadedRoutines().map((r) => r.name)).toEqual(['morning-brief']);
  });
});

describe('prompt helpers', () => {
  it('treats a missing marker as done and strips a present one', () => {
    expect(parseStatusMarker('hello')).toEqual({ status: 'done', text: 'hello' });
    expect(parseStatusMarker('hello\nSTATUS: failed')).toEqual({ status: 'failed', text: 'hello' });
    expect(parseStatusMarker('hello\nstatus: needs_input\n')).toEqual({
      status: 'needs_input',
      text: 'hello',
    });
    expect(parseStatusMarker('hello\nSTATUS: whatever')).toEqual({
      status: 'done',
      text: 'hello\nSTATUS: whatever',
    });
  });

  it('renders the local time of the routine timezone in the header', () => {
    vault.writeRoutine(
      'morning-brief',
      ['schedule: "0 7 * * 1-5"', 'timezone: Europe/Prague'].join('\n'),
      'Summarise today.',
    );
    const scheduler = build();
    scheduler.tick(T0);
    const routine = scheduler.loadedRoutines()[0];
    expect(routine).toBeDefined();
    if (routine === undefined) return;
    const prompt = buildJobPrompt(routine, T0, '{"id":"evt"}');
    expect(prompt).toContain('Timezone: Europe/Prague');
    expect(prompt).toContain('{"id":"evt"}');
  });
});

describe('tick is never blocked by a running job', () => {
  it('a later tick still enqueues and runs a health routine while an LLM job hangs', async () => {
    writeMorningBrief();
    vault.writeRoutine(
      'health-check',
      [
        'schedule: "*/10 * * * *"',
        'timezone: Europe/Prague',
        'kind: health',
        'catch_up_minutes: 1',
      ].join('\n'),
      'Check the box.',
    );
    const release = runner.pushPending('Three meetings today.\n\nSTATUS: done');
    const scheduler = build({
      health: fakeHealthDeps({ statfs: () => Promise.resolve({ blocks: 100, bfree: 1 }) }),
    });

    // The brief starts and hangs. Without the fix this tick never resolves.
    await scheduler.tick(T0);
    expect(runner.calls.length).toBe(1);
    expect(history(db, 'morning-brief')[0]?.status).toBe('running');
    await vi.waitFor(() => {
      expect(pendingFor(db, 'health-check')).toEqual([]);
    });
    expect(history(db, 'health-check').length).toBe(1);

    // Ten minutes later the health slot is still enqueued and still runs.
    clock.set(at(10 * MINUTE));
    await scheduler.tick(at(10 * MINUTE));
    await vi.waitFor(() => {
      expect(history(db, 'health-check').length).toBe(2);
      expect(pendingFor(db, 'health-check')).toEqual([]);
    });
    expect(history(db, 'health-check')[0]?.status).toBe('done');
    expect(deliverer.sends.some((s) => s.text.includes('disk is down'))).toBe(true);

    // The brief is still the only LLM call, and it finishes normally once released.
    expect(runner.calls.length).toBe(1);
    expect(history(db, 'morning-brief')[0]?.status).toBe('running');
    release();
    await scheduler.idle();
    expect(history(db, 'morning-brief')[0]?.status).toBe('done');
    expect(deliverer.sends.some((s) => s.text === 'Three meetings today.')).toBe(true);
  }, 5_000);
});

describe('crash between finishing a run and clearing the spool item', () => {
  /** Re-insert the spool row a crash would have left behind. */
  function reinstateSpoolItem(name: string): void {
    const queued = enqueue(db, { name, slot: T0, trigger: 'cron', stage: 'run', now: T0 });
    expect(queued.inserted).toBe(true);
  }

  it('does not re-run a job whose result was already delivered', async () => {
    writeMorningBrief();
    runner.pushText('Three meetings today.\n\nSTATUS: done');
    const scheduler = build();

    await scheduler.tick(T0);
    await scheduler.idle();
    expect(runner.calls.length).toBe(1);
    expect(deliverer.sends.length).toBe(1);

    // Crash after markDelivered, before remove(item).
    reinstateSpoolItem('morning-brief');
    clock.set(at(MINUTE));
    await scheduler.tick(at(MINUTE));
    await scheduler.idle();

    expect(runner.calls.length).toBe(1);
    expect(deliverer.sends.length).toBe(1);
    expect(pendingFor(db, 'morning-brief')).toEqual([]);
    expect(history(db, 'morning-brief').length).toBe(1);
  });

  it('re-delivers from the run log instead of re-running when the send never happened', async () => {
    writeMorningBrief();
    runner.pushText('Three meetings today.\n\nSTATUS: done');
    const scheduler = build();

    await scheduler.tick(T0);
    await scheduler.idle();
    const run = history(db, 'morning-brief')[0];
    expect(run).toBeDefined();

    // Crash between finishRun(done) and the delivery.
    db.prepare('UPDATE runs SET delivered_at = NULL WHERE id = ?').run(run?.id ?? 0);
    deliverer.sends.length = 0;
    reinstateSpoolItem('morning-brief');

    clock.set(at(MINUTE));
    await scheduler.tick(at(MINUTE));
    await scheduler.idle();

    // The item is now a delivery, not a run.
    const staged = pendingFor(db, 'morning-brief');
    expect(staged.length).toBe(1);
    expect(staged[0]?.stage).toBe('deliver');
    expect(staged[0]?.payload).toBe('Three meetings today.');
    expect(runner.calls.length).toBe(1);

    clock.set(at(2 * MINUTE));
    await scheduler.tick(at(2 * MINUTE));
    await scheduler.idle();

    expect(runner.calls.length).toBe(1);
    expect(deliverer.sends).toEqual([{ to: 'owner', text: 'Three meetings today.' }]);
    expect(getRun(db, run?.id ?? 0)?.deliveredAt).not.toBeNull();
    expect(pendingFor(db, 'morning-brief')).toEqual([]);
  });
});

describe('health alert delivery', () => {
  it('re-alerts on the next slot when the alert could not be sent', async () => {
    vault.writeRoutine(
      'health-check',
      [
        'schedule: "*/10 * * * *"',
        'timezone: Europe/Prague',
        'kind: health',
        'catch_up_minutes: 1',
      ].join('\n'),
      'Check the box.',
    );
    deliverer.alwaysFail = true;
    const scheduler = build({
      health: fakeHealthDeps({ statfs: () => Promise.resolve({ blocks: 100, bfree: 1 }) }),
    });

    await scheduler.tick(T0);
    await scheduler.idle();
    expect(deliverer.sends).toEqual([]);

    // The failure state was not stored, so the next slot alerts again.
    deliverer.alwaysFail = false;
    clock.set(at(10 * MINUTE));
    await scheduler.tick(at(10 * MINUTE));
    await scheduler.idle();

    expect(deliverer.sends.length).toBe(1);
    expect(deliverer.sends[0]?.text).toContain('disk is down');
  });
});

describe('same-instant calendar triggers', () => {
  it('spools one prep per meeting when two start at the same time', async () => {
    vault.writeRoutine(
      'meeting-prep',
      [
        'schedule: "*/5 * * * *"',
        'timezone: Europe/Prague',
        'trigger:',
        '  type: calendar',
        '  lead_minutes: 15',
        '  require_attendees: true',
      ].join('\n'),
      'Prepare for the meeting.',
    );

    const guests = [
      { email: 'me@example.com', self: true },
      { email: 'guest@example.com', self: false },
    ];
    const first: CalendarEvent = {
      id: 'evt-a',
      summary: 'Design sync',
      start: at(18 * MINUTE),
      end: at(48 * MINUTE),
      attendees: guests,
      location: 'Room 3',
      description: 'Agenda: the new spool',
    };
    const second: CalendarEvent = {
      id: 'evt-b',
      summary: 'Budget call',
      start: at(18 * MINUTE),
      end: at(48 * MINUTE),
      attendees: guests,
    };
    const scheduler = build({ calendar: new FakeCalendar([first, second]) });

    await scheduler.tick(T0);
    await scheduler.idle();

    const pending = pendingFor(db, 'meeting-prep');
    expect(pending.length).toBe(2);
    expect(pending.map((p) => p.dedupe).sort()).toEqual(['evt-a', 'evt-b']);
    expect(pending.some((p) => (p.payload ?? '').includes('Design sync'))).toBe(true);
    expect(pending.some((p) => (p.payload ?? '').includes('Budget call'))).toBe(true);
    // The payload carries the fields meeting-prep.md promises.
    const withDetails = pending.find((p) => (p.payload ?? '').includes('Design sync'))?.payload;
    expect(withDetails).toContain('Room 3');
    expect(withDetails).toContain('Agenda: the new spool');
  });
});
