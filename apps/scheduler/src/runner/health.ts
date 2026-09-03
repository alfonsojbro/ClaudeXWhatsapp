/**
 * The health check: four cheap probes, no LLM.
 *
 * Every dependency is injected so the check is testable without a filesystem, a network or
 * Google credentials.
 */
import fs from 'node:fs/promises';
import type { Db } from '../db.js';

/** Name of one probe. */
export type HealthCheckName = 'whatsapp' | 'google' | 'disk' | 'backup';

/** Outcome of one probe. */
export interface HealthCheck {
  name: HealthCheckName;
  ok: boolean;
  /** One short human line. Never contains a secret. */
  detail: string;
}

/** Outcome of a whole health run. */
export interface HealthReport {
  ok: boolean;
  checks: HealthCheck[];
  /** Human alert text describing the failing checks; empty when everything is ok. */
  alertText: string;
}

/** Filesystem stats the disk probe needs (a subset of `fs.StatsFs`). */
export interface StatFsLike {
  blocks: number;
  bfree: number;
}

/** Injected dependencies for {@link runHealthCheck}. */
export interface HealthDeps {
  /** Bridge probe: resolves true when WhatsApp is connected. Must not throw. */
  checkBridge: () => Promise<boolean>;
  /**
   * Google probe: refresh a token. `null` means Google is not configured, which counts as ok
   * with a note.
   */
  refreshGoogleToken: (() => Promise<void>) | null;
  /** Directory whose filesystem is measured. */
  dataDir: string;
  /** Maximum used percentage that still counts as healthy. */
  diskLimitPct: number;
  /** Path of the backup stamp file, or undefined when backups are not configured. */
  backupStampFile?: string;
  backupMaxAgeHours: number;
  /** Injected `fs.statfs`. */
  statfs?: (dir: string) => Promise<StatFsLike>;
  /** Injected `fs.stat`, reduced to the mtime the backup probe reads. */
  statFile?: (file: string) => Promise<{ mtimeMs: number }>;
}

const HOUR_MS = 3_600_000;

const realStatfs = async (dir: string): Promise<StatFsLike> => {
  const s = await fs.statfs(dir);
  return { blocks: Number(s.blocks), bfree: Number(s.bfree) };
};

const realStatFile = async (file: string): Promise<{ mtimeMs: number }> => {
  const s = await fs.stat(file);
  return { mtimeMs: s.mtimeMs };
};

async function checkWhatsapp(deps: HealthDeps): Promise<HealthCheck> {
  const connected = await deps.checkBridge();
  return {
    name: 'whatsapp',
    ok: connected,
    detail: connected ? 'bridge connected' : 'bridge not connected',
  };
}

async function checkGoogle(deps: HealthDeps): Promise<HealthCheck> {
  if (deps.refreshGoogleToken === null) {
    return { name: 'google', ok: true, detail: 'not configured' };
  }
  try {
    await deps.refreshGoogleToken();
    return { name: 'google', ok: true, detail: 'token refresh ok' };
  } catch (err: unknown) {
    return { name: 'google', ok: false, detail: `token refresh failed: ${errText(err)}` };
  }
}

async function checkDisk(deps: HealthDeps): Promise<HealthCheck> {
  const statfs = deps.statfs ?? realStatfs;
  try {
    const s = await statfs(deps.dataDir);
    if (s.blocks <= 0) {
      return { name: 'disk', ok: false, detail: 'filesystem reports zero blocks' };
    }
    const usedPct = Math.round(((s.blocks - s.bfree) / s.blocks) * 100);
    const ok = usedPct <= deps.diskLimitPct;
    return {
      name: 'disk',
      ok,
      detail: `${String(usedPct)}% used (limit ${String(deps.diskLimitPct)}%)`,
    };
  } catch (err: unknown) {
    return { name: 'disk', ok: false, detail: `statfs failed: ${errText(err)}` };
  }
}

