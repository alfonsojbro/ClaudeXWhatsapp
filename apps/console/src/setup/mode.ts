/**
 * Is this box still in setup?
 *
 * Two independent signals, either of which is enough:
 *   - `setup.json` has no `completedAt`, so the wizard was never finished; or
 *   - the owners file is missing, unparseable, or holds an empty list, so the bridge would
 *     answer nobody. That second signal exists because a box restored from a backup without
 *     its owners file is unusable, and the honest response is to offer setup again.
 *
 * Setup mode only ever *adds* the `/setup` routes. It never opens anything: every route but
 * `/setup/health` is behind Cloudflare Access exactly like the console's own routes.
 */

import { readFileSync } from 'node:fs';
import { readSetupState, isoUtc } from './state.js';
import type { SetupState } from './state.js';
import { writeSetupState } from './state.js';

export interface ModeInput {
  readonly stateDir: string;
  readonly ownersFile: string;
}

/** True when the owners file names at least one owner. Any failure reads as "no owners". */
export function hasOwners(ownersFile: string): boolean {
  let text: string;
  try {
    text = readFileSync(ownersFile, 'utf8');
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const owners = (parsed as Record<string, unknown>)['owners'];
  if (!Array.isArray(owners)) return false;
  return owners.some((entry) => typeof entry === 'string' && entry.trim() !== '');
}

export function isSetupMode(input: ModeInput, at: number = Date.now()): boolean {
  const state = readSetupState(input.stateDir, at);
  if (state.completedAt === undefined) return true;
  return !hasOwners(input.ownersFile);
}

/** Stamp `completedAt`, which is what turns setup mode off. Idempotent. */
export function completeSetup(stateDir: string, at: number = Date.now()): SetupState {
  const state = readSetupState(stateDir, at);
  if (state.completedAt !== undefined) return state;
  const next: SetupState = { ...state, completedAt: isoUtc(at) };
  writeSetupState(stateDir, next);
  return next;
}
