import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUDIENCE_PAGE_URL,
  buildAuthUrl,
  DEFAULT_TOKEN_URL,
  exchangeCode,
  newOauthState,
  renderGoogleEnv,
  SCOPES,
  stateMatches,
  writeGoogleEnv,
} from './google.js';

const REDIRECT = 'https://cxw.example.com/setup/google/callback';

function envPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'cxw-google-')), 'google.env');
}

function tokenFetch(
  body: unknown,
  status = 200,
): { impl: typeof fetch; last: () => { url: string; init: RequestInit } | null } {
  let last: { url: string; init: RequestInit } | null = null;
  const impl = ((url: string, init: RequestInit) => {
    last = { url: String(url), init };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { impl, last: () => last };
}

describe('buildAuthUrl', () => {
  it('carries every parameter the flow needs', () => {
    const url = new URL(buildAuthUrl({ clientId: 'cid.apps', redirectUri: REDIRECT, state: 'n1' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('cid.apps');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('n1');
  });

  it('asks for exactly phase 4 scopes, space separated', () => {
    const url = new URL(buildAuthUrl({ clientId: 'c', redirectUri: REDIRECT, state: 's' }));
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([...SCOPES]);
  });

  it('refuses a missing client id', () => {
    expect(() => buildAuthUrl({ clientId: '  ', redirectUri: REDIRECT, state: 's' })).toThrow(
      /client ID/,
    );
  });

  it('names a real audience page for the manual production check', () => {
    expect(AUDIENCE_PAGE_URL.startsWith('https://console.cloud.google.com/')).toBe(true);
  });
});

describe('stateMatches', () => {
  it('accepts the exact nonce', () => {
    const nonce = newOauthState();
    expect(stateMatches(nonce, nonce)).toBe(true);
  });

  it('rejects a mismatch, a missing stored nonce and a missing returned nonce', () => {
    expect(stateMatches(newOauthState(), newOauthState())).toBe(false);
    expect(stateMatches(undefined, 'abc')).toBe(false);
    expect(stateMatches('abc', undefined)).toBe(false);
    expect(stateMatches('', '')).toBe(false);
  });

  it('rejects a prefix of the stored nonce', () => {
    const nonce = newOauthState();
    expect(stateMatches(nonce, nonce.slice(0, -1))).toBe(false);
  });

  it('mints a distinct nonce each time', () => {
    expect(newOauthState()).not.toBe(newOauthState());
  });
});

describe('exchangeCode', () => {
  const input = {
    clientId: 'cid.apps',
    clientSecret: 'THE-CLIENT-SECRET',
    code: 'auth-code',
    redirectUri: REDIRECT,
  };

  it('posts form-encoded to the token endpoint and returns the refresh token', async () => {
    const fetcher = tokenFetch({ refresh_token: 'rt-1', access_token: 'at-1', scope: 'a b' });
    await expect(exchangeCode(input, fetcher.impl)).resolves.toEqual({
      refreshToken: 'rt-1',
      accessToken: 'at-1',
      scope: 'a b',
    });
    const call = fetcher.last();
    expect(call?.url).toBe(DEFAULT_TOKEN_URL);
    expect(call?.init.method).toBe('POST');
    const body = new URLSearchParams(String(call?.init.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('redirect_uri')).toBe(REDIRECT);
  });

  it('honours a GOOGLE_TOKEN_URL style override', async () => {
    const fetcher = tokenFetch({ refresh_token: 'rt' });
    await exchangeCode({ ...input, tokenUrl: 'https://stub.invalid/token' }, fetcher.impl);
    expect(fetcher.last()?.url).toBe('https://stub.invalid/token');
  });

  it('reports Google’s own error description', async () => {
    const fetcher = tokenFetch(
      { error: 'invalid_grant', error_description: 'Bad Request' },
      400,
    );
    await expect(exchangeCode(input, fetcher.impl)).rejects.toThrow(/Bad Request/);
  });

  it('reports a refusal with no description', async () => {
    await expect(exchangeCode(input, tokenFetch({}, 401).impl)).rejects.toThrow(/no reason given/);
  });

  it('explains the missing-refresh-token case', async () => {
    await expect(exchangeCode(input, tokenFetch({ access_token: 'at' }).impl)).rejects.toThrow(
      /no refresh token/,
    );
  });

  it('reports a network failure as something to retry', async () => {
    const impl = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    await expect(exchangeCode(input, impl)).rejects.toThrow(/did not answer/);
  });

  it('never puts the client secret into a thrown message', async () => {
    const fetcher = tokenFetch({ error_description: 'nope' }, 400);
    await expect(exchangeCode(input, fetcher.impl)).rejects.toThrow(
      expect.not.stringContaining('THE-CLIENT-SECRET') as unknown as string,
    );
  });
});

describe('renderGoogleEnv', () => {
  const values = {
    clientId: 'cid.apps',
    clientSecret: 'sec',
    refreshToken: 'rt',
    ownerEmail: 'alfonso@example.com',
  };

  it('writes exactly the four keys phase 4 reads', () => {
    const text = renderGoogleEnv(values, new Date('2026-09-03T00:00:00Z'));
    expect(text).toContain('GOOGLE_CLIENT_ID=cid.apps');
    expect(text).toContain('GOOGLE_CLIENT_SECRET=sec');
    expect(text).toContain('GOOGLE_REFRESH_TOKEN=rt');
    expect(text).toContain('GOOGLE_OWNER_EMAIL=alfonso@example.com');
    expect(text.split('\n').filter((line) => line.includes('=')).length).toBe(4);
  });

  it('writes the file at mode 0600, identically on a second run', () => {
    const path = envPath();
    const at = new Date('2026-09-03T00:00:00Z');
    writeGoogleEnv(path, values, at);
    const once = readFileSync(path, 'utf8');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    writeGoogleEnv(path, values, at);
    expect(readFileSync(path, 'utf8')).toBe(once);
  });
});
