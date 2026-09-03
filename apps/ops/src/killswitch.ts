import { execFile } from 'node:child_process';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { readCostPause } from './costs.js';
import { PANIC_FILE } from './health.js';
import { logger } from './logger.js';
import { monthKey, readJsonFile, removeFile, statePath, writeJsonFile } from './state.js';

/** Allowlist mirrored from `cxw-ctl`, enforced here too so a bug can never widen it. */
export const CTL_ACTIONS = ['start', 'stop', 'restart', 'status', 'is-active'] as const;
export const CTL_UNITS = [
  'bridge',
  'brain',
  'scheduler',
  'sentinel',
  'backup',
  'monitor.timer',
  'purge.timer',
  'backup.timer',
] as const;
/** Actions that take no unit argument. */
export const CTL_BARE_ACTIONS = ['backup', 'vacuum-journal'] as const;

export type CtlAction = (typeof CTL_ACTIONS)[number] | (typeof CTL_BARE_ACTIONS)[number];
export type CtlUnit = (typeof CTL_UNITS)[number];

export interface PanicFlag {
  since: string;
  by: string;
  reason: string;
}

export interface PauseState {
  paused: boolean;
  reasons: Array<'panic' | 'cost-cap'>;
}

export interface CtlResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

function isBare(action: string): action is (typeof CTL_BARE_ACTIONS)[number] {
  return (CTL_BARE_ACTIONS as readonly string[]).includes(action);
}

/**
 * Run the privileged helper: `${CXW_SUDO} ${CXW_CTL} <action> [unit]`, no shell. The
 * allowlist is checked before spawning so a bad caller never reaches sudo.
 */
export function ctl(action: string, unit?: string, cfg: Config = loadConfig()): Promise<CtlResult> {
  const args: string[] = [];
  if (isBare(action)) {
    if (unit !== undefined) {
      return Promise.reject(new Error(`ctl: action "${action}" takes no unit`));
    }
    args.push(action);
  } else {
    if (!(CTL_ACTIONS as readonly string[]).includes(action)) {
      return Promise.reject(new Error(`ctl: action "${action}" is not allowed`));
    }
    if (unit === undefined || !(CTL_UNITS as readonly string[]).includes(unit)) {
      return Promise.reject(new Error(`ctl: unit "${String(unit)}" is not allowed`));
    }
    args.push(action, unit);
  }

  const argv = [...cfg.ctl.sudo, cfg.ctl.bin, ...args];
  const [cmd, ...rest] = argv;
  if (cmd === undefined) return Promise.reject(new Error('ctl: no command configured'));

  return new Promise<CtlResult>((resolve) => {
    execFile(cmd, rest, { timeout: 30_000 }, (err, stdout, stderr) => {
      const code =
        err === null ? 0 : ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1);
      resolve({
        ok: err === null,
        code: typeof code === 'number' ? code : null,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

export function readPanic(cfg: Config): PanicFlag | null {
  return readJsonFile<PanicFlag>(statePath(cfg, PANIC_FILE));
}

/** Pause flags read by the scheduler before it claims a routine. */
export function getPauseState(cfg: Config = loadConfig(), now: number = Date.now()): PauseState {
  const reasons: Array<'panic' | 'cost-cap'> = [];
  if (readPanic(cfg) !== null) reasons.push('panic');
  const cost = readCostPause(cfg);
  // A stale flag from a previous month no longer pauses anything.
  if (cost !== null && cost.month === monthKey(now)) reasons.push('cost-cap');
  return { paused: reasons.length > 0, reasons };
}

/**
 * Kill switch: raise the panic flag, then stop the scheduler and the brain (brain last, so
 * the acknowledgement can still be sent by the caller before it goes down).
 */
export async function panic(
  reason = 'owner request',
  by = 'owner',
  cfg: Config = loadConfig(),
): Promise<PanicFlag> {
  const flag: PanicFlag = { since: new Date().toISOString(), by, reason };
  writeJsonFile(statePath(cfg, PANIC_FILE), flag);
  // The reason is owner message text. It belongs in the 0600 flag file, not in the journal.
  logger.warn({ by, reasonLength: reason.length }, 'panic: stopping scheduler and brain');
  await ctl('stop', 'scheduler', cfg);
  await ctl('stop', 'brain', cfg);
  return flag;
}

/** Clear the panic flag and bring the brain and the scheduler back up, in that order. */
export async function resume(cfg: Config = loadConfig()): Promise<void> {
  removeFile(statePath(cfg, PANIC_FILE));
  logger.warn('resume: starting brain and scheduler');
  await ctl('start', 'brain', cfg);
  await ctl('start', 'scheduler', cfg);
}
