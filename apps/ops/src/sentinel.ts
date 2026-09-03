import type { DatabaseSync } from 'node:sqlite';
import { deliver } from './alerts.js';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { openDb, TS_MS_SQL, toMs } from './db.js';
import { panic, resume } from './killswitch.js';
import { logger } from './logger.js';
import { isOwnerJid, loadOwners } from './owners.js';
import { fileExists, readState, writeState } from './state.js';

export const SENTINEL_STATE_FILE = 'sentinel.json';
export const SENTINEL_POLL_MS = 5000;
const MAX_HANDLED = 200;

export type KillSwitchWord = 'panic' | 'resume';

export interface SentinelState {
  lastSeen: number;
  handled: string[];
}

export interface SentinelHit {
  id: string;
  jid: string;
  word: KillSwitchWord;
  ts: number;
}

interface MessageRow {
  jid: string;
  id: string;
  ts: number;
  from_me: number | null;
  sender: string | null;
  text: string | null;
}

/** `panic`, `/Resume `, `PANIC` → the kill switch word. Anything else → null. */
export function isKillSwitchText(text: string | null | undefined): KillSwitchWord | null {
  if (typeof text !== 'string') return null;
  const value = text.trim().replace(/^\//, '').trim().toLowerCase();
  if (value === 'panic') return 'panic';
  if (value === 'resume') return 'resume';
  return null;
}

export function emptySentinelState(now: number = Date.now()): SentinelState {
  return { lastSeen: now, handled: [] };
}

export function readSentinelState(cfg: Config): SentinelState | null {
  const state = readState<SentinelState>(cfg, SENTINEL_STATE_FILE);
  if (state === null) return null;
  return {
    lastSeen: typeof state.lastSeen === 'number' ? state.lastSeen : Date.now(),
    handled: Array.isArray(state.handled) ? state.handled : [],
  };
}

export function writeSentinelState(cfg: Config, state: SentinelState): void {
  writeState(cfg, SENTINEL_STATE_FILE, {
    lastSeen: state.lastSeen,
    handled: state.handled.slice(-MAX_HANDLED),
  });
}

/** True when this message id was already acted on (by the sentinel or the brain handler). */
export function isHandled(cfg: Config, messageId: string): boolean {
  const state = readSentinelState(cfg);
  return state !== null && state.handled.includes(messageId);
}

/** Record a message id so the sentinel and the brain command handler never double-fire. */
export function markHandled(cfg: Config, messageId: string): void {
  const state = readSentinelState(cfg) ?? emptySentinelState();
  if (state.handled.includes(messageId)) return;
  state.handled = [...state.handled, messageId].slice(-MAX_HANDLED);
  writeSentinelState(cfg, state);
}

/**
 * One poll of the bridge store: read the rows newer than `lastSeen` and return the next
 * state plus the kill-switch hits to execute.
 *
 * When `cfg` is given, the handled ids persisted in `sentinel.json` are merged in first.
 * The brain command handler writes that file, and a *running* sentinel would otherwise
 * keep its set purely in memory — so both paths would fire for the same message, which is
 * the normal case since the sentinel is a `Restart=always` unit. The union becomes the new
 * in-memory set. Without `cfg` the call stays pure with respect to the file system.
 */
export function pollOnce(
  db: DatabaseSync,
  state: SentinelState,
  owners: string[],
  cfg?: Config,
): { next: SentinelState; hits: SentinelHit[] } {
  const rows = db
    .prepare(
      `SELECT jid, id, ts, from_me, sender, text FROM messages
       WHERE ${TS_MS_SQL} > ? ORDER BY ${TS_MS_SQL} ASC LIMIT 200`,
    )
    .all(state.lastSeen) as unknown as MessageRow[];

  const hits: SentinelHit[] = [];
  let lastSeen = state.lastSeen;
  const persisted = cfg === undefined ? null : readSentinelState(cfg);
  const handled =
    persisted === null
      ? [...state.handled]
      : [...new Set([...state.handled, ...persisted.handled])];

  for (const row of rows) {
    const ms = toMs(Number(row.ts));
    if (ms > lastSeen) lastSeen = ms;
    if (handled.includes(row.id)) continue;
    // The kill switch fires only inside an owner conversation, and only when the message
    // is ours or an owner's. `from_me` alone would let the word "panic" typed to a
    // recruiter stop production; an owner `sender` alone would do the same for any
    // outgoing message, since the bridge stamps our own JID on those.
    const fromOwner =
      isOwnerJid(row.jid, owners) &&
      (row.from_me === 1 || isOwnerJid(row.sender ?? row.jid, owners));
    if (!fromOwner) continue;
    const word = isKillSwitchText(row.text);
    if (word === null) continue;
    hits.push({ id: row.id, jid: row.jid, word, ts: ms });
    handled.push(row.id);
  }

  return { next: { lastSeen, handled: handled.slice(-MAX_HANDLED) }, hits };
}

async function sendAck(cfg: Config, owners: string[], text: string): Promise<void> {
  const jid = owners[0];
  if (jid === undefined || !isOwnerJid(jid, owners)) return;
  if (cfg.alert.transport === 'log') {
    process.stdout.write(`[alert:whatsapp] ${text}\n`);
    return;
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.bridgeToken !== undefined) headers['authorization'] = `Bearer ${cfg.bridgeToken}`;
  await fetch(`${cfg.bridgeUrl}/send`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jid, text }),
    signal: AbortSignal.timeout(cfg.healthTimeoutMs),
  });
}

