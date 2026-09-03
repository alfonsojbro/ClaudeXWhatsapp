import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { statfs } from 'node:fs/promises';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { fileExists, readJsonFile, statePath, writeState } from './state.js';

export const HEALTH_FILE = 'health.json';
export const PANIC_FILE = 'panic';
const DEEP_CHECK_STAMP = 'claude-auth-deep.json';

export type HealAction = 'restart bridge' | 'restart brain' | 'purge --emergency' | 'backup';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  healAction: HealAction | null;
  /** True when the failure is expected (panic mode) and must not raise an alert. */
  noAlert?: boolean;
}

export interface HealthReport {
  ts: number;
  ok: boolean;
  checks: Check[];
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Run a check with a hard timeout; a timeout or throw becomes a failed check. */
async function guard(
  name: string,
  healAction: HealAction | null,
  timeoutMs: number,
  fn: () => Promise<Check>,
): Promise<Check> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Check>((resolve) => {
    timer = setTimeout(
      () => resolve({ name, ok: false, detail: `timeout after ${timeoutMs}ms`, healAction }),
      timeoutMs,
    );
    timer.unref();
  });
  try {
    return await Promise.race([fn(), timeout]);
  } catch (err) {
    return { name, ok: false, detail: errText(err), healAction };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function getJson(url: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

async function checkWhatsApp(cfg: Config): Promise<Check> {
  const body = await getJson(`${cfg.bridgeUrl}/health`, cfg.healthTimeoutMs);
  const connected = body['ok'] === true && body['connected'] === true;
  const uptime = body['uptimeSec'] ?? body['uptime_s'] ?? null;
  return {
    name: 'whatsapp',
    ok: connected,
    detail: connected ? `connected, uptime ${String(uptime ?? '?')}s` : 'bridge not connected',
    healAction: connected ? null : 'restart bridge',
  };
}

async function checkBrain(cfg: Config): Promise<Check> {
  const body = await getJson(`${cfg.brainUrl}/health`, cfg.healthTimeoutMs);
  const ok = body['ok'] === true;
  return {
    name: 'brain',
    ok,
    detail: ok ? `sessions ${String(body['sessions'] ?? 0)}` : 'brain reports not ok',
    healAction: ok ? null : 'restart brain',
  };
}

async function checkGoogle(cfg: Config): Promise<Check> {
  if (!cfg.google.enabled) {
    return { name: 'google', ok: true, detail: 'disabled', healAction: null };
  }
  const { clientId, clientSecret, refreshToken, tokenUrl } = cfg.google;
  if (clientId === undefined || clientSecret === undefined || refreshToken === undefined) {
    return { name: 'google', ok: false, detail: 'not configured', healAction: null };
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(cfg.healthTimeoutMs),
  });
  if (!res.ok) {
    return {
      name: 'google',
      ok: false,
      detail: `token endpoint HTTP ${res.status}`,
      healAction: null,
    };
  }
  const json = (await res.json().catch(() => ({}))) as { access_token?: unknown };
  const ok = typeof json.access_token === 'string' && json.access_token.length > 0;
  return {
    name: 'google',
    ok,
    detail: ok ? 'refresh token valid' : 'no access_token in response',
    healAction: null,
  };
}

async function checkDisk(cfg: Config): Promise<Check> {
  const st = await statfs(cfg.diskPath);
  const total = Number(st.blocks);
  const free = Number(st.bfree);
  const usedPct = total > 0 ? ((total - free) / total) * 100 : 100;
  const ok = usedPct < cfg.diskLimitPct;
  return {
    name: 'disk',
    ok,
    detail: `${usedPct.toFixed(1)}% used (limit ${cfg.diskLimitPct}%)`,
    healAction: ok ? null : 'purge --emergency',
  };
}

/** Backup freshness from the marker file written by `backup.sh` (UTC ISO or mtime). */
async function checkBackup(cfg: Config): Promise<Check> {
  const marker = statePath(cfg, 'last-backup');
  let stamp: number | null = null;
  try {
    const raw = fs.readFileSync(marker, 'utf8').trim();
    const parsed = Date.parse(raw);
    stamp = Number.isNaN(parsed) ? fs.statSync(marker).mtimeMs : parsed;
  } catch {
    stamp = null;
  }
  if (stamp === null) {
    return { name: 'backup', ok: false, detail: 'no last-backup marker', healAction: 'backup' };
  }
  const ageH = (Date.now() - stamp) / 3_600_000;
  const ok = ageH <= cfg.backupMaxAgeH;
  return {
    name: 'backup',
    ok,
    detail: `${ageH.toFixed(1)}h old (max ${cfg.backupMaxAgeH}h)`,
    healAction: ok ? null : 'backup',
  };
}

interface DeepStamp {
  at: number;
  ok: boolean;
  detail: string;
}

function cheapAuth(cfg: Config): { ok: boolean; detail: string } {
  if (cfg.claude.oauthToken !== undefined) return { ok: true, detail: 'oauth token set' };
  if (cfg.claude.apiKey !== undefined) return { ok: true, detail: 'api key set' };
  const creds = readJsonFile<{ claudeAiOauth?: { expiresAt?: number } }>(
    cfg.claude.credentialsFile,
  );
  const expiresAt = creds?.claudeAiOauth?.expiresAt;
  if (typeof expiresAt !== 'number') {
    return { ok: false, detail: 'no token env and no usable credentials file' };
  }
  // The credentials file stores expiresAt in ms.
  if (expiresAt <= Date.now()) return { ok: false, detail: 'stored credentials expired' };
  return { ok: true, detail: 'credentials file valid' };
}

function runClaude(cfg: Config): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    execFile(
      cfg.claude.bin,
      ['-p', 'ok', '--model', cfg.claude.fastModel, '--max-turns', '1'],
      { timeout: 60_000 },
      (err) => {
        if (err) resolve({ ok: false, detail: `deep check failed: ${errText(err)}` });
        else resolve({ ok: true, detail: 'deep check ok' });
      },
    );
  });
}

