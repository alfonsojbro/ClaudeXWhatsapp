import path from 'node:path';
import os from 'node:os';

export type AlertTransport = 'live' | 'log';

export interface SmtpConfig {
  host: string | undefined;
  port: number;
  user: string | undefined;
  pass: string | undefined;
  secure: boolean;
  from: string | undefined;
  to: string | undefined;
}

export interface TelegramConfig {
  enabled: boolean;
  botToken: string | undefined;
  chatId: string | undefined;
}

export interface GoogleConfig {
  enabled: boolean;
  clientId: string | undefined;
  clientSecret: string | undefined;
  refreshToken: string | undefined;
  tokenUrl: string;
}

export interface ClaudeConfig {
  oauthToken: string | undefined;
  apiKey: string | undefined;
  credentialsFile: string;
  deepCheckMin: number;
  bin: string;
  fastModel: string;
}

export interface AlertConfig {
  whatsappJid: string | undefined;
  repeatMin: number;
  afterFailures: number;
  transport: AlertTransport;
}

export interface RetentionConfig {
  textDays: number;
  mediaDays: number;
  ownerForever: boolean;
  emergencyMediaDays: number;
  vacuum: boolean;
}

export interface CostConfig {
  monthlyCapUsd: number;
  warnPct: number;
}

export interface CtlConfig {
  bin: string;
  sudo: string[];
}

export interface Config {
  dataDir: string;
  stateDir: string;
  ownersFile: string;
  ownerJidsEnv: string[];
  bridgeDb: string;
  opsDb: string;
  mediaDir: string;
  bridgeUrl: string;
  brainUrl: string;
  bridgeToken: string | undefined;
  healthTimeoutMs: number;
  diskPath: string;
  diskLimitPct: number;
  backupMaxAgeH: number;
  google: GoogleConfig;
  claude: ClaudeConfig;
  alert: AlertConfig;
  smtp: SmtpConfig;
  telegram: TelegramConfig;
  retention: RetentionConfig;
  cost: CostConfig;
  ctl: CtlConfig;
  logLevel: string;
}

type Env = Record<string, string | undefined>;

