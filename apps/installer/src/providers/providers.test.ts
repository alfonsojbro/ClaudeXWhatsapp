import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FetchImpl } from '../cloudflare.js';
import type { CloudInitInput } from '../cloud-init-core.js';
import { buildCloudInit } from '../cloud-init-core.js';
import { HETZNER_FIREWALL_NAME, createHetznerProvider } from './hetzner.js';
import { KNOWN_GOOD_PROVIDERS, MANUAL_SERVER_ID, createManualProvider } from './manual.js';
import type { ServerProvider } from './types.js';
import { UFW_FIREWALL_NOTE } from './types.js';

const input: CloudInitInput = {
  repoUrl: 'git@github.com:alfonsojbro/claudexwhatsapp.git',
  branch: 'main',
  deployKeyPrivate: '-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZQ==\n-----END OPENSSH PRIVATE KEY-----\n',
  deployKeyPublic: 'ssh-ed25519 AAAAfake cxw-installer',
  tunnelToken: 'SECRETTUNNELTOKENVALUE',
  accessTeam: 'acme',
  accessAud: 'SECRETAUDIENCETAG',
  consoleHostname: 'cxw.example.com',
  timezone: 'Europe/Prague',
  ownerEmail: 'me@example.com',
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function recorder(replies: readonly unknown[]): { fetchImpl: FetchImpl; calls: Call[] } {
  const calls: Call[] = [];
  let n = 0;
  const fetchImpl: FetchImpl = async (url, init) => {
    const reply = replies[n];
    n += 1;
    if (reply === undefined) throw new Error(`unexpected request ${n} to ${url}`);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

/** Every provider must satisfy the same shape. */
function assertIsServerProvider(provider: ServerProvider): void {
  expect(typeof provider.id).toBe('string');
  expect(provider.id.length).toBeGreaterThan(0);
  expect(typeof provider.label).toBe('string');
  expect(typeof provider.capabilities.canCreateFirewall).toBe('boolean');
  expect(typeof provider.capabilities.canCreateServer).toBe('boolean');
  expect(typeof provider.createServer).toBe('function');
  expect(typeof provider.waitForRunning).toBe('function');
}

describe('the Hetzner provider', () => {
  it('satisfies the interface and declares a cloud firewall', () => {
    const provider = createHetznerProvider({ token: 'hz', fetchImpl: recorder([]).fetchImpl });
    assertIsServerProvider(provider);
    expect(provider.id).toBe('hetzner');
    expect(provider.capabilities).toEqual({ canCreateFirewall: true, canCreateServer: true });
  });

  it('creates the empty-rules firewall, then the server, and normalises the result', async () => {
    const { fetchImpl, calls } = recorder([
      { firewall: { id: 7 } },
      { server: { id: 42, name: 'cxw', status: 'initializing', public_net: { ipv4: { ip: '203.0.113.7' } } } },
    ]);
    const provider = createHetznerProvider({ token: 'hz', fetchImpl });
    const server = await provider.createServer({ name: 'cxw', userData: '#cloud-config\n' });

    expect(calls[0]?.body).toEqual({ name: HETZNER_FIREWALL_NAME, rules: [] });
    expect(calls[1]?.body).toMatchObject({ user_data: '#cloud-config\n', firewalls: [{ firewall: 7 }] });
    expect(server).toEqual({ id: '42', status: 'initializing', ipv4: '203.0.113.7' });
    expect(server.manual).toBeUndefined();
  });

  it('polls to running through the injected sleep', async () => {
    const { fetchImpl } = recorder([
      { server: { id: 42, name: 'cxw', status: 'starting' } },
      { server: { id: 42, name: 'cxw', status: 'running' } },
    ]);
    const provider = createHetznerProvider({ token: 'hz', fetchImpl });
    const seen: string[] = [];
    const server = await provider.waitForRunning('42', {
      sleep: async () => {},
      pollMs: 1,
      timeoutMs: 1000,
      onProgress: (s) => seen.push(s.status),
    });
    expect(server.status).toBe('running');
    expect(seen).toEqual(['starting', 'running']);
  });
});

describe('the manual provider', () => {
  const provider = createManualProvider({ input });

  it('satisfies the same interface and claims no cloud firewall', () => {
    assertIsServerProvider(provider);
    expect(provider.id).toBe(MANUAL_SERVER_ID);
    expect(provider.capabilities).toEqual({ canCreateFirewall: false, canCreateServer: false });
  });

  it('makes no network call at all', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    try {
      const created = await provider.createServer({ name: 'cxw', userData: buildCloudInit(input) });
      await provider.waitForRunning(created.id);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('hands back the cloud-init payload, the SSH one-liner and the named providers', async () => {
    const userData = buildCloudInit(input);
    const created = await provider.createServer({ name: 'cxw', userData });
    expect(created.status).toBe('manual');
    expect(created.manual?.cloudInit).toBe(userData);
    expect(created.manual?.sshCommand).toMatch(/^printf %s '[A-Za-z0-9+/=]+' \| base64 -d \| bash -s$/);
    expect(created.manual?.knownGoodProviders).toEqual(['DigitalOcean', 'Vultr', 'Linode', 'OVH', 'Scaleway']);
    expect(KNOWN_GOOD_PROVIDERS).toContain('DigitalOcean');
  });

  it('says ufw is the firewall rather than implying a cloud firewall exists', async () => {
    const created = await provider.createServer({ name: 'cxw', userData: '#cloud-config\n' });
    expect(created.manual?.firewallNote).toBe(UFW_FIREWALL_NOTE);
    expect(UFW_FIREWALL_NOTE).toContain('ufw');
    expect(UFW_FIREWALL_NOTE).toContain('no cloud firewall');
  });

  it('resolves waitForRunning immediately; readiness is the health probe', async () => {
    const settled = await provider.waitForRunning(MANUAL_SERVER_ID);
    expect(settled).toEqual({ id: MANUAL_SERVER_ID, status: 'manual' });
  });
});

describe('provider neutrality', () => {
  const srcRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

  function sourceFiles(dir: string): string[] {
    const found: string[] = [];
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      for (const entry of readdirSync(current)) {
        const full = join(current, entry);
        if (statSync(full).isDirectory()) stack.push(full);
        else if (entry.endsWith('.ts')) found.push(full);
      }
    }
    return found.sort();
  }

  it('no module outside src/providers/ imports the Hetzner client', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(srcRoot)) {
      const rel = relative(srcRoot, file);
      if (rel === 'hetzner.ts' || rel.startsWith('providers/')) continue;
      if (rel.endsWith('.test.ts')) continue; // the client keeps its own unit test
      const source = readFileSync(file, 'utf8');
      if (/from '\.\/hetzner\.js'/.test(source)) offenders.push(`${rel} imports ./hetzner.js`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('steps.ts names no provider and no provider error type', () => {
    const steps = readFileSync(join(srcRoot, 'steps.ts'), 'utf8');
    for (const token of ['Hetzner', 'hetzner', 'DigitalOcean', 'cx33', 'fsn1', 'firewall', 'Firewall']) {
      expect(steps.includes(token), `steps.ts mentions ${token}`).toBe(false);
    }
  });

  it('manual.ts contains no fetch call and no network host', () => {
    const source = readFileSync(join(srcRoot, 'providers', 'manual.ts'), 'utf8');
    expect(/\bfetch\s*\(/.test(source)).toBe(false);
    expect(/https?:\/\//.test(source)).toBe(false);
    expect(source.includes('XMLHttpRequest')).toBe(false);
  });
});
