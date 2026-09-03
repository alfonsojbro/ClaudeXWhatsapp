import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MODEL_IDS,
  RoutineError,
  deleteRoutine,
  loadRoutines,
  parseRoutine,
  routineFilePath,
  setEnabled,
  writeRoutine,
} from '../src/routine.js';

const VALID = `---
name: morning-brief
schedule: "0 7 * * 1-5"
---

Summarise the day.
`;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxw-routine-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const at = (name: string): string => path.join(dir, `${name}.md`);

describe('parseRoutine', () => {
  it('parses valid frontmatter and applies defaults', () => {
    const r = parseRoutine(VALID, at('morning-brief'));
    expect(r.name).toBe('morning-brief');
    expect(r.body).toBe('Summarise the day.');
    expect(r.frontmatter.schedule).toBe('0 7 * * 1-5');
    expect(r.frontmatter.timezone).toBe('Europe/Prague');
    expect(r.frontmatter.model).toBe('opus');
    expect(r.modelId).toBe(MODEL_IDS.opus);
    expect(r.frontmatter.tools).toEqual([]);
    expect(r.frontmatter.deliver_to).toBe('owner');
    expect(r.frontmatter.enabled).toBe(true);
    expect(r.frontmatter.kind).toBe('llm');
    expect(r.frontmatter.max_turns).toBe(30);
    expect(r.frontmatter.catch_up_minutes).toBe(10);
    expect(r.onceAt).toBeUndefined();
  });

  it('honours an explicit default timezone', () => {
    const r = parseRoutine(VALID, at('morning-brief'), { defaultTimezone: 'America/Managua' });
    expect(r.frontmatter.timezone).toBe('America/Managua');
  });

  it('maps every model alias to a full model id', () => {
    for (const alias of ['opus', 'fable', 'sonnet', 'haiku'] as const) {
      const text = `---\nname: x\nschedule: "0 7 * * *"\nmodel: ${alias}\n---\nbody\n`;
      expect(parseRoutine(text, at('x')).modelId).toBe(MODEL_IDS[alias]);
    }
  });

  it('resolves `once` in the routine timezone and defaults catch_up to 1440', () => {
    const text = `---\nname: reminder-x\nonce: "2026-09-05T09:00"\ntimezone: Europe/Prague\n---\nhi\n`;
    const r = parseRoutine(text, at('reminder-x'));
    // Prague is UTC+2 on 2026-09-05.
    expect(r.onceAt?.toISOString()).toBe('2026-09-05T07:00:00.000Z');
    expect(r.frontmatter.catch_up_minutes).toBe(1440);
  });

  it('accepts a `once` value YAML turned into a Date', () => {
    const text = `---\nname: reminder-y\nonce: 2026-09-05T09:00:00Z\n---\nhi\n`;
    const r = parseRoutine(text, at('reminder-y'));
    expect(r.onceAt?.toISOString()).toBe('2026-09-05T09:00:00.000Z');
  });

  it('rejects both schedule and once', () => {
    const text = `---\nname: x\nschedule: "0 7 * * *"\nonce: "2026-09-05T09:00"\n---\nb\n`;
    expect(() => parseRoutine(text, at('x'))).toThrow(/exactly one/);
  });

  it('rejects neither schedule nor once', () => {
    expect(() => parseRoutine(`---\nname: x\n---\nb\n`, at('x'))).toThrow(/exactly one/);
  });

  it('rejects an invalid cron expression', () => {
    const text = `---\nname: x\nschedule: "not a cron"\n---\nb\n`;
    expect(() => parseRoutine(text, at('x'))).toThrow(/invalid cron/);
  });

  it('rejects an unknown timezone', () => {
    const text = `---\nname: x\nschedule: "0 7 * * *"\ntimezone: Mars/Olympus\n---\nb\n`;
    expect(() => parseRoutine(text, at('x'))).toThrow(/unknown timezone/);
  });

  it('rejects a name that does not match the filename stem', () => {
    expect(() => parseRoutine(VALID, at('evening-close'))).toThrow(/does not match filename/);
  });

  it('rejects a name that is not kebab-case', () => {
    const text = `---\nname: Morning_Brief\nschedule: "0 7 * * *"\n---\nb\n`;
    expect(() => parseRoutine(text, at('Morning_Brief'))).toThrow(/kebab-case/);
  });

  it('parses a calendar trigger with defaults', () => {
    const text = `---
name: meeting-prep
schedule: "*/5 * * * *"
trigger:
  type: calendar
  lead_minutes: 15
---
b
`;
    const r = parseRoutine(text, at('meeting-prep'));
    expect(r.frontmatter.trigger).toEqual({
      type: 'calendar',
      lead_minutes: 15,
      require_attendees: true,
    });
  });

  it('throws a RoutineError carrying the file path', () => {
    try {
      parseRoutine(`---\nname: x\n---\nb\n`, at('x'));
      expect.unreachable('should have thrown');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(RoutineError);
      expect((err as RoutineError).filePath).toBe(at('x'));
    }
  });
});

