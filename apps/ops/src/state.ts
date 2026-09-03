import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';

/** Absolute path of a file inside `$CXW_STATE_DIR`. */
export function statePath(cfg: Config, name: string): string {
  return path.join(cfg.stateDir, name);
}

export function ensureStateDir(cfg: Config): void {
  fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
}

export function readJsonFile<T>(file: string): T | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readState<T>(cfg: Config, name: string): T | null {
  return readJsonFile<T>(statePath(cfg, name));
}

export function writeState(cfg: Config, name: string, value: unknown): void {
  writeJsonFile(statePath(cfg, name), value);
}

export function fileExists(file: string): boolean {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}

export function removeFile(file: string): boolean {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Modification time in epoch ms, or null when the file is missing. */
export function fileMtimeMs(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

export function touchFile(file: string, contents = ''): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode: 0o600 });
}

/** `2026-09` in the process time zone. Cost months follow the box's `TZ`. */
export function monthKey(now: number = Date.now()): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** `2026-09-03` in the process time zone. */
export function dayKey(now: number = Date.now()): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Local midnight (epoch ms) of the day containing `now`. */
export function startOfDay(now: number = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local first-of-month midnight (epoch ms) of the month containing `now`. */
export function startOfMonth(now: number = Date.now()): number {
  const d = new Date(now);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Compact human duration: `45s`, `12m`, `3h 5m`, `2d 4h`. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) {
    const rem = m % 60;
    return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
  }
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH === 0 ? `${d}d` : `${d}d ${remH}h`;
}
