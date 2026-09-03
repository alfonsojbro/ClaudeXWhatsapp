import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { columnExists, openDb, tableExists, TS_MS_SQL } from './db.js';
import { logger } from './logger.js';
import { normalizeOwnerJid, loadOwners } from './owners.js';
import { fileExists, writeState } from './state.js';

export const PURGE_RESULT_FILE = 'last-purge.json';

/** Refusal message when `CXW_RETENTION_OWNER_FOREVER` is on but no owner is known. */
export const PURGE_EMPTY_OWNERS_MESSAGE =
  'refusing to purge: owner list is empty (check CXW_OWNERS_FILE)';

/** An operator-facing failure: the CLI prints `message` and exits non-zero, no stack trace. */
export class OpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpsError';
  }
}

export interface PurgeOptions {
  dryRun?: boolean;
  emergency?: boolean;
}

export interface PurgeResult {
  dryRun: boolean;
  emergency: boolean;
  textRows: number;
  mediaRows: number;
  files: number;
  bytes: number;
  /** Rows whose `media_path` pointed outside `MEDIA_DIR` and were left untouched. */
  skipped: number;
}

const DAY_MS = 86_400_000;

/** `jid NOT IN (?, ?)` for the owner allowlist, or a no-op clause when nothing is exempt. */
function notOwnerClause(owners: string[], column = 'jid'): { sql: string; params: string[] } {
  if (owners.length === 0) return { sql: '1 = 1', params: [] };
  return { sql: `${column} NOT IN (${owners.map(() => '?').join(', ')})`, params: owners };
}

/**
 * `fs.realpathSync` for a path that may not exist yet: climb to the deepest ancestor that
 * does exist, resolve that through its symlinks, then re-append the missing tail. A plain
 * fallback to `path.resolve` would compare a lexical path against a realpath'd root, so a
 * candidate whose parent directory is not created yet under a symlinked media directory
 * would look like an escape and silently disable media retention.
 */
function realOrResolve(p: string): string {
  const resolved = path.resolve(p);
  const tail: string[] = [];
  let dir = resolved;
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...tail);
    } catch {
      const parent = path.dirname(dir);
      // The filesystem root is its own parent: nothing above it exists to resolve.
      if (parent === dir) return resolved;
      tail.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

/**
 * Resolve a stored `media_path` to an absolute file, but only when it stays inside the
 * media directory. `MEDIA_DIR` is the only tree the purge may ever unlink from: the data
 * directory also holds `bridge.sqlite`, `ops.sqlite` and the Baileys `session/`, and
 * `media_path` is data written by a remote party (the message key id), so a row saying
 * `../bridge.sqlite` must be refused rather than obeyed. Returns null for anything that
 * escapes.
 *
 * Both sides are compared through `fs.realpathSync` — the candidate via its parent
 * directory, so a file that is itself a symlink is still unlinked as the link it is.
 * Without that, a symlinked data directory (an attached volume) would refuse every
 * absolute path the bridge stored and silently disable media retention.
 */
export function resolveMediaPath(cfg: Config, stored: string): string | null {
  const resolved = path.resolve(path.isAbsolute(stored) ? stored : path.join(cfg.mediaDir, stored));
  const root = realOrResolve(cfg.mediaDir);
  const candidate = path.join(realOrResolve(path.dirname(resolved)), path.basename(resolved));
  if (candidate === root) return null;
  if (!candidate.startsWith(root + path.sep)) return null;
  // The resolved spelling is returned, not the realpath'd one, so the `seen` dedupe still
  // matches the paths the orphan walk builds from `cfg.mediaDir`.
  return resolved;
}

/**
 * Account for one media file exactly once. On a dry run it is only measured; otherwise it
 * is unlinked. Returns whether the file counted and how many bytes it freed.
 */
function takeFile(
  file: string,
  dryRun: boolean,
  seen: Set<string>,
): { counted: boolean; bytes: number } {
  if (seen.has(file)) return { counted: false, bytes: 0 };
  seen.add(file);
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { counted: false, bytes: 0 };
  }
  if (dryRun) return { counted: true, bytes: size };
  try {
    fs.unlinkSync(file);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'could not unlink media',
    );
    return { counted: false, bytes: 0 };
  }
  return { counted: true, bytes: size };
}

function purgeMediaTableRows(db: DatabaseSync, jid: string, msgId: string): void {
  if (!tableExists(db, 'media')) return;
  if (columnExists(db, 'media', 'msg_id') && columnExists(db, 'media', 'jid')) {
    db.prepare('DELETE FROM media WHERE jid = ? AND msg_id = ?').run(jid, msgId);
  } else if (columnExists(db, 'media', 'msg_id')) {
    db.prepare('DELETE FROM media WHERE msg_id = ?').run(msgId);
  }
}

/**
 * Delete third-party history past its retention window. Owner chats are exempt while
 * `CXW_RETENTION_OWNER_FOREVER` is true. `emergency` touches media only, with the shorter
 * emergency window; `dryRun` counts without changing anything.
 */
