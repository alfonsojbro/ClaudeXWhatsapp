/**
 * The one command a person runs as root on a server that already exists.
 *
 * It is ONE self-contained line. It base64-decodes an embedded payload and runs it.
 * It deliberately does not `curl | bash` a script from the internet: the payload
 * carries the person's own deploy key and tunnel token, they paste it into their own
 * SSH session, and so nothing is fetched from a third party and no secret crosses
 * another host.
 *
 * Browser-safe: no `node:` imports. Built from the same `CloudInitInput` as the
 * cloud-init payload, and guarded by the same `assertNoSecretLeaks`.
 */

import type { CloudInitInput } from './cloud-init-core.js';
import { assertNoSecretLeaks, assertSafeInput, buildInstallerEnv, payloadSecrets, utf8ToBase64 } from './cloud-init-core.js';

const SSH_IDENTITY = "ssh -i /home/cxw/.ssh/cxw_deploy -o IdentitiesOnly=yes";

/**
 * The script the one-liner decodes and runs. Both secrets travel inside it as their
 * own base64 blobs, so neither is ever a shell word even after the outer decode.
 */
export function buildBootstrapScript(input: CloudInitInput): { script: string; blobs: readonly string[] } {
  assertSafeInput(input);

  const keyBlob = utf8ToBase64(input.deployKeyPrivate);
  const envBlob = utf8ToBase64(buildInstallerEnv(input));

  const script = [
    '#!/usr/bin/env bash',
    '# ClaudeXWhatsapp setup, pasted by its owner. Idempotent: safe to run twice.',
    'set -euo pipefail',
    '[ "$(id -u)" = 0 ] || { echo "run this as root" >&2; exit 1; }',
    'command -v git >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq git; }',
    'install -d -m 0700 -o root -g root /root/.ssh',
    `printf %s '${keyBlob}' | base64 -d > /root/.ssh/cxw_deploy`,
    'chmod 0600 /root/.ssh/cxw_deploy',
    `printf %s '${envBlob}' | base64 -d > /root/cxw-installer.env`,
    'chmod 0600 /root/cxw-installer.env',
    'id -u cxw >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/cxw --shell /bin/bash cxw',
    'install -d -m 0700 -o cxw -g cxw /home/cxw/.ssh',
    'install -m 0600 -o cxw -g cxw /root/.ssh/cxw_deploy /home/cxw/.ssh/cxw_deploy',
    'ssh-keyscan -t rsa,ecdsa,ed25519 github.com >> /home/cxw/.ssh/known_hosts',
    'chown cxw:cxw /home/cxw/.ssh/known_hosts',
    'chmod 0600 /home/cxw/.ssh/known_hosts',
    'install -d -m 0711 -o root -g root /srv/cxw',
    'install -d -m 0700 -o cxw -g cxw /srv/cxw/repo',
    `[ -d /srv/cxw/repo/.git ] || sudo -u cxw -H git -c core.sshCommand='${SSH_IDENTITY}' clone --branch '${input.branch}' '${input.repoUrl}' /srv/cxw/repo`,
    `sudo -u cxw -H git -C /srv/cxw/repo config core.sshCommand '${SSH_IDENTITY}'`,
    'set -a',
    '. /root/cxw-installer.env',
    'set +a',
    'bash /srv/cxw/repo/deploy/hetzner/bootstrap.sh',
  ].join('\n');

  // The inner script is guarded on its own terms: the only place a secret may appear
  // is inside one of the two blobs it declares here.
  assertNoSecretLeaks(`${script}\n`, payloadSecrets(input), [keyBlob, envBlob]);

  return { script: `${script}\n`, blobs: [keyBlob, envBlob] };
}

/** The single line to paste into a root shell on any Ubuntu 24.04 server. */
export function buildBootstrapCommand(input: CloudInitInput): string {
  const { script } = buildBootstrapScript(input);
  const payload = utf8ToBase64(script);
  const command = `printf %s '${payload}' | base64 -d | bash -s`;

  if (command.includes('\n')) throw new Error('the bootstrap command must be a single line');
  assertNoSecretLeaks(command, payloadSecrets(input), [payload]);
  return command;
}
