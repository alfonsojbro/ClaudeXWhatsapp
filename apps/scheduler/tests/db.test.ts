/**
 * The schema migrations.
 *
 * Every other test opens a fresh `:memory:` database, so the rebuild branches of `upgradeSpool`
 * and `upgradeRuns` never run there. These tests build the old table shapes by hand, put rows in
 * them, and then migrate — twice, because `migrate()` is called on every start and must be a
 * no-op the second time.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db.js';
import { migrate, SCHEMA_VERSION, schemaVersion } from '../src/db.js';

/** The v1 spool: `UNIQUE (name, slot, trigger)` as a table constraint, no `dedupe` column. */
const SPOOL_V1 = `CREATE TABLE spool (
   id              INTEGER PRIMARY KEY AUTOINCREMENT,
   name            TEXT NOT NULL,
   slot            INTEGER NOT NULL,
   trigger         TEXT NOT NULL,
   stage           TEXT NOT NULL CHECK (stage IN ('run', 'deliver')),
   payload         TEXT,
   attempts        INTEGER NOT NULL DEFAULT 0,
   next_attempt_at INTEGER NOT NULL,
   last_error      TEXT,
   created_at      INTEGER NOT NULL,
   UNIQUE (name, slot, trigger)
 )`;

/** The v2 runs table: no `dedupe` column. */
const RUNS_V2 = `CREATE TABLE runs (
   id             INTEGER PRIMARY KEY AUTOINCREMENT,
   name           TEXT NOT NULL,
   slot           INTEGER NOT NULL,
   trigger        TEXT NOT NULL,
   started_at     INTEGER NOT NULL,
   finished_at    INTEGER,
   status         TEXT NOT NULL
                  CHECK (status IN ('running', 'done', 'failed', 'needs_input', 'skipped')),
   attempts       INTEGER NOT NULL DEFAULT 0,
   log_path       TEXT,
   error          TEXT,
   result_preview TEXT,
   cost_usd       REAL,
   delivered_at   INTEGER
 )`;

const T0 = 1_772_000_000_000;

let db: Db;

beforeEach(() => {
  db = new Database(':memory:');
});

afterEach(() => {
  db.close();
});

/** Names of the indexes SQLite knows about. */
function indexNames(): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
    name: string;
  }[];
  return rows.map((r) => r.name).sort();
}

/** Column names of one table. */
function columns(table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map((r) => r.name);
}

describe('spool rebuild', () => {
  beforeEach(() => {
    db.exec(SPOOL_V1);
    db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
    db.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
    const insert = db.prepare(
      `INSERT INTO spool (id, name, slot, trigger, stage, payload, attempts, next_attempt_at,
                          last_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(7, 'morning-brief', T0, 'cron', 'run', null, 0, T0, null, T0);
    insert.run(9, 'evening-close', T0, 'cron', 'deliver', 'text', 2, T0 + 60_000, 'boom', T0);
  });

  it('keeps every row and its id, and is idempotent', () => {
    migrate(db);
    migrate(db);

    const rows = db
      .prepare('SELECT id, name, stage, payload, attempts FROM spool ORDER BY id')
      .all();
    expect(rows).toEqual([
      { id: 7, name: 'morning-brief', stage: 'run', payload: null, attempts: 0 },
      { id: 9, name: 'evening-close', stage: 'deliver', payload: 'text', attempts: 2 },
    ]);
    expect(columns('spool')).toContain('dedupe');
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
  });

  it('creates both spool indexes and drops the old table constraint', () => {
    migrate(db);

    expect(indexNames()).toContain('spool_due_idx');
    expect(indexNames()).toContain('spool_key_idx');

    // The old `UNIQUE (name, slot, trigger)` is gone: two rows differing only in `dedupe` fit.
    const insert = db.prepare(
      `INSERT INTO spool (name, slot, trigger, stage, dedupe, attempts, next_attempt_at, created_at)
       VALUES (?, ?, 'calendar', 'run', ?, 0, ?, ?)`,
    );
    insert.run('meeting-prep', T0, 'evt-a', T0, T0);
    insert.run('meeting-prep', T0, 'evt-b', T0, T0);
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM spool WHERE name = 'meeting-prep'")
      .get() as { n: number };
    expect(count.n).toBe(2);
  });
});

describe('runs rebuild', () => {
  beforeEach(() => {
    db.exec(RUNS_V2);
    db.exec('CREATE INDEX runs_name_idx ON runs (name, started_at DESC)');
    db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
    db.prepare('INSERT INTO schema_version (version) VALUES (2)').run();
    const insert = db.prepare(
      `INSERT INTO runs (id, name, slot, trigger, started_at, finished_at, status, attempts,
                         log_path, result_preview, cost_usd, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(3, 'morning-brief', T0, 'cron', T0, T0 + 1000, 'done', 1, '/a.md', 'hi', 0.5, T0);
    insert.run(4, 'meeting-prep', T0, 'calendar', T0, null, 'running', 0, null, null, null, null);
  });

  it('keeps every row and its id, and is idempotent', () => {
    migrate(db);
    migrate(db);

    const rows = db
      .prepare(
        'SELECT id, name, trigger, status, dedupe, cost_usd, delivered_at FROM runs ORDER BY id',
      )
      .all();
    expect(rows).toEqual([
      {
        id: 3,
        name: 'morning-brief',
        trigger: 'cron',
        status: 'done',
        dedupe: '',
        cost_usd: 0.5,
        delivered_at: T0,
      },
      {
        id: 4,
        name: 'meeting-prep',
        trigger: 'calendar',
        status: 'running',
        dedupe: '',
        cost_usd: null,
        delivered_at: null,
      },
    ]);
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
  });

  it('recreates the runs index the rebuild dropped', () => {
    migrate(db);

    expect(indexNames()).toContain('runs_name_idx');
  });

  it('lets two same-slot calendar runs coexist on separate rows', () => {
    migrate(db);

    const insert = db.prepare(
      `INSERT INTO runs (name, slot, trigger, dedupe, started_at, status)
       VALUES ('meeting-prep', ?, 'calendar', ?, ?, 'running')`,
    );
    insert.run(T0 + 1, 'evt-a', T0);
    insert.run(T0 + 1, 'evt-b', T0);
    const rows = db
      .prepare("SELECT dedupe FROM runs WHERE slot = ? AND trigger = 'calendar' ORDER BY dedupe")
      .all(T0 + 1) as { dedupe: string }[];
    expect(rows.map((r) => r.dedupe)).toEqual(['evt-a', 'evt-b']);
  });
});
