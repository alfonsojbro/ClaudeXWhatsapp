/**
 * Environment for the Google MCP server. The names are shared with the brain
 * (Phase 2) and the deploy kit — do not rename them.
 */
import { z } from 'zod';
import { defaultConfirmDir } from '@cxw/shared';
import { DEFAULT_TOKEN_URL } from './scopes.js';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  ownerEmail: string;
  tokenUrl: string;
  confirmDir: string;
  tz: string;
}

const nonEmpty = z.string().trim().min(1);

const envSchema = z.object({
  GOOGLE_CLIENT_ID: nonEmpty,
  GOOGLE_CLIENT_SECRET: nonEmpty,
  GOOGLE_REFRESH_TOKEN: nonEmpty,
  GOOGLE_OWNER_EMAIL: nonEmpty.pipe(z.email()),
  GOOGLE_TOKEN_URL: z.string().trim().url().optional(),
});

/** Default timezone when neither `CXW_TZ` nor `TZ` is set. */
export const DEFAULT_TZ = 'Europe/Prague';

/** Read and validate the environment. Throws with every missing variable listed. */
export function loadGoogleConfig(env: NodeJS.ProcessEnv = process.env): GoogleConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(env)'}: ${issue.message}`)
      .sort();
    throw new Error(
      `mcp-google: bad environment.\n  ${problems.join('\n  ')}\n` +
        'Run `pnpm google:auth` on the Mac and copy google.env to the box (see docs/RUNBOOK.md §8).',
    );
  }
  const e = parsed.data;
  const tz = env['CXW_TZ']?.trim() ?? '';
  const sysTz = env['TZ']?.trim() ?? '';
  return {
    clientId: e.GOOGLE_CLIENT_ID,
    clientSecret: e.GOOGLE_CLIENT_SECRET,
    refreshToken: e.GOOGLE_REFRESH_TOKEN,
    ownerEmail: e.GOOGLE_OWNER_EMAIL,
    tokenUrl: e.GOOGLE_TOKEN_URL ?? DEFAULT_TOKEN_URL,
    confirmDir: defaultConfirmDir(env),
    tz: tz !== '' ? tz : sysTz !== '' ? sysTz : DEFAULT_TZ,
  };
}
