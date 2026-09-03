/**
 * The scheduler loop.
 *
 * One tick reloads the routine files, enqueues the cron and once slots that have come due, polls
 * the calendar triggers, and then works the retry spool. Every port is injected, so the whole
 * class is testable with fakes and a fixed clock.
 *
 * Privacy: routine result text passes through here and is never logged.
 */
import path from 'node:path';
import { pollCalendarTriggers } from './calendar-trigger.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { claimLease, heartbeatLease, releaseLease } from './lease.js';
import type { Logger } from './log.js';
import { createLogger } from './log.js';
import { buildJobPrompt, parseStatusMarker } from './prompt.js';
import { deleteRoutine, loadRoutines } from './routine.js';
import type { JobStatus } from './prompt.js';
import {
  changeAlertText,
  diffHealth,
  runHealthCheck,
  storeHealthStates,
  type HealthDeps,
  type HealthReport,
} from './runner/health.js';
import {
  finishRun,
  findRunBySlot,
  markDelivered,
  readRunLogBody,
  recordSkipped,
  reopenRun,
  setState,
  startRun,
  writeRunLog,
} from './runs.js';
import { dueSlot } from './schedule.js';
import { dueItems, enqueue, markFailed, remove, toDeliverStage } from './spool.js';
import type { SpoolItem } from './spool.js';
import type {
  CalendarSource,
  Clock,
  Deliverer,
  JobResult,
  JobRunner,
  Routine,
  RunStatus,
  Trigger,
} from './types.js';

const PREVIEW_CHARS = 240;

/** Sends an alert by e-mail when WhatsApp itself is down. */
export type EmailAlert = (subject: string, body: string) => Promise<void>;

/** Everything the scheduler needs from the outside world. */
export interface SchedulerDeps {
  db: Db;
  config: Config;
  clock: Clock;
  /** Runner for `kind: llm` routines. */
  llmRunner: JobRunner;
  /** Runner for `kind: static` routines. */
  staticRunner: JobRunner;
  /** Dependencies of the health probes; `kind: health` routines use them directly. */
  health: HealthDeps;
  deliverer: Deliverer;
  /** Calendar source for event triggers; omit when Google is not configured. */
  calendar?: CalendarSource | null;
  /** Alert channel used when the `whatsapp` probe is down. */
  emailAlert?: EmailAlert | null;
  logger?: Logger;
  /** Lease owner id. Defaults to `pid-<process id>`. */
  owner?: string;
  /**
   * `unref` the tick timer so it does not hold the event loop open. Defaults to **false**:
   * production must keep the timer ref'd or the service exits as soon as `main()` drains.
   * Only a test that starts a scheduler it never stops should set this.
   */
  unrefTimer?: boolean;
}

/** The system clock. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

function preview(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
}

function toRunStatus(status: JobStatus): RunStatus {
  return status;
}

/** Drives routines from their files to WhatsApp. */
export class Scheduler {
  private readonly db: Db;
  private readonly config: Config;
  private readonly clock: Clock;
  private readonly llmRunner: JobRunner;
  private readonly staticRunner: JobRunner;
  private readonly healthDeps: HealthDeps;
  private readonly deliverer: Deliverer;
  private readonly calendar: CalendarSource | null;
  private readonly emailAlert: EmailAlert | null;
  private readonly logger: Logger;
  private readonly owner: string;
  private readonly unrefTimer: boolean;

  private routines = new Map<string, Routine>();
  private inFlight = new Map<string, Promise<void>>();
  private llmInFlight = 0;
  private lastCalendarPollMs = 0;
  private timer: NodeJS.Timeout | null = null;
  private alignTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  constructor(deps: SchedulerDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.clock = deps.clock;
    this.llmRunner = deps.llmRunner;
    this.staticRunner = deps.staticRunner;
    this.healthDeps = deps.health;
    this.deliverer = deps.deliverer;
    this.calendar = deps.calendar ?? null;
    this.emailAlert = deps.emailAlert ?? null;
    this.logger = deps.logger ?? createLogger('scheduler');
    this.owner = deps.owner ?? `pid-${String(process.pid)}`;
    this.unrefTimer = deps.unrefTimer ?? false;
  }

