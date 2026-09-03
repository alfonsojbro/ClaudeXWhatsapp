import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeSetup, hasOwners, isSetupMode } from './mode.js';
import { freshSetupState, readSetupState, writeSetupState } from './state.js';

function fixture(): { stateDir: string; ownersFile: string } {
  const stateDir = mkdtempSync(join(tmpdir(), 'cxw-setup-mode-'));
  return { stateDir, ownersFile: join(stateDir, 'owners.json') };
}

function writeOwners(path: string, owners: unknown): void {
  writeFileSync(path, JSON.stringify({ owners }));
}

describe('setup mode', () => {
  it('is on when setup.json has no completedAt', () => {
    const { stateDir, ownersFile } = fixture();
    writeSetupState(stateDir, freshSetupState(0));
    writeOwners(ownersFile, ['420123456789@s.whatsapp.net']);
    expect(isSetupMode({ stateDir, ownersFile })).toBe(true);
  });

  it('is on when the owners file is missing', () => {
    const { stateDir, ownersFile } = fixture();
    completeSetup(stateDir, 0);
    expect(isSetupMode({ stateDir, ownersFile })).toBe(true);
  });

  it('is on when the owners array is empty', () => {
    const { stateDir, ownersFile } = fixture();
    completeSetup(stateDir, 0);
    writeOwners(ownersFile, []);
    expect(isSetupMode({ stateDir, ownersFile })).toBe(true);
  });

  it('is off when setup is complete and an owner exists', () => {
    const { stateDir, ownersFile } = fixture();
    completeSetup(stateDir, 0);
    writeOwners(ownersFile, ['420123456789@s.whatsapp.net']);
    expect(isSetupMode({ stateDir, ownersFile })).toBe(false);
  });

  it('treats a corrupt owners file as no owners', () => {
    const { ownersFile } = fixture();
    writeFileSync(ownersFile, 'not json');
    expect(hasOwners(ownersFile)).toBe(false);
  });

  it('treats blank owner entries as no owners', () => {
    const { ownersFile } = fixture();
    writeOwners(ownersFile, ['   ']);
    expect(hasOwners(ownersFile)).toBe(false);
  });

  it('completeSetup is idempotent', () => {
    const { stateDir } = fixture();
    const first = completeSetup(stateDir, 1_000);
    const second = completeSetup(stateDir, 9_000);
    expect(second.completedAt).toBe(first.completedAt);
    expect(readSetupState(stateDir).completedAt).toBe('1970-01-01T00:00:01.000Z');
  });
});
