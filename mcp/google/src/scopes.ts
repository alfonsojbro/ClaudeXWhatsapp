/**
 * Exactly the OAuth scopes this server needs. Adding a tool that needs more
 * means re-running `pnpm google:auth` (the refresh token is scope-bound).
 */
export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/contacts.readonly',
] as const;

export type Scope = (typeof SCOPES)[number];

/** Default Google token endpoint; overridable with `GOOGLE_TOKEN_URL` for stubs. */
export const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
