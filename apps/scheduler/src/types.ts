/**
 * Shared types and ports for the scheduler.
 *
 * The ports (`JobRunner`, `Deliverer`, `CalendarSource`, `Clock`) are declared here so that the
 * real implementations and the test fakes share exactly one definition.
 */

/** Lifecycle status of a single routine run. */
export type RunStatus = 'running' | 'done' | 'failed' | 'needs_input' | 'skipped';

/** What caused a run to be enqueued. */
export type Trigger = 'cron' | 'once' | 'manual' | 'calendar';

/** Which runner executes the routine. */
export type RoutineKind = 'llm' | 'static' | 'health';

/** Short model alias accepted in routine frontmatter. */
export type ModelAlias = 'opus' | 'fable' | 'sonnet' | 'haiku';

/** Spool stage: the LLM job, or the delivery of an already-produced result. */
export type SpoolStage = 'run' | 'deliver';

/** Event-driven trigger configuration (currently only calendar). */
export interface CalendarTriggerConfig {
  type: 'calendar';
  lead_minutes: number;
  require_attendees: boolean;
}

/** Routine frontmatter after zod validation and defaulting. */
export interface RoutineFrontmatter {
  name: string;
  /** Cron expression in `timezone`. Exactly one of `schedule` / `once` is present. */
  schedule?: string;
  /** ISO local datetime in `timezone` (an explicit offset is allowed). */
  once?: string;
  timezone: string;
  model: ModelAlias;
  tools: string[];
  deliver_to: string;
  enabled: boolean;
  kind: RoutineKind;
  trigger?: CalendarTriggerConfig;
  catch_up_minutes: number;
  max_turns: number;
  description?: string;
}

/** A parsed routine file. */
export interface Routine {
  /** Frontmatter with defaults applied. */
  frontmatter: RoutineFrontmatter;
  /** Convenience alias of `frontmatter.name`. */
  name: string;
  /** Prompt body (markdown), trimmed. */
  body: string;
  /** Absolute path of the file this routine was parsed from. */
  filePath: string;
  /** Full Anthropic model id resolved from `frontmatter.model`. */
  modelId: string;
  /** Resolved instant of `once`, when the routine is a one-shot. */
  onceAt?: Date;
}

/** A routine file that failed to parse. */
export interface RoutineProblem {
  filePath: string;
  reason: string;
}

/** Result of a job that produced output. */
export interface JobSuccess {
  isError: false;
  text: string;
  costUsd: number;
  numTurns: number;
  sessionId: string;
}

/** Result of a job that failed. */
export interface JobFailure {
  isError: true;
  error: string;
}

/** Discriminated job result. */
export type JobResult = JobSuccess | JobFailure;

/** Port: executes a routine and returns its text output. */
export interface JobRunner {
  run(routine: Routine, prompt: string, signal: AbortSignal): Promise<JobResult>;
}

/** Port: delivers text to the owner or to a specific WhatsApp JID. Throws on failure. */
export interface Deliverer {
  send(to: string, text: string): Promise<void>;
}

/** One attendee of a calendar event. */
export interface CalendarAttendee {
  email: string;
  self: boolean;
}

/** A calendar event, normalised. */
export interface CalendarEvent {
  id: string;
  summary: string;
  start: Date;
  end: Date;
  attendees: CalendarAttendee[];
  /** Where the meeting is, when the calendar carries it. */
  location?: string;
  /** The event description, when the calendar carries one. Often holds the agenda. */
  description?: string;
}

/** Port: reads upcoming calendar events. */
export interface CalendarSource {
  listEvents(from: Date, to: Date): Promise<CalendarEvent[]>;
}

/** Port: the current time, injectable so tests never depend on the real clock. */
export interface Clock {
  now(): Date;
}
