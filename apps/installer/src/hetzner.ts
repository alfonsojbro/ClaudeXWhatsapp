/**
 * Hetzner Cloud API v1 client.
 *
 * Browser-safe: no `node:` imports. `fetchImpl` and `sleep` are injected so no test
 * reaches the network or spends real time.
 */

import type { FetchImpl } from './cloudflare.js';

export const HETZNER_API_BASE = 'https://api.hetzner.cloud/v1';

export const SERVER_TYPE = 'cx33';
export const SERVER_IMAGE = 'ubuntu-24.04';
export const SERVER_LOCATION = 'fsn1';

export class HetznerApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** What to do by hand instead. Never contains a real token. */
  readonly fallback: string;

  constructor(message: string, options: { status: number; code: string; fallback: string }) {
    super(message);
    this.name = 'HetznerApiError';
    this.status = options.status;
    this.code = options.code;
    this.fallback = options.fallback;
  }
}

export interface HetznerClientOptions {
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

export interface HetznerServer {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly public_net?: {
    readonly ipv4?: { readonly ip: string } | null;
    readonly ipv6?: { readonly ip: string } | null;
  };
}

export interface CreateServerInput {
  readonly name: string;
  readonly userData: string;
  readonly firewallId: number;
  /** Hetzner SSH key ids to add for root. Optional: the deploy path does not need one. */
  readonly sshKeys?: readonly number[];
}

export interface WaitOptions {
  readonly pollMs?: number;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onProgress?: (server: HetznerServer) => void;
}

export interface HetznerClient {
  createFirewall(name: string): Promise<{ firewallId: number }>;
  createServer(input: CreateServerInput): Promise<HetznerServer>;
  getServer(id: number): Promise<HetznerServer>;
  waitForRunning(id: number, options?: WaitOptions): Promise<HetznerServer>;
}

const TOKEN_PLACEHOLDER = '<YOUR_TOKEN>';

function curl(method: string, path: string, body?: unknown): string {
  const parts = [
    `curl -X ${method} '${HETZNER_API_BASE}${path}'`,
    `-H 'Authorization: Bearer ${TOKEN_PLACEHOLDER}'`,
    "-H 'Content-Type: application/json'",
  ];
  if (body !== undefined) parts.push(`--data '${JSON.stringify(body)}'`);
  return parts.join(' ');
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createHetznerClient(options: HetznerClientOptions): HetznerClient {
  const doFetch: FetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const baseUrl = options.baseUrl ?? HETZNER_API_BASE;

  async function request<T>(spec: { method: string; path: string; fallback: string; body?: unknown }): Promise<T> {
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
    let payload: { error?: { code?: string; message?: string } } & Record<string, unknown> = {};
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      payload = {};
    }

    if (!response.ok || payload.error !== undefined) {
      const code = payload.error?.code ?? `http_${response.status}`;
      const message = payload.error?.message ?? `HTTP ${response.status}`;
      throw new HetznerApiError(`Hetzner ${spec.method} ${spec.path} failed — ${code}: ${message}`, {
        status: response.status,
        code,
        fallback: spec.fallback,
      });
    }
    return payload as unknown as T;
  }

  const client: HetznerClient = {
    async createFirewall(name) {
      // No inbound rules at all. Hetzner's default for an attached firewall is deny,
      // so the box is reachable only over Tailscale and the Cloudflare tunnel, both
      // of which are outbound connections.
      const body = { name, rules: [] as readonly unknown[] };
      const result = await request<{ firewall: { id: number } }>({
        method: 'POST',
        path: '/firewalls',
        body,
        fallback:
          `Hetzner Cloud console → Firewalls → Create Firewall, name "${name}", delete every inbound rule, ` +
          `then attach it to the server. Or run: ${curl('POST', '/firewalls', body)}`,
      });
      return { firewallId: result.firewall.id };
    },

    async createServer(input) {
      const body = {
        name: input.name,
        server_type: SERVER_TYPE,
        image: SERVER_IMAGE,
        location: SERVER_LOCATION,
        user_data: input.userData,
        firewalls: [{ firewall: input.firewallId }],
        public_net: { enable_ipv4: true, enable_ipv6: true },
        ...(input.sshKeys === undefined ? {} : { ssh_keys: input.sshKeys }),
      };
      const result = await request<{ server: HetznerServer }>({
        method: 'POST',
        path: '/servers',
        body,
        fallback:
          `Hetzner Cloud console → Add Server: ${SERVER_LOCATION}, ${SERVER_IMAGE}, ${SERVER_TYPE}, ` +
          `attach the firewall, and paste the cloud-init document into "Cloud config" under User data. ` +
          `The installer offers that document as a download.`,
      });
      return result.server;
    },

    async getServer(id) {
      const result = await request<{ server: HetznerServer }>({
        method: 'GET',
        path: `/servers/${id}`,
        fallback: `Hetzner Cloud console → Servers shows the status. Or run: ${curl('GET', `/servers/${id}`)}`,
      });
      return result.server;
    },

    async waitForRunning(id, waitOptions = {}) {
      const pollMs = waitOptions.pollMs ?? 5_000;
      const timeoutMs = waitOptions.timeoutMs ?? 300_000;
      const sleep = waitOptions.sleep ?? defaultSleep;

      let waited = 0;
      for (;;) {
        const server = await client.getServer(id);
        waitOptions.onProgress?.(server);
        if (server.status === 'running') return server;
        if (waited >= timeoutMs) {
          throw new HetznerApiError(
            `Hetzner server ${id} was still "${server.status}" after ${Math.round(timeoutMs / 1000)}s`,
            {
              status: 200,
              code: 'timeout',
              fallback:
                `The server was created; it is only slow to start. Watch it in the Hetzner Cloud console, ` +
                `then come back to this page and continue. Nothing needs to be re-created.`,
            },
          );
        }
        await sleep(pollMs);
        waited += pollMs;
      }
    },
  };

  return client;
}
