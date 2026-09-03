import { describe, expect, it } from 'vitest';
import type { CloudflareClient } from './cloudflare.js';
import { CloudflareApiError } from './cloudflare.js';
import type { HealthProbe } from './health.js';
import type { CreatedServer, ServerProvider } from './providers/types.js';
import type { InstallDeps, InstallInput, ProgressEvent } from './steps.js';
import { INSTALLER_STEPS, InstallStepError, runInstall } from './steps.js';

const server: CreatedServer = { id: '42', status: 'running', ipv4: '203.0.113.7' };

function fakeCloudflare(overrides: Partial<CloudflareClient> = {}): CloudflareClient {
  return {
    findZone: async () => ({ zoneId: 'zone1', accountId: 'acct1' }),
    createTunnel: async () => ({ tunnelId: 'tun1', tunnelToken: 'tunnel-token' }),
    putTunnelConfig: async () => {},
    upsertDnsRecord: async () => ({ recordId: 'rec1' }),
    createAccessApp: async () => ({ appId: 'app1', aud: 'aud-tag' }),
    createAccessPolicy: async () => ({ policyId: 'pol1' }),
    getAccessTeam: async () => 'acme',
    ...overrides,
  };
}

function fakeProvider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    id: 'fake',
    label: 'Fake provider',
    capabilities: { canCreateFirewall: true, canCreateServer: true },
    createServer: async () => server,
    waitForRunning: async () => server,
    ...overrides,
  };
}

const input: InstallInput = {
  domain: 'example.com',
  ownerEmail: 'me@example.com',
  repoUrl: 'git@github.com:alfonsojbro/claudexwhatsapp.git',
  branch: 'main',
  deployKeyPrivate: 'PRIVATE',
  deployKeyPublic: 'PUBLIC',
  timezone: 'Europe/Prague',
};

const accessRedirect: HealthProbe = {
  status: 302,
  location: 'https://acme.cloudflareaccess.com/cdn-cgi/access/login/cxw.example.com',
};

function deps(overrides: Partial<InstallDeps> = {}): InstallDeps {
  return {
    cloudflare: fakeCloudflare(),
    provider: fakeProvider(),
    buildCloudInit: () => '#cloud-config\n',
    probeHealth: async () => accessRedirect,
    wait: { sleep: async () => {}, healthAttempts: 3, healthIntervalMs: 1 },
    ...overrides,
  };
}

describe('INSTALLER_STEPS', () => {
  it('covers the nine operations from the plan, in order', () => {
    expect(INSTALLER_STEPS.map((s) => s.id)).toEqual([
      'zone',
      'tunnel',
      'tunnel-config',
      'dns',
      'access-app',
      'access-policy',
      'payload',
      'server',
      'health',
    ]);
  });

  it('gives every step a title, a detail and a non-empty fallback', () => {
    for (const step of INSTALLER_STEPS) {
      expect(step.title.length, `${step.id} title`).toBeGreaterThan(0);
      expect(step.detail.length, `${step.id} detail`).toBeGreaterThan(0);
      expect(step.fallback.trim().length, `${step.id} fallback`).toBeGreaterThan(20);
    }
  });

  it('has unique ids', () => {
    expect(new Set(INSTALLER_STEPS.map((s) => s.id)).size).toBe(INSTALLER_STEPS.length);
  });
});

