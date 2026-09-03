/**
 * Test doubles for the scheduler.
 *
 * Every port is faked here so the integration tests need no network, no timers, no Anthropic or
 * Google credentials, and never spawn the Claude CLI.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import type { FetchLike, HttpResponse } from '../src/deliver.js';
import type { QueryFn } from '../src/runner/brain.js';
import type { HealthDeps } from '../src/runner/health.js';
import type {
  CalendarEvent,
  CalendarSource,
  Clock,
  Deliverer,
  JobResult,
  JobRunner,
  Routine,
} from '../src/types.js';

/** A clock the test moves by hand. */
export class FixedClock implements Clock {
  private current: Date;

  constructor(start: Date) {
    this.current = start;
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  /** Move the clock to an absolute instant. */
  set(at: Date): void {
    this.current = new Date(at.getTime());
  }

  /** Move the clock forward. */
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** One recorded call to {@link FakeRunner}. */
export interface RunnerCall {
  routine: string;
  prompt: string;
}

/** A promise plus the function that settles it. */
function deferred(): { promise: Promise<JobResult>; settle: (result: JobResult) => void } {
  const box: { resolve?: (result: JobResult) => void } = {};
  const promise = new Promise<JobResult>((resolve) => {
    box.resolve = resolve;
  });
  const resolve = box.resolve;
  if (resolve === undefined) throw new Error('promise executor did not run synchronously');
  return { promise, settle: resolve };
}

/** A job runner that records its calls and returns scripted results. */
export class FakeRunner implements JobRunner {
  readonly calls: RunnerCall[] = [];
  /** Results returned in order; the last one is reused once the queue runs dry. */
  private readonly queue: (JobResult | Promise<JobResult>)[] = [];
  private fallback: JobResult;

  constructor(text = 'default result\n\nSTATUS: done') {
    this.fallback = { isError: false, text, costUsd: 0.01, numTurns: 1, sessionId: 'fake' };
  }

  /** Queue one result for the next call. */
  push(result: JobResult): this {
    this.queue.push(result);
    return this;
  }

  /** Queue a successful result with this text. */
  pushText(text: string): this {
    return this.push({ isError: false, text, costUsd: 0.02, numTurns: 2, sessionId: 'fake' });
  }

  /** Queue a failure. */
  pushFailure(error: string): this {
    return this.push({ isError: true, error });
  }

  /**
   * Queue a job that hangs until the returned function is called.
   *
   * Used to prove that a long job never blocks the tick loop.
   *
   * @returns a function that finishes the hanging job with `result`.
   */
  pushPending(text = 'slow result\n\nSTATUS: done'): () => void {
    const { promise, settle } = deferred();
    this.queue.push(promise);
    return (): void => {
      settle({ isError: false, text, costUsd: 0.5, numTurns: 9, sessionId: 'fake-slow' });
    };
  }

  /** Change the result used once the queue is empty. */
  setDefault(result: JobResult): this {
    this.fallback = result;
    return this;
  }

  run(routine: Routine, prompt: string): Promise<JobResult> {
    this.calls.push({ routine: routine.name, prompt });
    const next = this.queue.shift();
    return Promise.resolve(next ?? this.fallback);
  }
}

/** One recorded delivery. */
export interface Delivery {
  to: string;
  text: string;
}

/** A deliverer that records its sends and can be told to fail. */
export class FakeDeliverer implements Deliverer {
  readonly sends: Delivery[] = [];
  /** Number of upcoming sends that should throw. */
  failures = 0;
  /** When true, every send throws. */
  alwaysFail = false;

  /** Make the next `count` sends fail. */
  failNext(count = 1): this {
    this.failures = count;
    return this;
  }

  send(to: string, text: string): Promise<void> {
    if (this.alwaysFail || this.failures > 0) {
      if (this.failures > 0) this.failures -= 1;
      return Promise.reject(new Error('bridge send failed: 502'));
    }
    this.sends.push({ to, text });
    return Promise.resolve();
  }
}

/** A calendar source returning a fixed list. */
export class FakeCalendar implements CalendarSource {
  readonly calls: { from: Date; to: Date }[] = [];

  constructor(private events: CalendarEvent[] = []) {}

  /** Replace the events this calendar returns. */
  setEvents(events: CalendarEvent[]): void {
    this.events = events;
  }

  listEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    this.calls.push({ from, to });
    return Promise.resolve(this.events);
  }
}

/** A scripted `query` for {@link import('../src/runner/brain.js').BrainJobRunner}. */
export interface FakeQuery {
  fn: QueryFn;
  calls: { prompt: string }[];
}

/**
 * Build a fake Agent SDK `query` that yields one result message.
 *
 * @param result the text of a successful run, or `{ error }` for a failing subtype.
 */
export function fakeQuery(result: string | { error: string }): FakeQuery {
  const calls: { prompt: string }[] = [];
  const fn: QueryFn = (params) => {
    calls.push({ prompt: params.prompt });
    async function* gen(): AsyncGenerator<never> {
      await Promise.resolve();
      if (typeof result === 'string') {
        yield {
          type: 'result',
          subtype: 'success',
          result,
          total_cost_usd: 0.03,
          num_turns: 3,
          session_id: 'fake-session',
          is_error: false,
        } as never;
      } else {
        yield { type: 'result', subtype: result.error, is_error: true } as never;
      }
    }
    return gen();
  };
  return { fn, calls };
}

/** A response the fake fetch should return for a URL substring. */
export interface FakeRoute {
  match: string;
  status?: number;
  body?: unknown;
}

/** One recorded HTTP call. */
export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A fetch double: matches routes by URL substring, records every call. */
export function fakeFetch(routes: FakeRoute[]): { fn: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body,
    });
    const route = routes.find((r) => url.includes(r.match));
    const status = route?.status ?? (route === undefined ? 404 : 200);
    const payload = route?.body ?? {};
    const res: HttpResponse = {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(payload),
      text: () => Promise.resolve(typeof payload === 'string' ? payload : JSON.stringify(payload)),
    };
    return Promise.resolve(res);
  };
  return { fn, calls };
}

