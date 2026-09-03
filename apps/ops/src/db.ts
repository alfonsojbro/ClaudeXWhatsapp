import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQL fragment normalising the `ts` column to epoch milliseconds. Phase 1 writes unix
 * seconds, older rows and some fixtures use milliseconds; anything below 1e12 is seconds.
 */
export const TS_MS_SQL = '(CASE WHEN ts < 1000000000000 THEN ts * 1000 ELSE ts END)';

/** Normalise a timestamp that may be in seconds or milliseconds to milliseconds. */
export function toMs(ts: number): number {
  return ts < 1_000_000_000_000 ? ts * 1000 : ts;
}

/** How long SQLite retries a locked database before it throws `SQLITE_BUSY`. */
export const BUSY_TIMEOUT_MS = 5000;

export function openDb(
  file: string,
  opts: { create?: boolean; readOnly?: boolean } = {},
): DatabaseSync {
  if (opts.create === true) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { readOnly: opts.readOnly === true });
  // The bridge writes to its store continuously. Without a busy timeout the daily purge
  // hits SQLITE_BUSY at once and `cxw-purge.service` fails, so retention just stops.
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  } catch {
    // A database that will not take a pragma will fail loudly on the first real query.
  }
  return db;
}

export function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?`)
    .get(name);
  return row !== undefined;
}

export function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  return rows.some((r) => r.name === column);
}

export { DatabaseSync };
