/**
 * The static runner: no LLM, the routine body is the output.
 *
 * Used by reminders (`kind: static`), where the body is already the message to send.
 */
import type { JobResult, JobRunner, Routine } from '../types.js';

/** Returns the routine body verbatim as a successful job result. */
export class StaticRunner implements JobRunner {
  run(routine: Routine): Promise<JobResult> {
    return Promise.resolve({
      isError: false,
      text: routine.body.trim(),
      costUsd: 0,
      numTurns: 0,
      sessionId: '',
    });
  }
}