async function checkBackup(deps: HealthDeps, now: Date): Promise<HealthCheck> {
  if (deps.backupStampFile === undefined) {
    return { name: 'backup', ok: true, detail: 'not configured' };
  }
  const statFile = deps.statFile ?? realStatFile;
  try {
    const s = await statFile(deps.backupStampFile);
    const ageHours = (now.getTime() - s.mtimeMs) / HOUR_MS;
    const ok = ageHours <= deps.backupMaxAgeHours;
    return {
      name: 'backup',
      ok,
      detail: `last backup ${ageHours.toFixed(1)} h ago (max ${String(deps.backupMaxAgeHours)} h)`,
    };
  } catch {
    return { name: 'backup', ok: false, detail: 'backup stamp file missing' };
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run all four probes. Never throws. */
export async function runHealthCheck(
  deps: HealthDeps,
  now: Date = new Date(),
): Promise<HealthReport> {
  const checks = [
    await checkWhatsapp(deps),
    await checkGoogle(deps),
    await checkDisk(deps),
    await checkBackup(deps, now),
  ];
  const failing = checks.filter((c) => !c.ok);
  const alertText =
    failing.length === 0
      ? ''
      : ['Health check failed:', ...failing.map((c) => `- ${c.name}: ${c.detail}`)].join('\n');
  return { ok: failing.length === 0, checks, alertText };
}

/** A stored probe state, used to alert only when a probe changes state. */
export interface StoredHealthState {
  name: string;
  ok: boolean;
  detail: string | null;
  changedAt: number;
}

/** Read the last recorded state of one probe. */
export function getHealthState(db: Db, name: string): StoredHealthState | null {
  const row = db
    .prepare('SELECT check_name, ok, detail, changed_at FROM health_state WHERE check_name = ?')
    .get(name) as
    { check_name: string; ok: number; detail: string | null; changed_at: number } | undefined;
  if (row === undefined) return null;
  return { name: row.check_name, ok: row.ok === 1, detail: row.detail, changedAt: row.changed_at };
}

/** Upsert one probe's state. */
export function setHealthState(db: Db, check: HealthCheck, at: Date): void {
  db.prepare(
    `INSERT INTO health_state (check_name, ok, detail, changed_at)
     VALUES (@name, @ok, @detail, @at)
     ON CONFLICT (check_name) DO UPDATE SET ok = excluded.ok, detail = excluded.detail,
       changed_at = excluded.changed_at`,
  ).run({ name: check.name, ok: check.ok ? 1 : 0, detail: check.detail, at: at.getTime() });
}

/** A probe whose ok/not-ok state differs from what was stored. */
export interface HealthChange {
  check: HealthCheck;
  /** True when this is the first time the probe has ever been recorded. */
  first: boolean;
}

/**
 * Compare a report against the stored states and return only the probes whose state changed.
 *
 * Writes nothing: the caller stores the new states only once the alert has actually been sent, so
 * a failed send does not silence the alert forever.
 *
 * A first-ever ok result is not a change worth alerting about.
 */
export function diffHealth(db: Db, report: HealthReport): HealthChange[] {
  const changes: HealthChange[] = [];
  for (const check of report.checks) {
    const previous = getHealthState(db, check.name);
    const first = previous === null;
    if (previous === null ? !check.ok : previous.ok !== check.ok) {
      changes.push({ check, first });
    }
  }
  return changes;
}

/** Persist every probe state from one report. */
export function storeHealthStates(db: Db, report: HealthReport, at: Date): void {
  for (const check of report.checks) setHealthState(db, check, at);
}

/** {@link diffHealth} followed by {@link storeHealthStates}. */
export function diffAndStore(db: Db, report: HealthReport, at: Date): HealthChange[] {
  const changes = diffHealth(db, report);
  storeHealthStates(db, report, at);
  return changes;
}

/** Human alert text for a set of state changes. Empty when there are none. */
export function changeAlertText(changes: HealthChange[]): string {
  if (changes.length === 0) return '';
  const failed = changes.filter((c) => !c.check.ok);
  const recovered = changes.filter((c) => c.check.ok);
  const lines: string[] = [];
  if (failed.length > 0) {
    lines.push('Health alert:');
    for (const c of failed) lines.push(`- ${c.check.name} is down: ${c.check.detail}`);
  }
  if (recovered.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Recovered:');
    for (const c of recovered) lines.push(`- ${c.check.name}: ${c.check.detail}`);
  }
  return lines.join('\n');
}
