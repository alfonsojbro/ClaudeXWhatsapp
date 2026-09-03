import { describe, expect, it } from 'vitest';
import { CLOUDFLARE_API_BASE, CloudflareApiError, createCloudflareClient } from './cloudflare.js';
import type { FetchImpl } from './cloudflare.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function recorder(replies: readonly { status?: number; payload: unknown }[]): {
  fetchImpl: FetchImpl;
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
  return { fetchImpl, calls };
}

const ok = (result: unknown): { payload: unknown } => ({ payload: { success: true, errors: [], result } });
const fail = (code: number, message: string, status = 400): { status: number; payload: unknown } => ({
  status,
  payload: { success: false, errors: [{ code, message }], result: null },
});

function client(replies: readonly { status?: number; payload: unknown }[]): {
  cf: ReturnType<typeof createCloudflareClient>;
  calls: Call[];
} {
  const { fetchImpl, calls } = recorder(replies);
  return { cf: createCloudflareClient({ token: 'cf-token', fetchImpl }), calls };
}

describe('findZone', () => {
  it('GETs /zones?name= and returns the zone and account ids', async () => {
    const { cf, calls } = client([ok([{ id: 'zone1', account: { id: 'acct1' } }])]);
    expect(await cf.findZone('example.com')).toEqual({ zoneId: 'zone1', accountId: 'acct1' });
    expect(calls[0]?.url).toBe(`${CLOUDFLARE_API_BASE}/zones?name=example.com`);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers['Authorization']).toBe('Bearer cf-token');
  });

  it('throws with a fallback when the zone is missing', async () => {
    const { cf } = client([ok([])]);
    const error = await cf.findZone('nope.test').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect((error as CloudflareApiError).fallback).toContain('Add a site');
  });

  it('throws CloudflareApiError carrying status, errors and a token-free fallback', async () => {
    const { cf } = client([fail(9109, 'Unauthorized to access requested resource', 403)]);
    const error = await cf.findZone('example.com').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareApiError);
    const cfError = error as CloudflareApiError;
    expect(cfError.status).toBe(403);
    expect(cfError.errors[0]?.code).toBe(9109);
    expect(cfError.fallback).toContain('<YOUR_TOKEN>');
    expect(cfError.fallback).not.toContain('cf-token');
  });
});

describe('extraHeaders', () => {
  it('adds the header the Pages Function reads, without dropping the others', async () => {
    const { fetchImpl, calls } = recorder([ok([{ id: 'z', account: { id: 'a' } }])]);
    const cf = createCloudflareClient({
      token: 'cf-token',
      fetchImpl,
      baseUrl: '/api/cloudflare',
      extraHeaders: { 'X-CXW-CF-Token': 'cf-token' },
    });
    await cf.findZone('example.com');
    expect(calls[0]?.url).toBe('/api/cloudflare/zones?name=example.com');
    expect(calls[0]?.headers['X-CXW-CF-Token']).toBe('cf-token');
    expect(calls[0]?.headers['Content-Type']).toBe('application/json');
  });
});

describe('createTunnel', () => {
  it('POSTs config_src cloudflare and returns id and token', async () => {
    const { cf, calls } = client([ok({ id: 'tun1', token: 'tunnel-token' })]);
    expect(await cf.createTunnel('acct1', 'cxw')).toEqual({ tunnelId: 'tun1', tunnelToken: 'tunnel-token' });
    expect(calls[0]?.url).toBe(`${CLOUDFLARE_API_BASE}/accounts/acct1/cfd_tunnel`);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toEqual({ name: 'cxw', config_src: 'cloudflare' });
  });

  it('surfaces an error with a dashboard fallback', async () => {
    const { cf } = client([fail(1000, 'no permission')]);
    await expect(cf.createTunnel('acct1', 'cxw')).rejects.toMatchObject({
      fallback: expect.stringContaining('Zero Trust'),
    });
  });
});

describe('putTunnelConfig', () => {
  it('PUTs an ingress list ending in a 404 catch-all', async () => {
    const { cf, calls } = client([ok({})]);
    await cf.putTunnelConfig('acct1', 'tun1', 'cxw.example.com', 'http://127.0.0.1:7803');
    expect(calls[0]?.url).toBe(`${CLOUDFLARE_API_BASE}/accounts/acct1/cfd_tunnel/tun1/configurations`);
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.body).toEqual({
      config: {
        ingress: [
          { hostname: 'cxw.example.com', service: 'http://127.0.0.1:7803' },
          { service: 'http_status:404' },
        ],
      },
    });
  });

  it('surfaces an error with a fallback', async () => {
    const { cf } = client([fail(1002, 'bad config')]);
    await expect(cf.putTunnelConfig('a', 't', 'h', 's')).rejects.toMatchObject({
      fallback: expect.stringContaining('Published application routes'),
    });
  });
});

