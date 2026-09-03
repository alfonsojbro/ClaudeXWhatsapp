/**
 * Hetzner Cloud as a {@link ServerProvider}.
 *
 * This is the only module outside `../hetzner.ts` itself that is allowed to import the
 * Hetzner client; `providers/providers.test.ts` asserts it.
 *
 * The empty-rules firewall is Hetzner-specific on purpose. Hetzner's default for an
 * attached firewall is deny, so an empty rule set is the tightest thing we can ask for.
 * No other provider gets a pretend firewall.
 */

import type { FetchImpl } from '../cloudflare.js';
import type { HetznerClient } from '../hetzner.js';
import { createHetznerClient } from '../hetzner.js';
import type { CreateServerInput, CreatedServer, ServerProvider, WaitForRunningOptions } from './types.js';

export { HetznerApiError } from '../hetzner.js';

export const HETZNER_FIREWALL_NAME = 'cxw-fw';

export interface HetznerProviderOptions {
  readonly token: string;
  readonly fetchImpl?: FetchImpl;
  readonly baseUrl?: string;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /** Injected by tests; production builds one from `token`. */
  readonly client?: HetznerClient;
  readonly firewallName?: string;
}

function toCreatedServer(server: { id: number; status: string; public_net?: { ipv4?: { ip: string } | null } }): CreatedServer {
  const ip = server.public_net?.ipv4?.ip;
  return {
    id: String(server.id),
    status: server.status,
    ...(ip === undefined || ip === null ? {} : { ipv4: ip }),
  };
}

export function createHetznerProvider(options: HetznerProviderOptions): ServerProvider {
  const client =
    options.client ??
    createHetznerClient({
      token: options.token,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.extraHeaders === undefined ? {} : { extraHeaders: options.extraHeaders }),
    });

  return {
    id: 'hetzner',
    label: 'Hetzner Cloud',
    capabilities: { canCreateFirewall: true, canCreateServer: true },

    async createServer(input: CreateServerInput): Promise<CreatedServer> {
      const firewall = await client.createFirewall(options.firewallName ?? HETZNER_FIREWALL_NAME);
      const server = await client.createServer({
        name: input.name,
        userData: input.userData,
        firewallId: firewall.firewallId,
      });
      return toCreatedServer(server);
    },

    async waitForRunning(id: string, waitOptions: WaitForRunningOptions = {}): Promise<CreatedServer> {
      const server = await client.waitForRunning(Number(id), {
        ...(waitOptions.sleep === undefined ? {} : { sleep: waitOptions.sleep }),
        ...(waitOptions.timeoutMs === undefined ? {} : { timeoutMs: waitOptions.timeoutMs }),
        ...(waitOptions.pollMs === undefined ? {} : { pollMs: waitOptions.pollMs }),
        ...(waitOptions.onProgress === undefined
          ? {}
          : { onProgress: (s) => waitOptions.onProgress?.(toCreatedServer(s)) }),
      });
      return toCreatedServer(server);
    },
  };
}
