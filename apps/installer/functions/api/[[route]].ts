/**
 * The installer's only server-side code: a stateless forwarder on the person's own
 * Cloudflare Pages project.
 *
 * It exists because neither api.cloudflare.com nor api.hetzner.cloud answers a
 * cross-origin browser request. It takes the token from a request header, forwards
 * exactly one request, and returns the response.
 *
 * It declares no KV, D1, R2, Durable Object or cache binding, reads no `env`, sets no
 * cookie, and logs nothing. The context type below is deliberately minimal so that
 * staying stateless is a compile-time property, not a promise.
 */

interface PagesContext {
  readonly request: Request;
}

type Handler = (context: PagesContext) => Promise<Response>;

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const HETZNER_API = 'https://api.hetzner.cloud/v1';

/** The only two hosts this function will ever talk to on a forward. */
const ALLOWED_API_HOSTS: readonly string[] = ['api.cloudflare.com', 'api.hetzner.cloud'];

const CF_TOKEN_HEADER = 'X-CXW-CF-Token';
const HZ_TOKEN_HEADER = 'X-CXW-HZ-Token';

const JSON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** Never echoes the caller's input; the message is a constant. */
function refuse(message: string, status = 400): Response {
  return json({ error: message }, status);
}

async function forward(request: Request, base: string, token: string | null, suffix: string): Promise<Response> {
  if (token === null || token === '') return refuse('missing API token header', 401);

  let target: URL;
  try {
    target = new URL(base + suffix);
  } catch {
    return refuse('bad target path');
  }
  if (target.protocol !== 'https:' || !ALLOWED_API_HOSTS.includes(target.hostname)) {
    return refuse('target host is not allowed');
  }
  if (!target.pathname.startsWith(new URL(base).pathname)) return refuse('target path escapes the API base');

  const upstream = await fetch(target.toString(), {
    method: request.method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: await request.text() }),
  });

  // Pass the body through untouched; strip every upstream header but the content type.
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: JSON_HEADERS,
  });
}

/**
 * A single redirect-following-free GET, reduced to the three fields
 * `classifyHealthProbe` needs. Not a general proxy: no body, no headers, 255 bytes.
 */
async function probe(request: Request): Promise<Response> {
  if (request.method !== 'POST') return refuse('probe takes POST', 405);

  let url = '';
  try {
    const body = (await request.json()) as { url?: unknown };
    if (typeof body.url === 'string') url = body.url;
  } catch {
    return refuse('probe body must be JSON');
  }

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return refuse('probe url is not a URL');
  }
  if (target.protocol !== 'https:') return refuse('probe url must be https');
  if (!target.pathname.startsWith('/setup')) return refuse('probe url must be a /setup path');

  try {
    const response = await fetch(target.toString(), { method: 'GET', redirect: 'manual' });
    const text = await response.text();
    return json({
      status: response.status,
      location: response.headers.get('location') ?? '',
      snippet: text.slice(0, 255),
    });
  } catch {
    // A connect/DNS/TLS failure is the expected state while the tunnel comes up.
    return json({ status: 0, location: '', snippet: '' });
  }
}

export const onRequest: Handler = async (context) => {
  const { request } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/probe') return probe(request);

  if (path.startsWith('/api/cloudflare/')) {
    return forward(request, CLOUDFLARE_API, request.headers.get(CF_TOKEN_HEADER), path.slice('/api/cloudflare'.length) + url.search);
  }
  if (path.startsWith('/api/hetzner/')) {
    return forward(request, HETZNER_API, request.headers.get(HZ_TOKEN_HEADER), path.slice('/api/hetzner'.length) + url.search);
  }

  return refuse('no such route', 404);
};

export const __test__ = { forward, probe, onRequest, ALLOWED_API_HOSTS, CLOUDFLARE_API, HETZNER_API };