function str(env: Env, key: string): string | undefined {
  const v = env[key];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

/**
 * Placeholder values shipped in `*.env.example`. A secret still holding one of these has
 * never been filled in, so it must behave exactly like an unset key — otherwise a fresh
 * install "authenticates" with a token that is published in this repository.
 */
const PLACEHOLDER_SECRETS = ['changeme', 'change-me', 'change_me', 'todo', 'xxx'];

/** Like `str`, but a placeholder such as `CHANGEME` also counts as unset. */
function secret(env: Env, key: string): string | undefined {
  const value = str(env, key);
  if (value === undefined) return undefined;
  return PLACEHOLDER_SECRETS.includes(value.toLowerCase()) ? undefined : value;
}

function num(env: Env, key: string, fallback: number): number {
  const raw = str(env, key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = str(env, key);
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

/** Split a command prefix such as `sudo -n` into argv words. Empty string → no prefix. */
export function splitPrefix(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw.split(/\s+/).filter((w) => w.length > 0);
}

function csv(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Build the ops config from an environment map. Every path is overridable so tests can
 * point the whole package at a temp directory.
 */
export function loadConfig(env: Env = process.env): Config {
  const dataDir = str(env, 'CXW_DATA_DIR') ?? '/srv/cxw/data';
  const stateDir = str(env, 'CXW_STATE_DIR') ?? '/srv/cxw/state';

  const bridgeHost = str(env, 'BRIDGE_HOST') ?? '127.0.0.1';
  const bridgePort = num(env, 'BRIDGE_PORT', 7411);
  const brainHost = str(env, 'BRAIN_HOST') ?? '127.0.0.1';
  const brainPort = num(env, 'BRAIN_PORT', 7412);

  // `CXW_SUDO` unset means the production default `sudo -n`; set-but-empty means no prefix.
  const sudoRaw = env['CXW_SUDO'] === undefined ? 'sudo -n' : env['CXW_SUDO'];

  return {
    dataDir,
    stateDir,
    ownersFile: str(env, 'CXW_OWNERS_FILE') ?? '/srv/cxw/state/owners.json',
    ownerJidsEnv: csv(str(env, 'OWNER_JIDS')),
    bridgeDb: str(env, 'BRIDGE_DB') ?? path.join(dataDir, 'bridge.sqlite'),
    opsDb: str(env, 'CXW_OPS_DB') ?? path.join(dataDir, 'ops.sqlite'),
    mediaDir: str(env, 'MEDIA_DIR') ?? path.join(dataDir, 'media'),
    bridgeUrl: str(env, 'BRIDGE_URL') ?? `http://${bridgeHost}:${bridgePort}`,
    brainUrl: str(env, 'BRAIN_URL') ?? `http://${brainHost}:${brainPort}`,
    bridgeToken: secret(env, 'BRIDGE_TOKEN'),
    healthTimeoutMs: num(env, 'HEALTH_TIMEOUT_MS', 5000),
    diskPath: str(env, 'DISK_PATH') ?? dataDir,
    diskLimitPct: num(env, 'CXW_DISK_LIMIT_PCT', 85),
    backupMaxAgeH: num(env, 'CXW_BACKUP_MAX_AGE_H', 8),
    google: {
      enabled: (str(env, 'CXW_GOOGLE_CHECK') ?? 'on').toLowerCase() !== 'off',
      clientId: secret(env, 'GOOGLE_CLIENT_ID'),
      clientSecret: secret(env, 'GOOGLE_CLIENT_SECRET'),
      refreshToken: secret(env, 'GOOGLE_REFRESH_TOKEN'),
      tokenUrl: str(env, 'CXW_GOOGLE_TOKEN_URL') ?? 'https://oauth2.googleapis.com/token',
    },
    claude: {
      oauthToken: secret(env, 'CLAUDE_CODE_OAUTH_TOKEN'),
      apiKey: secret(env, 'ANTHROPIC_API_KEY'),
      credentialsFile:
        str(env, 'CXW_CLAUDE_CREDENTIALS_FILE') ??
        path.join(os.homedir(), '.claude', '.credentials.json'),
      deepCheckMin: num(env, 'CXW_CLAUDE_AUTH_DEEP_CHECK_MIN', 60),
      bin: str(env, 'CXW_CLAUDE_BIN') ?? 'claude',
      fastModel: str(env, 'CXW_MODEL_FAST') ?? 'claude-haiku-4-5-20251001',
    },
    alert: {
      whatsappJid: str(env, 'CXW_ALERT_WHATSAPP_JID'),
      repeatMin: num(env, 'CXW_ALERT_REPEAT_MIN', 240),
      afterFailures: Math.max(1, num(env, 'CXW_ALERT_AFTER_FAILURES', 1)),
      transport: (str(env, 'CXW_ALERT_TRANSPORT') ?? 'live') === 'log' ? 'log' : 'live',
    },
    smtp: {
      host: str(env, 'SMTP_HOST'),
      port: num(env, 'SMTP_PORT', 587),
      user: secret(env, 'SMTP_USER'),
      pass: secret(env, 'SMTP_PASS'),
      secure: bool(env, 'SMTP_SECURE', false),
      from: str(env, 'ALERT_EMAIL_FROM'),
      to: str(env, 'ALERT_EMAIL_TO'),
    },
    telegram: {
      enabled: bool(env, 'TELEGRAM_ALERTS', false),
      botToken: secret(env, 'TELEGRAM_BOT_TOKEN'),
      chatId: secret(env, 'TELEGRAM_CHAT_ID'),
    },
    retention: {
      textDays: num(env, 'CXW_RETENTION_TEXT_DAYS', 180),
      mediaDays: num(env, 'CXW_RETENTION_MEDIA_DAYS', 90),
      ownerForever: bool(env, 'CXW_RETENTION_OWNER_FOREVER', true),
      emergencyMediaDays: num(env, 'CXW_PURGE_EMERGENCY_MEDIA_DAYS', 14),
      vacuum: bool(env, 'CXW_PURGE_VACUUM', false),
    },
    cost: {
      monthlyCapUsd: num(env, 'CXW_COST_MONTHLY_CAP_USD', 100),
      warnPct: num(env, 'CXW_COST_WARN_PCT', 80),
    },
    ctl: {
      bin: str(env, 'CXW_CTL') ?? '/usr/local/bin/cxw-ctl',
      sudo: splitPrefix(sudoRaw),
    },
    logLevel: str(env, 'LOG_LEVEL') ?? 'info',
  };
}
