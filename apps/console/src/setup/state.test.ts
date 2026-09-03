import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  freshSetupState,
  isoUtc,
  markStep,
  readSetupState,
  setupStatePath,
  STEP_IDS,
  writeSetupState,
} from './state.js';

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'cxw-setup-state-'));
}

describe('setup state', () => {
  it('starts fresh with every step pending', () => {
    const state = freshSetupState(0);
    expect(state.version).toBe(1);
    expect(state.startedAt).toBe('1970-01-01T00:00:00.000Z');
    expect(state.completedAt).toBeUndefined();
    for (const id of STEP_IDS) expect(state.steps[id].status).toBe('pending');
  });

  it('returns a fresh state, flagged, when the file is absent', () => {
    const state = readSetupState(join(dir(), 'nope'));
    expect(state.recovered).toBe(true);
    expect(state.steps.owner.status).toBe('pending');
  });

  it('returns a fresh state, flagged, when the file is corrupt', () => {
    const stateDir = dir();
    writeFileSync(setupStatePath(stateDir), '{ this is not json');
    const state = readSetupState(stateDir);
    expect(state.recovered).toBe(true);
    expect(state.steps.google.status).toBe('pending');
  });

  it('returns a fresh state when the version is wrong', () => {
    const stateDir = dir();
    writeFileSync(setupStatePath(stateDir), JSON.stringify({ version: 99 }));
    expect(readSetupState(stateDir).recovered).toBe(true);
  });

  it('drops unrecognised step ids and statuses', () => {
    const stateDir = dir();
    writeFileSync(
      setupStatePath(stateDir),
      JSON.stringify({
        version: 1,
        startedAt: '2026-01-01T00:00:00.000Z',
        steps: { owner: { status: 'nonsense' }, bogus: { status: 'done' } },
      }),
    );
    const state = readSetupState(stateDir);
    expect(state.recovered).toBeUndefined();
    expect(state.steps.owner.status).toBe('pending');
    expect(Object.keys(state.steps).sort()).toEqual([...STEP_IDS].sort());
  });

  it('round trips through the file at mode 0600', () => {
    const stateDir = dir();
    const state = markStep(
      { ...freshSetupState(0), timezone: 'Europe/Prague', googleConsentConfirmed: true },
      'owner',
      'done',
      1_000,
    );
    writeSetupState(stateDir, state);
    expect(statSync(setupStatePath(stateDir)).mode & 0o777).toBe(0o600);
    const back = readSetupState(stateDir);
    expect(back.steps.owner).toEqual({ status: 'done', at: '1970-01-01T00:00:01.000Z' });
    expect(back.timezone).toBe('Europe/Prague');
    expect(back.googleConsentConfirmed).toBe(true);
    expect(back.recovered).toBeUndefined();
  });

  it('never persists the recovered flag', () => {
    const stateDir = dir();
    writeSetupState(stateDir, { ...freshSetupState(0), recovered: true });
    expect(readFileSync(setupStatePath(stateDir), 'utf8')).not.toContain('recovered');
  });

  it('leaves no temp file behind', () => {
    const stateDir = dir();
    writeSetupState(stateDir, freshSetupState(0));
    // The rename is the last step, so only the target exists.
    expect(() => statSync(setupStatePath(stateDir))).not.toThrow();
  });

  it('stamps ISO 8601 UTC', () => {
    expect(isoUtc(1_700_000_000_000)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
