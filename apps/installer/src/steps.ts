/**
 * The ordered install: nine operations, each with a progress line and a fallback.
 *
 * Browser-safe: no `node:` imports. Server creation goes through `ServerProvider`, so
 * everything from the tunnel onwards is provider-neutral: it neither knows nor cares
 * which provider made the box. `buildCloudInit` is injected so a caller can supply a
 * different template.
 */

import type { AccessAppRef, CloudflareClient, TunnelRef, ZoneRef } from './cloudflare.js';
import type { CloudInitInput } from './cloud-init-core.js';
import type { HealthProbe, HealthVerdict } from './health.js';
import { pollSetupHealth } from './health.js';
import type { CreatedServer, ServerProvider } from './providers/types.js';
import { redactedMessage } from './redact.js';

export interface InstallerStep {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  /** What to do by hand if this step fails. Never empty. */
  readonly fallback: string;
}

export const CONSOLE_SUBDOMAIN = 'cxw';
export const CONSOLE_SERVICE = 'http://127.0.0.1:7803';

export const INSTALLER_STEPS: readonly InstallerStep[] = [
  {
    id: 'zone',
    title: 'Find the domain',
    detail: 'Looks the domain up on Cloudflare and reads its zone id and account id.',
    fallback:
      'The domain must already be a site on this Cloudflare account, and the API token must be scoped ' +
      'to that zone with Zone:Read. Add the site in the dashboard, then run this step again.',
  },
  {
    id: 'tunnel',
    title: 'Create the tunnel',
    detail: 'Creates a remotely-managed Cloudflare tunnel and takes its connector token.',
    fallback:
      'Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared. Name it cxw and copy the token ' +
      'out of the install command. The token is the long string after "--token".',
  },
  {
    id: 'tunnel-config',
    title: 'Route the tunnel',
    detail: `Points the tunnel's ingress at ${CONSOLE_SERVICE} on the box, with a 404 catch-all.`,
    fallback:
      `Zero Trust → Networks → Tunnels → this tunnel → Published application routes. Add the hostname and ` +
      `send it to ${CONSOLE_SERVICE}, then add a catch-all that returns HTTP 404.`,
  },
  {
    id: 'dns',
    title: 'Point DNS at the tunnel',
    detail: 'Creates or updates a proxied CNAME from cxw.<domain> to the tunnel.',
    fallback:
      'DNS → Records: a CNAME named cxw whose target is <tunnel-id>.cfargotunnel.com, with the proxy ' +
      '(orange cloud) turned on. If the record already exists, edit it instead of adding a second one.',
  },
  {
    id: 'access-app',
    title: 'Put Access in front of it',
    detail: 'Creates a self-hosted Access application for the hostname and reads its audience tag and team name.',
    fallback:
      'Zero Trust → Access → Applications → Add an application → Self-hosted, domain cxw.<domain>, ' +
      'session 24h. Copy the Application Audience (AUD) tag. The team name is the first label of your ' +
      'team domain, shown under Zero Trust → Settings.',
  },
  {
    id: 'access-policy',
    title: 'Allow your email only',
    detail: 'Adds a single Allow policy that includes exactly one email address.',
    fallback:
      'Zero Trust → Access → Applications → this application → Policies → Add a policy: action Allow, ' +
      'Include → Emails → your address. Without this policy nobody can reach the wizard, including you.',
  },
  {
    id: 'payload',
    title: 'Build the cloud-init payload',
    detail: 'Assembles the first-boot document: the deploy key, the tunnel token and the Access settings.',
    fallback:
      'The installer offers the payload as a download. If this step fails, nothing has been sent anywhere ' +
      'yet — the failure is local, and the message says which field it refused.',
  },
  {
    id: 'server',
    title: 'Create the server',
    detail: 'The only provider-specific step: one API call, or the payload you paste yourself.',
    fallback:
      'Create an Ubuntu 24.04 server with at least 4 GB of RAM anywhere you like, and paste the ' +
      'cloud-init payload into its "user data" or "cloud config" field. For a server that already ' +
      'exists, run the single root command the page shows instead. Everything after this step is the ' +
      'same whichever provider you used.',
  },
  {
    id: 'health',
    title: 'Wait for the wizard',
    detail: 'Probes the hostname through the Pages Function until Cloudflare Access answers. Three to five minutes.',
    fallback:
      'Nothing is lost while this waits. Open https://cxw.<domain>/setup yourself in a few minutes; a ' +
      'Cloudflare Access login page means the box is up. A 1033 or 530 means the tunnel has not connected ' +
      'yet — check the cloudflared service on the box over Tailscale.',
  },
];

/**
 * An API error carrying its own fallback text. Duck-typed on purpose: `steps.ts` stays
 * provider-neutral, so it must not name any provider's error class.
 */
function apiFallbackOf(cause: unknown): string | null {
  if (typeof cause !== 'object' || cause === null) return null;
  const fallback = (cause as { fallback?: unknown }).fallback;
  return typeof fallback === 'string' && fallback !== '' ? fallback : null;
}

export class InstallStepError extends Error {
  readonly stepId: string;
  readonly step: InstallerStep;
  readonly fallback: string;
  override readonly cause: unknown;

  constructor(step: InstallerStep, cause: unknown) {
    const apiFallback = apiFallbackOf(cause);
    const detail = apiFallback !== null && cause instanceof Error ? cause.message : redactedMessage(cause);
    super(`${step.title} failed — ${detail}`);
    this.name = 'InstallStepError';
    this.stepId = step.id;
    this.step = step;
    this.cause = cause;
    this.fallback = apiFallback === null ? step.fallback : `${step.fallback}\n\n${apiFallback}`;
  }
}

