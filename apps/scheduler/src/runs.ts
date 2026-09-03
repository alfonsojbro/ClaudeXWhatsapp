/**
 * Run bookkeeping: the `runs` and `routine_state` tables, plus the markdown run log written into
 * the vault.
 */
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { Db } from './db.js';
import type { RunStatus, Trigger } from './types.js';

/** A row of the `runs` table. */
export interface RunRecord {
  id: number;
  name: string;
  slot: number;
  trigger: Trigger;
  startedAt: number;
  finishedAt: number | null;
  status: RunStatus;
  attempts: number;
  logPath: string | null;
  error: string | null;
  resultPreview: string | null;
  costUsd: number | null;
  deliveredAt: number | null;
}

/** Per-routine state used for due detection and the `routines` listing. */
export interface RoutineState {
  name: string;
  lastSlot: number | null;
  lastStatus: RunStatus | null;
  lastRunAt: number | null;
}

interface RunRow {
  id: number;
  name: string;
  slot: number;
  trigger: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  attempts: number;
  log_path: string | null;
  error: string | null;
  result_preview: string | null;
  cost_usd: number | null;
  delivered_at: number | null;
}

const RUN_SELECT = `SELECT id, name, slot, trigger, started_at, finished_at, status, attempts,
                           log_path, error, result_preview, cost_usd, delivered_at
                    FROM runs`;

function toRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    name: row.name,
    slot: row.slot,
    trigger: row.trigger as Trigger,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status as RunStatus,
    attempts: row.attempts,
    logPath: row.log_path,
    error: row.error,
    resultPreview: row.result_preview,
    costUsd: row.cost_usd,
    deliveredAt: row.delivered_at,
  };
}

/** Arguments for {@link startRun}. */
export interface StartRunInput {
  name: string;
  slot: Date;
  trigger: Trigger;
  startedAt: Date;
  attempts?: number;
}

/** Insert a `running` row and return its id. */
export function startRun(db: Db, input: StartRunInput): number {
  const info = db
    .prepare(
      `INSERT INTO runs (name, slot, trigger, started_at, status, attempts)
       VALUES (?, ?, ?, ?, 'running', ?)`,
    )
    .run(
      input.name,
      input.slot.getTime(),
      input.trigger,
      input.startedAt.getTime(),
      input.attempts ?? 0,
    );
  return Number(info.lastInsertRowid);
}

/** Arguments for {@link finishRun}. */
export interface FinishRunInput {
  status: RunStatus;
  finishedAt: Date;
  logPath?: string;
  error?: string;
  resultPreview?: string;
  costUsd?: number;
  attempts?: number;
}

/** Close out a run row and mirror the outcome into `routine_state`. */
export function finishRun(db: Db, id: number, input: FinishRunInput): void {
  db.prepare(
    `UPDATE runs
       SET status = @status,
           finished_at = @finished,
           log_path = COALESCE(@logPath, log_path),
           error = @error,
           result_preview = COALESCE(@preview, result_preview),
           cost_usd = COALESCE(@cost, cost_usd),
           attempts = COALESCE(@attempts, attempts)
     WHERE id = @id`,
  ).run({
    id,
    status: input.status,
    finished: input.finishedAt.getTime(),
    logPath: input.logPath ?? null,
    error: input.error ?? null,
    preview: input.resultPreview ?? null,
    cost: input.costUsd ?? null,
    attempts: input.attempts ?? null,
  });

  const row = db.prepare('SELECT name, slot FROM runs WHERE id = ?').get(id) as
    { name: string; slot: number } | undefined;
  if (row !== undefined) {
    setState(db, row.name, {
      lastStatus: input.status,
      lastRunAt: input.finishedAt.getTime(),
    });
  }
}

/** Mark a run as delivered. */
export function markDelivered(db: Db, id: number, at: Date): void {
  db.prepare('UPDATE runs SET delivered_at = ? WHERE id = ?').run(at.getTime(), id);
}

/** Arguments for {@link recordSkipped}. */
export interface SkippedInput {
  name: string;
  slot: Date;
  trigger: Trigger;
  at: Date;
  error?: string;
}

/** Record a slot the scheduler was not up for, so the gap shows in `history`. */
export function recordSkipped(db: Db, input: SkippedInput): number {
  const info = db
    .prepare(
      `INSERT INTO runs (name, slot, trigger, started_at, finished_at, status, attempts, error)
       VALUES (?, ?, ?, ?, ?, 'skipped', 0, ?)`,
    )
    .run(
      input.name,
      input.slot.getTime(),
      input.trigger,
      input.at.getTime(),
      input.at.getTime(),
      input.error ?? 'missed while scheduler was down',
    );
  return Number(info.lastInsertRowid);
}

/** The most recent runs of one routine, newest first. */
export function history(db: Db, name: string, limit = 5): RunRecord[] {
  const rows = db
    .prepare(`${RUN_SELECT} WHERE name = ? ORDER BY started_at DESC, id DESC LIMIT ?`)
    .all(name, limit) as RunRow[];
  return rows.map(toRun);
}

