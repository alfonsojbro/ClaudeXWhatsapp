import { describe, expect, it, vi } from 'vitest';
import { checkGoogleToken, tokenCheckHint } from './token-check.js';

const CFG = {
  clientId: 'client-id.apps.googleusercontent.com',
  clientSecret: 'client-secret-value',
  refreshToken: 'refresh-token-value',
  tokenUrl: 'https://oauth2.example/token',
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('checkGoogleToken', () => {
  it('is ok when Google returns an access token', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        access_token: 'ya29.super-secret',
        expires_in: 3599,
        scope:
          'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar',
      }),
    ) as unknown as typeof fetch;

    const result = await checkGoogleToken(CFG, fetchImpl);
    expect(result.ok).toBe(true);
    expect(result.expiresInSec).toBe(3599);
    expect(result.scopes).toEqual([
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/calendar',
    ]);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('refresh-token-value');
    expect(serialised).not.toContain('client-secret-value');
    expect(serialised).not.toContain('ya29.super-secret');
  });

  it('posts the refresh_token grant to the configured URL', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return jsonResponse(200, { access_token: 'a' });
    }) as unknown as typeof fetch;

    await checkGoogleToken(CFG, fetchImpl);
    const [url, init] = calls[0] ?? ['', undefined];
    expect(url).toBe(CFG.tokenUrl);
    expect(init?.method).toBe('POST');
    const body = String(init?.body ?? '');
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=refresh-token-value');
  });

  it('fails on invalid_grant without echoing the token', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, { error: 'invalid_grant', error_description: 'Token has been expired' }),
    ) as unknown as typeof fetch;

    const result = await checkGoogleToken(CFG, fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_grant: Token has been expired');
    expect(JSON.stringify(result)).not.toContain('refresh-token-value');
    expect(tokenCheckHint(result)).toContain('Production');
  });

  it('fails when the network throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND oauth2.example');
    }) as unknown as typeof fetch;

    const result = await checkGoogleToken(CFG, fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ENOTFOUND');
    expect(tokenCheckHint(result)).toContain('pnpm google:auth');
  });

  it('fails on a 200 without an access token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {})) as unknown as typeof fetch;
    const result = await checkGoogleToken(CFG, fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('HTTP 200');
  });

  it('has no hint when everything is fine', () => {
    expect(tokenCheckHint({ ok: true, checkedAt: '2026-09-04T09:00:00.000Z' })).toBe('');
  });
});
