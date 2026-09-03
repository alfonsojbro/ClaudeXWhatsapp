import { describe, expect, it } from 'vitest';
import { buildBootstrapCommand, buildBootstrapScript } from './bootstrap-command.js';
import type { CloudInitInput } from './cloud-init-core.js';
import { CloudInitLeakError, buildCloudInit, buildInstallerEnv } from './cloud-init-core.js';
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

const decode = (text: string): string => new TextDecoder().decode(fromBase64(text));

/** A repo URL with shell metacharacters in it; the builder must refuse, not escape. */
const INJECTING_REPO_URL = "x'; touch /tmp/pwned; #";

describe('buildBootstrapCommand', () => {
  const command = buildBootstrapCommand(input);

  it('is exactly one line', () => {
    expect(command.includes('\n')).toBe(false);
    expect(command.split('\n')).toHaveLength(1);
  });

  it('base64-decodes an embedded payload and runs it', () => {
    expect(command.startsWith("printf %s '")).toBe(true);
    expect(command.endsWith("' | base64 -d | bash -s")).toBe(true);
  });

  it('fetches nothing from a third party', () => {
    for (const forbidden of ['curl', 'wget', 'http://', 'https://raw.', '| sh']) {
      expect(command.includes(forbidden), `command contains ${forbidden}`).toBe(false);
    }
  });

  it('carries no secret outside its own base64 blob', () => {
    for (const secret of [PRIVATE_KEY, input.tunnelToken, input.accessAud, input.tailscaleAuthKey as string]) {
      expect(command.includes(secret)).toBe(false);
    }
  });

  it('decodes to a runnable, root-checked, idempotent script', () => {
    const payload = /^printf %s '([^']+)' \| base64 -d \| bash -s$/.exec(command)?.[1] as string;
    const script = decode(payload);
    expect(script.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('[ "$(id -u)" = 0 ]');
    expect(script).toContain('[ -d /srv/cxw/repo/.git ] ||');
    expect(script).toContain('bash /srv/cxw/repo/deploy/hetzner/bootstrap.sh');
  });

  it('refuses the same odd inputs as the cloud-init builder', () => {
    expect(() => buildBootstrapCommand({ ...input, repoUrl: INJECTING_REPO_URL })).toThrow(/repo URL/);
    expect(() => buildBootstrapCommand({ ...input, branch: "main'; echo evil" })).toThrow(/branch/);
  });
});

describe('buildBootstrapScript', () => {
  const { script, blobs } = buildBootstrapScript(input);

  it('writes the deploy key and the env fragment from base64, never as shell words', () => {
    const [keyBlob, envBlob] = blobs as [string, string];
    expect(decode(keyBlob)).toBe(PRIVATE_KEY);
    expect(decode(envBlob)).toBe(buildInstallerEnv(input));
    expect(script).toContain(`printf %s '${keyBlob}' | base64 -d > /root/.ssh/cxw_deploy`);
    expect(script).toContain(`printf %s '${envBlob}' | base64 -d > /root/cxw-installer.env`);
    expect(script).toContain('chmod 0600 /root/.ssh/cxw_deploy');
    expect(script).toContain('chmod 0600 /root/cxw-installer.env');
  });

  it('is built from the same inputs as the cloud-init payload', () => {
    const cloudInit = buildCloudInit(input);
    // Both carry the same env fragment, so the box ends up configured identically.
    const envBlob = blobs[1] as string;
    expect(cloudInit).toContain(envBlob);
  });

  it('throws CloudInitLeakError if a secret ever escapes its blob', () => {
    const error = (() => {
      try {
        // A branch name equal to the tunnel token would be templated in plain text.
        buildBootstrapScript({ ...input, branch: input.tunnelToken });
        return null;
      } catch (e: unknown) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(CloudInitLeakError);
    expect((error as CloudInitLeakError).leaked).toContain('tunnelToken');
  });
});