describe('runInstall', () => {
  it('runs every step in order and ends ready', async () => {
    const events: ProgressEvent[] = [];
    const result = await runInstall(deps(), input, (e) => events.push(e));

    expect(result.hostname).toBe('cxw.example.com');
    expect(result.setupUrl).toBe('https://cxw.example.com/setup');
    expect(result.accessTeam).toBe('acme');
    expect(result.accessApp.aud).toBe('aud-tag');
    expect(result.server.status).toBe('running');
    expect(result.server.ipv4).toBe('203.0.113.7');
    expect(result.health).toMatchObject({ state: 'ready', warning: false });

    const done = events.filter((e) => e.state === 'done').map((e) => e.stepId);
    expect(done).toEqual(INSTALLER_STEPS.map((s) => s.id));
    expect(events.every((e) => e.total === INSTALLER_STEPS.length)).toBe(true);
    expect(events.filter((e) => e.state === 'failed')).toEqual([]);
  });

  it('feeds the tunnel token, audience tag and team into the payload', async () => {
    let seen: Record<string, unknown> = {};
    await runInstall(
      deps({
        buildCloudInit: (payload) => {
          seen = payload as unknown as Record<string, unknown>;
          return '#cloud-config\n';
        },
      }),
      { ...input, tailscaleAuthKey: 'tskey-auth-x' },
    );
    expect(seen).toMatchObject({
      tunnelToken: 'tunnel-token',
      accessAud: 'aud-tag',
      accessTeam: 'acme',
      consoleHostname: 'cxw.example.com',
      tailscaleAuthKey: 'tskey-auth-x',
      ownerEmail: 'me@example.com',
    });
  });

  it('omits tailscaleAuthKey entirely when none was given', async () => {
    let seen: Record<string, unknown> = {};
    await runInstall(
      deps({
        buildCloudInit: (payload) => {
          seen = payload as unknown as Record<string, unknown>;
          return '#cloud-config\n';
        },
      }),
      input,
    );
    expect('tailscaleAuthKey' in seen).toBe(false);
  });

  it('routes the tunnel at the console loopback port', async () => {
    const seen: unknown[] = [];
    await runInstall(
      deps({
        cloudflare: fakeCloudflare({
          putTunnelConfig: async (accountId, tunnelId, hostname, service) => {
            seen.push([accountId, tunnelId, hostname, service]);
          },
        }),
      }),
      input,
    );
    expect(seen[0]).toEqual(['acct1', 'tun1', 'cxw.example.com', 'http://127.0.0.1:7803']);
  });

  it('flags a 200 as ready with a warning rather than as success', async () => {
    const result = await runInstall(deps({ probeHealth: async () => ({ status: 200, body: 'ok' }) }), input);
    expect(result.health).toMatchObject({ state: 'ready', warning: true });
  });


  it('carries a manual provider\u2019s instructions through to the result', async () => {
    const manualServer: CreatedServer = {
      id: 'manual',
      status: 'manual',
      manual: {
        cloudInit: '#cloud-config\n',
        sshCommand: "printf %s 'AAA' | base64 -d | bash -s",
        knownGoodProviders: ['DigitalOcean'],
        firewallNote: 'ufw default-deny is the firewall',
      },
    };
    const result = await runInstall(
      deps({
        provider: fakeProvider({
          createServer: async () => manualServer,
          waitForRunning: async (id) => ({ id, status: 'manual' }),
        }),
      }),
      input,
    );
    expect(result.server.manual?.sshCommand).toContain('base64 -d | bash -s');
    expect(result.server.manual?.firewallNote).toContain('ufw');
    expect(result.health.state).toBe('ready');
  });

  it('surfaces a mid-flight API failure as the step id plus its fallback, not a stack', async () => {
    const boom = new CloudflareApiError('Cloudflare POST /access/apps failed — 1001: nope', {
      status: 403,
      errors: [{ code: 1001, message: 'nope' }],
      fallback: 'Dashboard → Zero Trust → Access → Applications → Add an application.',
    });
    const events: ProgressEvent[] = [];
    const error = await runInstall(
      deps({ cloudflare: fakeCloudflare({ createAccessApp: async () => Promise.reject(boom) }) }),
      input,
      (e) => events.push(e),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InstallStepError);
    const stepError = error as InstallStepError;
    expect(stepError.stepId).toBe('access-app');
    expect(stepError.message).toContain('1001: nope');
    expect(stepError.fallback).toContain('Application Audience');
    expect(stepError.fallback).toContain('Dashboard → Zero Trust → Access → Applications');
    expect(stepError.cause).toBe(boom);

    expect(events.filter((e) => e.state === 'failed').map((e) => e.stepId)).toEqual(['access-app']);
    expect(events.filter((e) => e.state === 'done').map((e) => e.stepId)).toEqual([
      'zone',
      'tunnel',
      'tunnel-config',
      'dns',
    ]);
  });

  it('wraps a plain thrown Error too, with the step fallback and no stack', async () => {
    const error = await runInstall(
      deps({
        buildCloudInit: () => {
          throw new Error('refusing to template an unusual branch: main\nboom');
        },
      }),
      input,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstallStepError);
    expect((error as InstallStepError).stepId).toBe('payload');
    expect((error as InstallStepError).fallback).toContain('nothing has been sent anywhere');
  });
});
