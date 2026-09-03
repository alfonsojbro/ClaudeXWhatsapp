/**
 * Routine files: `vault/routines/<name>.md` — YAML frontmatter plus a markdown prompt body.
 */
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { isValidCron, isValidTimeZone, parseLocalDateTimeInTz } from './schedule.js';
import type { ModelAlias, Routine, RoutineFrontmatter, RoutineProblem } from './types.js';

/** Short alias -> full Anthropic model id. */
export const MODEL_IDS: Record<ModelAlias, string> = {
  opus: 'claude-opus-5',
  fable: 'claude-fable-5-1',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001',
};

/** kebab-case, starting with a letter or digit. */
export const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const DEFAULT_CATCH_UP_CRON = 10;
const DEFAULT_CATCH_UP_ONCE = 1440;

/** Options for {@link parseRoutine}. */
export interface ParseOptions {
  /** Timezone used when the file does not set one. */
  defaultTimezone?: string;
}

const DEFAULT_TZ = 'Europe/Prague';

/** Accept a YAML timestamp (js-yaml may hand back a Date) or a plain string. */
const dateOrString = z.union([z.string(), z.date()]).transform((v) => {
  if (typeof v === 'string') return v.trim();
  return v.toISOString();
});

const triggerSchema = z.object({
  type: z.literal('calendar'),
  lead_minutes: z.coerce
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .default(15),
  require_attendees: z.boolean().default(true),
});

const rawSchema = z.object({
  name: z.string().trim().min(1),
  schedule: z.string().trim().min(1).optional(),
  once: dateOrString.optional(),
  timezone: z.string().trim().min(1).optional(),
  model: z.enum(['opus', 'fable', 'sonnet', 'haiku']).optional(),
  tools: z.array(z.string().trim().min(1)).optional(),
  deliver_to: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  kind: z.enum(['llm', 'static', 'health']).optional(),
  trigger: triggerSchema.optional(),
  catch_up_minutes: z.coerce.number().int().min(0).optional(),
  max_turns: z.coerce.number().int().min(1).max(500).optional(),
  description: z.string().trim().min(1).optional(),
});

/** Thrown when a routine file is malformed. */
export class RoutineError extends Error {
  readonly filePath: string;

  constructor(message: string, filePath: string) {
    super(message);
    this.name = 'RoutineError';
    this.filePath = filePath;
  }
}

function issuesToMessage(err: z.ZodError): string {
  return err.issues
    .map((i) => {
      const at = i.path.length > 0 ? `${i.path.join('.')}: ` : '';
      return `${at}${i.message}`;
    })
    .join('; ');
}

/**
 * Parse one routine file.
 *
 * @param text raw file contents (frontmatter + body).
 * @param filePath path the text came from; its stem must equal `name`.
 * @throws {RoutineError} when the frontmatter is invalid.
 */
export function parseRoutine(text: string, filePath: string, opts: ParseOptions = {}): Routine {
  const defaultTimezone = opts.defaultTimezone ?? DEFAULT_TZ;

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(text);
  } catch (err: unknown) {
    throw new RoutineError(`invalid YAML frontmatter (${String(err)})`, filePath);
  }

  const result = rawSchema.safeParse(parsed.data);
  if (!result.success) throw new RoutineError(issuesToMessage(result.error), filePath);
  const raw = result.data;

  const stem = path.basename(filePath).replace(/\.md$/i, '');
  if (!NAME_RE.test(raw.name)) {
    throw new RoutineError(`name "${raw.name}" is not kebab-case (${NAME_RE.source})`, filePath);
  }
  if (raw.name !== stem) {
    throw new RoutineError(`name "${raw.name}" does not match filename stem "${stem}"`, filePath);
  }

  const hasSchedule = raw.schedule !== undefined;
  const hasOnce = raw.once !== undefined;
  if (hasSchedule === hasOnce) {
    throw new RoutineError('set exactly one of `schedule` or `once`', filePath);
  }

  const timezone = raw.timezone ?? defaultTimezone;
  if (!isValidTimeZone(timezone)) {
    throw new RoutineError(`unknown timezone "${timezone}"`, filePath);
  }

  if (raw.schedule !== undefined && !isValidCron(raw.schedule, timezone)) {
    throw new RoutineError(`invalid cron expression "${raw.schedule}"`, filePath);
  }

  let onceAt: Date | null = null;
  if (raw.once !== undefined) {
    onceAt = parseLocalDateTimeInTz(raw.once, timezone);
    if (onceAt === null) {
      throw new RoutineError(`invalid \`once\` datetime "${raw.once}"`, filePath);
    }
  }

  const model = raw.model ?? 'opus';
  const frontmatter: RoutineFrontmatter = {
    name: raw.name,
    timezone,
    model,
    tools: raw.tools ?? [],
    deliver_to: raw.deliver_to ?? 'owner',
    enabled: raw.enabled ?? true,
    kind: raw.kind ?? 'llm',
    catch_up_minutes:
      raw.catch_up_minutes ?? (hasOnce ? DEFAULT_CATCH_UP_ONCE : DEFAULT_CATCH_UP_CRON),
    max_turns: raw.max_turns ?? 30,
  };
  if (raw.schedule !== undefined) frontmatter.schedule = raw.schedule;
  if (raw.once !== undefined) frontmatter.once = raw.once;
  if (raw.trigger !== undefined) frontmatter.trigger = raw.trigger;
  if (raw.description !== undefined) frontmatter.description = raw.description;

  const routine: Routine = {
    frontmatter,
    name: raw.name,
    body: parsed.content.trim(),
    filePath,
    modelId: MODEL_IDS[model],
  };
  if (onceAt !== null) routine.onceAt = onceAt;
  return routine;
}

