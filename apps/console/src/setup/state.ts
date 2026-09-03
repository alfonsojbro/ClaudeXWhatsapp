/**
 * Setup progress, held in one small JSON file under the state directory.
 *
 * The file is the only thing the wizard remembers between requests. It never holds a
 * secret: tokens go straight to `cxw.env` / `google.env` at mode 0600 and are never read
 * back into this structure. What lives here is progress, a timezone, one boolean the
 * person confirmed, and two short-lived nonces (CSRF, OAuth `state`).
 *
 * A corrupt file is not a failure the operator can act on mid-setup, so `readSetupState`
 * never throws: it returns a fresh state and says so through `recovered`.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const SETUP_STATE_VERSION = 1;
export const SETUP_FILENAME = 'setup.json';

export type StepId = 'owner' | 'whatsapp' | 'claude' | 'google' | 'routines' | 'vault';

/** Wizard order. The rail renders in exactly this order. */
export const STEP_IDS: readonly StepId[] = [
  'owner',
  'whatsapp',
  'claude',
  'google',
  'routines',
  'vault',
];

export type StepStatus = 'pending' | 'done' | 'skipped';

export interface StepRecord {
  readonly status: StepStatus;
  /** ISO 8601 UTC, set when the status last moved off `pending`. */
  readonly at?: string;
}

export interface SetupState {
  readonly version: 1;
  /** ISO 8601 UTC. */
  readonly startedAt: string;
  /** ISO 8601 UTC. Present only when setup is finished; its presence ends setup mode. */
  readonly completedAt?: string;
  readonly steps: Record<StepId, StepRecord>;
  readonly timezone?: string;
  /** True only when the person ticked "my consent screen reads In production". */
  readonly googleConsentConfirmed?: boolean;
  /** The OAuth `state` nonce currently outstanding, if any. */
  readonly googleOauthState?: string;
  /** The CSRF value every POST form carries. */
  readonly csrfToken?: string;
  /** True when the file on disk was missing or unparseable and this state is fresh. */
  readonly recovered?: boolean;
}

export function setupStatePath(stateDir: string): string {
  return join(stateDir, SETUP_FILENAME);
}

/** ISO 8601 in UTC, to the second, which is all the precision anything here needs. */
export function isoUtc(at: number = Date.now()): string {
  return new Date(at).toISOString();
}

export function freshSetupState(at: number = Date.now()): SetupState {
  const steps = {} as Record<StepId, StepRecord>;
  for (const id of STEP_IDS) steps[id] = { status: 'pending' };
  return { version: SETUP_STATE_VERSION, startedAt: isoUtc(at), steps };
}

function isStepStatus(value: unknown): value is StepStatus {
  return value === 'pending' || value === 'done' || value === 'skipped';
}

/**
 * Rebuild a state from whatever the file held. Anything unrecognised is dropped rather
 * than trusted: this file is written by us, but it sits on a box someone else runs.
 */
function coerce(parsed: unknown, at: number): SetupState | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const raw = parsed as Record<string, unknown>;
  if (raw['version'] !== SETUP_STATE_VERSION) return null;
  const startedAt = typeof raw['startedAt'] === 'string' ? raw['startedAt'] : isoUtc(at);

  const rawSteps = (
    typeof raw['steps'] === 'object' && raw['steps'] !== null ? raw['steps'] : {}
  ) as Record<string, unknown>;
  const steps = {} as Record<StepId, StepRecord>;
  for (const id of STEP_IDS) {
    const entry = rawSteps[id];
    if (typeof entry !== 'object' || entry === null) {
      steps[id] = { status: 'pending' };
      continue;
    }
    const record = entry as Record<string, unknown>;
    const status = isStepStatus(record['status']) ? record['status'] : 'pending';
    const atValue = record['at'];
    steps[id] = typeof atValue === 'string' ? { status, at: atValue } : { status };
  }

  const completedAt = raw['completedAt'];
  const timezone = raw['timezone'];
  const consent = raw['googleConsentConfirmed'];
  const oauthState = raw['googleOauthState'];
  const csrf = raw['csrfToken'];

  return {
    version: SETUP_STATE_VERSION,
    startedAt,
    steps,
    ...(typeof completedAt === 'string' ? { completedAt } : {}),
    ...(typeof timezone === 'string' ? { timezone } : {}),
    ...(typeof consent === 'boolean' ? { googleConsentConfirmed: consent } : {}),
    ...(typeof oauthState === 'string' ? { googleOauthState: oauthState } : {}),
    ...(typeof csrf === 'string' ? { csrfToken: csrf } : {}),
  };
}

/**
 * Read the state, or start over. A missing file is the normal first-boot case; an
 * unparseable one is rare and unrecoverable, and starting over is strictly better than
 * refusing to serve the wizard at all. Both are reported as `recovered: true`.
 */
export function readSetupState(stateDir: string, at: number = Date.now()): SetupState {
  let text: string;
  try {
    text = readFileSync(setupStatePath(stateDir), 'utf8');
  } catch {
    return { ...freshSetupState(at), recovered: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ...freshSetupState(at), recovered: true };
  }
  const coerced = coerce(parsed, at);
  if (coerced === null) return { ...freshSetupState(at), recovered: true };
  return coerced;
}

/**
 * Write atomically at mode 0600: a temp file in the same directory, then rename. A crash
 * mid-write therefore leaves the previous state, not a truncated one.
 */
export function writeSetupState(stateDir: string, state: SetupState): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const target = setupStatePath(stateDir);
  const temp = `${target}.tmp-${process.pid.toString(36)}-${Date.now().toString(36)}`;
  // `recovered` describes this process's read, not the state, so it is never persisted.
  const persisted: Record<string, unknown> = { ...state };
  delete persisted['recovered'];
  try {
    writeFileSync(temp, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, target);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file may never have been created; nothing to clean up.
    }
    throw error;
  }
}

/** Return a copy with one step's status stamped. */
export function markStep(
  state: SetupState,
  id: StepId,
  status: StepStatus,
  at: number = Date.now(),
): SetupState {
  return { ...state, steps: { ...state.steps, [id]: { status, at: isoUtc(at) } } };
}
