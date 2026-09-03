import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import type { Db } from '../src/db.js';
import {
  MAX_ATTEMPTS,
  backoffMs,
  dueItems,
  enqueue,
  getItem,
  markFailed,
  pendingFor,
  remove,
  toDeliverStage,
} from '../src/spool.js';

const T0 = new Date('2026-09-03T05:00:00Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);

let db: Db;
let tmp: string;

beforeEach(() => {
  db = openDb(':memory:');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cxw-spool-'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const base = {
  name: 'morning-brief',
  slot: T0,
  trigger: 'cron' as const,
  stage: 'run' as const,
  now: T0,
};

describe('enqueue', () => {
  it('inserts an item and reports its id', () => {
    const res = enqueue(db, base);
    expect(res.inserted).toBe(true);
    expect(res.id).not.toBeNull();
    expect(getItem(db, res.id ?? 0)?.name).toBe('morning-brief');
  });

  it('is idempotent for the same name, slot and trigger', () => {
    expect(enqueue(db, base).inserted).toBe(true);
    expect(enqueue(db, base).inserted).toBe(false);
    expect(pendingFor(db, 'morning-brief')).toHaveLength(1);
  });

  it('treats a different trigger for the same slot as a separate item', () => {
    enqueue(db, base);
    expect(enqueue(db, { ...base, trigger: 'manual' }).inserted).toBe(true);
    expect(pendingFor(db, 'morning-brief')).toHaveLength(2);
  });

  it('honours an explicit nextAttemptAt', () => {
    const res = enqueue(db, { ...base, nextAttemptAt: at(600_000) });
    expect(getItem(db, res.id ?? 0)?.nextAttemptAt).toBe(at(600_000).getTime());
  });
});

describe('dueItems', () => {
  it('returns only items whose time has come, oldest first', () => {
    enqueue(db, { ...base, slot: at(3_000), nextAttemptAt: at(3_000) });
    enqueue(db, { ...base, slot: at(1_000), nextAttemptAt: at(1_000) });
    enqueue(db, { ...base, slot: at(9_000), nextAttemptAt: at(9_000) });

    const due = dueItems(db, at(5_000));
    expect(due.map((i) => i.nextAttemptAt)).toEqual([at(1_000).getTime(), at(3_000).getTime()]);
  });

  it('respects the limit', () => {
    enqueue(db, { ...base, slot: at(1_000) });
    enqueue(db, { ...base, slot: at(2_000) });
    expect(dueItems(db, at(5_000), 1)).toHaveLength(1);
  });
});

describe('backoffMs', () => {
  it('doubles and then caps at 30 minutes', () => {
    expect(backoffMs(1)).toBe(120_000);
    expect(backoffMs(2)).toBe(240_000);
    expect(backoffMs(3)).toBe(480_000);
    expect(backoffMs(9)).toBe(1_800_000);
    expect(backoffMs(99)).toBe(1_800_000);
  });
});

describe('markFailed', () => {
  it('grows the backoff on each attempt', () => {
    const id = enqueue(db, base).id ?? 0;

    const first = markFailed(db, id, 'boom', T0);
    expect(first?.attempts).toBe(1);
    expect(first?.dropped).toBe(false);
    expect(first?.nextAttemptAt).toBe(T0.getTime() + 120_000);
    expect(getItem(db, id)?.lastError).toBe('boom');

    const second = markFailed(db, id, 'boom again', at(120_000));
    expect(second?.attempts).toBe(2);
    expect(second?.nextAttemptAt).toBe(at(120_000).getTime() + 240_000);
  });

  it('drops a run item after three attempts', () => {
    const id = enqueue(db, base).id ?? 0;
    expect(markFailed(db, id, 'e', T0)?.dropped).toBe(false);
    expect(markFailed(db, id, 'e', T0)?.dropped).toBe(false);
    expect(markFailed(db, id, 'e', T0)?.dropped).toBe(true);
    expect(getItem(db, id)).toBeNull();
    expect(MAX_ATTEMPTS.run).toBe(3);
  });

  it('gives a deliver item ten attempts', () => {
    const id = enqueue(db, { ...base, stage: 'deliver', payload: 'text' }).id ?? 0;
    for (let i = 1; i < MAX_ATTEMPTS.deliver; i += 1) {
      expect(markFailed(db, id, 'e', T0)?.dropped).toBe(false);
    }
    expect(markFailed(db, id, 'e', T0)?.dropped).toBe(true);
    expect(MAX_ATTEMPTS.deliver).toBe(10);
  });

  it('returns null for an unknown id', () => {
    expect(markFailed(db, 999, 'e', T0)).toBeNull();
  });
});

describe('toDeliverStage', () => {
  it('keeps the produced text and resets the attempt count', () => {
    const id = enqueue(db, base).id ?? 0;
    markFailed(db, id, 'delivery failed', T0);
    toDeliverStage(db, id, 'the result', at(5_000));

    const item = getItem(db, id);
    expect(item?.stage).toBe('deliver');
    expect(item?.payload).toBe('the result');
    expect(item?.attempts).toBe(0);
    expect(item?.nextAttemptAt).toBe(at(5_000).getTime());
  });
});

describe('remove', () => {
  it('deletes once and then reports nothing to delete', () => {
    const id = enqueue(db, base).id ?? 0;
    expect(remove(db, id)).toBe(true);
    expect(remove(db, id)).toBe(false);
  });
});

describe('durability', () => {
  it('keeps a pending item across a reopen of the same file, without duplicating it', () => {
    const file = path.join(tmp, 'scheduler.sqlite');

    const first = openDb(file);
    enqueue(first, base);
    first.close();

    const second = openDb(file);
    expect(pendingFor(second, 'morning-brief')).toHaveLength(1);
    expect(enqueue(second, base).inserted).toBe(false);
    expect(dueItems(second, at(1_000))).toHaveLength(1);
    second.close();
  });
});
