import { describe, expect, it } from 'vitest';
import type { FetchImpl } from './cloudflare.js';
import {
  HETZNER_API_BASE,
  HetznerApiError,
  SERVER_IMAGE,
  SERVER_LOCATION,
  SERVER_TYPE,
  createHetznerClient,
} from './hetzner.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function client(replies: readonly { status?: number; payload: unknown }[]): {
  hz: ReturnType<typeof createHetznerClient>;
  calls: Call[];
} {
  const calls: Call[] = [];
  let n = 0;
  const fetchImpl: FetchImpl = async (url, init) => {
    const reply = replies[n];
    n += 1;
    if (reply === undefined) throw new Error(`unexpected request ${n} to ${url}`);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(reply.payload), {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { hz: createHetznerClient({ token: 'hz-token', fetchImpl }), calls };
}

const running = { id: 42, name: 'cxw', status: 'running' };

describe('createFirewall', () => {
  it('POSTs a firewall with a deliberately empty rules array', async () => {
    const { hz, calls } = client([{ payload: { firewall: { id: 7 } } }]);
    expect(await hz.createFirewall('cxw-fw')).toEqual({ firewallId: 7 });
    expect(calls[0]?.url).toBe(`${HETZNER_API_BASE}/firewalls`);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toEqual({ name: 'cxw-fw', rules: [] });
    expect(calls[0]?.headers['Authorization']).toBe('Bearer hz-token');
  });

  it('throws HetznerApiError with a token-free fallback', async () => {
    const { hz } = client([{ status: 403, payload: { error: { code: 'forbidden', message: 'no' } } }]);
    const error = await hz.createFirewall('cxw-fw').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HetznerApiError);
    const hzError = error as HetznerApiError;
    expect(hzError.status).toBe(403);
    expect(hzError.code).toBe('forbidden');
    expect(hzError.fallback).toContain('<YOUR_TOKEN>');
    expect(hzError.fallback).not.toContain('hz-token');
  });
});

describe('extraHeaders', () => {
  it('routes through a relative base with the Pages Function header', async () => {
    const calls: Call[] = [];
    const fetchImpl: FetchImpl = async (url, init) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: undefined,
      });
      return new Response(JSON.stringify({ server: running }), { status: 200 });
    };
    const hz = createHetznerClient({
      token: 'hz-token',
      fetchImpl,
      baseUrl: '/api/hetzner',
      extraHeaders: { 'X-CXW-HZ-Token': 'hz-token' },
    });
    await hz.getServer(42);
    expect(calls[0]?.url).toBe('/api/hetzner/servers/42');
    expect(calls[0]?.headers['X-CXW-HZ-Token']).toBe('hz-token');
  });
});

describe('createServer', () => {
  it('POSTs the fixed shape from the plan', async () => {
    const { hz, calls } = client([{ payload: { server: running } }]);
    const server = await hz.createServer({ name: 'cxw', userData: '#cloud-config\n', firewallId: 7 });
    expect(server).toEqual(running);
    expect(calls[0]?.body).toEqual({
      name: 'cxw',
      server_type: SERVER_TYPE,
      image: SERVER_IMAGE,
      location: SERVER_LOCATION,
      user_data: '#cloud-config\n',
      firewalls: [{ firewall: 7 }],
      public_net: { enable_ipv4: true, enable_ipv6: true },
    });
  });

  it('adds ssh_keys only when they were supplied', async () => {
    const { hz, calls } = client([{ payload: { server: running } }]);
    await hz.createServer({ name: 'cxw', userData: 'x', firewallId: 7, sshKeys: [1, 2] });
    expect(calls[0]?.body).toMatchObject({ ssh_keys: [1, 2] });
  });

  it('explains the manual path on failure', async () => {
    const { hz } = client([{ status: 400, payload: { error: { code: 'invalid_input', message: 'bad' } } }]);
    await expect(hz.createServer({ name: 'cxw', userData: 'x', firewallId: 7 })).rejects.toMatchObject({
      fallback: expect.stringContaining('User data'),
    });
  });
});

describe('waitForRunning', () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
  };

  it('polls until running and reports progress', async () => {
    sleeps.length = 0;
    const { hz, calls } = client([
      { payload: { server: { ...running, status: 'initializing' } } },
      { payload: { server: { ...running, status: 'starting' } } },
      { payload: { server: running } },
    ]);
    const seen: string[] = [];
    const server = await hz.waitForRunning(42, {
      pollMs: 100,
      timeoutMs: 10_000,
      sleep,
      onProgress: (s) => seen.push(s.status),
    });
    expect(server.status).toBe('running');
    expect(seen).toEqual(['initializing', 'starting', 'running']);
    expect(sleeps).toEqual([100, 100]);
    expect(calls).toHaveLength(3);
  });

  it('times out with a reassuring fallback instead of hanging', async () => {
    sleeps.length = 0;
    const { hz } = client(
      Array.from({ length: 5 }, () => ({ payload: { server: { ...running, status: 'initializing' } } })),
    );
    const error = await hz.waitForRunning(42, { pollMs: 100, timeoutMs: 200, sleep }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HetznerApiError);
    expect((error as HetznerApiError).code).toBe('timeout');
    expect((error as HetznerApiError).fallback).toContain('Nothing needs to be re-created');
  });
});

describe('getServer', () => {
  it('GETs /servers/{id}', async () => {
    const { hz, calls } = client([{ payload: { server: running } }]);
    expect(await hz.getServer(42)).toEqual(running);
    expect(calls[0]?.url).toBe(`${HETZNER_API_BASE}/servers/42`);
    expect(calls[0]?.method).toBe('GET');
  });

  it('surfaces a 404 with a fallback', async () => {
    const { hz } = client([{ status: 404, payload: { error: { code: 'not_found', message: 'gone' } } }]);
    await expect(hz.getServer(42)).rejects.toMatchObject({ code: 'not_found' });
  });
});
