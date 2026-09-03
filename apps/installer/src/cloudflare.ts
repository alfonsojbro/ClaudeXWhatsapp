/**
 * Cloudflare API v4 client.
 *
 * Browser-safe: no `node:` imports. `fetchImpl` is injected everywhere so no test
 * ever reaches the network, and so the browser can route calls through its own
 * Pages Function (the Cloudflare API does not answer cross-origin browser requests).
 *
 * Every method carries a `fallback`: the exact curl command or dashboard path the
 * person can use by hand when their token is missing a permission.
 */

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface CloudflareError {
  readonly code: number;
  readonly message: string;
}

export class CloudflareApiError extends Error {
  readonly status: number;
  readonly errors: readonly CloudflareError[];
  /** What to do by hand instead. Never contains a real token. */
  readonly fallback: string;

  constructor(message: string, options: { status: number; errors: readonly CloudflareError[]; fallback: string }) {
    super(message);
    this.name = 'CloudflareApiError';
    this.status = options.status;
    this.errors = options.errors;
    this.fallback = options.fallback;
  }
}

interface Envelope<T> {
  readonly success?: boolean;
  readonly errors?: readonly CloudflareError[];
  readonly result?: T;
}

export interface CloudflareClientOptions {
  readonly token: string;
  readonly fetchImpl?: FetchImpl;
  /** Overridden by the browser so calls go through its own Pages Function. */
  readonly baseUrl?: string;
  /**
   * Extra request headers. The browser uses this to pass the token as the header the
   * Pages Function reads, since a browser cannot call the API directly.
   */
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

interface RequestOptions {
  readonly method: string;
  readonly path: string;
  readonly fallback: string;
  readonly body?: unknown;
}

export interface ZoneRef {
  readonly zoneId: string;
  readonly accountId: string;
}

export interface TunnelRef {
  readonly tunnelId: string;
  readonly tunnelToken: string;
}

export interface AccessAppRef {
  readonly appId: string;
  /** The Access audience tag the console checks on every request. */
  readonly aud: string;
}

export interface CloudflareClient {
  findZone(domain: string): Promise<ZoneRef>;
  createTunnel(accountId: string, name: string): Promise<TunnelRef>;
  putTunnelConfig(accountId: string, tunnelId: string, hostname: string, service: string): Promise<void>;
  upsertDnsRecord(zoneId: string, name: string, tunnelId: string): Promise<{ recordId: string }>;
  createAccessApp(accountId: string, hostname: string): Promise<AccessAppRef>;
  createAccessPolicy(accountId: string, appId: string, email: string): Promise<{ policyId: string }>;
  getAccessTeam(accountId: string): Promise<string>;
}

/** Cloudflare's "record already exists" code on POST /dns_records. */
const DNS_RECORD_EXISTS = 81053;
const TOKEN_PLACEHOLDER = '<YOUR_TOKEN>';

function curl(method: string, path: string, body?: unknown): string {
  const parts = [
    `curl -X ${method} '${CLOUDFLARE_API_BASE}${path}'`,
    `-H 'Authorization: Bearer ${TOKEN_PLACEHOLDER}'`,
    "-H 'Content-Type: application/json'",
  ];
  if (body !== undefined) parts.push(`--data '${JSON.stringify(body)}'`);
  return parts.join(' ');
}

export function createCloudflareClient(options: CloudflareClientOptions): CloudflareClient {
  const doFetch: FetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const baseUrl = options.baseUrl ?? CLOUDFLARE_API_BASE;

  async function request<T>(spec: RequestOptions): Promise<T> {
    const init: RequestInit = {
      method: spec.method,
      headers: {
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
        ...(options.extraHeaders ?? {}),
      },
      ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
    };

    const response = await doFetch(`${baseUrl}${spec.path}`, init);
    let envelope: Envelope<T> = {};
    try {
      envelope = (await response.json()) as Envelope<T>;
    } catch {
      envelope = {};
    }

    if (!response.ok || envelope.success !== true) {
      const errors = envelope.errors ?? [];
      const detail = errors.map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${response.status}`;
      throw new CloudflareApiError(`Cloudflare ${spec.method} ${spec.path} failed — ${detail}`, {
        status: response.status,
        errors,
        fallback: spec.fallback,
      });
    }
    return envelope.result as T;
  }

  /** Same as `request`, but returns the errors instead of throwing on a known code. */
  async function requestAllowing<T>(spec: RequestOptions, allowedCode: number): Promise<T | { allowed: true }> {
    try {
      return await request<T>(spec);
    } catch (error) {
      if (error instanceof CloudflareApiError && error.errors.some((e) => e.code === allowedCode)) {
        return { allowed: true };
      }
      throw error;
    }
  }

  return {
    async findZone(domain) {
      const path = `/zones?name=${encodeURIComponent(domain)}`;
      const result = await request<readonly { id: string; account: { id: string } }[]>({
        method: 'GET',
        path,
        fallback:
          `Read the zone id and account id from the domain's overview page in the Cloudflare dashboard, ` +
          `or run: ${curl('GET', path)}`,
      });
      const zone = result[0];
      if (zone === undefined) {
        throw new CloudflareApiError(`Cloudflare has no zone named ${domain}`, {
          status: 200,
          errors: [],
          fallback:
            `Add ${domain} to this Cloudflare account first (Dashboard → Add a site), then re-run this step. ` +
            `The API token must also be scoped to that zone.`,
        });
      }
      return { zoneId: zone.id, accountId: zone.account.id };
    },

