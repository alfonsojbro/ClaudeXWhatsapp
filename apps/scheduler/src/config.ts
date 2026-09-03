/**
 * Environment configuration for the scheduler.
 *
 * `loadConfig` is pure: it reads only the record it is given, never the filesystem, and never
 * throws for missing Google or Anthropic credentials — those are optional at this layer.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Repo root, derived from this file's location (`apps/scheduler/src/config.ts`). */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

const DEFAULT_TZ = 'Europe/Prague';
const DEFAULT_DATA_DIR = '/srv/cxw/data';
const DEFAULT_BRIDGE_HOST = '127.0.0.1';
/** Matches `BRIDGE_PORT` in `deploy/hetzner/cxw.env.example` and the box itself. */
const DEFAULT_BRIDGE_PORT = '7411';

/** A raw environment record. `process.env` satisfies this. */
export type EnvRecord = Record<string, string | undefined>;

const intFrom = (fallback: number, min = 1): z.ZodType<number> =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .refine((n) => Number.isFinite(n) && n >= min, {
      message: `expected an integer >= ${String(min)}`,
    })
    .transform((n) => Math.trunc(n));

const optionalString = (): z.ZodType<string | undefined> =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : v));

const nonEmpty = (fallback: string): z.ZodType<string> =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v));

/** Validated scheduler configuration. */
export interface Config {
  timezone: string;
  logLevel: string;
  vaultDir: string;
  dataDir: string;
  workspaceDir: string;
  dbPath: string;
  bridgeUrl: string;
  bridgeToken?: string;
  ownerJid?: string;
  tickMs: number;
  maxConcurrentJobs: number;
  leaseTtlMs: number;
  jobTimeoutMs: number;
  calendarPollMinutes: number;
  /** Maximum used-disk percentage that still counts as healthy. */
  diskLimitPct: number;
  backupStampFile?: string;
  backupMaxAgeHours: number;
  alertEmailTo?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleRefreshToken?: string;
  anthropicApiKey?: string;
  claudeCodeOauthToken?: string;
}

const schema = z.object({
  CXW_TZ: optionalString(),
  TZ: optionalString(),
  LOG_LEVEL: nonEmpty('info'),
  CXW_VAULT_DIR: optionalString(),
  CXW_DATA_DIR: nonEmpty(DEFAULT_DATA_DIR),
  CXW_WORKSPACE_DIR: optionalString(),
  SCHEDULER_DB: optionalString(),
  BRIDGE_URL: optionalString(),
  BRIDGE_HOST: nonEmpty(DEFAULT_BRIDGE_HOST),
  BRIDGE_PORT: nonEmpty(DEFAULT_BRIDGE_PORT),
  BRIDGE_TOKEN: optionalString(),
  OWNER_JID: optionalString(),
  SCHEDULER_TICK_MS: intFrom(60_000),
  MAX_CONCURRENT_JOBS: intFrom(2),
  LEASE_TTL_MS: intFrom(90_000),
  JOB_TIMEOUT_MS: intFrom(900_000),
  CALENDAR_POLL_MINUTES: intFrom(5),
  CXW_DISK_LIMIT_PCT: intFrom(85),
  CXW_BACKUP_STAMP_FILE: optionalString(),
  CXW_BACKUP_MAX_AGE_H: intFrom(8),
  CXW_ALERT_EMAIL_TO: optionalString(),
  GOOGLE_CLIENT_ID: optionalString(),
  GOOGLE_CLIENT_SECRET: optionalString(),
  GOOGLE_REFRESH_TOKEN: optionalString(),
  ANTHROPIC_API_KEY: optionalString(),
  CLAUDE_CODE_OAUTH_TOKEN: optionalString(),
});

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the scheduler config from an environment record.
 *
 * @throws {z.ZodError} when a present value is malformed (never for a merely missing credential).
 */
export function loadConfig(env: EnvRecord = process.env): Config {
  const e = schema.parse(env);

  const tzCandidate = e.CXW_TZ ?? e.TZ ?? DEFAULT_TZ;
  const timezone = isValidTimeZone(tzCandidate) ? tzCandidate : DEFAULT_TZ;

  const dataDir = path.resolve(e.CXW_DATA_DIR);
  const vaultDir = path.resolve(e.CXW_VAULT_DIR ?? path.join(REPO_ROOT, 'vault'));
  const workspaceDir = path.resolve(e.CXW_WORKSPACE_DIR ?? path.join(REPO_ROOT, 'workspace'));
  const dbPath = e.SCHEDULER_DB ?? path.join(dataDir, 'scheduler.sqlite');
  const bridgeUrl = (e.BRIDGE_URL ?? `http://${e.BRIDGE_HOST}:${e.BRIDGE_PORT}`).replace(
    /\/+$/,
    '',
  );

  const config: Config = {
    timezone,
    logLevel: e.LOG_LEVEL,
    vaultDir,
    dataDir,
    workspaceDir,
    dbPath,
    bridgeUrl,
    tickMs: e.SCHEDULER_TICK_MS,
    maxConcurrentJobs: e.MAX_CONCURRENT_JOBS,
    leaseTtlMs: e.LEASE_TTL_MS,
    jobTimeoutMs: e.JOB_TIMEOUT_MS,
    calendarPollMinutes: e.CALENDAR_POLL_MINUTES,
    diskLimitPct: e.CXW_DISK_LIMIT_PCT,
    backupMaxAgeHours: e.CXW_BACKUP_MAX_AGE_H,
  };

  if (e.BRIDGE_TOKEN !== undefined) config.bridgeToken = e.BRIDGE_TOKEN;
  if (e.OWNER_JID !== undefined) config.ownerJid = e.OWNER_JID;
  if (e.CXW_BACKUP_STAMP_FILE !== undefined) config.backupStampFile = e.CXW_BACKUP_STAMP_FILE;
  if (e.CXW_ALERT_EMAIL_TO !== undefined) config.alertEmailTo = e.CXW_ALERT_EMAIL_TO;
  if (e.GOOGLE_CLIENT_ID !== undefined) config.googleClientId = e.GOOGLE_CLIENT_ID;
  if (e.GOOGLE_CLIENT_SECRET !== undefined) config.googleClientSecret = e.GOOGLE_CLIENT_SECRET;
  if (e.GOOGLE_REFRESH_TOKEN !== undefined) config.googleRefreshToken = e.GOOGLE_REFRESH_TOKEN;
  if (e.ANTHROPIC_API_KEY !== undefined) config.anthropicApiKey = e.ANTHROPIC_API_KEY;
  if (e.CLAUDE_CODE_OAUTH_TOKEN !== undefined) {
    config.claudeCodeOauthToken = e.CLAUDE_CODE_OAUTH_TOKEN;
  }

  return config;
}
