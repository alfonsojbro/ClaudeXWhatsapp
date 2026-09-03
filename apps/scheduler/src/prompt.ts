/**
 * The prompt handed to a routine's job runner, and the STATUS marker it must end with.
 */
import { formatInTz } from './schedule.js';
import type { Routine } from './types.js';

/** The three statuses a routine may report on its last line. */
export type JobStatus = 'done' | 'needs_input' | 'failed';

const STATUS_LINE_RE = /^STATUS:\s*(done|needs_input|failed)\s*$/i;

/** The output contract appended to every job prompt. */
export const OUTPUT_CONTRACT = [
  '## Output contract',
  '',
  '- Reply with plain text for WhatsApp. No markdown headings, no tables, no code fences.',
  '- Keep each section to about 3500 characters. Use short lines and simple dashes for lists.',
  '- If the output would be long, write the full text to a file under `vault/` and reply with a',
  '  summary of at most five lines that names the file you wrote.',
  '- The last line of your reply must be exactly one of:',
  '  `STATUS: done`, `STATUS: needs_input`, or `STATUS: failed`.',
].join('\n');

/**
 * Build the prompt for one run.
 *
 * @param routine the routine being run.
 * @param now the instant the run started; rendered in the routine's timezone.
 * @param extraContext optional block injected between the header and the body, for example the
 * JSON of the calendar event that triggered the run.
 */
export function buildJobPrompt(routine: Routine, now: Date, extraContext?: string): string {
  const tz = routine.frontmatter.timezone;
  const header = [
    '# Routine context',
    '',
    `Routine: ${routine.name}`,
    `Local date and time: ${formatInTz(now, tz, 'datetime')}`,
    `Timezone: ${tz}`,
  ].join('\n');

  const parts = [header];
  if (extraContext !== undefined && extraContext.trim() !== '') {
    parts.push(['# Trigger context', '', extraContext.trim()].join('\n'));
  }
  parts.push(['# Task', '', routine.body.trim()].join('\n'));
  parts.push(OUTPUT_CONTRACT);
  return parts.join('\n\n');
}

/** The outcome of reading a routine's trailing STATUS marker. */
export interface ParsedStatus {
  status: JobStatus;
  /** The reply with the marker line removed and trailing whitespace trimmed. */
  text: string;
}

/**
 * Read the trailing `STATUS:` marker.
 *
 * A missing or unrecognised marker means `done`, and the text is returned unchanged.
 */
export function parseStatusMarker(text: string): ParsedStatus {
  const lines = text.replace(/\s+$/, '').split('\n');
  const last = lines[lines.length - 1];
  if (last === undefined) return { status: 'done', text: text.trim() };

  const match = STATUS_LINE_RE.exec(last.trim());
  if (match === null) return { status: 'done', text: text.trim() };

  const status = (match[1] ?? 'done').toLowerCase() as JobStatus;
  lines.pop();
  return { status, text: lines.join('\n').replace(/\s+$/, '') };
}