    async createTunnel(accountId, name) {
      const path = `/accounts/${accountId}/cfd_tunnel`;
      const body = { name, config_src: 'cloudflare' };
      const result = await request<{ id: string; token: string }>({
        method: 'POST',
        path,
        body,
        fallback:
          `Dashboard → Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared, name it "${name}", ` +
          `and copy the tunnel token from the install command. Or run: ${curl('POST', path, body)}`,
      });
      return { tunnelId: result.id, tunnelToken: result.token };
    },

    async putTunnelConfig(accountId, tunnelId, hostname, service) {
      const path = `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`;
      const body = {
        config: { ingress: [{ hostname, service }, { service: 'http_status:404' }] },
      };
      await request<unknown>({
        method: 'PUT',
        path,
        body,
        fallback:
          `Dashboard → Zero Trust → Networks → Tunnels → this tunnel → Published application routes: ` +
          `add ${hostname} → ${service}, then a catch-all returning 404. Or run: ${curl('PUT', path, body)}`,
      });
    },

    async upsertDnsRecord(zoneId, name, tunnelId) {
      const content = `${tunnelId}.cfargotunnel.com`;
      const createPath = `/zones/${zoneId}/dns_records`;
      const body = { type: 'CNAME', name, content, proxied: true };
      const dashboardFallback =
        `Dashboard → ${name} → DNS → Records: a proxied CNAME from ${name} to ${content}. ` +
        `Or run: ${curl('POST', createPath, body)}`;

      const created = await requestAllowing<{ id: string }>(
        { method: 'POST', path: createPath, body, fallback: dashboardFallback },
        DNS_RECORD_EXISTS,
      );
      if ('id' in created) return { recordId: created.id };

      // The record is already there — from a previous run, or from an earlier setup.
      // Point it at this tunnel so a re-run converges instead of failing.
      const listPath = `${createPath}?type=CNAME&name=${encodeURIComponent(name)}`;
      const existing = await request<readonly { id: string }[]>({
        method: 'GET',
        path: listPath,
        fallback: dashboardFallback,
      });
      const record = existing[0];
      if (record === undefined) {
        throw new CloudflareApiError(`Cloudflare says ${name} exists but does not list it`, {
          status: 200,
          errors: [{ code: DNS_RECORD_EXISTS, message: 'record already exists' }],
          fallback: dashboardFallback,
        });
      }
      const updatePath = `${createPath}/${record.id}`;
      await request<unknown>({
        method: 'PUT',
        path: updatePath,
        body,
        fallback: `Edit the existing ${name} record to point at ${content}. Or run: ${curl('PUT', updatePath, body)}`,
      });
      return { recordId: record.id };
    },

    async createAccessApp(accountId, hostname) {
      const path = `/accounts/${accountId}/access/apps`;
      const body = {
        name: `ClaudeXWhatsapp console (${hostname})`,
        domain: hostname,
        type: 'self_hosted',
        session_duration: '24h',
      };
      const result = await request<{ id: string; aud: string }>({
        method: 'POST',
        path,
        body,
        fallback:
          `Dashboard → Zero Trust → Access → Applications → Add an application → Self-hosted, ` +
          `domain ${hostname}, session 24h. Copy its Application Audience (AUD) tag. ` +
          `Or run: ${curl('POST', path, body)}`,
      });
      return { appId: result.id, aud: result.aud };
    },

    async createAccessPolicy(accountId, appId, email) {
      const path = `/accounts/${accountId}/access/apps/${appId}/policies`;
      const body = { name: 'Owner', decision: 'allow', include: [{ email: { email } }] };
      const result = await request<{ id: string }>({
        method: 'POST',
        path,
        body,
        fallback:
          `Dashboard → Zero Trust → Access → Applications → this application → Policies → Add a policy: ` +
          `Allow, Include → Emails → ${email}. Or run: ${curl('POST', path, body)}`,
      });
      return { policyId: result.id };
    },

    async getAccessTeam(accountId) {
      const path = `/accounts/${accountId}/access/organizations`;
      const result = await request<{ auth_domain: string }>({
        method: 'GET',
        path,
        fallback:
          `Dashboard → Zero Trust → Settings → Custom Pages shows your team domain, ` +
          `for example acme.cloudflareaccess.com — the team name is the first label. ` +
          `Or run: ${curl('GET', path)}`,
      });
      const team = result.auth_domain.split('.')[0] ?? '';
      if (team === '') {
        throw new CloudflareApiError('Cloudflare returned an empty Access team domain', {
          status: 200,
          errors: [],
          fallback:
            `Zero Trust has not been set up on this account yet. Open Dashboard → Zero Trust once, ` +
            `choose a team name, then re-run this step.`,
        });
      }
      return team;
    },
  };
}