async function checkClaudeAuth(cfg: Config): Promise<Check> {
  const cheap = cheapAuth(cfg);
  if (!cheap.ok) {
    return { name: 'claude_auth', ok: false, detail: cheap.detail, healAction: null };
  }
  const intervalMin = cfg.claude.deepCheckMin;
  if (intervalMin <= 0) {
    return { name: 'claude_auth', ok: true, detail: cheap.detail, healAction: null };
  }
  const stampFile = statePath(cfg, DEEP_CHECK_STAMP);
  const last = readJsonFile<DeepStamp>(stampFile);
  const due = last === null || Date.now() - last.at >= intervalMin * 60_000;
  if (!due) {
    return {
      name: 'claude_auth',
      ok: last.ok,
      detail: `${cheap.detail}; last ${last.detail}`,
      healAction: null,
    };
  }
  const deep = await runClaude(cfg);
  writeState(cfg, DEEP_CHECK_STAMP, { at: Date.now(), ok: deep.ok, detail: deep.detail });
  return {
    name: 'claude_auth',
    ok: deep.ok,
    detail: `${cheap.detail}; ${deep.detail}`,
    healAction: null,
  };
}

/**
 * Run every health check. Each is independently timed out and try/caught, so one hang can
 * never stop the report from being written.
 */
export async function runHealth(cfg: Config = loadConfig()): Promise<HealthReport> {
  const t = cfg.healthTimeoutMs;
  const panic = fileExists(statePath(cfg, PANIC_FILE));

  const checks = await Promise.all([
    guard('whatsapp', 'restart bridge', t, () => checkWhatsApp(cfg)),
    guard('brain', 'restart brain', t, () => checkBrain(cfg)),
    guard('google', null, t, () => checkGoogle(cfg)),
    guard('disk', 'purge --emergency', t, () => checkDisk(cfg)),
    guard('backup', 'backup', t, () => checkBackup(cfg)),
    // The deep auth check spawns `claude`, which needs longer than the HTTP timeout.
    guard('claude_auth', null, Math.max(t, 65_000), () => checkClaudeAuth(cfg)),
  ]);

  const adjusted = checks.map((c): Check => {
    if (c.name !== 'brain' || c.ok || !panic) return c;
    return {
      name: 'brain',
      ok: false,
      detail: 'panic mode, expected down',
      healAction: null,
      noAlert: true,
    };
  });

  const report: HealthReport = {
    ts: Date.now(),
    ok: adjusted.every((c) => c.ok),
    checks: adjusted,
  };
  try {
    writeState(cfg, HEALTH_FILE, report);
  } catch (err) {
    logger.error({ err: errText(err) }, 'could not write health.json');
  }
  return report;
}

export function readHealth(cfg: Config): HealthReport | null {
  return readJsonFile<HealthReport>(statePath(cfg, HEALTH_FILE));
}

/** Deduped list of heal actions for the failing checks. */
export function healActions(report: HealthReport): HealAction[] {
  const out: HealAction[] = [];
  for (const c of report.checks) {
    if (c.ok || c.healAction === null) continue;
    if (!out.includes(c.healAction)) out.push(c.healAction);
  }
  return out;
}
