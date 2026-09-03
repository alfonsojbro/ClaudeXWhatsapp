import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDeps,
  createStandaloneServer,
  loadStandaloneConfig,
  LOOPBACK_HOSTS,
} from './standalone.js';

const ACCESS = { CF_ACCESS_TEAM: 'alfonso', CF_ACCESS_AUD: 'aud-tag' };

describe('loadStandaloneConfig', () => {
  it('defaults to loopback, port 7803 and the documented paths', () => {
    const config = loadStandaloneConfig(ACCESS);
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(7803);
    expect(config.stateDir).toBe('/srv/cxw/state');
    expect(config.ownersFile).toBe('/srv/cxw/state/owners.json');
    expect(config.vaultDir).toBe('/srv/cxw/repo/vault');
    expect(config.routinesDir).toBe('/srv/cxw/repo/vault/routines');
    expect(config.requireAccess).toBe(true);
  });

  it('reads every documented environment variable', () => {
    const config = loadStandaloneConfig({
      ...ACCESS,
      CXW_STATE_DIR: '/tmp/state',
      CXW_OWNERS_FILE: '/tmp/owners.json',
      CXW_VAULT_DIR: '/tmp/vault',
      CONSOLE_PORT: '8080',
      CXW_CONSOLE_HOSTNAME: 'cxw.example.com',
    });
    expect(config.stateDir).toBe('/tmp/state');
    expect(config.ownersFile).toBe('/tmp/owners.json');
    expect(config.vaultDir).toBe('/tmp/vault');
    expect(config.routinesDir).toBe('/tmp/vault/routines');
    expect(config.port).toBe(8080);
    expect(config.consoleHostname).toBe('cxw.example.com');
  });

  it('accepts every loopback spelling and refuses anything else', () => {
    for (const host of LOOPBACK_HOSTS) {
      expect(loadStandaloneConfig({ ...ACCESS, CONSOLE_HOST: host }).host).toBe(host);
    }
    for (const host of ['0.0.0.0', '::', '10.0.0.5', 'cxw.example.com']) {
      expect(() => loadStandaloneConfig({ ...ACCESS, CONSOLE_HOST: host }), host).toThrow(
        /binds loopback only/,
      );
    }
  });

  it('refuses to start when Access is required and the pair is missing', () => {
    expect(() => loadStandaloneConfig({})).toThrow(/CF_ACCESS_TEAM and CF_ACCESS_AUD are required/);
    expect(() => loadStandaloneConfig({ CF_ACCESS_TEAM: 'alfonso' })).toThrow(/required/);
    expect(() => loadStandaloneConfig({ CF_ACCESS_AUD: 'aud' })).toThrow(/required/);
  });

  it('only the literal string false turns the Access requirement off', () => {
    expect(loadStandaloneConfig({ CONSOLE_REQUIRE_ACCESS: 'false' }).requireAccess).toBe(false);
    expect(loadStandaloneConfig({ CONSOLE_REQUIRE_ACCESS: 'FALSE' }).requireAccess).toBe(false);
    // A typo must fail closed, which here means still demanding the Access pair.
    expect(() => loadStandaloneConfig({ CONSOLE_REQUIRE_ACCESS: 'no' })).toThrow(/required/);
    expect(() => loadStandaloneConfig({ CONSOLE_REQUIRE_ACCESS: '0' })).toThrow(/required/);
  });

  it('refuses a port that is not a port', () => {
    expect(() => loadStandaloneConfig({ ...ACCESS, CONSOLE_PORT: 'http' })).toThrow(/valid port/);
    expect(() => loadStandaloneConfig({ ...ACCESS, CONSOLE_PORT: '99999' })).toThrow(/valid port/);
  });
});

describe('buildDeps', () => {
  it('carries the configuration through to the handler dependencies', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cxw-standalone-'));
    const deps = buildDeps(
      loadStandaloneConfig({ ...ACCESS, CXW_STATE_DIR: stateDir, CXW_CONSOLE_HOSTNAME: 'c.example' }),
    );
    expect(deps.stateDir).toBe(stateDir);
    expect(deps.consoleHostname).toBe('c.example');
    expect(typeof deps.verifyAccess).toBe('function');
  });

  it('uses the open verifier only when Access is explicitly disabled', async () => {
    const open = buildDeps(loadStandaloneConfig({ CONSOLE_REQUIRE_ACCESS: 'false' }));
    await expect(open.verifyAccess({ headers: {} } as never)).resolves.toMatchObject({
      email: 'dev@localhost',
    });
    const strict = buildDeps(loadStandaloneConfig(ACCESS));
    await expect(strict.verifyAccess({ headers: {} } as never)).rejects.toThrow(/no Cloudflare/);
  });
});

describe('createStandaloneServer', () => {
  it('builds a server without binding a socket', () => {
    const server = createStandaloneServer(loadStandaloneConfig(ACCESS));
    expect(server.listening).toBe(false);
    server.close();
  });
});