/** Result of {@link loadRoutines}. */
export interface LoadResult {
  routines: Routine[];
  problems: RoutineProblem[];
}

/** The canonical file path for a routine name inside `dir`. */
export function routineFilePath(dir: string, name: string): string {
  return path.join(dir, `${name}.md`);
}

/**
 * Load every `*.md` in `dir`.
 *
 * One bad file never fails the load: it is reported in `problems` and skipped. A missing directory
 * yields an empty result.
 */
export function loadRoutines(dir: string, opts: ParseOptions = {}): LoadResult {
  const routines: Routine[] = [];
  const problems: RoutineProblem[] = [];

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { routines, problems };
  }

  for (const entry of entries.sort()) {
    if (!entry.endsWith('.md')) continue;
    if (entry.toLowerCase() === 'readme.md') continue;
    const filePath = path.join(dir, entry);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      routines.push(parseRoutine(fs.readFileSync(filePath, 'utf8'), filePath, opts));
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      problems.push({ filePath, reason });
    }
  }

  return { routines, problems };
}

/** Frontmatter fields accepted by {@link writeRoutine}. */
export type WritableFrontmatter = Omit<Partial<RoutineFrontmatter>, 'name'> & { name: string };

const FIELD_ORDER: (keyof RoutineFrontmatter)[] = [
  'name',
  'schedule',
  'once',
  'timezone',
  'model',
  'tools',
  'deliver_to',
  'enabled',
  'kind',
  'trigger',
  'catch_up_minutes',
  'max_turns',
  'description',
];

function yamlScalar(value: string | number | boolean): string {
  if (typeof value !== 'string') return String(value);
  if (value === '' || /[:#{}[\],&*?|<>=!%@`"']/.test(value) || /^\s|\s$/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function yamlLines(fm: WritableFrontmatter): string[] {
  const lines: string[] = [];
  for (const key of FIELD_ORDER) {
    const value = fm[key];
    if (value === undefined) continue;
    if (key === 'tools' && Array.isArray(value)) {
      lines.push(`tools: [${value.map((t) => yamlScalar(t)).join(', ')}]`);
      continue;
    }
    if (key === 'trigger' && typeof value === 'object') {
      const t = value as RoutineFrontmatter['trigger'];
      if (t === undefined) continue;
      lines.push('trigger:');
      lines.push(`  type: ${t.type}`);
      lines.push(`  lead_minutes: ${String(t.lead_minutes)}`);
      lines.push(`  require_attendees: ${String(t.require_attendees)}`);
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  return lines;
}

/**
 * Write a routine file into `dir`, creating the directory if needed.
 *
 * @returns the path written.
 */
export function writeRoutine(dir: string, fm: WritableFrontmatter, body: string): string {
  if (!NAME_RE.test(fm.name)) throw new Error(`invalid routine name "${fm.name}"`);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = routineFilePath(dir, fm.name);
  const text = `---\n${yamlLines(fm).join('\n')}\n---\n\n${body.trim()}\n`;
  fs.writeFileSync(filePath, text, 'utf8');
  return filePath;
}

const FRONTMATTER_RE = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/;

/**
 * Flip the `enabled:` line of a routine file in place.
 *
 * Only that one line is touched: every other line, including comments and blank lines, is
 * preserved byte for byte. When no `enabled:` line exists one is appended to the frontmatter.
 *
 * @returns true when the file changed.
 */
export function setEnabled(filePath: string, enabled: boolean): boolean {
  const original = fs.readFileSync(filePath, 'utf8');
  const m = FRONTMATTER_RE.exec(original);
  if (m === null) throw new RoutineError('file has no frontmatter block', filePath);

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
  fs.writeFileSync(filePath, next, 'utf8');
  return true;
}

/** Delete a routine file. Returns false when it was already gone. */
export function deleteRoutine(filePath: string): boolean {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}
