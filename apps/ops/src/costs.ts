import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { logger } from './logger.js';
import {
  fileExists,
  monthKey,
  readJsonFile,
  removeFile,
  startOfDay,
  startOfMonth,
  statePath,
  writeJsonFile,
} from './state.js';

export const COST_PAUSED_FILE = 'cost-paused';

/** How close to the monthly cap we are. `warn` is the `CXW_COST_WARN_PCT` threshold. */
export type CostLevel = 'ok' | 'warn' | 'paused';

export interface CapState {
  /** Percentage of the cap used, rounded. 0 when no cap is configured. */
  pct: number;
  total: number;
  cap: number;
  level: CostLevel;
  /** Owner-facing text for `warn`/`paused`, null at `ok`. Never suppressed. */
  text: string | null;
}

/** Price per million tokens. Matched against the model id by longest prefix. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const PRICING: Record<string, ModelPrice> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

const FALLBACK_MODEL = 'claude-opus-5';

export function priceFor(model: string): ModelPrice {
  const prefixes = Object.keys(PRICING).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (model.startsWith(prefix)) return PRICING[prefix] as ModelPrice;
  }
  logger.warn({ model }, 'unknown model id; pricing at opus-5 rates');
  return PRICING[FALLBACK_MODEL] as ModelPrice;
}

export interface UsageInput {
  ts?: number;
  source: 'chat' | 'routine';
  chatJid?: string;
  routine?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface Totals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export function computeCost(u: UsageInput): number {
  if (typeof u.costUsd === 'number') return u.costUsd;
  const p = priceFor(u.model);
  const perMillion =
    u.inputTokens * p.input +
    u.outputTokens * p.output +
    (u.cacheReadTokens ?? 0) * p.cacheRead +
    (u.cacheWriteTokens ?? 0) * p.cacheWrite;
  return perMillion / 1_000_000;
}

function openUsageDb(cfg: Config): DatabaseSync {
  const db = openDb(cfg.opsDb, { create: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      source TEXT NOT NULL,
      chat_jid TEXT,
      routine TEXT,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
  `);
  return db;
}

/** Record one model call and re-evaluate the monthly cap. Returns the computed cost. */
export function recordUsage(u: UsageInput, cfg: Config = loadConfig()): number {
  const cost = computeCost(u);
  const db = openUsageDb(cfg);
  try {
    db.prepare(
      `INSERT INTO usage (ts, source, chat_jid, routine, model, input_tokens, output_tokens,
                          cache_read_tokens, cache_write_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      u.ts ?? Date.now(),
      u.source,
      u.chatJid ?? null,
      u.routine ?? null,
      u.model,
      u.inputTokens,
      u.outputTokens,
      u.cacheReadTokens ?? 0,
      u.cacheWriteTokens ?? 0,
      cost,
    );
  } finally {
    db.close();
  }
  checkCap(cfg);
  return cost;
}

function totalsSince(cfg: Config, sinceMs: number): Totals {
  if (!fileExists(cfg.opsDb)) return { costUsd: 0, inputTokens: 0, outputTokens: 0, calls: 0 };
  const db = openUsageDb(cfg);
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS cost,
                COALESCE(SUM(input_tokens), 0) AS input,
                COALESCE(SUM(output_tokens), 0) AS output,
                COUNT(*) AS calls
         FROM usage
         WHERE (CASE WHEN ts < 1000000000000 THEN ts * 1000 ELSE ts END) >= ?`,
      )
      .get(sinceMs) as { cost: number; input: number; output: number; calls: number } | undefined;
    return {
      costUsd: Number(row?.cost ?? 0),
      inputTokens: Number(row?.input ?? 0),
      outputTokens: Number(row?.output ?? 0),
      calls: Number(row?.calls ?? 0),
    };
  } finally {
    db.close();
  }
}

export function todayTotals(cfg: Config = loadConfig(), now: number = Date.now()): Totals {
  return totalsSince(cfg, startOfDay(now));
}

