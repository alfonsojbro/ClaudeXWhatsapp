/**
 * A minimal `node:http` entry that serves nothing but the setup wizard.
 *
 * INTEGRATION IP-2: **this file is deleted when phase 8 merges.** It exists only because
 * `apps/console/src/main.ts` and `server.ts` are not on this branch, so without it the wizard
 * could be unit-tested but never actually run. Once phase 8 lands, its `main.ts` binds the
 * socket, its `access.ts` verifies Access, and its `server.ts` mounts `createSetupHandler`
 * (see IP-1 in `router.ts`). Delete this file and `access-verify.ts` in the same commit.
 *
 * Two refusals, both deliberate:
 *   - it binds loopback only, and refuses any other address outright rather than warning;
 *   - it refuses to start when Access is required but the team/audience pair is missing,
 *     because a wizard that writes tokens must never come up unauthenticated by accident.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { spawn } from 'node:child_process';
import { createAccessVerifier, createOpenVerifier } from './access-verify.js';
import { createSetupHandler } from './router.js';
import type { SetupDeps, SetupSpawn } from './router.js';

export type EnvRecord = Readonly<Record<string, string | undefined>>;

/** The only addresses this process will bind. A tunnel reaches it; the internet does not. */
export const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '::1'];

export class StandaloneConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StandaloneConfigError';
  }
}

function str(env: EnvRecord, key: string, fallback: string): string {
  const raw = env[key];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

export interface StandaloneConfig {
  readonly host: string;
  readonly port: number;
  readonly requireAccess: boolean;
  readonly accessTeam: string;
  readonly accessAud: string;
  readonly stateDir: string;
  readonly ownersFile: string;
  readonly envFilePath: string;
  readonly googleEnvPath: string;
  readonly vaultDir: string;
  readonly routinesDir: string;
  readonly consoleHostname: string;
}

/**
 * Build the configuration from the environment, using the same variable names and defaults as
 * phase 8's `config.ts` so the two agree on where everything lives.
 */
export function loadStandaloneConfig(env: EnvRecord = process.env): StandaloneConfig {
  const host = str(env, 'CONSOLE_HOST', '127.0.0.1');
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new StandaloneConfigError(
      `the setup wizard binds loopback only; CONSOLE_HOST=${host} is refused. Reach it through ` +
        'the Cloudflare tunnel, not by binding a public address.',
    );
  }

  const rawPort = str(env, 'CONSOLE_PORT', '7803');
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new StandaloneConfigError(`CONSOLE_PORT is not a valid port: ${rawPort}`);
  }

  // Only the literal string `false` turns the Access requirement off, so a typo fails closed.
  const requireAccess = str(env, 'CONSOLE_REQUIRE_ACCESS', 'true').toLowerCase() !== 'false';
  const accessTeam = str(env, 'CF_ACCESS_TEAM', '');
  const accessAud = str(env, 'CF_ACCESS_AUD', '');
  if (requireAccess && (accessTeam === '' || accessAud === '')) {
    throw new StandaloneConfigError(
      'CF_ACCESS_TEAM and CF_ACCESS_AUD are required while CONSOLE_REQUIRE_ACCESS is true. The ' +
        'installer writes both into cxw.env before the box boots; if they are missing, fix that ' +
        'rather than turning Access off.',
    );
  }

  const stateDir = str(env, 'CXW_STATE_DIR', '/srv/cxw/state');
  const vaultDir = str(env, 'CXW_VAULT_DIR', '/srv/cxw/repo/vault');
  return {
    host,
    port,
    requireAccess,
    accessTeam,
    accessAud,
    stateDir,
    ownersFile: str(env, 'CXW_OWNERS_FILE', `${stateDir}/owners.json`),
    envFilePath: str(env, 'CXW_ENV_FILE', '/srv/cxw/cxw.env'),
    googleEnvPath: str(env, 'CXW_GOOGLE_ENV_FILE', '/srv/cxw/google.env'),
    vaultDir,
    routinesDir: str(env, 'CXW_ROUTINES_DIR', `${vaultDir}/routines`),
    consoleHostname: str(env, 'CXW_CONSOLE_HOSTNAME', 'console.example.invalid'),
  };
}

/** Everything `createSetupHandler` needs, from a configuration. */
export function buildDeps(config: StandaloneConfig): SetupDeps {
  const verifyAccess = config.requireAccess
    ? createAccessVerifier({ team: config.accessTeam, aud: config.accessAud })
    : createOpenVerifier();
  return {
    stateDir: config.stateDir,
    ownersFile: config.ownersFile,
    envFilePath: config.envFilePath,
    googleEnvPath: config.googleEnvPath,
    vaultDir: config.vaultDir,
    routinesDir: config.routinesDir,
    consoleHostname: config.consoleHostname,
    verifyAccess,
    spawn: spawn as unknown as SetupSpawn,
  };
}

/** Create the server. Not listening yet, so a test can drive it without a socket. */
export function createStandaloneServer(config: StandaloneConfig): Server {
  const handler = createSetupHandler(buildDeps(config));
  return createServer((request, response) => {
    void handler(request, response)
      .then((handled) => {
        if (handled) return;
        // Nothing else exists on this branch: the console's own routes land with phase 8.
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'no such route' }));
      })
      .catch(() => {
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'the setup wizard failed to answer' }));
        }
      });
  });
}

export function start(env: EnvRecord = process.env): Server {
  const config = loadStandaloneConfig(env);
  const server = createStandaloneServer(config);
  server.listen(config.port, config.host, () => {
    console.log(`setup wizard on http://${config.host}:${String(config.port)}/setup`);
  });
  return server;
}

// Run only when executed directly, never on import, so the tests can load this module freely.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  start();
}
