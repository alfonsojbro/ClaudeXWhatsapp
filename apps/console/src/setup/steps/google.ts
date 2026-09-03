/**
 * Step 4: connect Gmail and Calendar.
 *
 * INTEGRATION IP-4: the scope list and the four `google.env` key names are phase 4's
 * (`mcp/google/src/scopes.ts`, `auth.ts`) and must stay identical, because phase 4's server
 * reads that file. The *flow* is genuinely different and is not a duplicate: phase 4 runs a
 * desktop flow on the Mac against an ephemeral loopback redirect, while the wizard runs on the
 * box behind Access and redirects to its own `https://<console>/setup/google/callback`.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { writeEnvFile } from '../envfile.js';

/** Exactly phase 4's scopes. A different set means a refresh token phase 4 cannot use. */
export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/contacts.readonly',
] as const;

export const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

/**
 * Where a person checks the publishing status. There is no API for it — see
 * `PRODUCTION_CHECK_IS_MANUAL` below.
 */
export const AUDIENCE_PAGE_URL = 'https://console.cloud.google.com/auth/audience';

/**
 * Why the production check is a checkbox and not a call.
 *
 * Google publishes no API that reports an OAuth consent screen's publishing status. It is not
 * in the OAuth2 metadata, not in `tokeninfo`, and the Cloud Resource Manager surfaces do not
 * carry it. Faking a check — probing a token's lifetime, scraping the console — would either be
 * wrong or would break the day Google changes a page. So the wizard is honest about it: it
 * links straight to the audience page, asks the person to read one word, and records what they
 * said. If they do not confirm, the done page carries a standing warning, because a refresh
 * token issued while the app is in Testing expires after seven days and the assistant will
 * simply stop reading mail one morning with no other explanation.
 *
 * This is not laziness. If Google ever ships such an API, replacing the checkbox is a small
 * change and this comment is the place to start.
 */
export const PRODUCTION_CHECK_IS_MANUAL = true;

/** How long a Testing-mode refresh token lasts. Quoted on the warning. */
export const TESTING_REFRESH_TOKEN_DAYS = 7;

export interface AuthUrlInput {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
}

/**
 * The consent URL.
 *
 * `access_type=offline` with `prompt=consent` is what makes Google return a *refresh* token,
 * and return it again on a re-run. Without `prompt=consent` a second authorisation of the same
 * client returns only an access token, so the step would silently stop being re-runnable.
 */
export function buildAuthUrl(input: AuthUrlInput): string {
  if (input.clientId.trim() === '') throw new Error('Enter the OAuth client ID.');
  if (input.redirectUri.trim() === '') throw new Error('The redirect URI is missing.');
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', input.clientId.trim());
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', input.state);
  return url.toString();
}

/** A fresh `state` nonce. Held in `setup.json` and compared on the callback. */
export function newOauthState(): string {
  return randomUUID();
}

/**
 * Compare the returned `state` against the stored one without leaking a timing signal, and
 * without ever treating "no state stored" as a match.
 */
export function stateMatches(expected: string | undefined, actual: string | undefined): boolean {
  if (typeof expected !== 'string' || expected === '') return false;
  if (typeof actual !== 'string' || actual === '') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface ExchangeInput {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly redirectUri: string;
  /** Overrides the endpoint, exactly as phase 4's `GOOGLE_TOKEN_URL` does. Tests use it. */
  readonly tokenUrl?: string;
}

export interface ExchangeResult {
  readonly refreshToken: string;
  readonly accessToken: string;
  readonly scope: string;
}

export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

/** Swap the authorisation code for a refresh token. */
export async function exchangeCode(
  input: ExchangeInput,
  fetchImpl: typeof fetch,
): Promise<ExchangeResult> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
    grant_type: 'authorization_code',
  });

  let response: Response;
  try {
    response = await fetchImpl(input.tokenUrl ?? DEFAULT_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GoogleAuthError('Google did not answer the token request. Try the step again.');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new GoogleAuthError(`Google answered with ${String(response.status)} and no JSON body.`);
  }

  if (!response.ok) {
    // Google's own `error_description` is the useful half and is safe to show: it describes the
    // request, not the secret. The secret is never in it, and is never logged here either.
    const description =
      typeof parsed['error_description'] === 'string'
        ? parsed['error_description']
        : typeof parsed['error'] === 'string'
          ? parsed['error']
          : 'no reason given';
    throw new GoogleAuthError(`Google refused the authorisation: ${description}`);
  }

  const refreshToken = parsed['refresh_token'];
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    throw new GoogleAuthError(
      'Google returned no refresh token. That happens when this Google account has already ' +
        'authorised this client: remove it at https://myaccount.google.com/permissions and run ' +
        'the step again.',
    );
  }
  return {
    refreshToken,
    accessToken: typeof parsed['access_token'] === 'string' ? parsed['access_token'] : '',
    scope: typeof parsed['scope'] === 'string' ? parsed['scope'] : '',
  };
}

export interface GoogleEnvValues {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly ownerEmail: string;
}

/** The contents of `google.env`. Same four keys phase 4 reads, in the same order. */
export function renderGoogleEnv(values: GoogleEnvValues, now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 10);
  return [
    `# Written by the ClaudeXWhatsapp setup wizard on ${stamp}. Mode 0600, never commit it.`,
    `GOOGLE_CLIENT_ID=${values.clientId}`,
    `GOOGLE_CLIENT_SECRET=${values.clientSecret}`,
    `GOOGLE_REFRESH_TOKEN=${values.refreshToken}`,
    `GOOGLE_OWNER_EMAIL=${values.ownerEmail}`,
    '',
  ].join('\n');
}

/** Write `google.env` at mode 0600. The whole file is rewritten: it has one author. */
export function writeGoogleEnv(path: string, values: GoogleEnvValues, now?: Date): void {
  writeEnvFile(path, renderGoogleEnv(values, now));
}
