import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { checkCap, dailyCostLine, monthTotals, todayTotals, unpause } from './costs.js';
import { readHealth } from './health.js';
import { getPauseState, panic, resume } from './killswitch.js';
import { logger } from './logger.js';
import { isHandled, markHandled } from './sentinel.js';
import { formatDuration } from './state.js';
import { OpsError, purge } from './retention.js';

export interface OpsCommandContext {
  senderJid: string;
  isOwner: boolean;
  messageId?: string;
}

export interface OpsCommandDeps {
  cfg?: Config;
  /** Injectable so tests can run the deferred panic without a real timer. */
  schedule?: (fn: () => void, ms: number) => void;
  /** Delay before the panic stop runs, so the ack can be delivered first. */
  panicDelayMs?: number;
}

const PANIC_ACK = '🛑 Panic: scheduler and brain stopping. Send `resume` to restart.';

function defaultSchedule(fn: () => void, ms: number): void {
  const t = setTimeout(fn, ms);
  t.unref();
}

/** Status one-liner per check plus pause state and today's spend. */
export function statusText(cfg: Config = loadConfig(), now: number = Date.now()): string {
  const lines: string[] = [];
  const health = readHealth(cfg);
  if (health === null) {
    lines.push('🩺 no health report yet');
  } else {
    lines.push(`🩺 health ${formatDuration(now - health.ts)} ago`);
    for (const check of health.checks) {
      lines.push(`${check.ok ? '✅' : '❌'} ${check.name} — ${check.detail}`);
    }
  }
  const pause = getPauseState(cfg, now);
  lines.push(pause.paused ? `⏸ paused: ${pause.reasons.join(', ')}` : '▶️ running');
  lines.push(dailyCostLine(cfg, now));
  return lines.join('\n');
}

function costsText(cfg: Config, arg: string | undefined, now: number): string {
  if (arg === 'today') {
    const t = todayTotals(cfg, now);
    return `Today: $${t.costUsd.toFixed(2)} · ${t.calls} calls · ${t.inputTokens} in / ${t.outputTokens} out`;
  }
  if (arg === 'month') {
    const m = monthTotals(cfg, now);
    return `Month: $${m.costUsd.toFixed(2)} of $${cfg.cost.monthlyCapUsd} · ${m.calls} calls`;
  }
  if (arg === 'unpause') {
    const removed = unpause(cfg);
    return removed ? '▶️ Cost cap override on; routines resume.' : 'Nothing to unpause.';
  }
  return dailyCostLine(cfg, now);
}

function purgeText(cfg: Config, args: string[]): string {
  const dryRun = args.includes('--dry-run');
  const emergency = args.includes('--emergency');
  let r;
  try {
    r = purge({ dryRun, emergency }, cfg);
  } catch (err) {
    // The owner asked for this by message: answer with the refusal, do not throw at them.
    if (err instanceof OpsError) return `⚠️ ${err.message}`;
    throw err;
  }
  const mb = (r.bytes / 1_048_576).toFixed(1);
  const prefix = r.dryRun ? '🧪 Purge (dry run)' : '🧹 Purge';
  const mode = r.emergency ? ' emergency' : '';
  return `${prefix}${mode}: ${r.textRows} text rows, ${r.mediaRows} media rows, ${r.files} files, ${mb} MB.`;
}

/**
 * Ops command hook for the brain router. Called before any LLM call: a non-null return is
 * the reply and the message is consumed. Non-owners always get null.
 */
export async function handleOpsCommand(
  text: string,
  ctx: OpsCommandContext,
  deps: OpsCommandDeps = {},
): Promise<string | null> {
  if (!ctx.isOwner) return null;
  if (typeof text !== 'string') return null;

  const cfg = deps.cfg ?? loadConfig();
  const parts = text
    .trim()
    .replace(/^\//, '')
    .split(/\s+/)
    .filter((p) => p.length > 0);
  const verb = (parts[0] ?? '').toLowerCase();
  const args = parts.slice(1);
  if (!['panic', 'resume', 'status', 'purge', 'costs'].includes(verb)) return null;

  const messageId = ctx.messageId;
  if (messageId !== undefined) {
    if (isHandled(cfg, messageId)) return null;
    markHandled(cfg, messageId);
  }

  const now = Date.now();
  switch (verb) {
    case 'panic': {
      const schedule = deps.schedule ?? defaultSchedule;
      const reason = args.length > 0 ? args.join(' ') : 'owner request';
      // Ack first: the caller sends it, then the brain is allowed to go down.
      schedule(() => {
        void panic(reason, 'owner', cfg).catch((err: unknown) => {
          logger.error({ err: err instanceof Error ? err.message : String(err) }, 'panic failed');
        });
      }, deps.panicDelayMs ?? 1000);
      return PANIC_ACK;
    }
    case 'resume':
      await resume(cfg);
      return '▶️ Resumed.';
    case 'status':
      return statusText(cfg, now);
    case 'purge':
      return purgeText(cfg, args);
    case 'costs': {
      const line = costsText(cfg, args[0]?.toLowerCase(), now);
      const cap = checkCap(cfg, now);
      return cap.text === null ? line : `${line}\n${cap.text}`;
    }
    default:
      return null;
  }
}
