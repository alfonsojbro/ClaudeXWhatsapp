import { describe, expect, it } from 'vitest';
import type { CloudInitInput } from './cloud-init.js';
import {
  CLOUD_INIT_TEMPLATE,
  CLOUD_INIT_TEMPLATE_FILE,
  CloudInitLeakError,
  assertNoSecretLeaks,
  buildCloudInit,
  buildInstallerEnv,
} from './cloud-init.js';
import { fromBase64 } from './ssh-key.js';

const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZS1kZXBsb3kta2V5\n-----END OPENSSH PRIVATE KEY-----\n';

const input: CloudInitInput = {
  repoUrl: 'git@github.com:alfonsojbro/claudexwhatsapp.git',
  branch: 'main',
  deployKeyPrivate: PRIVATE_KEY,
  deployKeyPublic: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIfake cxw-installer',
  tailscaleAuthKey: 'tskey-auth-SECRETTAILSCALEKEY',
  tunnelToken: 'SECRETTUNNELTOKENVALUE',
  accessTeam: 'acme',
  accessAud: 'SECRETAUDIENCETAG',
  consoleHostname: 'cxw.example.com',
  timezone: 'Europe/Prague',
  ownerEmail: 'me@example.com',
};

/** Read back the base64 `content:` of one write_files entry. */
function fileContent(rendered: string, path: string): string {
  const lines = rendered.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- path: ${path}`);
  expect(at, `no write_files entry for ${path}`).toBeGreaterThanOrEqual(0);
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.trim().startsWith('- path:')) break;
    const match = /^\s*content:\s*(\S+)\s*$/.exec(line);
    if (match !== null) return new TextDecoder().decode(fromBase64(match[1] as string));
  }
  throw new Error(`no content for ${path}`);
}

describe('the template has one source of truth', () => {
  it('the browser-safe copy matches cloud-init.template.yml byte for byte', () => {
    // cloud-init-core.ts must load in a browser, so it carries the template inline.
    // The .yml stays the readable reference; this fails the moment they drift.
    expect(CLOUD_INIT_TEMPLATE).toBe(CLOUD_INIT_TEMPLATE_FILE);
  });
});

describe('buildInstallerEnv', () => {
  const env = buildInstallerEnv(input);

  it('writes the exact names phase 8 reads', () => {
    for (const line of [
      'CXW_TUNNEL_TOKEN=SECRETTUNNELTOKENVALUE',
      'CXW_SETUP_MODE=1',
      'CXW_CONSOLE_HOSTNAME=cxw.example.com',
      'CF_ACCESS_TEAM=acme',
      'CF_ACCESS_AUD=SECRETAUDIENCETAG',
      'CONSOLE_REQUIRE_ACCESS=true',
      'CONSOLE_HOST=127.0.0.1',
      'CONSOLE_PORT=7803',
      'TZ=Europe/Prague',
    ]) {
      expect(env.split('\n')).toContain(line);
    }
  });

  it('includes the Tailscale key only when one was given', () => {
    expect(env).toContain('TS_AUTHKEY=tskey-auth-SECRETTAILSCALEKEY');
    const rest: CloudInitInput = { ...input, tailscaleAuthKey: undefined };
    expect(buildInstallerEnv(rest)).not.toContain('TS_AUTHKEY');
    expect(buildInstallerEnv({ ...rest, tailscaleAuthKey: '' })).not.toContain('TS_AUTHKEY');
  });
});

describe('buildCloudInit', () => {
  const rendered = buildCloudInit(input);

  it('is a cloud-config document', () => {
    expect(rendered.startsWith('#cloud-config')).toBe(true);
    expect(rendered).toContain('write_files:');
    expect(rendered).toContain('runcmd:');
    expect(/__[A-Z0-9_]+__/.test(rendered)).toBe(false);
  });

  it('carries the deploy key as base64 at 0600', () => {
    expect(fileContent(rendered, '/root/.ssh/cxw_deploy')).toBe(PRIVATE_KEY);
    const block = rendered.slice(rendered.indexOf('- path: /root/.ssh/cxw_deploy'));
    expect(block).toContain("permissions: '0600'");
    expect(block).toContain('encoding: b64');
  });

  it('carries the env fragment as base64', () => {
    expect(fileContent(rendered, '/root/cxw-installer.env')).toBe(buildInstallerEnv(input));
  });

  it('installs the key, keyscans github, clones, then runs bootstrap — in that order', () => {
    const run = rendered.slice(rendered.indexOf('runcmd:'));
    const order = [
      '/home/cxw/.ssh/cxw_deploy',
      'ssh-keyscan',
      'clone',
      'deploy/hetzner/bootstrap.sh',
    ].map((needle) => run.indexOf(needle));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('templates the repo url and branch', () => {
    expect(rendered).toContain("'git@github.com:alfonsojbro/claudexwhatsapp.git'");
    expect(rendered).toContain("--branch 'main'");
  });

  it('refuses odd inputs rather than templating them into YAML', () => {
    expect(() => buildCloudInit({ ...input, repoUrl: "x'; rm -rf /; #" })).toThrow(/repo URL/);
    expect(() => buildCloudInit({ ...input, branch: 'main\nruncmd: pwned' })).toThrow(/branch/);
    expect(() => buildCloudInit({ ...input, consoleHostname: 'a b' })).toThrow(/hostname/);
    expect(() => buildCloudInit({ ...input, timezone: 'Europe/Prague; boom' })).toThrow(/timezone/);
  });

  it('calls assertNoSecretLeaks itself: a leaking template is refused', () => {
    const leaky = CLOUD_INIT_TEMPLATE.replace(
      'runcmd:',
      'runcmd:\n  - echo "tunnel token is __INSTALLER_ENV_B64__" >> /var/log/cxw-install.log',
    );
    // The base64 blob on its own is fine — a plaintext echo of the token is not.
    expect(() => buildCloudInit(input, leaky)).not.toThrow();

    const plaintext = CLOUD_INIT_TEMPLATE.replace('runcmd:', `runcmd:\n  - echo "${input.tunnelToken}" >> /tmp/x`);
    const error = (() => {
      try {
        buildCloudInit(input, plaintext);
        return null;
      } catch (e: unknown) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(CloudInitLeakError);
    expect((error as CloudInitLeakError).leaked).toEqual(['tunnelToken']);
    expect((error as CloudInitLeakError).message).toContain('tunnelToken');
  });
});

describe('assertNoSecretLeaks', () => {
  it('allows a secret inside the two base64 anchors and inside `tailscale up`', () => {
    const doc = [
      '#cloud-config',
      'write_files:',
      '  - path: /root/.ssh/cxw_deploy',
      '    encoding: b64',
      '    content: SECRETONE',
      '  - path: /root/cxw-installer.env',
      '    encoding: b64',
      '    content: SECRETTWO',
      'runcmd:',
      '  - tailscale up --auth-key=SECRETTHREE',
    ].join('\n');
    expect(() =>
      assertNoSecretLeaks(doc, { one: 'SECRETONE', two: 'SECRETTWO', three: 'SECRETTHREE' }),
    ).not.toThrow();
  });

  it('names every secret that escaped, and only those', () => {
    const doc = [
      '#cloud-config',
      'write_files:',
      '  - path: /root/cxw-installer.env',
      '    encoding: b64',
      '    content: SAFE',
      '  - path: /etc/motd',
      '    content: LEAKED_B',
      'runcmd:',
      '  - echo LEAKED_A',
    ].join('\n');
    const error = (() => {
      try {
        assertNoSecretLeaks(doc, { safe: 'SAFE', a: 'LEAKED_A', b: 'LEAKED_B' });
        return null;
      } catch (e: unknown) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(CloudInitLeakError);
    expect([...(error as CloudInitLeakError).leaked].sort()).toEqual(['a', 'b']);
  });

  it('ignores empty secrets', () => {
    expect(() => assertNoSecretLeaks('#cloud-config\n', { blank: '' })).not.toThrow();
  });
});