/** Health dependencies that pass every probe, overridable per test. */
export function fakeHealthDeps(overrides: Partial<HealthDeps> = {}): HealthDeps {
  return {
    checkBridge: () => Promise.resolve(true),
    refreshGoogleToken: null,
    dataDir: '/tmp',
    diskLimitPct: 85,
    backupMaxAgeHours: 8,
    statfs: () => Promise.resolve({ blocks: 100, bfree: 50 }),
    ...overrides,
  };
}

/** A throwaway vault directory. */
export interface TempVault {
  dir: string;
  routinesDir: string;
  /** Write `routines/<name>.md` from raw frontmatter lines and a body. */
  writeRoutine(name: string, frontmatter: string, body: string): string;
  /** Every run-log file written for a routine. */
  runLogs(name: string): string[];
  /** True when the routine file still exists. */
  hasRoutine(name: string): boolean;
  cleanup(): void;
}

/** Create a temporary vault with a `routines/` directory. */
export function makeTempVault(): TempVault {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxw-vault-'));
  const routinesDir = path.join(dir, 'routines');
  fs.mkdirSync(routinesDir, { recursive: true });

  return {
    dir,
    routinesDir,
    writeRoutine(name, frontmatter, body): string {
      const filePath = path.join(routinesDir, `${name}.md`);
      const text = ['---', `name: ${name}`, frontmatter.trim(), '---', '', body.trim(), ''].join(
        '\n',
      );
      fs.writeFileSync(filePath, text, 'utf8');
      return filePath;
    },
    runLogs(name): string[] {
      const logDir = path.join(dir, 'runs', name);
      try {
        return fs.readdirSync(logDir).sort();
      } catch {
        return [];
      }
    },
    hasRoutine(name): boolean {
      return fs.existsSync(path.join(routinesDir, `${name}.md`));
    },
    cleanup(): void {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A config pointing at a temp vault, with everything else at its default. */
export function testConfig(vault: TempVault, overrides: Partial<Config> = {}): Config {
  const base = loadConfig({
    CXW_VAULT_DIR: vault.dir,
    CXW_DATA_DIR: vault.dir,
    CXW_WORKSPACE_DIR: path.join(vault.dir, 'workspace'),
    SCHEDULER_DB: ':memory:',
    CXW_TZ: 'Europe/Prague',
  });
  return { ...base, ...overrides };
}
