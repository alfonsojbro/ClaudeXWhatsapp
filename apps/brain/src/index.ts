/**
 * @cxw/brain — Brain: Claude Agent SDK loop, router, confirm gate, media pipeline.
 * Phase 0 stub: starts, logs its banner, and waits for SIGTERM.
 */
import { pathToFileURL } from 'node:url';
import { banner, serviceInfo } from '@cxw/shared';

export const SERVICE = 'brain' as const;

export function describe(): string {
  return banner(serviceInfo(SERVICE));
}

export async function main(): Promise<void> {
  console.log(describe());
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      console.log(`${SERVICE}: shutting down`);
      resolve();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
}

// --- Routine commands (Phase 5) -------------------------------------------------------------
//
// The router must call `handleRoutineCommand` before the LLM loop, and only for the owner.
// A string reply is final; `null` means the message was not a routine command.

export { handleRoutineCommand, slugify } from './commands/routines.js';
export type { RoutineCommandContext } from './commands/routines.js';
export { parseSchedulePhrase, SUPPORTED_FORMS } from './commands/schedule-phrase.js';
export type { ParsedSchedule } from './commands/schedule-phrase.js';
export { parseReminder } from './commands/reminder.js';
export type { ParsedReminder } from './commands/reminder.js';

// `import.meta.url` is percent-encoded; `pathToFileURL` encodes the argv path the same way, so
// this still matches on a checkout whose path contains a space.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
