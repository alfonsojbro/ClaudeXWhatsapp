/**
 * A very small Google REST client.
 *
 * The scheduler itself needs Google only for the health check, the calendar trigger poll and the
 * e-mail alert fallback. LLM routines reach Gmail and Calendar through the `google` MCP instead.
 *
 * Token values are never logged and never returned in error messages.
 */
import type { FetchLike } from './deliver.js';
import type { CalendarAttendee, CalendarEvent, CalendarSource } from './types.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

/** Every Google REST call is bounded, the way `deliver.ts` bounds the bridge calls. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Refresh-token credentials. */
export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** Construction options for {@link GoogleClient}. */
export interface GoogleClientOptions {
  credentials: GoogleCredentials;
  fetchImpl?: FetchLike;
  /** Injected so token caching is testable. */
  now?: () => Date;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

interface RawEvent {
  id?: string;
  summary?: string;
  location?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; self?: boolean }[];
}

function toDate(slot: { dateTime?: string; date?: string } | undefined): Date | null {
  const raw = slot?.dateTime ?? slot?.date;
  if (raw === undefined) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Base64url encoding for the Gmail raw message. */
function base64url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Minimal Google client: token refresh, calendar listing, e-mail send. */
export class GoogleClient implements CalendarSource {
  private readonly credentials: GoogleCredentials;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(options: GoogleClientOptions) {
    this.credentials = options.credentials;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? ((): Date => new Date());
  }

  /**
   * Exchange the refresh token for an access token, caching it until shortly before it expires.
   *
   * @throws {Error} when Google refuses; the message carries the status only, never a token.
   */
  async getAccessToken(): Promise<string> {
    const nowMs = this.now().getTime();
    if (this.token !== null && nowMs < this.tokenExpiresAt) return this.token;

    const body = new URLSearchParams({
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      refresh_token: this.credentials.refreshToken,
      grant_type: 'refresh_token',
    }).toString();

    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`google token refresh failed: ${String(res.status)}`);

    const parsed = (await res.json()) as TokenResponse;
    if (typeof parsed.access_token !== 'string' || parsed.access_token === '') {
      throw new Error('google token refresh returned no access_token');
    }
    const ttlSeconds = typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600;
    this.token = parsed.access_token;
    this.tokenExpiresAt = nowMs + Math.max(0, ttlSeconds - 60) * 1000;
    return this.token;
  }

  /** Events of the primary calendar that overlap `[from, to]`, single occurrences, in order. */
  async listEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    const token = await this.getAccessToken();
    const query = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '50',
      fields: 'items(id,summary,location,description,start,end,attendees(email,self))',
    }).toString();

    const res = await this.fetchImpl(`${CALENDAR_URL}?${query}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`google calendar list failed: ${String(res.status)}`);

    const body = (await res.json()) as { items?: RawEvent[] };
    const events: CalendarEvent[] = [];
    for (const item of body.items ?? []) {
      const start = toDate(item.start);
      const end = toDate(item.end);
      if (item.id === undefined || start === null || end === null) continue;
      const attendees: CalendarAttendee[] = (item.attendees ?? [])
        .filter((a): a is { email: string; self?: boolean } => typeof a.email === 'string')
        .map((a) => ({ email: a.email, self: a.self === true }));
      const event: CalendarEvent = {
        id: item.id,
        summary: item.summary ?? '(no title)',
        start,
        end,
        attendees,
      };
      if (item.location !== undefined) event.location = item.location;
      if (item.description !== undefined) event.description = item.description;
      events.push(event);
    }
    return events;
  }

  /** Send a plain-text e-mail as the authenticated user. */
  async sendEmail(to: string, subject: string, body: string): Promise<void> {
    const token = await this.getAccessToken();
    const mime = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      body,
    ].join('\r\n');

    const res = await this.fetchImpl(GMAIL_SEND_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ raw: base64url(mime) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`gmail send failed: ${String(res.status)}`);
  }
}

/** The three environment values a {@link GoogleClient} needs. */
export interface GoogleEnv {
  googleClientId?: string;
  googleClientSecret?: string;
  googleRefreshToken?: string;
}

/**
 * Build a {@link GoogleClient}, or `null` when the credentials are not all present.
 *
 * A `null` client means "Google is not configured", which the health check treats as ok.
 */
export function createGoogleClient(
  env: GoogleEnv,
  fetchImpl?: FetchLike,
  now?: () => Date,
): GoogleClient | null {
  const { googleClientId, googleClientSecret, googleRefreshToken } = env;
  if (
    googleClientId === undefined ||
    googleClientSecret === undefined ||
    googleRefreshToken === undefined
  ) {
    return null;
  }
  const options: GoogleClientOptions = {
    credentials: {
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      refreshToken: googleRefreshToken,
    },
  };
  if (fetchImpl !== undefined) options.fetchImpl = fetchImpl;
  if (now !== undefined) options.now = now;
  return new GoogleClient(options);
}
