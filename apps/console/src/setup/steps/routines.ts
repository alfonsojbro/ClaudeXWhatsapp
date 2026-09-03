/**
 * Step 5: routines and the timezone.
 *
 * INTEGRATION IP-5: `vault/routines/*.md` and `apps/scheduler/src/routine.ts` land with phase 5
 * and are not on this branch. Two consequences, both handled here rather than papered over:
 *
 *  - `listRoutines` tolerates a missing directory and returns `{ routines: [], present: false }`,
 *    which the page renders as "routines land with phase 5" instead of an error.
 *  - `setRoutineEnabled` reproduces phase 5's `setEnabled` byte for byte, including its
 *    frontmatter regexp, so the same file edited by either code path comes out the same. When
 *    phase 5 merges, this function should be replaced by an import of `setEnabled` — it is a
 *    deliberate, marked duplicate, not a fork.
 *
 * This is one of only two places anything under the vault is written, and it writes exactly one
 * line of one file. `guardrails.test.ts` asserts that.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { updateEnvFile } from '../envfile.js';

/** Phase 5's regexp, copied so the two implementations cannot drift on whitespace. */
const FRONTMATTER_RE = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/;

export interface RoutineSummary {
  /** The file name without `.md`, which is the name the scheduler and WhatsApp use. */
  readonly name: string;
  readonly file: string;
  readonly enabled: boolean;
  readonly description: string;
}

export interface RoutineListing {
  readonly routines: readonly RoutineSummary[];
  /** False when the directory does not exist yet, which is the phase-5 case. */
  readonly present: boolean;
}

/** One scalar out of a frontmatter block. No YAML parser: `@cxw/console` has no dependencies. */
function frontmatterValue(yaml: string, key: string): string | undefined {
  const pattern = new RegExp(`^\\s*${key}:[ \\t]*(.*?)[ \\t]*\\r?$`, 'm');
  const hit = pattern.exec(yaml);
  if (hit === null) return undefined;
  return (hit[1] ?? '').replace(/^["']|["']$/g, '').trim();
}

/**
 * Every `*.md` in the routines directory, with the three fields the page shows.
 *
 * A file that cannot be read or has no frontmatter is skipped rather than failing the listing:
 * one malformed routine must not make the step unusable.
 */
export function listRoutines(routinesDir: string): RoutineListing {
  let entries: string[];
  try {
    entries = readdirSync(routinesDir);
  } catch {
    return { routines: [], present: false };
  }
  const routines: RoutineSummary[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.md')) continue;
    const file = join(routinesDir, entry);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const block = FRONTMATTER_RE.exec(text);
    if (block === null) continue;
    const yaml = block[2] ?? '';
    routines.push({
      name: frontmatterValue(yaml, 'name') ?? entry.slice(0, -3),
      file,
      enabled: frontmatterValue(yaml, 'enabled') === 'true',
      description: frontmatterValue(yaml, 'description') ?? '',
    });
  }
  return { routines, present: true };
}

export class RoutineFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutineFileError';
  }
}

/**
 * Flip only the `enabled:` line, byte-preserving.
 *
 * A copy of phase 5's `setEnabled`, down to the indentation and carriage-return capture. These
 * files are the person's own text and are committed to their vault; a rewrite that reflowed the
 * YAML would show up as noise in every git diff forever. Returns false when nothing changed.
 */
export function setRoutineEnabled(file: string, enabled: boolean): boolean {
  const original = readFileSync(file, 'utf8');
  const m = FRONTMATTER_RE.exec(original);
  if (m === null) throw new RoutineFileError(`${file} has no frontmatter block`);

  const open = m[1] ?? '---\n';
  const yaml = m[2] ?? '';
  const close = m[3] ?? '\n---\n';
  const rest = original.slice(m[0].length);

  const desired = `enabled: ${String(enabled)}`;
  let replaced = false;
  const lines = yaml.split('\n').map((line) => {
    if (replaced) return line;
    const hit = /^(\s*)enabled:[^\r\n]*?(\r?)$/.exec(line);
    if (hit === null) return line;
    replaced = true;
    return `${hit[1] ?? ''}${desired}${hit[2] ?? ''}`;
  });

  const nextYaml = replaced ? lines.join('\n') : `${yaml}\n${desired}`;
  const next = `${open}${nextYaml}${close}${rest}`;
  if (next === original) return false;
  writeFileSync(file, next, 'utf8');
  return true;
}

export class TimezoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimezoneError';
  }
}

/**
 * Is this a zone name the runtime knows?
 *
 * `Intl.DateTimeFormat` is the only zone database on the box, so it is also the only honest
 * validator: a name it rejects is a name every timestamp on this machine would reject.
 */
export function isValidTimezone(tz: string): boolean {
  const value = String(tz ?? '').trim();
  if (value === '') return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the zone to `cxw.env` as both `TZ` and `CXW_TZ`.
 *
 * Two keys because they are read by different things: systemd and every child process read
 * `TZ`, while the console and scheduler read `CXW_TZ` to display and schedule in. Writing only
 * one leaves the box and the routines disagreeing about what "07:00" means.
 */
export function setTimezone(envPath: string, tz: string): string {
  const value = String(tz ?? '').trim();
  if (!isValidTimezone(value)) {
    throw new TimezoneError(
      `\`${value}\` is not a timezone this box knows. Use an IANA name such as Europe/Prague or America/Panama.`,
    );
  }
  updateEnvFile(envPath, { TZ: value, CXW_TZ: value });
  return value;
}
