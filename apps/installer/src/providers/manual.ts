/**
 * "Any other server" as a {@link ServerProvider}.
 *
 * It makes no network call of any kind — there is no `fetch` in this file, and a test
 * asserts that. It hands back two routes and lets the person pick:
 *
 *   1. A new server anywhere: paste the cloud-init document into the provider's
 *      create-server form (Ubuntu 24.04).
 *   2. A server that already exists: run one command as root over SSH.
 *
 * Everything after this is provider-neutral, so the installer carries on into the
 * tunnel, DNS, Access and the readiness probe exactly as it does for Hetzner.
 */

import type { CloudInitInput } from '../cloud-init-core.js';
import { buildBootstrapCommand } from '../bootstrap-command.js';
import type { CreateServerInput, CreatedServer, ManualInstructions, ServerProvider } from './types.js';
import { UFW_FIREWALL_NOTE } from './types.js';

/** Providers whose create-server form is known to accept cloud-init on Ubuntu 24.04. */
export const KNOWN_GOOD_PROVIDERS: readonly string[] = [
  'DigitalOcean',
  'Vultr',
  'Linode',
  'OVH',
  'Scaleway',
];

export const MANUAL_SERVER_ID = 'manual';

export interface ManualProviderOptions {
  /** The same input the cloud-init payload was built from. */
  readonly input: CloudInitInput;
  /** Injected by tests; otherwise built here from `input`. */
  readonly sshCommand?: string;
}

export function createManualProvider(options: ManualProviderOptions): ServerProvider {
  const sshCommand = options.sshCommand ?? buildBootstrapCommand(options.input);

  const instructions = (userData: string): ManualInstructions => ({
    cloudInit: userData,
    sshCommand,
    knownGoodProviders: KNOWN_GOOD_PROVIDERS,
    firewallNote: UFW_FIREWALL_NOTE,
  });

  return {
    id: MANUAL_SERVER_ID,
    label: 'Any other server',
    capabilities: { canCreateFirewall: false, canCreateServer: false },

    async createServer(input: CreateServerInput): Promise<CreatedServer> {
      // No API call: the person creates the server. We only hand back what to paste.
      return { id: MANUAL_SERVER_ID, status: 'manual', manual: instructions(input.userData) };
    },

    async waitForRunning(id: string): Promise<CreatedServer> {
      // There is nothing to poll — no API knows about this box. Readiness is decided by
      // the health probe in the next step, which works for every provider alike.
      return { id, status: 'manual' };
    },
  };
}
