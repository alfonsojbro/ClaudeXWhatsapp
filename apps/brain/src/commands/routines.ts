/**
 * Routine commands: the deterministic shortcuts the brain answers without an LLM turn.
 *
 * The Phase-2 router calls {@link handleRoutineCommand} first. A `string` reply is final and is
 * sent as-is; `null` means "not a routine command" and the router falls through to the LLM loop.
 *
 * Owner-only enforcement is the router's job: this module never checks who is asking.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Db, Routine, WritableFrontmatter } from '@cxw/scheduler';
import {
  describeCron,
  enqueue,
  formatInTz,
  history,
  loadRoutines,
  nextRun,
  getState,
  parseRoutine,
  routineFilePath,
  setEnabled,
  writeRoutine,
} from '@cxw/scheduler';
import { parseReminder } from './reminder.js';
import { parseSchedulePhrase, SUPPORTED_FORMS } from './schedule-phrase.js';

/** Everything the command handler needs from the brain. */
export interface RoutineCommandContext {
  /** The vault root; routines live in `<vaultDir>/routines`. */
  vaultDir: string;
  /** The scheduler database, already migrated. */
  db: Db;
  /** Timezone used for routines that do not set one. */
  defaultTimezone: string;
  /** Injected clock. Defaults to the system clock. */
  now?: () => Date;
}

const PREVIEW_CHARS = 60;
const NAME_WORDS = 4;

function routinesDirOf(ctx: RoutineCommandContext): string {
  return path.join(ctx.vaultDir, 'routines');
}

function nowOf(ctx: RoutineCommandContext): Date {
  return ctx.now === undefined ? new Date() : ctx.now();
}

function load(ctx: RoutineCommandContext): Routine[] {
  return loadRoutines(routinesDirOf(ctx), { defaultTimezone: ctx.defaultTimezone }).routines;
}

function findRoutine(routines: Routine[], name: string): Routine | undefined {
  const wanted = name.trim().toLowerCase();
  return routines.find((r) => r.name === wanted);
}

function unknownName(name: string, routines: Routine[]): string {
  if (routines.length === 0) return `No routine named "${name}". There are no routines yet.`;
  const names = routines.map((r) => r.name).join(', ');
  return `No routine named "${name}". Available: ${names}`;
}

/** `<hh:mm>` style rendering of a next-run instant, or a dash when there is none. */
function nextRunLabel(routine: Routine, now: Date): string {
  const next = nextRun(routine, now);
  if (next === null) return '—';
  return formatInTz(next, routine.frontmatter.timezone);
}

function scheduleLabel(routine: Routine): string {
  if (routine.frontmatter.trigger !== undefined) return 'event-driven';
  const cron = routine.frontmatter.schedule;
  if (cron !== undefined) return `${cron} (${describeCron(cron)})`;
  if (routine.onceAt !== undefined) {
    return `once ${formatInTz(routine.onceAt, routine.frontmatter.timezone, 'datetime')}`;
  }
  return 'unscheduled';
}

function lastLabel(ctx: RoutineCommandContext, routine: Routine): string {
  const state = getState(ctx.db, routine.name);
  if (state === null || state.lastStatus === null || state.lastRunAt === null) return 'never';
  const at = formatInTz(new Date(state.lastRunAt), routine.frontmatter.timezone, 'datetime');
  return `${state.lastStatus} at ${at}`;
}

function listRoutines(ctx: RoutineCommandContext): string {
  const routines = load(ctx);
  if (routines.length === 0) return 'No routines yet. Add one with `new routine <when>: <what>`.';
  const now = nowOf(ctx);
  return routines
    .map((routine) => {
      const state = routine.frontmatter.enabled ? 'enabled' : 'paused';
      const next = routine.frontmatter.trigger === undefined ? nextRunLabel(routine, now) : '—';
      return [
        routine.name,
        scheduleLabel(routine),
        `next ${next}`,
        state,
        `last ${lastLabel(ctx, routine)}`,
      ].join(' · ');
    })
    .join('\n');
}

function runNow(ctx: RoutineCommandContext, name: string): string {
  const routines = load(ctx);
  const routine = findRoutine(routines, name);
  if (routine === undefined) return unknownName(name, routines);

  const now = nowOf(ctx);
  enqueue(ctx.db, {
    name: routine.name,
    slot: now,
    trigger: 'manual',
    stage: 'run',
    now,
  });
  const paused = routine.frontmatter.enabled ? '' : ' (currently paused)';
  return `Queued ${routine.name}${paused}. Result in about a minute.`;
}

function setPaused(ctx: RoutineCommandContext, name: string, paused: boolean): string {
  const routines = load(ctx);
  const routine = findRoutine(routines, name);
  if (routine === undefined) return unknownName(name, routines);

  setEnabled(routine.filePath, !paused);
  if (paused) return `Paused ${routine.name}. Next run: none until you resume it.`;

  const reloaded = parseRoutine(fs.readFileSync(routine.filePath, 'utf8'), routine.filePath, {
    defaultTimezone: ctx.defaultTimezone,
  });
  return `Resumed ${reloaded.name}. Next run ${nextRunLabel(reloaded, nowOf(ctx))}.`;
}

