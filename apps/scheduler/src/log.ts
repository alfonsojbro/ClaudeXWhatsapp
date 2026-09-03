/**
 * Logger factory.
 *
 * Privacy rule for this service: never log message bodies, routine prompt text, or delivered
 * result text at `info` or above. Sizes, counts, names and statuses only.
 */
import { pino } from 'pino';
import type { Logger, LoggerOptions } from 'pino';

export type { Logger };

/** Levels pino accepts, plus `silent`. Anything else is a typo, not a level. */
const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);

const DEFAULT_LEVEL = 'info';

/**
 * Create a pino logger.
 *
 * Level comes from `LOG_LEVEL`, defaulting to `info`. An unknown value falls back to `info` with a
 * warning rather than throwing: a typo in the env file must not stop the service from booting.
 */
export function createLogger(
  name = 'scheduler',
  env: Record<string, string | undefined> = process.env,
): Logger {
  const raw = env.LOG_LEVEL?.trim().toLowerCase() ?? '';
  const valid = raw === '' || LEVELS.has(raw);
  const level = valid && raw !== '' ? raw : DEFAULT_LEVEL;
  const options: LoggerOptions = { name, level };
  const logger = pino(options);
  if (!valid) {
    logger.warn({ logLevel: raw, using: DEFAULT_LEVEL }, 'unknown LOG_LEVEL, falling back');
  }
  return logger;
}

/** Process-wide default logger. */
export const log: Logger = createLogger();
