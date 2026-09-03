import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { isOwnerJid, loadOwners } from './owners.js';
import { formatDuration, readState, writeState } from './state.js';

export const ALERT_STATE_FILE = 'alerts.json';

export type AlertChannel = 'whatsapp' | 'email' | 'telegram';

export interface CheckLike {
  name: string;
  ok: boolean;
  detail: string;
}

export interface AlertEntry {
  status: 'ok' | 'failing';
  failures: number;
  firstFailedAt: number | null;
  lastAlertAt: number | null;
  alertCount: number;
}

export type AlertState = Record<string, AlertEntry>;

export interface Alert {
  check: string;
  kind: 'failing' | 'recovered';
  text: string;
}

export interface ReconcileOptions {
  repeatMin: number;
  afterFailures: number;
}

const EMPTY: AlertEntry = {
  status: 'ok',
  failures: 0,
  firstFailedAt: null,
  lastAlertAt: null,
  alertCount: 0,
};

/**
 * Pure alert state machine. Alerts once a check has failed `afterFailures` times, repeats
 * no more often than `repeatMin` minutes, and emits one recovery message per outage.
 */
export function reconcile(
  previous: AlertState,
  checks: CheckLike[],
  now: number,
  opts: ReconcileOptions,
): { next: AlertState; toSend: Alert[] } {
  const next: AlertState = { ...previous };
  const toSend: Alert[] = [];
  const repeatMs = Math.max(0, opts.repeatMin) * 60_000;
  const threshold = Math.max(1, opts.afterFailures);

  for (const check of checks) {
    const prev = previous[check.name] ?? EMPTY;

    if (!check.ok) {
      const failures = prev.failures + 1;
      const firstFailedAt = prev.status === 'failing' ? (prev.firstFailedAt ?? now) : now;
      const dueForRepeat = prev.lastAlertAt !== null && now - prev.lastAlertAt >= repeatMs;
      const shouldAlert = failures >= threshold && (prev.lastAlertAt === null || dueForRepeat);

      next[check.name] = {
        status: 'failing',
        failures,
        firstFailedAt,
        lastAlertAt: shouldAlert ? now : prev.lastAlertAt,
        alertCount: shouldAlert ? prev.alertCount + 1 : prev.alertCount,
      };

      if (shouldAlert) {
        toSend.push({
          check: check.name,
          kind: 'failing',
          text: `🚨 cxw: ${check.name} FAILING since ${new Date(firstFailedAt).toISOString()} — ${check.detail}`,
        });
      }
      continue;
    }

    if (prev.status === 'failing' && prev.alertCount > 0) {
      const since = prev.firstFailedAt ?? now;
      toSend.push({
        check: check.name,
        kind: 'recovered',
        text: `✅ cxw: ${check.name} recovered after ${formatDuration(now - since)}`,
      });
    }
    next[check.name] = { ...EMPTY };
  }

  return { next, toSend };
}

export function readAlertState(cfg: Config): AlertState {
  return readState<AlertState>(cfg, ALERT_STATE_FILE) ?? {};
}

export function writeAlertState(cfg: Config, state: AlertState): void {
  writeState(cfg, ALERT_STATE_FILE, state);
}

/** Where WhatsApp alerts go: the configured JID, else the first owner. Must be an owner. */
export function alertTargetJid(cfg: Config, owners: string[]): string | null {
  const configured = cfg.alert.whatsappJid;
  if (configured !== undefined) {
    if (!isOwnerJid(configured, owners)) {
      logger.error('CXW_ALERT_WHATSAPP_JID is not an owner JID; refusing to send');
      return null;
    }
    return configured;
  }
  return owners[0] ?? null;
}

async function sendWhatsApp(cfg: Config, owners: string[], text: string): Promise<boolean> {
  const jid = alertTargetJid(cfg, owners);
  if (jid === null) return false;
  // Defence in depth: ops must never send to a non-owner, whatever the config says.
  if (!isOwnerJid(jid, owners)) {
    logger.error('refusing to deliver an alert to a non-owner JID');
    return false;
  }
  if (cfg.alert.transport === 'log') {
    process.stdout.write(`[alert:whatsapp] ${text}\n`);
    return true;
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.bridgeToken !== undefined) headers['authorization'] = `Bearer ${cfg.bridgeToken}`;
  const res = await fetch(`${cfg.bridgeUrl}/send`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jid, text }),
    signal: AbortSignal.timeout(cfg.healthTimeoutMs),
  });
  if (!res.ok) return false;
  const body = (await res.json().catch(() => ({}))) as { ok?: unknown };
  return body.ok !== false;
}

async function sendEmail(cfg: Config, text: string): Promise<boolean> {
  const { host, from, to } = cfg.smtp;
  if (host === undefined || from === undefined || to === undefined) return false;
  if (cfg.alert.transport === 'log') {
    process.stdout.write(`[alert:email] ${text}\n`);
    return true;
  }
  const { createTransport } = await import('nodemailer');
  const auth =
    cfg.smtp.user !== undefined && cfg.smtp.pass !== undefined
      ? { user: cfg.smtp.user, pass: cfg.smtp.pass }
      : undefined;
  const transport = createTransport({
    host,
    port: cfg.smtp.port,
    secure: cfg.smtp.secure,
    ...(auth === undefined ? {} : { auth }),
  });
  await transport.sendMail({ from, to, subject: 'cxw alert', text });
  return true;
}

async function sendTelegram(cfg: Config, text: string): Promise<boolean> {
  if (!cfg.telegram.enabled) return false;
  const { botToken, chatId } = cfg.telegram;
  if (botToken === undefined || chatId === undefined) return false;
  if (cfg.alert.transport === 'log') {
    process.stdout.write(`[alert:telegram] ${text}\n`);
    return true;
  }
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(cfg.healthTimeoutMs),
  });
  return res.ok;
}

export interface DeliverResult {
  channel: AlertChannel | null;
  errors: string[];
}

/**
 * Deliver one batch of alert text. WhatsApp first when the bridge is healthy, then email,
 * then Telegram. Delivery failures are reported, never thrown.
 */
export async function deliver(
  texts: string[],
  ctx: { whatsappOk: boolean; owners?: string[] },
  cfg: Config = loadConfig(),
): Promise<DeliverResult> {
  const errors: string[] = [];
  if (texts.length === 0) return { channel: null, errors };
  const text = texts.join('\n');
  const owners = ctx.owners ?? loadOwners(cfg);

  const chain: Array<{ channel: AlertChannel; run: () => Promise<boolean> }> = [];
  if (ctx.whatsappOk)
    chain.push({ channel: 'whatsapp', run: () => sendWhatsApp(cfg, owners, text) });
  chain.push({ channel: 'email', run: () => sendEmail(cfg, text) });
  chain.push({ channel: 'telegram', run: () => sendTelegram(cfg, text) });

  for (const step of chain) {
    try {
      if (await step.run()) return { channel: step.channel, errors };
    } catch (err) {
      errors.push(`${step.channel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  logger.error({ errors }, 'alert delivery failed on every channel');
  return { channel: null, errors };
}
