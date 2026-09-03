import { describe, expect, it, vi } from 'vitest';
// The Pages Function lives outside src/ because Cloudflare Pages requires that layout;
// vitest only globs src/, so the test lives here and imports across.
import { __test__, onRequest } from '../functions/api/[[route]].js';

interface Recorded {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(reply: Response | Error): { calls: Recorded[]; restore: () => void } {
  const calls: Recorded[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (reply instanceof Error) throw reply;
    return reply.clone();
  }) as typeof fetch);
  return { calls, restore: () => spy.mockRestore() };
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('routing', () => {
  it('404s an unknown path', async () => {
    const response = await onRequest({ request: new Request('https://install.example.com/api/nope') });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'no such route' });
  });

  it('sets no cookie and never caches', async () => {
    const response = await onRequest({ request: new Request('https://install.example.com/api/nope') });
    expect(response.headers.get('set-cookie')).toBe(null);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('/api/cloudflare', () => {
  it('forwards to api.cloudflare.com with the header token as a bearer', async () => {
    const stub = stubFetch(jsonResponse({ success: true, result: [] }));
    try {
      const response = await onRequest({
        request: new Request('https://install.example.com/api/cloudflare/zones?name=example.com', {
          headers: { 'X-CXW-CF-Token': 'cf-token' },
        }),
      });
      expect(response.status).toBe(200);
      expect(stub.calls[0]?.url).toBe('https://api.cloudflare.com/client/v4/zones?name=example.com');
      const headers = stub.calls[0]?.init?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer cf-token');
    } finally {
      stub.restore();
    }
  });

  it('refuses when the token header is missing', async () => {
    const stub = stubFetch(jsonResponse({}));
    try {
      const response = await onRequest({
        request: new Request('https://install.example.com/api/cloudflare/zones'),
      });
      expect(response.status).toBe(401);
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
    }
  });

  it('refuses a suffix that climbs out of the API base', async () => {
    const stub = stubFetch(jsonResponse({}));
    try {
      const response = await __test__.forward(
        new Request('https://install.example.com/api/cloudflare/x', {
          headers: { 'X-CXW-CF-Token': 'cf-token' },
        }),
        __test__.CLOUDFLARE_API,
        'cf-token',
        '/../../../evil',
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'target path escapes the API base' });
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
    }
  });

  it('normalises a dot-dot request path to a route that does not exist', async () => {
    const stub = stubFetch(jsonResponse({}));
    try {
      const response = await onRequest({
        request: new Request('https://install.example.com/api/cloudflare/../../../evil', {
          headers: { 'X-CXW-CF-Token': 'cf-token' },
        }),
      });
      expect(response.status).toBe(404);
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
    }
  });

  it('passes a POST body through', async () => {
    const stub = stubFetch(jsonResponse({ success: true }));
    try {
      await onRequest({
        request: new Request('https://install.example.com/api/cloudflare/accounts/a/cfd_tunnel', {
          method: 'POST',
          headers: { 'X-CXW-CF-Token': 'cf-token' },
          body: JSON.stringify({ name: 'cxw' }),
        }),
      });
      expect(stub.calls[0]?.init?.body).toBe('{"name":"cxw"}');
      expect(stub.calls[0]?.init?.method).toBe('POST');
    } finally {
      stub.restore();
    }
  });
});

describe('/api/hetzner', () => {
  it('forwards to api.hetzner.cloud with its own header', async () => {
    const stub = stubFetch(jsonResponse({ servers: [] }));
    try {
      await onRequest({
        request: new Request('https://install.example.com/api/hetzner/servers/42', {
          headers: { 'X-CXW-HZ-Token': 'hz-token' },
        }),
      });
      expect(stub.calls[0]?.url).toBe('https://api.hetzner.cloud/v1/servers/42');
      const headers = stub.calls[0]?.init?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer hz-token');
    } finally {
      stub.restore();
    }
  });
});

describe('open-proxy rejection', () => {
  it('allows exactly two hosts', () => {
    expect([...__test__.ALLOWED_API_HOSTS].sort()).toEqual(['api.cloudflare.com', 'api.hetzner.cloud']);
  });

  it('refuses to forward to any other host', async () => {
    const stub = stubFetch(jsonResponse({}));
    try {
      const response = await __test__.forward(
        new Request('https://install.example.com/api/cloudflare/x', {
          headers: { 'X-CXW-CF-Token': 'cf-token' },
        }),
        'https://evil.example.com/v1',
        'cf-token',
        '/anything',
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'target host is not allowed' });
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
    }
  });

  it('refuses a plain-http target', async () => {
    const response = await __test__.forward(
      new Request('https://install.example.com/api/cloudflare/x'),
      'http://api.cloudflare.com/client/v4',
      'cf-token',
      '/zones',
    );
    expect(response.status).toBe(400);
  });
});

describe('/api/probe', () => {
  const probeRequest = (url: string): Request =>
    new Request('https://install.example.com/api/probe', { method: 'POST', body: JSON.stringify({ url }) });

  it('returns only status, location and a snippet', async () => {
    const stub = stubFetch(
      new Response('<html>Error 1033</html>', { status: 530, headers: { location: 'https://x/' } }),
    );
    try {
      const response = await onRequest({ request: probeRequest('https://cxw.example.com/setup/health') });
      expect(stub.calls[0]?.init?.redirect).toBe('manual');
      expect(await response.json()).toEqual({
        status: 530,
        location: 'https://x/',
        snippet: '<html>Error 1033</html>',
      });
    } finally {
      stub.restore();
    }
  });

  it('reports a connect failure as status 0, which classifies as pending', async () => {
    const stub = stubFetch(new Error('getaddrinfo ENOTFOUND'));
    try {
      const response = await onRequest({ request: probeRequest('https://cxw.example.com/setup/health') });
      expect(await response.json()).toEqual({ status: 0, location: '', snippet: '' });
    } finally {
      stub.restore();
    }
  });

  it('refuses anything that is not an https /setup URL', async () => {
    for (const url of ['http://cxw.example.com/setup', 'https://cxw.example.com/admin', 'not a url']) {
      const response = await onRequest({ request: probeRequest(url) });
      expect(response.status, url).toBe(400);
    }
  });

  it('refuses GET and a non-JSON body', async () => {
    const get = await onRequest({ request: new Request('https://install.example.com/api/probe') });
    expect(get.status).toBe(405);
    const bad = await onRequest({
      request: new Request('https://install.example.com/api/probe', { method: 'POST', body: 'nope' }),
    });
    expect(bad.status).toBe(400);
  });
});
