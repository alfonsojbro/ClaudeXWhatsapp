/**
 * The seam between "make me a server" and everything after it.
 *
 * Only step 8 of the install is provider-specific. The tunnel, the DNS record, the
 * Access application, the readiness probe and the whole on-box wizard neither know nor
 * care which provider made the box. Adding DigitalOcean or Vultr later is one file in
 * this directory and nothing outside it.
 *
 * Browser-safe: no `node:` imports.
 */

export interface ProviderCapabilities {
  /** True only for providers whose API can create a cloud firewall for us. */
  readonly canCreateFirewall: boolean;
  /** False for the manual provider, which asks the person to create the server. */
  readonly canCreateServer: boolean;
}

/** Shown by the page when the person has to do the work themselves. */
export interface ManualInstructions {
  /** The cloud-init user-data to paste into any provider's create-server form. */
  readonly cloudInit: string;
  /** One root SSH command for a server that already exists. */
  readonly sshCommand: string;
  /** Providers known to accept cloud-init on Ubuntu 24.04. */
  readonly knownGoodProviders: readonly string[];
  /** What stands in for a cloud firewall on this provider. Never implies one exists. */
  readonly firewallNote: string;
}

export interface CreatedServer {
  readonly id: string;
  readonly status: string;
  readonly ipv4?: string | undefined;
  /** Present only when the person, not an API, creates the server. */
  readonly manual?: ManualInstructions | undefined;
}

export interface CreateServerInput {
  readonly name: string;
  /** The cloud-init document, byte for byte what `buildCloudInit` returned. */
  readonly userData: string;
}

export interface WaitForRunningOptions {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly onProgress?: (server: CreatedServer) => void;
}

export interface ServerProvider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  createServer(input: CreateServerInput): Promise<CreatedServer>;
  waitForRunning(id: string, options?: WaitForRunningOptions): Promise<CreatedServer>;
}

/**
 * What the page says about the firewall when the provider cannot make one. It is the
 * truth, not a reassurance: `bootstrap.sh` sets ufw to default-deny with SSH reachable
 * only over Tailscale, and nothing else listens on a public interface.
 */
export const UFW_FIREWALL_NOTE =
  'This provider has no cloud firewall in this installer. The box firewalls itself: ' +
  'bootstrap.sh sets ufw to deny all inbound traffic, allows SSH only over the Tailscale ' +
  'interface, and the console is reached through the Cloudflare tunnel, which is an ' +
  'outbound connection. If your provider offers its own firewall, deny all inbound there too.';