export function purge(opts: PurgeOptions = {}, cfg: Config = loadConfig()): PurgeResult {
  const dryRun = opts.dryRun === true;
  const emergency = opts.emergency === true;
  const result: PurgeResult = {
    dryRun,
    emergency,
    textRows: 0,
    mediaRows: 0,
    files: 0,
    bytes: 0,
    skipped: 0,
  };

  const owners = cfg.retention.ownerForever ? loadOwners(cfg) : [];
  // An empty allowlist would turn the owner exemption into `1 = 1` and delete the archive
  // this product exists to keep. A missing or truncated owners file must never do that.
  if (cfg.retention.ownerForever && owners.length === 0) {
    logger.error({ file: cfg.ownersFile }, 'refusing to purge: owner allowlist is empty');
    throw new OpsError(PURGE_EMPTY_OWNERS_MESSAGE);
  }
  const now = Date.now();
  const mediaDays = emergency ? cfg.retention.emergencyMediaDays : cfg.retention.mediaDays;
  const cutoffMedia = now - mediaDays * DAY_MS;
  const cutoffText = now - cfg.retention.textDays * DAY_MS;
  const seenFiles = new Set<string>();

  const db = fileExists(cfg.bridgeDb) ? openDb(cfg.bridgeDb, { readOnly: dryRun }) : null;
  if (db === null) logger.warn('bridge sqlite not found; skipping database purge');
  try {
    const hasMessages = db !== null && tableExists(db, 'messages');
    if (db !== null && hasMessages) {
      purgeMedia(db, cfg, owners, cutoffMedia, dryRun, seenFiles, result);
      if (!emergency) purgeText(db, owners, cutoffText, dryRun, result);
    }
    purgeOrphanMedia(cfg, owners, cutoffMedia, dryRun, seenFiles, result, hasMessages ? db : null);
    if (db !== null && hasMessages && !dryRun && cfg.retention.vacuum) db.exec('VACUUM');
  } finally {
    db?.close();
  }

  if (result.skipped > 0) {
    // The count only: the path itself is remote-controlled content and never goes to the journal.
    logger.warn({ skipped: result.skipped }, 'media rows outside the media directory were skipped');
  }

  // A dry run must not overwrite the record of the last real purge.
  if (!dryRun) {
    try {
      writeState(cfg, PURGE_RESULT_FILE, { at: new Date(now).toISOString(), ...result });
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'could not write purge result',
      );
    }
  }
  return result;
}

function purgeMedia(
  db: DatabaseSync,
  cfg: Config,
  owners: string[],
  cutoffMedia: number,
  dryRun: boolean,
  seenFiles: Set<string>,
  result: PurgeResult,
): void {
  if (!columnExists(db, 'messages', 'media_path')) return;
  const owner = notOwnerClause(owners);
  const rows = db
    .prepare(
      `SELECT jid, id, media_path FROM messages
       WHERE media_path IS NOT NULL AND media_path <> '' AND ${TS_MS_SQL} < ? AND ${owner.sql}`,
    )
    .all(cutoffMedia, ...owner.params) as Array<{ jid: string; id: string; media_path: string }>;

  for (const row of rows) {
    const file = resolveMediaPath(cfg, row.media_path);
    if (file === null) {
      result.skipped += 1;
      continue;
    }
    const taken = takeFile(file, dryRun, seenFiles);
    if (taken.counted) result.files += 1;
    result.bytes += taken.bytes;
    result.mediaRows += 1;
    if (dryRun) continue;
    db.prepare('UPDATE messages SET media_path = NULL WHERE jid = ? AND id = ?').run(
      row.jid,
      row.id,
    );
    purgeMediaTableRows(db, row.jid, row.id);
  }
}

function purgeText(
  db: DatabaseSync,
  owners: string[],
  cutoffText: number,
  dryRun: boolean,
  result: PurgeResult,
): void {
  const owner = notOwnerClause(owners);
  if (dryRun) {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${TS_MS_SQL} < ? AND ${owner.sql}`)
      .get(cutoffText, ...owner.params) as { n: number } | undefined;
    result.textRows = Number(row?.n ?? 0);
    return;
  }

  const info = db
    .prepare(`DELETE FROM messages WHERE ${TS_MS_SQL} < ? AND ${owner.sql}`)
    .run(cutoffText, ...owner.params);
  result.textRows = Number(info.changes);

  if (tableExists(db, 'media') && columnExists(db, 'media', 'msg_id')) {
    try {
      db.exec(
        `DELETE FROM media WHERE NOT EXISTS (
           SELECT 1 FROM messages m WHERE m.id = media.msg_id AND m.jid = media.jid
         )`,
      );
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'media table cleanup skipped',
      );
    }
  }

  if (result.textRows > 0 && tableExists(db, 'messages_fts')) {
    try {
      db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'FTS rebuild skipped');
    }
  }
}

/**
 * Clear a `media_path` that now points at nothing. The bridge stores either the absolute
 * path or the spelling relative to `MEDIA_DIR`, so both are cleared.
 */
function clearMediaPath(db: DatabaseSync, cfg: Config, file: string): void {
  if (!columnExists(db, 'messages', 'media_path')) return;
  const stmt = db.prepare('UPDATE messages SET media_path = NULL WHERE media_path = ?');
  stmt.run(file);
  const relative = path.relative(path.resolve(cfg.mediaDir), file);
  if (relative !== '' && !relative.startsWith('..')) stmt.run(relative);
}

/** Files under `MEDIA_DIR/<jid>/` with no surviving row, removed by mtime. */
function purgeOrphanMedia(
  cfg: Config,
  owners: string[],
  cutoffMedia: number,
  dryRun: boolean,
  seenFiles: Set<string>,
  result: PurgeResult,
  db: DatabaseSync | null,
): void {
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(cfg.mediaDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const jid = normalizeOwnerJid(dir.name) ?? dir.name;
    if (owners.includes(jid)) continue;
    const dirPath = path.join(cfg.mediaDir, dir.name);
    let files: string[];
    try {
      files = fs.readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const name of files) {
      const file = path.resolve(dirPath, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.mtimeMs >= cutoffMedia) continue;
      const taken = takeFile(file, dryRun, seenFiles);
      if (taken.counted) result.files += 1;
      result.bytes += taken.bytes;
      // A surviving row must never keep a path to a file this walk just removed.
      if (taken.counted && !dryRun && db !== null) clearMediaPath(db, cfg, file);
    }
  }
}
