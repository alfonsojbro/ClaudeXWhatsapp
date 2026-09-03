import { describe, expect, it } from 'vitest';
import type { HealthProbe } from './health.js';
import { classifyHealthProbe, pollSetupHealth } from './health.js';

describe('classifyHealthProbe', () => {
  it('treats a failed connection as pending', () => {
    expect(classifyHealthProbe({ status: 0 })).toMatchObject({ state: 'pending', warning: false });
  });

  it('treats a Cloudflare 530 as pending', () => {
    expect(classifyHealthProbe({ status: 530 }).state).toBe('pending');
  });

  it('treats error 1033 in the body as pending, whatever the status', () => {
    expect(classifyHealthProbe({ status: 502, body: 'Error 1033: Argo Tunnel error' }).state).toBe('pending');
  });

  it('treats a redirect to the Access login as ready', () => {
    for (const status of [302, 303, 307]) {
      const verdict = classifyHealthProbe({
        status,
        location: 'https://acme.cloudflareaccess.com/cdn-cgi/access/login/cxw.example.com',
      });
      expect(verdict).toMatchObject({ state: 'ready', warning: false });
    }
  });

  it('rejects a redirect that is not an Access login', () => {
    expect(classifyHealthProbe({ status: 302, location: 'https://evil.example.com/' }).state).toBe('error');
    expect(classifyHealthProbe({ status: 302, location: 'https://notcloudflareaccess.com/' }).state).toBe('error');
    expect(classifyHealthProbe({ status: 302, location: 'not-a-url' }).state).toBe('error');
    expect(classifyHealthProbe({ status: 302 }).state).toBe('error');
  });

  it('treats a 200 as ready but flags that Access is not enforcing', () => {
    const verdict = classifyHealthProbe({ status: 200, body: '{"ok":true}' });
    expect(verdict.state).toBe('ready');
    expect(verdict.warning).toBe(true);
    expect(verdict.reason).toContain('NOT enforcing');
  });

  it('treats anything else as an error naming the status', () => {
    expect(classifyHealthProbe({ status: 500 })).toMatchObject({ state: 'error', warning: false });
    expect(classifyHealthProbe({ status: 404 }).reason).toContain('404');
  });
});

describe('pollSetupHealth', () => {
  const sleep = async (): Promise<void> => {};

  it('stops at the first non-pending verdict', async () => {
    const answers: HealthProbe[] = [
      { status: 0 },
      { status: 530 },
      { status: 302, location: 'https://acme.cloudflareaccess.com/x' },
      { status: 500 },
    ];
    let n = 0;
    const seen: number[] = [];
    const verdict = await pollSetupHealth(
      async () => answers[n++] as HealthProbe,
      { attempts: 10, sleep, onProgress: (_v, attempt) => seen.push(attempt) },
    );
    expect(verdict.state).toBe('ready');
    expect(seen).toEqual([1, 2, 3]);
    expect(n).toBe(3);
  });

  it('returns the last pending verdict when it runs out of attempts', async () => {
    let n = 0;
    const verdict = await pollSetupHealth(
      async () => {
        n += 1;
        return { status: 530 };
      },
      { attempts: 3, sleep },
    );
    expect(n).toBe(3);
    expect(verdict.state).toBe('pending');
  });
});