export type ProgressState = 'running' | 'done' | 'failed';

export interface ProgressEvent {
  readonly stepId: string;
  readonly index: number;
  readonly total: number;
  readonly state: ProgressState;
  readonly message: string;
}

export interface InstallInput {
  readonly domain: string;
  readonly ownerEmail: string;
  readonly repoUrl: string;
  readonly branch: string;
  readonly deployKeyPrivate: string;
  readonly deployKeyPublic: string;
  readonly tailscaleAuthKey?: string | undefined;
  readonly timezone: string;
  readonly serverName?: string | undefined;
}

export interface InstallDeps {
  readonly cloudflare: CloudflareClient;
  /** The only provider-specific dependency. Everything after it is neutral. */
  readonly provider: ServerProvider;
  readonly buildCloudInit: (input: CloudInitInput) => string;
  readonly probeHealth: (url: string) => Promise<HealthProbe>;
  readonly wait?: {
    readonly sleep?: (ms: number) => Promise<void>;
    readonly serverTimeoutMs?: number;
    readonly healthAttempts?: number;
    readonly healthIntervalMs?: number;
  };
}

export interface InstallResult {
  readonly hostname: string;
  readonly zone: ZoneRef;
  readonly tunnel: TunnelRef;
  readonly accessApp: AccessAppRef;
  readonly accessTeam: string;
  readonly server: CreatedServer;
  readonly health: HealthVerdict;
  readonly setupUrl: string;
}

function step(id: string): InstallerStep {
  const found = INSTALLER_STEPS.find((s) => s.id === id);
  if (found === undefined) throw new Error(`unknown installer step: ${id}`);
  return found;
}

export async function runInstall(
  deps: InstallDeps,
  input: InstallInput,
  onProgress: (event: ProgressEvent) => void = () => {},
): Promise<InstallResult> {
  const total = INSTALLER_STEPS.length;
  const hostname = `${CONSOLE_SUBDOMAIN}.${input.domain}`;

  async function run<T>(id: string, body: () => Promise<T>): Promise<T> {
    const current = step(id);
    const index = INSTALLER_STEPS.indexOf(current) + 1;
    onProgress({ stepId: id, index, total, state: 'running', message: current.detail });
    try {
      const value = await body();
      onProgress({ stepId: id, index, total, state: 'done', message: current.title });
      return value;
    } catch (error) {
      const wrapped = error instanceof InstallStepError ? error : new InstallStepError(current, error);
      onProgress({ stepId: id, index, total, state: 'failed', message: wrapped.message });
      throw wrapped;
    }
  }

  const cf = deps.cloudflare;

  const zone = await run('zone', () => cf.findZone(input.domain));
  const tunnel = await run('tunnel', () => cf.createTunnel(zone.accountId, CONSOLE_SUBDOMAIN));
  await run('tunnel-config', () => cf.putTunnelConfig(zone.accountId, tunnel.tunnelId, hostname, CONSOLE_SERVICE));
  await run('dns', () => cf.upsertDnsRecord(zone.zoneId, hostname, tunnel.tunnelId));

  const access = await run('access-app', async () => {
    const app = await cf.createAccessApp(zone.accountId, hostname);
    const team = await cf.getAccessTeam(zone.accountId);
    return { app, team };
  });
  await run('access-policy', () => cf.createAccessPolicy(zone.accountId, access.app.appId, input.ownerEmail));

  const userData = await run('payload', async () =>
    deps.buildCloudInit({
      repoUrl: input.repoUrl,
      branch: input.branch,
      deployKeyPrivate: input.deployKeyPrivate,
      deployKeyPublic: input.deployKeyPublic,
      ...(input.tailscaleAuthKey === undefined ? {} : { tailscaleAuthKey: input.tailscaleAuthKey }),
      tunnelToken: tunnel.tunnelToken,
      accessTeam: access.team,
      accessAud: access.app.aud,
      consoleHostname: hostname,
      timezone: input.timezone,
      ownerEmail: input.ownerEmail,
    }),
  );

  const server = await run('server', async () => {
    const created = await deps.provider.createServer({ name: input.serverName ?? 'cxw', userData });
    // The manual provider returns instructions instead of a machine; carry them through
    // so the page can show them, and let the health probe decide readiness either way.
    const settled = await deps.provider.waitForRunning(created.id, {
      ...(deps.wait?.sleep === undefined ? {} : { sleep: deps.wait.sleep }),
      ...(deps.wait?.serverTimeoutMs === undefined ? {} : { timeoutMs: deps.wait.serverTimeoutMs }),
    });
    return created.manual === undefined ? settled : { ...settled, manual: created.manual };
  });

  const setupUrl = `https://${hostname}/setup`;
  const health = await run('health', () =>
    pollSetupHealth(() => deps.probeHealth(`${setupUrl}/health`), {
      ...(deps.wait?.healthAttempts === undefined ? {} : { attempts: deps.wait.healthAttempts }),
      ...(deps.wait?.sleep === undefined ? {} : { sleep: deps.wait.sleep }),
      ...(deps.wait?.healthIntervalMs === undefined ? {} : { intervalMs: deps.wait.healthIntervalMs }),
    }),
  );

  return {
    hostname,
    zone,
    tunnel,
    accessApp: access.app,
    accessTeam: access.team,
    server,
    health,
    setupUrl,
  };
}