function showHistory(ctx: RoutineCommandContext, name: string): string {
  const routines = load(ctx);
  const routine = findRoutine(routines, name);
  if (routine === undefined) return unknownName(name, routines);

  const rows = history(ctx.db, routine.name, 5);
  if (rows.length === 0) return `No runs yet for ${routine.name}.`;
  return rows
    .map((row) => {
      const at = formatInTz(new Date(row.startedAt), routine.frontmatter.timezone, 'datetime');
      const preview = (row.resultPreview ?? row.error ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, PREVIEW_CHARS);
      return [at, row.status, preview, row.logPath ?? '—'].join(' · ');
    })
    .join('\n');
}

/** kebab-case slug, empty when nothing survives. */
export function slugify(text: string, maxWords = NAME_WORDS): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w !== '')
    .slice(0, maxWords)
    .join('-');
}

function uniqueName(dir: string, base: string): string {
  if (!fs.existsSync(routineFilePath(dir, base))) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${String(n)}`;
    if (!fs.existsSync(routineFilePath(dir, candidate))) return candidate;
  }
  return `${base}-${String(Date.now())}`;
}

function createRoutine(ctx: RoutineCommandContext, phrase: string, prompt: string): string {
  const schedule = parseSchedulePhrase(phrase);
  if (schedule === null) {
    return [
      `I could not read "${phrase.trim()}" as a schedule. Supported forms:`,
      ...SUPPORTED_FORMS.map((form) => `• ${form}`),
    ].join('\n');
  }

  const body = prompt.trim();
  const base = slugify(body);
  if (base === '')
    return 'I need a prompt after the colon, for example `new routine every day at 8: check the news`.';

  const dir = routinesDirOf(ctx);
  const name = uniqueName(dir, base);
  const frontmatter: WritableFrontmatter = {
    name,
    schedule: schedule.cron,
    timezone: ctx.defaultTimezone,
    model: 'opus',
    tools: ['google', 'whatsapp', 'vault'],
    deliver_to: 'owner',
    enabled: true,
    kind: 'llm',
  };
  const filePath = writeRoutine(dir, frontmatter, body);
  const routine = parseRoutine(fs.readFileSync(filePath, 'utf8'), filePath, {
    defaultTimezone: ctx.defaultTimezone,
  });

  return [
    `Created ${name} — ${schedule.cron} (${schedule.human}).`,
    `Next run ${nextRunLabel(routine, nowOf(ctx))}.`,
    `File: vault/routines/${name}.md`,
  ].join(' ');
}

const REMINDER_HELP =
  'I could not set that reminder. I need a future time and a subject, for example ' +
  '`remind me Friday 9am to call Marco`.';

function createReminder(ctx: RoutineCommandContext, phrase: string): string {
  const now = nowOf(ctx);
  const tz = ctx.defaultTimezone;
  const parsed = parseReminder(phrase, now, tz);
  if (parsed === null) return REMINDER_HELP;

  const local = formatInTz(parsed.when, tz, 'datetime');
  const stamp = local.replace(/[-: ]/g, '');
  const name = `reminder-${slugify(parsed.what, 3)}-${stamp.slice(0, 8)}-${stamp.slice(8, 12)}`;
  const dir = routinesDirOf(ctx);
  const frontmatter: WritableFrontmatter = {
    name: uniqueName(dir, name),
    once: local.replace(' ', 'T'),
    timezone: tz,
    deliver_to: 'owner',
    enabled: true,
    kind: 'static',
  };
  writeRoutine(dir, frontmatter, `⏰ Reminder: ${parsed.what}`);
  return `Reminder set for ${local}: ${parsed.what}`;
}

/**
 * Answer a routine command.
 *
 * @param text the raw incoming message.
 * @param ctx vault, database, timezone and clock.
 * @returns the reply to send, or `null` when the message is not a routine command.
 */
export async function handleRoutineCommand(
  text: string,
  ctx: RoutineCommandContext,
): Promise<string | null> {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  // Every branch below is synchronous today; the signature is async so the router can await it.
  await Promise.resolve();

  if (/^routines$/i.test(trimmed)) return listRoutines(ctx);

  const run = /^run\s+([a-z0-9][a-z0-9-]*)$/i.exec(trimmed);
  if (run?.[1] !== undefined) return runNow(ctx, run[1]);

  const pause = /^pause\s+([a-z0-9][a-z0-9-]*)$/i.exec(trimmed);
  if (pause?.[1] !== undefined) return setPaused(ctx, pause[1], true);

  const resume = /^resume\s+([a-z0-9][a-z0-9-]*)$/i.exec(trimmed);
  if (resume?.[1] !== undefined) return setPaused(ctx, resume[1], false);

  const hist = /^history\s+([a-z0-9][a-z0-9-]*)$/i.exec(trimmed);
  if (hist?.[1] !== undefined) return showHistory(ctx, hist[1]);

  const created = /^new\s+routine\s+([^:]+):\s*([\s\S]+)$/i.exec(trimmed);
  if (created?.[1] !== undefined && created[2] !== undefined) {
    return createRoutine(ctx, created[1], created[2]);
  }

  if (/^remind\s+me\b/i.test(trimmed)) return createReminder(ctx, trimmed);

  return null;
}