  /** The routines loaded by the most recent tick. */
  loadedRoutines(): Routine[] {
    return [...this.routines.values()];
  }

  /**
   * Start ticking.
   *
   * The first tick runs immediately; the periodic ticks are then aligned to the interval grid, so
   * with the default 60 s cadence every later tick lands on a minute boundary and a `0 7 * * *`
   * slot is seen within a second of 07:00.
   *
   * The timer is ref'd unless `unrefTimer` was set, because it is what keeps the service alive.
   */
  start(intervalMs: number = this.config.tickMs): void {
    this.stopped = false;
    void this.tick(this.clock.now());

    const elapsed = this.clock.now().getTime() % intervalMs;
    const delay = intervalMs - elapsed;
    this.alignTimer = setTimeout(() => {
      this.alignTimer = null;
      if (this.stopped) return;
      void this.tick(this.clock.now());
      this.timer = setInterval(() => {
        void this.tick(this.clock.now());
      }, intervalMs);
      if (this.unrefTimer) this.timer.unref?.();
    }, delay);
    if (this.unrefTimer) this.alignTimer.unref?.();
  }

  /** Stop ticking and wait for the jobs already running. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.alignTimer !== null) {
      clearTimeout(this.alignTimer);
      this.alignTimer = null;
    }
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.idle();
  }

  /**
   * Resolve once every job started by a tick has finished.
   *
   * `tick()` deliberately returns while jobs are still running (a 12-minute brief must not block
   * the next tick), so tests await this instead of relying on `tick()` to block.
   */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()]);
    }
  }

  /**
   * One scheduling pass.
   *
   * Reloads the routine files, enqueues what is due, polls the calendar triggers, then works the
   * spool. Overlapping ticks are ignored, so a slow tick never runs twice at once.
   */
  async tick(now: Date = this.clock.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.reload();
      this.enqueueDue(now);
      await this.pollCalendars(now);
      this.processSpool(now);
    } catch (err: unknown) {
      this.logger.error({ err: errText(err) }, 'tick failed');
    } finally {
      this.ticking = false;
    }
  }

  /** Reload the routine directory, logging (but not failing on) unparsable files. */
  private reload(): void {
    const dir = path.join(this.config.vaultDir, 'routines');
    const { routines, problems } = loadRoutines(dir, { defaultTimezone: this.config.timezone });
    this.routines = new Map(routines.map((r) => [r.name, r]));
    for (const problem of problems) {
      this.logger.warn({ file: problem.filePath, reason: problem.reason }, 'invalid routine file');
    }
  }

  /** Enqueue the cron and once slots that are due, recording any slot missed during an outage. */
  private enqueueDue(now: Date): void {
    for (const routine of this.routines.values()) {
      if (!routine.frontmatter.enabled) continue;
      // Event-driven routines use their cron only as a poll cadence.
      if (routine.frontmatter.trigger !== undefined) continue;

      const state = this.stateOf(routine.name);
      const due = dueSlot(routine, now, state);
      if (due === null) continue;

      if (due.missedSlot !== null) {
        recordSkipped(this.db, {
          name: routine.name,
          slot: due.missedSlot,
          trigger: routine.onceAt === undefined ? 'cron' : 'once',
          at: now,
        });
      }

      const trigger: Trigger = routine.onceAt === undefined ? 'cron' : 'once';
      const result = enqueue(this.db, {
        name: routine.name,
        slot: due.slot,
        trigger,
        stage: 'run',
        now,
      });
      setState(this.db, routine.name, { lastSlot: due.slot.getTime() });
      if (result.inserted) {
        this.logger.info({ routine: routine.name, slot: due.slot.toISOString() }, 'enqueued');
      }
    }
  }

  private stateOf(name: string): Date | null {
    const row = this.db.prepare('SELECT last_slot FROM routine_state WHERE name = ?').get(name) as
      { last_slot: number | null } | undefined;
    const last = row?.last_slot;
    return last === null || last === undefined ? null : new Date(last);
  }

  /** Poll calendar-triggered routines, no more often than `CALENDAR_POLL_MINUTES`. */
  private async pollCalendars(now: Date): Promise<void> {
    const calendar = this.calendar;
    if (calendar === null) return;
    const throttleMs = this.config.calendarPollMinutes * 60_000;
    if (now.getTime() - this.lastCalendarPollMs < throttleMs) return;

    const triggered = [...this.routines.values()].filter(
      (r) => r.frontmatter.trigger !== undefined && r.frontmatter.enabled,
    );
    if (triggered.length === 0) return;
    this.lastCalendarPollMs = now.getTime();

    for (const routine of triggered) {
      try {
        await pollCalendarTriggers(routine, calendar, this.db, now, {
          pollMinutes: this.config.calendarPollMinutes,
        });
      } catch (err: unknown) {
        this.logger.warn({ routine: routine.name, err: errText(err) }, 'calendar poll failed');
      }
    }
  }

  /**
   * Run the spool items that are due.
   *
   * LLM work is capped at `MAX_CONCURRENT_JOBS`; health and static routines are never blocked
   * behind it, so an alert still goes out while a long brief is running.
   *
   * Jobs are *started*, not awaited: each one is registered in `inFlight` and the tick returns
   * immediately. A twelve-minute brief therefore never blocks routine reload, cron enqueue or the
   * calendar poll. `stop()` and `idle()` are what wait for the work.
   */
  private processSpool(now: Date): void {
    const items = dueItems(this.db, now);

    for (const item of items) {
      if (this.stopped) break;
      if (this.inFlight.has(item.name)) continue;
      const routine = this.routines.get(item.name);
      if (routine === undefined) {
        this.logger.warn({ routine: item.name }, 'spool item has no routine file');
        markFailed(this.db, item.id, 'routine file missing', now);
        continue;
      }

      const isLlm = routine.frontmatter.kind === 'llm';
      if (isLlm && this.llmInFlight >= this.config.maxConcurrentJobs) continue;
      if (isLlm) this.llmInFlight += 1;

      const promise = this.executeItem(item)
        .catch((err: unknown) => {
          this.logger.error({ routine: item.name, err: errText(err) }, 'job crashed');
        })
        .finally(() => {
          if (isLlm) this.llmInFlight -= 1;
          this.inFlight.delete(item.name);
        });
      this.inFlight.set(item.name, promise);
    }
  }

  /**
   * Execute one spool item end to end.
   *
   * Order: claim the lease, open the run row, run the job, parse the STATUS marker, write the run
   * log, close the run row, deliver, mark delivered, delete a `once` file, release the lease,
   * remove the item. A delivery failure re-stages the item as `deliver` carrying the result text,
   * so the LLM is never re-run because of a delivery problem.
   */
  async executeItem(item: SpoolItem): Promise<void> {
    const routine = this.routines.get(item.name);
    if (routine === undefined) return;

    const now = this.clock.now();
    if (!claimLease(this.db, item.name, this.owner, this.config.leaseTtlMs, now)) {
      this.logger.debug({ routine: item.name }, 'lease held elsewhere');
      return;
    }

    try {
      if (item.stage === 'deliver') {
        await this.redeliver(routine, item);
        return;
      }
      if (this.recoverFinishedRun(routine, item, now)) return;
      if (routine.frontmatter.kind === 'health') {
        await this.executeHealth(routine, item, now);
        return;
      }
      await this.executeJob(routine, item, now);
    } finally {
      releaseLease(this.db, item.name, this.owner);
    }
  }

  /** The `deliver` stage: the job already succeeded, only the send has to be retried. */
  private async redeliver(routine: Routine, item: SpoolItem): Promise<void> {
    const text = item.payload ?? '';
    try {
      await this.deliverer.send(routine.frontmatter.deliver_to, text);
    } catch (err: unknown) {
      const outcome = markFailed(this.db, item.id, errText(err), this.clock.now());
      this.logger.warn(
        { routine: routine.name, dropped: outcome?.dropped === true },
        'delivery retry failed',
      );
      return;
    }
    const at = this.clock.now();
    const run = findRunBySlot(this.db, routine.name, new Date(item.slot), item.trigger);
    if (run !== null) markDelivered(this.db, run.id, at);
    this.afterDelivery(routine);
    remove(this.db, item.id);
  }

  /** A `kind: health` item: probe, alert only on state change, never call an LLM. */
  private async executeHealth(routine: Routine, item: SpoolItem, now: Date): Promise<void> {
    const runId = this.openRun(routine, item, now);
    const report: HealthReport = await runHealthCheck(this.healthDeps, now);
    const changes = diffHealth(this.db, report);
    const alert = changeAlertText(changes);
    const finished = this.clock.now();

    let logPath: string | undefined;
    if (!report.ok) {
      logPath = writeRunLog(this.config.vaultDir, {
        routine: routine.name,
        trigger: item.trigger,
        scheduledFor: new Date(item.slot),
        started: now,
        finished,
        status: 'done',
        model: 'none',
        attempts: item.attempts,
        body: report.checks
          .map((c) => `- ${c.name}: ${c.ok ? 'ok' : 'FAIL'} — ${c.detail}`)
          .join('\n'),
      });
    }

    const finishInput: Parameters<typeof finishRun>[2] = {
      status: 'done',
      finishedAt: finished,
      resultPreview: preview(
        report.checks.map((c) => `${c.name}=${c.ok ? 'ok' : 'fail'}`).join(' '),
      ),
    };
    if (logPath !== undefined) finishInput.logPath = logPath;
    finishRun(this.db, runId, finishInput);

    if (alert === '') {
      storeHealthStates(this.db, report, now);
      remove(this.db, item.id);
      return;
    }

    // The new state is stored only after the alert has gone out. Storing it first would mean one
    // failed send silences that failure for good.
    const whatsappDown = report.checks.some((c) => c.name === 'whatsapp' && !c.ok);
    const sent = await this.sendAlert(routine, alert, whatsappDown);
    if (sent) {
      storeHealthStates(this.db, report, now);
      markDelivered(this.db, runId, this.clock.now());
    } else {
      this.logger.warn({ routine: routine.name }, 'health alert not sent, state left unchanged');
    }
    remove(this.db, item.id);
  }

  /** An `llm` or `static` item. */
  private async executeJob(routine: Routine, item: SpoolItem, now: Date): Promise<void> {
    const runId = this.openRun(routine, item, now);
    const runner = routine.frontmatter.kind === 'static' ? this.staticRunner : this.llmRunner;
    const prompt = buildJobPrompt(routine, now, item.payload ?? undefined);

    const controller = new AbortController();
    const heartbeat = setInterval(
      () => {
        if (
          !heartbeatLease(
            this.db,
            routine.name,
            this.owner,
            this.config.leaseTtlMs,
            this.clock.now(),
          )
        ) {
          this.logger.warn({ routine: routine.name }, 'lease lost, aborting job');
          controller.abort();
        }
      },
      Math.max(1_000, Math.floor(this.config.leaseTtlMs / 3)),
    );
    heartbeat.unref?.();

    let result: JobResult;
    try {
      result = await runner.run(routine, prompt, controller.signal);
    } catch (err: unknown) {
      result = { isError: true, error: errText(err) };
    } finally {
      clearInterval(heartbeat);
    }

    const finished = this.clock.now();

    if (result.isError) {
      const logPath = writeRunLog(this.config.vaultDir, {
        routine: routine.name,
        trigger: item.trigger,
        scheduledFor: new Date(item.slot),
        started: now,
        finished,
        status: 'failed',
        model: routine.modelId,
        attempts: item.attempts + 1,
        error: result.error,
        body: `Run failed: ${result.error}`,
      });
      finishRun(this.db, runId, {
        status: 'failed',
        finishedAt: finished,
        logPath,
        error: result.error,
        attempts: item.attempts + 1,
      });
      const outcome = markFailed(this.db, item.id, result.error, finished);
      this.logger.warn(
        { routine: routine.name, error: result.error, dropped: outcome?.dropped === true },
        'run failed',
      );
      return;
    }

    const parsed = parseStatusMarker(result.text);
    const status = toRunStatus(parsed.status);
    const logPath = writeRunLog(this.config.vaultDir, {
      routine: routine.name,
      trigger: item.trigger,
      scheduledFor: new Date(item.slot),
      started: now,
      finished,
      status,
      model: routine.modelId,
      attempts: item.attempts + 1,
      costUsd: result.costUsd,
      body: parsed.text,
    });
    finishRun(this.db, runId, {
      status,
      finishedAt: finished,
      logPath,
      resultPreview: preview(parsed.text),
      costUsd: result.costUsd,
      attempts: item.attempts + 1,
    });

    try {
      await this.deliverer.send(routine.frontmatter.deliver_to, parsed.text);
    } catch (err: unknown) {
      toDeliverStage(this.db, item.id, parsed.text, this.clock.now());
      this.logger.warn({ routine: routine.name, err: errText(err) }, 'delivery failed, re-staged');
      return;
    }

    markDelivered(this.db, runId, this.clock.now());
    this.afterDelivery(routine);
    remove(this.db, item.id);
  }

  /**
   * Handle a `run` item whose run already finished, which only a crash can leave behind.
   *
   * The spool row survives a crash between `finishRun(done)` and `remove(item)`. Without this
   * check `openRun` would reopen the finished row and the whole (expensive, side-effecting) job
   * would run a second time.
   *
   * - already delivered: drop the spool item, nothing left to do.
   * - produced but not delivered: re-stage the item as `deliver`, carrying the text read back
   *   from the run log, so only the send is retried.
   *
   * @returns true when the item was dealt with and must not be run.
   */
  private recoverFinishedRun(routine: Routine, item: SpoolItem, now: Date): boolean {
    const existing = findRunBySlot(this.db, routine.name, new Date(item.slot), item.trigger);
    if (existing === null) return false;
    if (existing.status !== 'done' && existing.status !== 'needs_input') return false;

    if (existing.deliveredAt !== null) {
      remove(this.db, item.id);
      this.logger.info({ routine: routine.name }, 'run already delivered, spool item dropped');
      return true;
    }

    const body = existing.logPath === null ? null : readRunLogBody(existing.logPath);
    if (body === null) {
      this.logger.warn(
        { routine: routine.name },
        'finished run has no readable log, re-running the job',
      );
      return false;
    }

    toDeliverStage(this.db, item.id, body, now);
    this.logger.info(
      { routine: routine.name },
      'run finished but was never delivered, re-staged for delivery',
    );
    return true;
  }

  /** Open (or reopen) the run row for this slot, so a retry never duplicates it. */
  private openRun(routine: Routine, item: SpoolItem, now: Date): number {
    const existing = findRunBySlot(this.db, routine.name, new Date(item.slot), item.trigger);
    if (existing !== null) {
      reopenRun(this.db, existing.id, now, item.attempts);
      return existing.id;
    }
    return startRun(this.db, {
      name: routine.name,
      slot: new Date(item.slot),
      trigger: item.trigger,
      startedAt: now,
      attempts: item.attempts,
    });
  }

  /** A delivered one-shot routine deletes its own file. */
  private afterDelivery(routine: Routine): void {
    if (routine.onceAt === undefined) return;
    deleteRoutine(routine.filePath);
    this.routines.delete(routine.name);
    this.logger.info({ routine: routine.name }, 'once routine delivered, file removed');
  }

  /**
   * Send an alert, falling back to e-mail when WhatsApp itself is the failing probe.
   *
   * @returns true when the alert actually went out.
   */
  private async sendAlert(routine: Routine, text: string, whatsappDown: boolean): Promise<boolean> {
    if (whatsappDown && this.emailAlert !== null) {
      try {
        await this.emailAlert('cxw health alert', text);
        return true;
      } catch (err: unknown) {
        this.logger.error({ err: errText(err) }, 'e-mail alert failed');
        return false;
      }
    }
    try {
      await this.deliverer.send(routine.frontmatter.deliver_to, text);
      return true;
    } catch (err: unknown) {
      this.logger.error({ err: errText(err) }, 'health alert delivery failed');
      return false;
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
