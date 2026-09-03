/**
 * `@cxw/scheduler` — routine files, leases, run logs, and the scheduling loop.
 *
 * This module is the package's public API: the brain's routine commands import from here. It has
 * no side effects, so importing it never starts the service. Run `src/main.ts` for that.
 */
import { pathToFileURL } from 'node:url';
import { banner, serviceInfo } from '@cxw/shared';

export const SERVICE = 'scheduler' as const;

export function describe(): string {
  return banner(serviceInfo(SERVICE));
}

/** Legacy stub entry point: prints the banner and waits for a stop signal. */
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

// --- Library surface used by the brain's routine commands ------------------------------------

export {
  deleteRoutine,
  loadRoutines,
  MODEL_IDS,
  NAME_RE,
  parseRoutine,
  RoutineError,
  routineFilePath,
  setEnabled,
  writeRoutine,
} from './routine.js';
export type { LoadResult, ParseOptions, WritableFrontmatter } from './routine.js';

export {
  describeCron,
  dueSlot,
  formatInTz,
  isValidCron,
  isValidTimeZone,
  nextRun,
  parseLocalDateTimeInTz,
  tzOffsetMinutes,
} from './schedule.js';
export type { DueSlot, TzFormat } from './schedule.js';

export { migrate, openDb, SCHEMA_VERSION, schemaVersion } from './db.js';
export type { Db } from './db.js';

export { dueItems, enqueue, markFailed, MAX_ATTEMPTS, pendingFor, remove } from './spool.js';
export type { EnqueueInput, EnqueueResult, SpoolItem } from './spool.js';

export { getState, history, recordSkipped, setState, writeRunLog } from './runs.js';
export type { RoutineState, RunLogInput, RunRecord } from './runs.js';

export { chunkText, DEFAULT_CHUNK_MAX } from './chunk.js';
export { buildJobPrompt, parseStatusMarker } from './prompt.js';
export type { JobStatus, ParsedStatus } from './prompt.js';
export { loadConfig } from './config.js';
export type { Config, EnvRecord } from './config.js';
export { Scheduler, SystemClock } from './scheduler.js';
export type { SchedulerDeps } from './scheduler.js';

export type {
  CalendarAttendee,
  CalendarEvent,
  CalendarSource,
  CalendarTriggerConfig,
  Clock,
  Deliverer,
  JobFailure,
  JobResult,
  JobRunner,
  JobSuccess,
  ModelAlias,
  Routine,
  RoutineFrontmatter,
  RoutineKind,
  RoutineProblem,
  RunStatus,
  SpoolStage,
  Trigger,
} from './types.js';

// `import.meta.url` is percent-encoded; `pathToFileURL` encodes the argv path the same way, so
// this still matches on a checkout whose path contains a space.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
