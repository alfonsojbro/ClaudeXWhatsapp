/**
 * Smoke test of the real service entry point.
 *
 * This test runs `src/main.ts` — the file `pnpm --filter @cxw/scheduler start` runs under the
 * systemd unit — in a child process and proves three things the unit tests cannot: a routine that
 * is due at boot actually runs (so a tick that threw would fail the test rather than pass
 * silently), the process is still running well after more than two tick intervals, and SIGTERM
 * shuts it down cleanly. A tick timer that is `unref`'d makes the liveness assertion fail, because
 * the event loop drains and node exits within a second of starting.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEDULER_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(HERE, '../../..');
/**
 * The tsx ESM loader. The `start` script uses the `tsx` CLI, which forks a child of its own; the
 * loader runs `main.ts` in the process we spawn, so the exit code we observe is `main.ts`'s own.
 */
const TSX_LOADER = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');
const MAIN = path.join(SCHEDULER_ROOT, 'src', 'main.ts');

const TICK_MS = 300;
/** Transpiling and importing the whole service can be slow on a loaded machine. */
const BOOT_TIMEOUT_MS = 20_000;

let child: ChildProcess | null = null;
let tempDir: string | null = null;

afterEach(() => {
  if (child !== null && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
  child = null;
  if (tempDir !== null) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * The parent environment minus anything the test runner injected.
 *
 * `NODE_OPTIONS` in particular would load vitest's own loader into the child.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  for (const key of Object.keys(env)) {
    if (key.startsWith('VITEST')) delete env[key];
  }
  return env;
}

/** Rows of the `runs` table of the child's database, read from outside the process. */
function runRows(dbPath: string): { name: string; status: string }[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT name, status FROM runs').all() as { name: string; status: string }[];
  } finally {
    db.close();
  }
}

describe('service entry point', () => {
  it('runs a due routine, stays alive past two ticks and exits cleanly on SIGTERM', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxw-main-'));
    const dataDir = path.join(tempDir, 'data');
    const vaultDir = path.join(tempDir, 'vault');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(vaultDir, 'routines'), { recursive: true });
    // A `static` routine due every minute: the first tick must run it. No model is called and the
    // bridge is unreachable, so delivery fails and the item is re-staged, but the run row proves
    // the tick actually did its work.
    fs.writeFileSync(
      path.join(vaultDir, 'routines', 'smoke.md'),
      [
        '---',
        'name: smoke',
        "schedule: '* * * * *'",
        'timezone: Europe/Prague',
        'kind: static',
        'catch_up_minutes: 5',
        '---',
        '',
        'Smoke test reminder.',
        '',
      ].join('\n'),
      'utf8',
    );
    const dbPath = path.join(dataDir, 'scheduler.sqlite');

    let stdout = '';
    let stderr = '';
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child = spawn(process.execPath, ['--import', pathToFileURL(TSX_LOADER).href, MAIN], {
        cwd: SCHEDULER_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...childEnv(),
          CXW_DATA_DIR: dataDir,
          CXW_VAULT_DIR: vaultDir,
          CXW_WORKSPACE_DIR: path.join(tempDir, 'workspace'),
          SCHEDULER_DB: dbPath,
          SCHEDULER_TICK_MS: String(TICK_MS),
          LOG_LEVEL: 'info',
          BRIDGE_URL: 'http://127.0.0.1:1',
        },
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });

    const started = child as unknown as ChildProcess;

    // Wait for the service to announce itself, so the liveness window starts after boot.
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (!stdout.includes('scheduler starting') && Date.now() < deadline) {
      expect(started.exitCode, `exited during boot. stderr:\n${stderr}`).toBeNull();
      await wait(50);
    }
    expect(stdout, `service never logged "scheduler starting". stderr:\n${stderr}`).toContain(
      'scheduler starting',
    );

    // More than two tick intervals later it must still be running: the tick timer holds the event
    // loop open. With an unref'd timer node would already have exited.
    await wait(TICK_MS * 3);
    expect(started.exitCode, `process exited early. stderr:\n${stderr}`).toBeNull();
    expect(started.signalCode).toBeNull();

    // The due routine really ran. Without this the test would still pass if every tick threw
    // inside `tick()`'s catch.
    const runDeadline = Date.now() + BOOT_TIMEOUT_MS;
    let rows = runRows(dbPath);
    while (rows.length === 0 && Date.now() < runDeadline) {
      await wait(50);
      rows = runRows(dbPath);
    }
    expect(rows, `no run row was written. stdout:\n${stdout}\nstderr:\n${stderr}`).toEqual([
      { name: 'smoke', status: 'done' },
    ]);

    started.kill('SIGTERM');
    const result = await exit;
    expect(result.code, `unclean shutdown. stderr:\n${stderr}`).toBe(0);
  }, 40_000);
});
