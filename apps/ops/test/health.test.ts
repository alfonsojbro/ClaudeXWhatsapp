import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import { healActions, runHealth } from '../src/health.js';
import { cleanupTempDirs, makeTempDir, OWNER, startStub } from './helpers.js';
import type { StubServer } from './helpers.js';

afterAll(cleanupTempDirs);

const okBridge = () => ({
  status: 200,
  json: { ok: true, connected: true, selfJid: OWNER, uptimeSec: 42 },
});
const okBrain = () => ({ status: 200, json: { ok: true, sessions: 0 } });
const okGoogle = () => ({
  status: 200,
  json: { access_token: 'stub', expires_in: 3600, token_type: 'Bearer' },
});

interface Env {
  cfg: Config;
  stateDir: string;
  bridge: StubServer;
  brain: StubServer;
  google: StubServer;
  close: () => Promise<void>;
}

async function makeEnv(overrides: Record<string, string> = {}): Promise<Env> {
  const dir = makeTempDir();
  const stateDir = path.join(dir, 'state');
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'owners.json'), JSON.stringify({ owners: [OWNER] }));
  fs.writeFileSync(path.join(stateDir, 'last-backup'), new Date().toISOString());

  const bridge = await startStub(okBridge);
  const brain = await startStub(okBrain);
  const google = await startStub(okGoogle);

  const cfg = loadConfig({
    CXW_STATE_DIR: stateDir,
    CXW_DATA_DIR: dataDir,
    CXW_OWNERS_FILE: path.join(stateDir, 'owners.json'),
    BRIDGE_URL: bridge.url,
    BRAIN_URL: brain.url,
    CXW_GOOGLE_TOKEN_URL: `${google.url}/token`,
    GOOGLE_CLIENT_ID: 'stub',
    GOOGLE_CLIENT_SECRET: 'stub',
    GOOGLE_REFRESH_TOKEN: 'stub',
    CLAUDE_CODE_OAUTH_TOKEN: 'stub',
    CXW_CLAUDE_AUTH_DEEP_CHECK_MIN: '0',
    CXW_ALERT_TRANSPORT: 'log',
    // The developer machine's real disk fill level must not decide the test outcome.
    CXW_DISK_LIMIT_PCT: '100',
    HEALTH_TIMEOUT_MS: '3000',
    CXW_SUDO: '',
    ...overrides,
  });

  return {
    cfg,
    stateDir,
    bridge,
    brain,
    google,
    close: async () => {
      await Promise.all([bridge.close(), brain.close(), google.close()]);
    },
  };
}