describe('upsertDnsRecord', () => {
  it('POSTs a proxied CNAME to <tunnelId>.cfargotunnel.com', async () => {
    const { cf, calls } = client([ok({ id: 'rec1' })]);
    expect(await cf.upsertDnsRecord('zone1', 'cxw.example.com', 'tun1')).toEqual({ recordId: 'rec1' });
    expect(calls[0]?.body).toEqual({
      type: 'CNAME',
      name: 'cxw.example.com',
      content: 'tun1.cfargotunnel.com',
      proxied: true,
    });
  });

  it('falls back to GET then PUT when the record already exists (81053)', async () => {
    const { cf, calls } = client([fail(81053, 'Record already exists.'), ok([{ id: 'rec9' }]), ok({ id: 'rec9' })]);
    expect(await cf.upsertDnsRecord('zone1', 'cxw.example.com', 'tun2')).toEqual({ recordId: 'rec9' });
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'PUT']);
    expect(calls[2]?.url).toBe(`${CLOUDFLARE_API_BASE}/zones/zone1/dns_records/rec9`);
    expect(calls[2]?.body).toMatchObject({ content: 'tun2.cfargotunnel.com', proxied: true });
  });

  it('re-runs cleanly: a second identical run converges on the same record', async () => {
    const { cf } = client([
      fail(81053, 'Record already exists.'),
      ok([{ id: 'rec9' }]),
      ok({ id: 'rec9' }),
      fail(81053, 'Record already exists.'),
      ok([{ id: 'rec9' }]),
      ok({ id: 'rec9' }),
    ]);
    expect(await cf.upsertDnsRecord('zone1', 'cxw.example.com', 'tun2')).toEqual({ recordId: 'rec9' });
    expect(await cf.upsertDnsRecord('zone1', 'cxw.example.com', 'tun2')).toEqual({ recordId: 'rec9' });
  });

  it('does not swallow an unrelated error', async () => {
    const { cf } = client([fail(9109, 'Unauthorized', 403)]);
    await expect(cf.upsertDnsRecord('zone1', 'cxw.example.com', 'tun1')).rejects.toMatchObject({ status: 403 });
  });
});

describe('createAccessApp', () => {
  it('POSTs a self-hosted app and returns the audience tag', async () => {
    const { cf, calls } = client([ok({ id: 'app1', aud: 'aud-tag' })]);
    expect(await cf.createAccessApp('acct1', 'cxw.example.com')).toEqual({ appId: 'app1', aud: 'aud-tag' });
    expect(calls[0]?.url).toBe(`${CLOUDFLARE_API_BASE}/accounts/acct1/access/apps`);
    expect(calls[0]?.body).toMatchObject({
      domain: 'cxw.example.com',
      type: 'self_hosted',
      session_duration: '24h',
    });
  });

  it('surfaces an error with a fallback', async () => {
    const { cf } = client([fail(1001, 'nope')]);
    await expect(cf.createAccessApp('a', 'h')).rejects.toMatchObject({
      fallback: expect.stringContaining('Application Audience'),
    });
  });
});

describe('createAccessPolicy', () => {
  it('POSTs a single allow-by-email policy', async () => {
    const { cf, calls } = client([ok({ id: 'pol1' })]);
    expect(await cf.createAccessPolicy('acct1', 'app1', 'me@example.com')).toEqual({ policyId: 'pol1' });
    expect(calls[0]?.url).toBe(`${CLOUDFLARE_API_BASE}/accounts/acct1/access/apps/app1/policies`);
    expect(calls[0]?.body).toEqual({
      name: 'Owner',
      decision: 'allow',
      include: [{ email: { email: 'me@example.com' } }],
    });
  });

  it('surfaces an error with a fallback naming the email', async () => {
    const { cf } = client([fail(1003, 'nope')]);
    await expect(cf.createAccessPolicy('a', 'b', 'me@example.com')).rejects.toMatchObject({
      fallback: expect.stringContaining('me@example.com'),
    });
  });
});

describe('getAccessTeam', () => {
  it('returns the first label of the auth domain', async () => {
    const { cf, calls } = client([ok({ auth_domain: 'acme.cloudflareaccess.com' })]);
    expect(await cf.getAccessTeam('acct1')).toBe('acme');
    expect(calls[0]?.url).toBe(`${CLOUDFLARE_API_BASE}/accounts/acct1/access/organizations`);
  });

  it('explains itself when Zero Trust has never been set up', async () => {
    const { cf } = client([ok({ auth_domain: '' })]);
    await expect(cf.getAccessTeam('acct1')).rejects.toMatchObject({
      fallback: expect.stringContaining('Zero Trust has not been set up'),
    });
  });

  it('surfaces an API error with a fallback', async () => {
    const { cf } = client([fail(1004, 'nope')]);
    await expect(cf.getAccessTeam('acct1')).rejects.toMatchObject({
      fallback: expect.stringContaining('team domain'),
    });
  });
});
