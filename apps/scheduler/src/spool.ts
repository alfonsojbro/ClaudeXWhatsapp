/**
 * The retry spool: durable work items with exponential backoff.
 *
 * A `run` item means "execute the routine". After a successful run whose delivery failed, the
 * item is re-staged as `deliver` with the result text as payload, so the LLM is never re-run
 * because of a delivery problem.
 */
import type { Db } from './db.js';
import type { SpoolStage, Trigger } from './types.js';

const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 1_800_000;

/** Attempt ceiling per stage. */
export const MAX_ATTEMPTS: Record<SpoolStage, number> = {
  run: 3,
  deliver: 10,
};

/** A spool row. */
export interface SpoolItem {
  id: number;
  name: string;
  slot: number;
  trigger: Trigger;
  stage: SpoolStage;
  /**
   * Extra dedupe discriminator, empty for everything except calendar triggers, where it is the
   * event id so two meetings starting at the same instant both get an item.
   */
  dedupe: string;
  payload: string | null;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
}

/** Arguments for {@link enqueue}. */
export interface EnqueueInput {
  name: string;
  /** Scheduled instant this item belongs to. */
  slot: Date;
  trigger: Trigger;
  stage: SpoolStage;
  /** Extra dedupe discriminator; defaults to the empty string. */
  dedupe?: string;
  payload?: string;
  /** When the item first becomes eligible. Defaults to `now`. */
  nextAttemptAt?: Date;
  now: Date;
}

/** Outcome of {@link enqueue}. */
export interface EnqueueResult {
  inserted: boolean;
  id: number | null;
}

interface Row {
  id: number;
  name: string;
  slot: number;
  trigger: string;
  stage: string;
  dedupe: string;
  payload: string | null;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
}

function toItem(row: Row): SpoolItem {
  return {
    id: row.id,
    name: row.name,
    slot: row.slot,
    trigger: row.trigger as Trigger,
    stage: row.stage as SpoolStage,
    dedupe: row.dedupe,
    payload: row.payload,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

const SELECT = `SELECT id, name, slot, trigger, stage, dedupe, payload, attempts,
                       next_attempt_at, last_error, created_at
                FROM spool`;

/**
 * Add a work item. The `(name, slot, trigger, dedupe)` uniqueness makes this idempotent:
 * enqueueing the same slot twice (for example after a restart mid-tick) inserts nothing the second
 * time. `dedupe` lets a calendar trigger keep two meetings that start at the same instant apart.
 */
export function enqueue(db: Db, input: EnqueueInput): EnqueueResult {
  const nowMs = input.now.getTime();
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO spool
         (name, slot, trigger, stage, dedupe, payload, attempts, next_attempt_at, last_error,
          created_at)
       VALUES (@name, @slot, @trigger, @stage, @dedupe, @payload, 0, @next, NULL, @created)`,
    )
    .run({
      name: input.name,
      slot: input.slot.getTime(),
      trigger: input.trigger,
      stage: input.stage,
      dedupe: input.dedupe ?? '',
      payload: input.payload ?? null,
      next: (input.nextAttemptAt ?? input.now).getTime(),
      created: nowMs,
    });
  if (info.changes === 0) return { inserted: false, id: null };
  return { inserted: true, id: Number(info.lastInsertRowid) };
}

/** Items whose `next_attempt_at` has arrived, oldest first. */
export function dueItems(db: Db, now: Date, limit = 100): SpoolItem[] {
  const rows = db
    .prepare(`${SELECT} WHERE next_attempt_at <= ? ORDER BY next_attempt_at ASC, id ASC LIMIT ?`)
    .all(now.getTime(), limit) as Row[];
  return rows.map(toItem);
}

/** Every pending item for one routine, oldest first. */
export function pendingFor(db: Db, name: string): SpoolItem[] {
  const rows = db
    .prepare(`${SELECT} WHERE name = ? ORDER BY next_attempt_at ASC, id ASC`)
    .all(name) as Row[];
  return rows.map(toItem);
}

/** Read one item by id. */
export function getItem(db: Db, id: number): SpoolItem | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as Row | undefined;
  return row === undefined ? null : toItem(row);
}

/** Backoff delay after `attempts` failures: 2 min, 4 min, 8 min … capped at 30 min. */
export function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
}

/** Outcome of {@link markFailed}. */
export interface MarkFailedResult {
  /** Attempt count after this failure. */
  attempts: number;
  /** True when the item exhausted its attempts and was removed. */
  dropped: boolean;
  /** When the item will next be tried; null when dropped. */
  nextAttemptAt: number | null;
}

/**
 * Record a failed attempt: bump `attempts`, push `next_attempt_at` out by the backoff, and drop
 * the item once it has used up the attempts allowed for its stage.
 */
export function markFailed(db: Db, id: number, error: string, now: Date): MarkFailedResult | null {
  const item = getItem(db, id);
  if (item === null) return null;

  const attempts = item.attempts + 1;
  const max = MAX_ATTEMPTS[item.stage];
  if (attempts >= max) {
    remove(db, id);
    return { attempts, dropped: true, nextAttemptAt: null };
  }

  const nextAttemptAt = now.getTime() + backoffMs(attempts);
  db.prepare('UPDATE spool SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?').run(
    attempts,
    error,
    nextAttemptAt,
    id,
  );
  return { attempts, dropped: false, nextAttemptAt };
}

/** Move an item to the `deliver` stage, carrying the produced text as its payload. */
export function toDeliverStage(db: Db, id: number, payload: string, now: Date): void {
  db.prepare(
    `UPDATE spool
       SET stage = 'deliver', payload = ?, attempts = 0, last_error = NULL, next_attempt_at = ?
     WHERE id = ?`,
  ).run(payload, now.getTime(), id);
}

/** Delete an item. Returns false when it was already gone. */
export function remove(db: Db, id: number): boolean {
  return db.prepare('DELETE FROM spool WHERE id = ?').run(id).changes === 1;
}
