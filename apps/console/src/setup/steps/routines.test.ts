import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isValidTimezone,
  listRoutines,
  setRoutineEnabled,
  setTimezone,
} from './routines.js';

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'cxw-routines-'));
}

function routinesDir(): string {
  const path = join(dir(), 'routines');
  mkdirSync(path, { recursive: true });
  return path;
}

const MORNING = `---
name: morning-brief
enabled: true
schedule: "0 7 * * *"
description: The day ahead, at seven.
---

Write the brief.
`;

describe('listRoutines', () => {
  it('reads name, enabled and description from the frontmatter', () => {
    const path = routinesDir();
    writeFileSync(join(path, 'morning-brief.md'), MORNING);
    const listing = listRoutines(path);
    expect(listing.present).toBe(true);
    expect(listing.routines).toHaveLength(1);
    expect(listing.routines[0]).toMatchObject({
      name: 'morning-brief',
      enabled: true,
      description: 'The day ahead, at seven.',
    });
  });

  it('tolerates a missing directory and says the directory is not there', () => {
    expect(listRoutines(join(dir(), 'nope'))).toEqual({ routines: [], present: false });
  });

  it('returns an empty present listing for an empty directory', () => {
    expect(listRoutines(routinesDir())).toEqual({ routines: [], present: true });
  });

  it('skips non-markdown files and files with no frontmatter', () => {
    const path = routinesDir();
    writeFileSync(join(path, 'notes.txt'), MORNING);
    writeFileSync(join(path, 'bare.md'), 'no frontmatter here');
    writeFileSync(join(path, 'ok.md'), MORNING);
    expect(listRoutines(path).routines.map((r) => r.name)).toEqual(['morning-brief']);
  });

  it('falls back to the filename when there is no name key', () => {
    const path = routinesDir();
    writeFileSync(join(path, 'weekly-review.md'), '---\nenabled: false\n---\nbody\n');
    const [routine] = listRoutines(path).routines;
    expect(routine?.name).toBe('weekly-review');
    expect(routine?.enabled).toBe(false);
    expect(routine?.description).toBe('');
  });

  it('sorts by filename so the page order is stable', () => {
    const path = routinesDir();
    for (const name of ['c', 'a', 'b']) {
      writeFileSync(join(path, `${name}.md`), `---\nname: ${name}\nenabled: false\n---\nx\n`);
    }
    expect(listRoutines(path).routines.map((r) => r.name)).toEqual(['a', 'b', 'c']);
  });
});

describe('setRoutineEnabled', () => {
  it('flips only the enabled line and preserves unusual spacing everywhere else', () => {
    const path = routinesDir();
    const file = join(path, 'odd.md');
    const original = [
      '---',
      'name:    odd-one',
      '   enabled:    true   ',
      'schedule:  "0 7 * * *"',
      '',
      '# a comment with trailing spaces   ',
      '---',
      '',
      'Body   with   spacing.',
      '',
    ].join('\n');
    writeFileSync(file, original);
    expect(setRoutineEnabled(file, false)).toBe(true);

    const before = original.split('\n');
    const after = readFileSync(file, 'utf8').split('\n');
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i += 1) {
      if (before[i]?.includes('enabled:')) expect(after[i]).toBe('   enabled: false');
      else expect(after[i]).toBe(before[i]);
    }
  });

  it('preserves CRLF line endings', () => {
    const file = join(routinesDir(), 'crlf.md');
    writeFileSync(file, '---\r\nname: x\r\nenabled: true\r\n---\r\nbody\r\n');
    setRoutineEnabled(file, false);
    expect(readFileSync(file, 'utf8')).toBe('---\r\nname: x\r\nenabled: false\r\n---\r\nbody\r\n');
  });

  it('adds the key when the frontmatter has none', () => {
    const file = join(routinesDir(), 'noflag.md');
    writeFileSync(file, '---\nname: x\n---\nbody\n');
    expect(setRoutineEnabled(file, true)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('---\nname: x\nenabled: true\n---\nbody\n');
  });

  it('is a no-op, and says so, when the value already matches', () => {
    const file = join(routinesDir(), 'same.md');
    writeFileSync(file, MORNING);
    expect(setRoutineEnabled(file, true)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(MORNING);
  });

  it('refuses a file with no frontmatter rather than inventing one', () => {
    const file = join(routinesDir(), 'bare.md');
    writeFileSync(file, 'just text\n');
    expect(() => setRoutineEnabled(file, true)).toThrow(/no frontmatter/);
  });
});

describe('setTimezone', () => {
  it('writes TZ and CXW_TZ', () => {
    const envPath = join(dir(), 'cxw.env');
    writeFileSync(envPath, 'NODE_ENV=production\nTZ=UTC\n');
    expect(setTimezone(envPath, ' Europe/Prague ')).toBe('Europe/Prague');
    const text = readFileSync(envPath, 'utf8');
    expect(text).toContain('TZ=Europe/Prague');
    expect(text).toContain('CXW_TZ=Europe/Prague');
    expect(text).toContain('NODE_ENV=production');
  });

  it('rejects a zone the runtime does not know', () => {
    const envPath = join(dir(), 'cxw.env');
    expect(() => setTimezone(envPath, 'Mars/Olympus')).toThrow(/not a timezone this box knows/);
    expect(() => setTimezone(envPath, '')).toThrow(/not a timezone/);
  });

  it('does not write the file at all when the zone is rejected', () => {
    const envPath = join(dir(), 'cxw.env');
    writeFileSync(envPath, 'TZ=UTC\n');
    expect(() => setTimezone(envPath, 'Nowhere/Nothing')).toThrow();
    expect(readFileSync(envPath, 'utf8')).toBe('TZ=UTC\n');
  });

  it('isValidTimezone accepts IANA names and rejects invented ones', () => {
    expect(isValidTimezone('America/Panama')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Not/AZone')).toBe(false);
  });
});