/** Best-effort owner alert when a kill-switch action itself failed. Never throws. */
async function alertActionFailure(
  cfg: Config,
  owners: string[],
  word: KillSwitchWord,
  message: string,
): Promise<void> {
  try {
    await deliver(
      [`🚨 cxw: kill switch "${word}" FAILED — ${message}`],
      { whatsappOk: false, owners },
      cfg,
    );
  } catch {
    // Alerting is the last resort; there is nothing above it to report to.
  }
}

export const PANIC_ACK = '🛑 Panic: scheduler and brain stopping. Send `resume` to restart.';
export const RESUME_ACK = '▶️ Resumed.';

/**
 * Run one kill-switch hit. The action comes first and the acknowledgement can never gate
 * it: the sentinel exists for the case where the bridge is broken, so a `POST /send` that
 * times out must not turn `panic` into a no-op.
 */
export async function executeHit(cfg: Config, owners: string[], hit: SentinelHit): Promise<void> {
  if (hit.word === 'panic') {
    await panic('sentinel kill switch', 'sentinel', cfg);
  } else {
    await resume(cfg);
  }
  await sendAck(cfg, owners, hit.word === 'panic' ? PANIC_ACK : RESUME_ACK).catch(
    (err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'kill-switch ack could not be delivered',
      );
    },
  );
}

export interface SentinelHandle {
  stop: () => void;
  /** Resolves when the loop has stopped. */
  done: Promise<void>;
}

/**
 * One iteration of the watcher loop: poll, run whatever the poll found, persist. It is
 * exported so the loop's behaviour — above all that the poll re-reads `sentinel.json`, so
 * an id the brain command handler already consumed is never fired a second time — is
 * testable without timers. Returns the next state.
 */
export async function sentinelTick(
  cfg: Config,
  state: SentinelState,
  owners: string[],
): Promise<SentinelState> {
  if (!fileExists(cfg.bridgeDb)) return state;
  const db = openDb(cfg.bridgeDb, { readOnly: true });
  let next = state;
  let hits: SentinelHit[] = [];
  try {
    // `cfg` makes the poll re-read `sentinel.json`, so an id the brain handler already
    // consumed is never fired a second time by this loop.
    const polled = pollOnce(db, state, owners, cfg);
    next = polled.next;
    hits = polled.hits;
  } finally {
    db.close();
  }
  for (const hit of hits) {
    try {
      await executeHit(cfg, owners, hit);
    } catch (err) {
      // The id is still marked handled so a broken action cannot loop forever, but the
      // failure must be loud and must reach the owner if any channel is alive.
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message, word: hit.word }, 'kill-switch action failed');
      await alertActionFailure(cfg, owners, hit.word, message);
    }
  }
  // Persist only after the actions ran, so a crash mid-action retries next poll.
  if (hits.length > 0) writeSentinelState(cfg, next);
  return next;
}

/**
 * Long-running kill-switch watcher. It never calls an LLM, so `panic` still works when the
 * brain is dead or hung. History is never replayed: it starts from "now".
 */
export function runSentinel(cfg: Config = loadConfig()): SentinelHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let wake: (() => void) | undefined;

  const done = (async () => {
    let state = readSentinelState(cfg) ?? emptySentinelState();
    state.lastSeen = Date.now();
    writeSentinelState(cfg, state);
    logger.info('sentinel watching for the kill switch');

    while (!stopped) {
      try {
        state = await sentinelTick(cfg, state, loadOwners(cfg));
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'sentinel poll failed',
        );
      }
      if (stopped) break;
      await new Promise<void>((r) => {
        wake = r;
        timer = setTimeout(r, SENTINEL_POLL_MS);
        timer.unref();
      });
    }
  })();

  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      if (wake !== undefined) wake();
    },
    done,
  };
}