describe('loadRoutines', () => {
  it('returns an empty result for a missing directory', () => {
    const res = loadRoutines(path.join(dir, 'nope'));
    expect(res.routines).toEqual([]);
    expect(res.problems).toEqual([]);
  });

  it('skips a bad file without failing the whole load', () => {
    fs.writeFileSync(at('morning-brief'), VALID);
    fs.writeFileSync(at('broken'), `---\nname: broken\n---\nno schedule\n`);
    fs.writeFileSync(path.join(dir, 'README.md'), '# not a routine\n');

    const res = loadRoutines(dir);
    expect(res.routines.map((r) => r.name)).toEqual(['morning-brief']);
    expect(res.problems).toHaveLength(1);
    expect(res.problems[0]?.filePath).toBe(at('broken'));
    expect(res.problems[0]?.reason).toMatch(/exactly one/);
  });
});

describe('writeRoutine / deleteRoutine', () => {
  it('writes a file that parses back to the same values', () => {
    const written = writeRoutine(
      dir,
      {
        name: 'new-thing',
        schedule: '0 9 * * 1,4',
        timezone: 'Europe/Prague',
        model: 'opus',
        tools: ['google', 'vault'],
        enabled: true,
        kind: 'llm',
      },
      'Do the thing.',
    );
    expect(written).toBe(routineFilePath(dir, 'new-thing'));

    const r = parseRoutine(fs.readFileSync(written, 'utf8'), written);
    expect(r.frontmatter.schedule).toBe('0 9 * * 1,4');
    expect(r.frontmatter.tools).toEqual(['google', 'vault']);
    expect(r.body).toBe('Do the thing.');
  });

  it('deletes a file and reports a second delete as a no-op', () => {
    fs.writeFileSync(at('morning-brief'), VALID);
    expect(deleteRoutine(at('morning-brief'))).toBe(true);
    expect(deleteRoutine(at('morning-brief'))).toBe(false);
  });
});

describe('setEnabled', () => {
  const WITH_COMMENTS = `---
name: morning-brief
schedule: "0 7 * * 1-5"   # weekdays only
# keep this comment
enabled: true
tools: [google, vault]
---

Body line one.

Body line two.
`;

  it('changes only the enabled line', () => {
    const file = at('morning-brief');
    fs.writeFileSync(file, WITH_COMMENTS);

    expect(setEnabled(file, false)).toBe(true);
    const after = fs.readFileSync(file, 'utf8');

    expect(after).toBe(WITH_COMMENTS.replace('enabled: true', 'enabled: false'));
    expect(after).toContain('# weekdays only');
    expect(after).toContain('# keep this comment');
    expect(parseRoutine(after, file).frontmatter.enabled).toBe(false);
  });

  it('is a no-op when the value already matches', () => {
    const file = at('morning-brief');
    fs.writeFileSync(file, WITH_COMMENTS);
    expect(setEnabled(file, true)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(WITH_COMMENTS);
  });

  it('adds the line when the file has none', () => {
    const file = at('morning-brief');
    fs.writeFileSync(file, VALID);
    expect(setEnabled(file, false)).toBe(true);
    const after = fs.readFileSync(file, 'utf8');
    expect(parseRoutine(after, file).frontmatter.enabled).toBe(false);
    expect(after).toContain('Summarise the day.');
  });
});

describe('the shipped starter routines', () => {
  it('loads all nine of vault/routines with no problems', () => {
    const dir = fileURLToPath(new URL('../../../vault/routines', import.meta.url));
    const { routines, problems } = loadRoutines(dir);

    expect(problems).toEqual([]);
    expect(routines.map((r) => r.name).sort()).toEqual([
      'evening-close',
      'followups',
      'health-check',
      'inbox-digest',
      'meeting-prep',
      'memory-consolidate',
      'memory-review',
      'morning-brief',
      'weekly-review',
    ]);

    for (const routine of routines) {
      expect(routine.name).toBe(path.basename(routine.filePath, '.md'));
      expect(routine.frontmatter.enabled).toBe(true);
      expect(routine.body.length).toBeGreaterThan(0);
      expect(routine.frontmatter.timezone).toBe('Europe/Prague');
    }

    const byName = new Map(routines.map((r) => [r.name, r]));
    expect(byName.get('morning-brief')?.frontmatter.schedule).toBe('0 7 * * 1-5');
    expect(byName.get('health-check')?.frontmatter.kind).toBe('health');
    expect(byName.get('health-check')?.frontmatter.catch_up_minutes).toBe(1);
    expect(byName.get('meeting-prep')?.frontmatter.trigger).toEqual({
      type: 'calendar',
      lead_minutes: 15,
      require_attendees: true,
    });

    // Every LLM routine closes with the output contract on its own last non-empty line, so the
    // instruction is never buried mid-body where a Rules block can bury it.
    for (const routine of routines) {
      if (routine.frontmatter.kind !== 'llm') continue;
      const lines = routine.body.split('\n').filter((line) => line.trim() !== '');
      const last = lines[lines.length - 1] ?? '';
      expect(last, `${routine.name} must end with the STATUS instruction`).toMatch(
        /STATUS: (done|needs_input)/,
      );
    }
  });
});
