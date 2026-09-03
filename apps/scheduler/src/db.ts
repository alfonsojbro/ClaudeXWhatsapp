/**
 * SQLite schema and connection handling.
 *
 * Migrations are idempotent: re-opening an existing database is a no-op.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/** The better-sqlite3 handle type, re-exported so callers need not import the package. */
export type Db = Database.Database;

/** Current schema version written to `schema_version`. */
export const SCHEMA_VERSION = 3;

/**
 * The spool table.
 *
 * `dedupe` distinguishes two work items that share a routine, a slot and a trigger — two meetings
 * starting at the same instant, for example. It is the empty string for everything else, so cron,
 * once and manual items keep the original one-item-per-slot behaviour.
 */
const SPOOL_TABLE = (name: string): string => `CREATE TABLE ${name} (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     name            TEXT NOT NULL,
     slot            INTEGER NOT NULL,
     trigger         TEXT NOT NULL,
     stage           TEXT NOT NULL CHECK (stage IN ('run', 'deliver')),
     dedupe          TEXT NOT NULL DEFAULT '',
     payload         TEXT,
     attempts        INTEGER NOT NULL DEFAULT 0,
     next_attempt_at INTEGER NOT NULL,
     last_error      TEXT,
     created_at      INTEGER NOT NULL
   )`;

const SPOOL_COLUMNS =
  'id, name, slot, trigger, stage, payload, attempts, next_attempt_at, last_error, created_at';

/**
 * The runs table.
 *
 * `dedupe` mirrors the spool column of the same name: it is what keeps the run rows of two
 * meetings that share a routine, a slot and the `calendar` trigger apart. Empty for everything
 * else, so cron, once and manual runs keep the original one-row-per-slot behaviour.
 */
const RUNS_TABLE = (name: string): string => `CREATE TABLE ${name} (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     name           TEXT NOT NULL,
     slot           INTEGER NOT NULL,
     trigger        TEXT NOT NULL,
     dedupe         TEXT NOT NULL DEFAULT '',
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

const RUNS_COLUMNS =
  'id, name, slot, trigger, started_at, finished_at, status, attempts, log_path, error, ' +
  'result_preview, cost_usd, delivered_at';

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS leases (
     name       TEXT PRIMARY KEY,
     owner      TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  SPOOL_TABLE('IF NOT EXISTS spool'),
  RUNS_TABLE('IF NOT EXISTS runs'),
  `CREATE TABLE IF NOT EXISTS routine_state (
     name        TEXT PRIMARY KEY,
     last_slot   INTEGER,
     last_status TEXT,
     last_run_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS fired_events (
     name     TEXT NOT NULL,
     event_id TEXT NOT NULL,
     fired_at INTEGER NOT NULL,
     PRIMARY KEY (name, event_id)
   )`,
  `CREATE TABLE IF NOT EXISTS health_state (
     check_name TEXT PRIMARY KEY,
     ok         INTEGER NOT NULL,
     detail     TEXT,
     changed_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS schema_version (
     version INTEGER NOT NULL
   )`,
];

/**
 * Open (and migrate) the scheduler database.
 *
 * @param dbPath a file path, or `':memory:'` for an ephemeral database.
 */
export function openDb(dbPath: string): Db {
  const inMemory = dbPath === ':memory:';
  if (!inMemory) fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });

  const db = new Database(dbPath);
  if (!inMemory) db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  migrate(db);
  return db;
}

/** Apply the schema. Safe to call on an already-migrated database. */
export function migrate(db: Db): void {
  db.exec('BEGIN');
  try {
    for (const stmt of MIGRATIONS) db.exec(stmt);
    upgradeSpool(db);
    upgradeRuns(db);
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
      { version: number } | undefined;
    if (row === undefined) {
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    } else if (row.version < SCHEMA_VERSION) {
      db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
    }
    db.exec('COMMIT');
  } catch (err: unknown) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Bring a pre-v2 `spool` table up to date.
 *
 * v1 had `UNIQUE (name, slot, trigger)` as a table constraint, which SQLite cannot alter in
 * place, so the table is rebuilt. On a fresh database only the indexes are created.
 */
function upgradeSpool(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(spool)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'dedupe')) {
    db.exec(SPOOL_TABLE('spool_v2'));
    db.exec(`INSERT INTO spool_v2 (${SPOOL_COLUMNS}) SELECT ${SPOOL_COLUMNS} FROM spool`);
    db.exec('DROP TABLE spool');
    db.exec('ALTER TABLE spool_v2 RENAME TO spool');
  }
  db.exec('CREATE INDEX IF NOT EXISTS spool_due_idx ON spool (next_attempt_at)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS spool_key_idx ON spool (name, slot, trigger, dedupe)');
}

/**
 * Bring a pre-v3 `runs` table up to date.
 *
 * v2 had no `dedupe` column, so two meetings starting at the same instant shared one run row and
 * the second prep was dropped as "already delivered". The table is rebuilt the way `upgradeSpool`
 * rebuilds the spool, which also keeps the two migrations shaped alike. On a fresh database only
 * the index is created.
 */
function upgradeRuns(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(runs)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'dedupe')) {
    db.exec(RUNS_TABLE('runs_v3'));
    db.exec(`INSERT INTO runs_v3 (${RUNS_COLUMNS}) SELECT ${RUNS_COLUMNS} FROM runs`);
    db.exec('DROP TABLE runs');
    db.exec('ALTER TABLE runs_v3 RENAME TO runs');
  }
  db.exec('CREATE INDEX IF NOT EXISTS runs_name_idx ON runs (name, started_at DESC)');
}

/** The version recorded in the database. */
export function schemaVersion(db: Db): number {
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    { version: number } | undefined;
  return row?.version ?? 0;
}