describe('runHealth', () => {
  it('reports every check green against healthy stubs', async () => {
    const env = await makeEnv();
    try {
      const report = await runHealth(env.cfg);
      expect(report.ok).toBe(true);
      expect(report.checks.map((c) => c.name)).toEqual([
        'whatsapp',
        'brain',
        'google',
        'disk',
        'backup',
        'claude_auth',
      ]);
      expect(healActions(report)).toEqual([]);
      const written = JSON.parse(fs.readFileSync(path.join(env.stateDir, 'health.json'), 'utf8'));
      expect(written.ok).toBe(true);
    } finally {
      await env.close();
    }
  });

  it('fails whatsapp with a restart heal when the bridge is down', async () => {
    const env = await makeEnv();
    await env.bridge.close();
    try {
      const report = await runHealth(env.cfg);
      const check = report.checks.find((c) => c.name === 'whatsapp');
      expect(check?.ok).toBe(false);
      expect(healActions(report)).toContain('restart bridge');
    } finally {
      await env.close();
    }
  });

  it('fails whatsapp when the bridge is up but not connected', async () => {
    const env = await makeEnv();
    env.bridge.setHandler(() => ({ status: 200, json: { ok: true, connected: false } }));
    try {
      const report = await runHealth(env.cfg);
      expect(report.checks.find((c) => c.name === 'whatsapp')?.ok).toBe(false);
    } finally {
      await env.close();
    }
  });

  it('fails google on a 401 from the token endpoint', async () => {
    const env = await makeEnv();
    env.google.setHandler(() => ({ status: 401, json: { error: 'invalid_grant' } }));
    try {
      const report = await runHealth(env.cfg);
      const check = report.checks.find((c) => c.name === 'google');
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain('401');
      expect(check?.healAction).toBeNull();
    } finally {
      await env.close();
    }
  });

  it('skips google when the check is turned off', async () => {
    const env = await makeEnv({ CXW_GOOGLE_CHECK: 'off' });
    try {
      const report = await runHealth(env.cfg);
      expect(report.checks.find((c) => c.name === 'google')).toMatchObject({
        ok: true,
        detail: 'disabled',
      });
    } finally {
      await env.close();
    }
  });

  it('fails disk with an emergency purge heal when the limit is zero', async () => {
    const env = await makeEnv({ CXW_DISK_LIMIT_PCT: '0' });
    try {
      const report = await runHealth(env.cfg);
      expect(report.checks.find((c) => c.name === 'disk')?.ok).toBe(false);
      expect(healActions(report)).toContain('purge --emergency');
    } finally {
      await env.close();
    }
  });

  it('fails backup when the marker is stale', async () => {
    const env = await makeEnv({ CXW_BACKUP_MAX_AGE_H: '1' });
    fs.writeFileSync(
      path.join(env.stateDir, 'last-backup'),
      new Date(Date.now() - 5 * 3_600_000).toISOString(),
    );
    try {
      const report = await runHealth(env.cfg);
      expect(report.checks.find((c) => c.name === 'backup')?.ok).toBe(false);
      expect(healActions(report)).toContain('backup');
    } finally {
      await env.close();
    }
  });

  it('never proposes restarting the brain while the panic flag is set', async () => {
    const env = await makeEnv();
    fs.writeFileSync(
      path.join(env.stateDir, 'panic'),
      JSON.stringify({ since: new Date().toISOString(), by: 'test', reason: 'test' }),
    );
    await env.brain.close();
    try {
      const report = await runHealth(env.cfg);
      const brain = report.checks.find((c) => c.name === 'brain');
      expect(brain?.ok).toBe(false);
      expect(brain?.detail).toBe('panic mode, expected down');
      expect(brain?.noAlert).toBe(true);
      expect(healActions(report)).not.toContain('restart brain');
    } finally {
      await env.close();
    }
  });

  it('never spawns the deep auth check when the interval is zero', async () => {
    const env = await makeEnv({ CXW_CLAUDE_BIN: '/nonexistent/claude-binary' });
    try {
      const report = await runHealth(env.cfg);
      const auth = report.checks.find((c) => c.name === 'claude_auth');
      expect(auth?.ok).toBe(true);
      expect(auth?.detail).toBe('oauth token set');
      expect(fs.existsSync(path.join(env.stateDir, 'claude-auth-deep.json'))).toBe(false);
    } finally {
      await env.close();
    }
  });

  it('fails claude_auth when no token and no usable credentials file exist', async () => {
    const env = await makeEnv({
      CLAUDE_CODE_OAUTH_TOKEN: '',
      CXW_CLAUDE_CREDENTIALS_FILE: '/nonexistent/creds.json',
    });
    try {
      const report = await runHealth(env.cfg);
      expect(report.checks.find((c) => c.name === 'claude_auth')?.ok).toBe(false);
      expect(report.ok).toBe(false);
    } finally {
      await env.close();
    }
  });
});

describe('cxw-ops health --json', () => {
  it('prints one JSON object and nothing else on stdout, with logs on stderr', async () => {
    const dir = makeTempDir();
    const state = path.join(dir, 'state');
    const data = path.join(dir, 'data');
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    const ownersFile = path.join(state, 'owners.json');
    // Corrupt on purpose: this is what made the logger write to stdout.
    fs.writeFileSync(ownersFile, 'not json');

    const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          path.join(process.cwd(), 'node_modules', '.bin', 'tsx'),
          [path.join(process.cwd(), 'src', 'cli.ts'), 'health', '--json'],
          {
            env: {
              ...process.env,
              CXW_STATE_DIR: state,
              CXW_DATA_DIR: data,
              CXW_OWNERS_FILE: ownersFile,
              CXW_ALERT_TRANSPORT: 'log',
              CXW_GOOGLE_CHECK: 'off',
              CXW_SUDO: '',
              LOG_LEVEL: 'info',
              BRIDGE_URL: 'http://127.0.0.1:1',
              BRAIN_URL: 'http://127.0.0.1:1',
              HEALTH_TIMEOUT_MS: '300',
              TELEGRAM_ALERTS: 'false',
              SMTP_HOST: '',
            },
            timeout: 30_000,
          },
          (err, stdout, stderr) => {
            const code =
              err === null ? 0 : ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1);
            resolve({
              code: typeof code === 'number' ? code : null,
              stdout: String(stdout),
              stderr: String(stderr),
            });
          },
        );
      },
    );

    expect(run.code).toBe(1); // every check fails against a closed port
    const parsed = JSON.parse(run.stdout) as { ok: boolean; checks: unknown[] };
    expect(parsed.ok).toBe(false);
    expect(Array.isArray(parsed.checks)).toBe(true);
    // The owners-file warning is a log line, so it must have gone to stderr.
    expect(run.stderr).toContain('owners file is not valid JSON');
  }, 40_000);
});