export function monthTotals(cfg: Config = loadConfig(), now: number = Date.now()): Totals {
  return totalsSince(cfg, startOfMonth(now));
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatCap(cap: number): string {
  return Number.isInteger(cap) ? String(cap) : cap.toFixed(2);
}

/** `💸 Today: $1.23 (12.3k in / 4.5k out, 3 calls) · Month: $23.45 / $100 (23%)` */
export function dailyCostLine(cfg: Config = loadConfig(), now: number = Date.now()): string {
  const today = todayTotals(cfg, now);
  const month = monthTotals(cfg, now);
  const cap = cfg.cost.monthlyCapUsd;
  const pct = cap > 0 ? Math.round((month.costUsd / cap) * 100) : 0;
  return (
    `💸 Today: $${today.costUsd.toFixed(2)} ` +
    `(${formatTokens(today.inputTokens)} in / ${formatTokens(today.outputTokens)} out, ${today.calls} calls)` +
    ` · Month: $${month.costUsd.toFixed(2)} / $${formatCap(cap)} (${pct}%)`
  );
}

export interface CostPauseFlag {
  since: string;
  reason: 'cost-cap';
  month: string;
  total: number;
  cap: number;
}

export function readCostPause(cfg: Config): CostPauseFlag | null {
  return readJsonFile<CostPauseFlag>(statePath(cfg, COST_PAUSED_FILE));
}

/** Remove the cost pause flag (the `costs unpause` command). */
export function unpause(cfg: Config = loadConfig()): boolean {
  return removeFile(statePath(cfg, COST_PAUSED_FILE));
}

/**
 * Evaluate the monthly cap. This is the *state* half: it keeps the `cost-paused` flag in
 * step with the spend (idempotently, so `recordUsage` may call it on every model call) and
 * it always returns the owner-facing text for the current level. It never writes a
 * "already told the owner" marker and never suppresses the text — that is `notifyCap`'s
 * job, so a warning can no longer be swallowed by whichever caller happened to be first.
 */
export function checkCap(cfg: Config = loadConfig(), now: number = Date.now()): CapState {
  const cap = cfg.cost.monthlyCapUsd;
  const month = monthKey(now);

  const existing = readCostPause(cfg);
  if (existing !== null && existing.month !== month) {
    // New month: the cap resets and the pause lifts on its own.
    removeFile(statePath(cfg, COST_PAUSED_FILE));
  }

  const total = monthTotals(cfg, now).costUsd;
  if (cap <= 0) return { pct: 0, total, cap, level: 'ok', text: null };
  const pct = Math.round((total / cap) * 100);

  if (total >= cap) {
    if (readCostPause(cfg) === null) {
      const flag: CostPauseFlag = {
        since: new Date(now).toISOString(),
        reason: 'cost-cap',
        month,
        total,
        cap,
      };
      writeJsonFile(statePath(cfg, COST_PAUSED_FILE), flag);
    }
    return {
      pct,
      total,
      cap,
      level: 'paused',
      text:
        `🛑 cxw: monthly cost cap reached ($${total.toFixed(2)} / $${formatCap(cap)}). ` +
        'Non-essential routines are paused. Send `costs unpause` to override.',
    };
  }

  if (total >= (cap * cfg.cost.warnPct) / 100) {
    return {
      pct,
      total,
      cap,
      level: 'warn',
      text:
        `⚠️ cxw: ${pct}% of the monthly cost cap used ` +
        `($${total.toFixed(2)} / $${formatCap(cap)}).`,
    };
  }
  return { pct, total, cap, level: 'ok', text: null };
}

/** Why `notifyCap` did or did not tell the owner on this call. */
export type NotifyCapStatus =
  'notified' | 'already notified this month' | 'delivery failed' | 'no alert needed';

export interface NotifyCapResult extends CapState {
  /** True when `deliver` accepted the text on this call (once per month per level). */
  delivered: boolean;
  status: NotifyCapStatus;
}

/**
 * A delivery counts as failed only when the callback explicitly reports no channel, which
 * is what `deliver()` returns when every channel is down. Anything else (a plain callback
 * that returns nothing) is taken at its word.
 */
function deliveryFailed(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    'channel' in result &&
    (result as { channel: unknown }).channel === null
  );
}

/** The one status line `cxw-ops costs check` prints on every run. */
export function capStatusLine(result: NotifyCapResult): string {
  return (
    `cost: ${result.level} $${result.total.toFixed(2)} / $${formatCap(result.cap)} ` +
    `(${result.pct}%) — ${result.status}`
  );
}

/** Marker file proving the owner was already told about this level, this month. */
function levelMarker(level: CostLevel, month: string): string | null {
  if (level === 'warn') return `cost-warned-${month}`;
  if (level === 'paused') return `cost-paused-alerted-${month}`;
  return null;
}

/**
 * The *notification* half of the cap: hand the current warning to `deliver` exactly once
 * per month per level. Call it from the monitor tick (`cxw-ops costs check`), never from
 * `recordUsage` — a hot path must not be able to consume the owner's only warning.
 */
export async function notifyCap(
  deliver: (text: string) => Promise<unknown> | unknown,
  cfg: Config = loadConfig(),
  now: number = Date.now(),
): Promise<NotifyCapResult> {
  const state = checkCap(cfg, now);
  const month = monthKey(now);
  const marker = levelMarker(state.level, month);
  if (marker === null || state.text === null)
    return { ...state, delivered: false, status: 'no alert needed' };
  if (fileExists(statePath(cfg, marker)))
    return { ...state, delivered: false, status: 'already notified this month' };

  // Deliver first and claim the marker only on success. The alert chain is most likely to
  // be down exactly when the cap is hit, and a failed send must not burn the month's one
  // notification — the next monitor tick has to retry it.
  let failed: boolean;
  try {
    failed = deliveryFailed(await deliver(state.text));
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'cost cap alert could not be delivered',
    );
    failed = true;
  }
  if (failed) return { ...state, delivered: false, status: 'delivery failed' };

  const claim = { at: new Date(now).toISOString(), total: state.total, cap: state.cap };
  writeJsonFile(statePath(cfg, marker), claim);
  // Once the cap is reached the spend only grows, so the warn level can never come back.
  // Claim its marker too, so pausing does not also emit a stale 80% warning next tick.
  if (state.level === 'paused') {
    const warnMarker = statePath(cfg, `cost-warned-${month}`);
    if (!fileExists(warnMarker)) writeJsonFile(warnMarker, claim);
  }
  return { ...state, delivered: true, status: 'notified' };
}
