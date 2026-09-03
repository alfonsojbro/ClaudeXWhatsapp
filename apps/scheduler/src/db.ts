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
export const SCHEMA_VERSION = 2;

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

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS leases (
     name       TEXT PRIMARY KEY,
     owner      TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  SPOOL_TABLE('IF NOT EXISTS spool'),
  `CREATE TABLE IF NOT EXISTS runs (
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
   )`,
  `CREATE INDEX IF NOT EXISTS runs_name_idx ON runs (name, started_at DESC)`,
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

/** The version recorded in the database. */
export function schemaVersion(db: Db): number {
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    { version: number } | undefined;
  return row?.version ?? 0;
}