/**
 * The run row already recorded for one scheduled slot, if any.
 *
 * The scheduler uses this so a retried spool item reuses its run row instead of adding a second.
 */
export function findRunBySlot(
  db: Db,
  name: string,
  slot: Date,
  trigger: Trigger,
): RunRecord | null {
  const row = db
    .prepare(`${RUN_SELECT} WHERE name = ? AND slot = ? AND trigger = ? ORDER BY id DESC LIMIT 1`)
    .get(name, slot.getTime(), trigger) as RunRow | undefined;
  return row === undefined ? null : toRun(row);
}

/** Put an existing run row back into `running` for a retry. */
export function reopenRun(db: Db, id: number, startedAt: Date, attempts: number): void {
  db.prepare(
    `UPDATE runs SET status = 'running', started_at = ?, finished_at = NULL, error = NULL,
                     attempts = ?
     WHERE id = ?`,
  ).run(startedAt.getTime(), attempts, id);
}

/** Read one run row. */
export function getRun(db: Db, id: number): RunRecord | null {
  const row = db.prepare(`${RUN_SELECT} WHERE id = ?`).get(id) as RunRow | undefined;
  return row === undefined ? null : toRun(row);
}

/**
 * Fail every run left `running` by a crash.
 *
 * A row is stale when no unexpired lease is held for its routine.
 *
 * @returns how many rows were failed.
 */
export function markStaleRunning(db: Db, now: Date): number {
  const info = db
    .prepare(
      `UPDATE runs
          SET status = 'failed', error = 'stale after restart', finished_at = @now
        WHERE status = 'running'
          AND name NOT IN (SELECT name FROM leases WHERE expires_at > @now)`,
    )
    .run({ now: now.getTime() });
  return info.changes;
}

/** Read the stored state of a routine. */
export function getState(db: Db, name: string): RoutineState | null {
  const row = db
    .prepare('SELECT name, last_slot, last_status, last_run_at FROM routine_state WHERE name = ?')
    .get(name) as
    | {
        name: string;
        last_slot: number | null;
        last_status: string | null;
        last_run_at: number | null;
      }
    | undefined;
  if (row === undefined) return null;
  return {
    name: row.name,
    lastSlot: row.last_slot,
    lastStatus: row.last_status as RunStatus | null,
    lastRunAt: row.last_run_at,
  };
}

/** Fields {@link setState} can change. Omitted fields keep their stored value. */
export interface StatePatch {
  lastSlot?: number;
  lastStatus?: RunStatus;
  lastRunAt?: number;
}

/** Upsert routine state, leaving unspecified fields untouched. */
export function setState(db: Db, name: string, patch: StatePatch): void {
  db.prepare(
    `INSERT INTO routine_state (name, last_slot, last_status, last_run_at)
     VALUES (@name, @slot, @status, @runAt)
     ON CONFLICT (name) DO UPDATE SET
       last_slot = COALESCE(excluded.last_slot, routine_state.last_slot),
       last_status = COALESCE(excluded.last_status, routine_state.last_status),
       last_run_at = COALESCE(excluded.last_run_at, routine_state.last_run_at)`,
  ).run({
    name,
    slot: patch.lastSlot ?? null,
    status: patch.lastStatus ?? null,
    runAt: patch.lastRunAt ?? null,
  });
}

/** Frontmatter of a run log file. */
export interface RunLogInput {
  routine: string;
  trigger: Trigger;
  scheduledFor: Date;
  started: Date;
  finished: Date;
  status: RunStatus;
  model: string;
  attempts: number;
  costUsd?: number;
  error?: string;
  body: string;
}

/** UTC stamp used in run-log filenames: `2026-09-03T07-00-00Z`. */
export function runLogStamp(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace(/:/g, '-')}Z`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Write `vault/runs/<name>/<YYYY-MM-DDTHH-mm-ssZ>.md`, creating directories as needed.
 *
 * @returns the absolute path written.
 */
export function writeRunLog(vaultDir: string, input: RunLogInput): string {
  const dir = path.join(vaultDir, 'runs', input.routine);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${runLogStamp(input.finished)}.md`);

  const lines = [
    '---',
    `routine: ${input.routine}`,
    `trigger: ${input.trigger}`,
    `scheduled_for: ${input.scheduledFor.toISOString()}`,
    `started: ${input.started.toISOString()}`,
    `finished: ${input.finished.toISOString()}`,
    `status: ${input.status}`,
    `model: ${input.model}`,
    `attempts: ${String(input.attempts)}`,
    `cost_usd: ${input.costUsd === undefined ? 'null' : String(input.costUsd)}`,
    `error: ${input.error === undefined ? 'null' : yamlString(input.error)}`,
    '---',
    '',
    input.body.trim(),
    '',
  ];
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

/**
 * Read back the body of a run log written by {@link writeRunLog}.
 *
 * Used after a crash to recover a result that was produced but never delivered, so the LLM job is
 * not run a second time.
 *
 * @returns the body, or `null` when the file is missing, unreadable or empty.
 */
export function readRunLogBody(filePath: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const body = matter(raw).content.trim();
  return body === '' ? null : body;
}
