import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db.js';
import { openDb } from '../src/db.js';
import { claimLease } from '../src/lease.js';
import {
  findRunBySlot,
  finishRun,
  getRun,
  getState,
  history,
  markDelivered,
  markStaleRunning,
  recordSkipped,
  reopenRun,
  runLogStamp,
  setState,
  startRun,
  writeRunLog,
} from '../src/runs.js';

const T0 = new Date('2026-09-03T05:00:00Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
});

function open(name = 'morning-brief', slot = T0): number {
  return startRun(db, { name, slot, trigger: 'cron', startedAt: slot });
}

describe('startRun and finishRun', () => {
  it('opens a running row', () => {
    const id = open();
    const run = getRun(db, id);
    expect(run?.status).toBe('running');
    expect(run?.finishedAt).toBeNull();
    expect(run?.trigger).toBe('cron');
  });

  it('closes the row with the outcome', () => {
    const id = open();
    finishRun(db, id, {
      status: 'done',
      finishedAt: at(5_000),
      logPath: '/vault/runs/morning-brief/x.md',
      resultPreview: 'three meetings today',
      costUsd: 0.12,
      attempts: 1,
    });
    const run = getRun(db, id);
    expect(run?.status).toBe('done');
    expect(run?.finishedAt).toBe(at(5_000).getTime());
    expect(run?.logPath).toBe('/vault/runs/morning-brief/x.md');
    expect(run?.resultPreview).toBe('three meetings today');
    expect(run?.costUsd).toBeCloseTo(0.12);
    expect(run?.attempts).toBe(1);
  });

  it('mirrors the outcome into routine_state', () => {
    const id = open();
    finishRun(db, id, { status: 'needs_input', finishedAt: at(1_000) });
    const state = getState(db, 'morning-brief');
    expect(state?.lastStatus).toBe('needs_input');
    expect(state?.lastRunAt).toBe(at(1_000).getTime());
  });

  it('records a failure with its error', () => {
    const id = open();
    finishRun(db, id, { status: 'failed', finishedAt: at(1_000), error: 'timeout' });
    expect(getRun(db, id)?.error).toBe('timeout');
    expect(getState(db, 'morning-brief')?.lastStatus).toBe('failed');
  });

  it('marks delivery separately from the run outcome', () => {
    const id = open();
    finishRun(db, id, { status: 'done', finishedAt: at(1_000) });
    expect(getRun(db, id)?.deliveredAt).toBeNull();
    markDelivered(db, id, at(2_000));
    expect(getRun(db, id)?.deliveredAt).toBe(at(2_000).getTime());
  });
});

describe('findRunBySlot and reopenRun', () => {
  it('finds the row already recorded for a slot', () => {
    const id = open();
    expect(findRunBySlot(db, 'morning-brief', T0, 'cron')?.id).toBe(id);
    expect(findRunBySlot(db, 'morning-brief', at(60_000), 'cron')).toBeNull();
    expect(findRunBySlot(db, 'morning-brief', T0, 'manual')).toBeNull();
  });

  it('puts a finished row back into running for a retry', () => {
    const id = open();
    finishRun(db, id, { status: 'failed', finishedAt: at(1_000), error: 'boom' });
    reopenRun(db, id, at(60_000), 1);
    const run = getRun(db, id);
    expect(run?.status).toBe('running');
    expect(run?.error).toBeNull();
    expect(run?.finishedAt).toBeNull();
    expect(run?.attempts).toBe(1);
  });
});

describe('recordSkipped', () => {
  it('inserts a skipped row with the default reason', () => {
    const id = recordSkipped(db, {
      name: 'morning-brief',
      slot: T0,
      trigger: 'cron',
      at: at(60_000),
    });
    const run = getRun(db, id);
    expect(run?.status).toBe('skipped');
    expect(run?.error).toBe('missed while scheduler was down');
    expect(run?.finishedAt).toBe(at(60_000).getTime());
  });

  it('accepts an explicit reason', () => {
    const id = recordSkipped(db, {
      name: 'morning-brief',
      slot: T0,
      trigger: 'cron',
      at: T0,
      error: 'paused',
    });
    expect(getRun(db, id)?.error).toBe('paused');
  });
});

