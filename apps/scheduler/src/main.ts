/**
 * Service entry point for `cxw-scheduler`.
 *
 * Importing this module has no side effects; the process only starts when the file is run
 * directly (the systemd unit runs `pnpm --filter @cxw/scheduler start`).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import type { Config } from './config.js';
import { openDb } from './db.js';
import { BridgeDeliverer, isBridgeConnected } from './deliver.js';
import { createGoogleClient } from './google.js';
import { createLogger } from './log.js';
import { loadRoutines } from './routine.js';
import { BrainJobRunner } from './runner/brain.js';
import type { HealthDeps } from './runner/health.js';
import { StaticRunner } from './runner/static.js';
import { markStaleRunning } from './runs.js';
import { Scheduler, SystemClock } from './scheduler.js';
import type { EmailAlert, SchedulerDeps } from './scheduler.js';

/** True when at least one enabled routine needs an LLM. */
export function needsAnthropicCredentials(vaultDir: string, timezone: string): boolean {
  const { routines } = loadRoutines(path.join(vaultDir, 'routines'), {
    defaultTimezone: timezone,
  });
  return routines.some((r) => r.frontmatter.enabled && r.frontmatter.kind === 'llm');
}

/** Assemble every port and return a started-but-not-ticking scheduler. */
export function buildScheduler(config: Config): { scheduler: Scheduler; close: () => void } {
  const logger = createLogger('scheduler');
  const db = openDb(config.dbPath);
  const clock = new SystemClock();

  const swept = markStaleRunning(db, clock.now());
  if (swept > 0) logger.warn({ runs: swept }, 'failed stale running rows after restart');

  const delivererOptions: ConstructorParameters<typeof BridgeDeliverer>[0] = {
    bridgeUrl: config.bridgeUrl,
  };
  if (config.bridgeToken !== undefined) delivererOptions.token = config.bridgeToken;
  const deliverer = new BridgeDeliverer(delivererOptions);

  const google = createGoogleClient(config);

  const health: HealthDeps = {
    checkBridge: () => isBridgeConnected(config.bridgeUrl, config.bridgeToken),
    refreshGoogleToken:
      google === null
        ? null
        : async (): Promise<void> => {
            await google.getAccessToken();
          },
    dataDir: config.dataDir,
    diskLimitPct: config.diskLimitPct,
    backupMaxAgeHours: config.backupMaxAgeHours,
  };
  if (config.backupStampFile !== undefined) health.backupStampFile = config.backupStampFile;

  const emailAlert: EmailAlert | null =
    google !== null && config.alertEmailTo !== undefined
      ? (subject, body): Promise<void> =>
          google.sendEmail(String(config.alertEmailTo), subject, body)
      : null;

  const deps: SchedulerDeps = {
    db,
    config,
    clock,
    llmRunner: new BrainJobRunner({
      workspaceDir: config.workspaceDir,
      jobTimeoutMs: config.jobTimeoutMs,
    }),
    staticRunner: new StaticRunner(),
    health,
    deliverer,
    calendar: google,
    emailAlert,
    logger,
  };

  return {
    scheduler: new Scheduler(deps),
    close: (): void => {
      db.close();
    },
  };
}

/** Start the service and resolve when it has shut down. */
export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger('scheduler');

  const hasCredentials =
    config.anthropicApiKey !== undefined || config.claudeCodeOauthToken !== undefined;
  if (!hasCredentials && needsAnthropicCredentials(config.vaultDir, config.timezone)) {
    logger.error(
      'no ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, and at least one enabled routine is kind: llm',
    );
    throw new Error('missing Anthropic credentials');
  }

  const { scheduler, close } = buildScheduler(config);
  logger.info(
    { tickMs: config.tickMs, vaultDir: config.vaultDir, db: config.dbPath },
    'scheduler starting',
  );
  scheduler.start(config.tickMs);

  await new Promise<void>((resolve) => {
    const stop = (signal: string): void => {
      logger.info({ signal }, 'scheduler stopping');
      void scheduler.stop().then(() => {
        close();
        resolve();
      });
    };
    process.once('SIGTERM', () => {
      stop('SIGTERM');
    });
    process.once('SIGINT', () => {
      stop('SIGINT');
    });
  });
}

// `import.meta.url` is percent-encoded; `pathToFileURL` encodes the argv path the same way, so
// this still matches on a checkout whose path contains a space.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