describe('history', () => {
  it('returns the newest runs first', () => {
    const a = startRun(db, { name: 'x', slot: T0, trigger: 'cron', startedAt: T0 });
    const b = startRun(db, { name: 'x', slot: at(60_000), trigger: 'cron', startedAt: at(60_000) });
    const c = startRun(db, {
      name: 'x',
      slot: at(120_000),
      trigger: 'cron',
      startedAt: at(120_000),
    });
    expect(history(db, 'x').map((r) => r.id)).toEqual([c, b, a]);
  });

  it('honours the limit', () => {
    for (let i = 0; i < 8; i += 1) {
      startRun(db, { name: 'x', slot: at(i * 1000), trigger: 'cron', startedAt: at(i * 1000) });
    }
    expect(history(db, 'x').length).toBe(5);
    expect(history(db, 'x', 2).length).toBe(2);
  });

  it('is scoped to one routine', () => {
    startRun(db, { name: 'x', slot: T0, trigger: 'cron', startedAt: T0 });
    startRun(db, { name: 'y', slot: T0, trigger: 'cron', startedAt: T0 });
    expect(history(db, 'x').length).toBe(1);
    expect(history(db, 'z')).toEqual([]);
  });
});

describe('getState and setState', () => {
  it('returns null for an unknown routine', () => {
    expect(getState(db, 'nobody')).toBeNull();
  });

  it('inserts then updates without clearing other fields', () => {
    setState(db, 'x', { lastSlot: T0.getTime() });
    expect(getState(db, 'x')).toEqual({
      name: 'x',
      lastSlot: T0.getTime(),
      lastStatus: null,
      lastRunAt: null,
    });

    setState(db, 'x', { lastStatus: 'done', lastRunAt: at(1_000).getTime() });
    expect(getState(db, 'x')).toEqual({
      name: 'x',
      lastSlot: T0.getTime(),
      lastStatus: 'done',
      lastRunAt: at(1_000).getTime(),
    });
  });
});

describe('markStaleRunning', () => {
  it('fails a running row whose routine holds no lease', () => {
    const id = open();
    expect(markStaleRunning(db, at(1_000))).toBe(1);
    const run = getRun(db, id);
    expect(run?.status).toBe('failed');
    expect(run?.error).toBe('stale after restart');
    expect(run?.finishedAt).toBe(at(1_000).getTime());
  });

  it('leaves a run alone while its lease is alive', () => {
    open();
    claimLease(db, 'morning-brief', 'other', 90_000, at(1_000));
    expect(markStaleRunning(db, at(2_000))).toBe(0);
  });

  it('fails a run whose lease has expired', () => {
    open();
    claimLease(db, 'morning-brief', 'other', 1_000, T0);
    expect(markStaleRunning(db, at(5_000))).toBe(1);
  });

  it('ignores rows that are not running', () => {
    const id = open();
    finishRun(db, id, { status: 'done', finishedAt: at(1_000) });
    expect(markStaleRunning(db, at(2_000))).toBe(0);
  });
});

describe('writeRunLog', () => {
  let vault: string;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cxw-runs-'));
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('stamps the filename in UTC', () => {
    expect(runLogStamp(new Date('2026-09-03T07:00:00Z'))).toBe('2026-09-03T07-00-00Z');
  });

  it('writes the path and frontmatter the plan specifies', () => {
    const written = writeRunLog(vault, {
      routine: 'morning-brief',
      trigger: 'cron',
      scheduledFor: new Date('2026-09-03T05:00:00Z'),
      started: new Date('2026-09-03T05:00:01Z'),
      finished: new Date('2026-09-03T05:00:09Z'),
      status: 'done',
      model: 'claude-opus-5',
      attempts: 1,
      costUsd: 0.42,
      body: 'Three meetings today.',
    });

    expect(written).toBe(path.join(vault, 'runs', 'morning-brief', '2026-09-03T05-00-09Z.md'));
    const text = fs.readFileSync(written, 'utf8');
    expect(text.startsWith('---\n')).toBe(true);
    expect(text).toContain('routine: morning-brief');
    expect(text).toContain('trigger: cron');
    expect(text).toContain('scheduled_for: 2026-09-03T05:00:00.000Z');
    expect(text).toContain('status: done');
    expect(text).toContain('model: claude-opus-5');
    expect(text).toContain('attempts: 1');
    expect(text).toContain('cost_usd: 0.42');
    expect(text).toContain('error: null');
    expect(text.trimEnd().endsWith('Three meetings today.')).toBe(true);
  });

  it('quotes the error and defaults the cost', () => {
    const written = writeRunLog(vault, {
      routine: 'weekly-review',
      trigger: 'manual',
      scheduledFor: new Date('2026-09-03T05:00:00Z'),
      started: new Date('2026-09-03T05:00:00Z'),
      finished: new Date('2026-09-03T05:00:02Z'),
      status: 'failed',
      model: 'claude-opus-5',
      attempts: 2,
      error: 'boom: it broke',
      body: 'Run failed',
    });
    const text = fs.readFileSync(written, 'utf8');
    expect(text).toContain('cost_usd: null');
    expect(text).toContain('error: "boom: it broke"');
  });
});
