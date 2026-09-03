import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createSetupHandler, MAX_BODY_BYTES } from './router.js';
import type { SetupDeps, SetupSpawn } from './router.js';
import { readSetupState, writeSetupState, freshSetupState } from './state.js';
import { AccessError } from './access-verify.js';

const HOST = 'cxw.example.com';

/** Every route the wizard owns, with the method it answers. */
const ROUTES: readonly (readonly [string, string])[] = [
  ['GET', '/setup'],
  ['GET', '/setup/whatsapp/status'],
  ['GET', '/setup/whatsapp/qr.svg'],
  ['GET', '/setup/claude/status'],
  ['GET', '/setup/google/start'],
  ['GET', '/setup/google/callback'],
  ['POST', '/setup/owner'],
  ['POST', '/setup/whatsapp/start'],
  ['POST', '/setup/whatsapp/pair-code'],
  ['POST', '/setup/claude/start'],
  ['POST', '/setup/claude/token'],
  ['POST', '/setup/claude/api-key'],
  ['POST', '/setup/google/start'],
  ['POST', '/setup/google/confirm-production'],
  ['POST', '/setup/routines'],
  ['POST', '/setup/vault'],
  ['POST', '/setup/done'],
];

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function response(): { res: ServerResponse; out: Captured } {
  const out: Captured = { status: 0, headers: {}, body: '' };
  let sent = false;
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      out.status = status;
      out.headers = headers ?? {};
      sent = true;
      return res;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) out.body += String(chunk);
    },
    get headersSent(): boolean {
      return sent;
    },
  } as unknown as ServerResponse;
  return { res, out };
}

function request(
  method: string,
  url: string,
  options: { headers?: Record<string, string>; body?: string | Buffer } = {},
): IncomingMessage {
  const body = options.body;
  const source =
    body === undefined || body === '' ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)];
  const stream = Readable.from(source) as unknown as IncomingMessage;
  (stream as { method?: string }).method = method;
  (stream as { url?: string }).url = url;
  (stream as { headers: Record<string, string> }).headers = options.headers ?? {};
  return stream;
}

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  (child as unknown as { exitCode: number | null }).exitCode = null;
  (child as unknown as { killed: boolean }).killed = false;
  (child as unknown as { unref: () => void }).unref = (): void => undefined;
  (child as unknown as { stdout: null }).stdout = null;
  (child as unknown as { stderr: null }).stderr = null;
  return child;
}

interface Fixture {
  readonly deps: SetupDeps;
  readonly stateDir: string;
  readonly ownersFile: string;
  readonly envFilePath: string;
  readonly googleEnvPath: string;
  readonly routinesDir: string;
  readonly spawned: string[][];
}

function fixture(over: Partial<SetupDeps> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'cxw-router-'));
  const stateDir = join(root, 'state');
  const routinesDir = join(root, 'vault', 'routines');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(routinesDir, { recursive: true });
  const spawned: string[][] = [];

  const deps: SetupDeps = {
    stateDir,
    ownersFile: join(stateDir, 'owners.json'),
    envFilePath: join(root, 'cxw.env'),
    googleEnvPath: join(root, 'google.env'),
    vaultDir: join(root, 'vault'),
    routinesDir,
    consoleHostname: HOST,
    verifyAccess: () => Promise.resolve({ email: 'alfonso@example.com' }),
    fetchImpl: (() =>
      Promise.resolve(new Response('', { status: 404 }))) as unknown as typeof fetch,
    spawn: ((command: string, args: readonly string[]) => {
      spawned.push([command, ...args]);
      return fakeChild();
    }) as unknown as SetupSpawn,
    now: () => 1_000,
    pairQrBaseUrl: 'http://127.0.0.1:7899',
    ...over,
  };
  return {
    deps,
    stateDir,
    ownersFile: deps.ownersFile,
    envFilePath: deps.envFilePath,
    googleEnvPath: deps.googleEnvPath,
    routinesDir,
    spawned,
  };
}

/** Mint the CSRF value the way the page does, by rendering the wizard once. */
async function csrfToken(deps: SetupDeps): Promise<string> {
  const handler = createSetupHandler(deps);
  const { res } = response();
  await handler(request('GET', '/setup'), res);
  const held = readSetupState(deps.stateDir).csrfToken;
  expect(held).toBeTypeOf('string');
  return held as string;
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' };

describe('access', () => {
  it('answers 403 on every route when verifyAccess throws', async () => {
    const { deps } = fixture({
      verifyAccess: () => Promise.reject(new AccessError('access: no assertion')),
    });
    const csrf = 'irrelevant';
    for (const [method, path] of ROUTES) {
      const handler = createSetupHandler(deps);
      const { res, out } = response();
      const handled = await handler(
        request(method, path, {
          headers: FORM_HEADERS,
          ...(method === 'POST' ? { body: form({ csrf }) } : {}),
        }),
        res,
      );
      expect(handled, `${method} ${path}`).toBe(true);
      expect(out.status, `${method} ${path}`).toBe(403);
      expect(out.body, `${method} ${path}`).toContain('access:');
    }
  });

  it('answers /setup/health with 204 and no body, without Access', async () => {
    const { deps } = fixture({
      verifyAccess: () => Promise.reject(new AccessError('access: no assertion')),
    });
    const { res, out } = response();
    expect(await createSetupHandler(deps)(request('GET', '/setup/health'), res)).toBe(true);
    expect(out.status).toBe(204);
    expect(out.body).toBe('');
  });

  it('leaks nothing else without Access: even the wizard shell is refused', async () => {
    const { deps } = fixture({
      verifyAccess: () => Promise.reject(new AccessError('access: no assertion')),
    });
    const { res, out } = response();
    await createSetupHandler(deps)(request('GET', '/setup'), res);
    expect(out.body).not.toContain('<form');
    expect(out.body).not.toContain('WhatsApp');
  });

  it('does not handle a path outside /setup at all', async () => {
    const { deps } = fixture();
    const { res } = response();
    expect(await createSetupHandler(deps)(request('GET', '/api/state'), res)).toBe(false);
    expect(await createSetupHandler(deps)(request('GET', '/setupsomething'), res)).toBe(false);
  });
});

describe('the wizard closes behind itself', () => {
  it('returns false for GET /setup once setup is complete, so the console takes it', async () => {
    const fx = fixture();
    writeSetupState(fx.stateDir, { ...freshSetupState(0), completedAt: '2026-09-03T00:00:00.000Z' });
    writeFileSync(fx.ownersFile, JSON.stringify({ owners: ['420123456789@s.whatsapp.net'] }));
    const { res, out } = response();
    expect(await createSetupHandler(fx.deps)(request('GET', '/setup'), res)).toBe(false);
    expect(out.status).toBe(0);
  });

  it('returns false for every other route once setup is complete', async () => {
    const fx = fixture();
    writeSetupState(fx.stateDir, { ...freshSetupState(0), completedAt: '2026-09-03T00:00:00.000Z' });
    writeFileSync(fx.ownersFile, JSON.stringify({ owners: ['420123456789@s.whatsapp.net'] }));
    for (const [method, path] of ROUTES) {
      const { res } = response();
      expect(
        await createSetupHandler(fx.deps)(request(method, path, { headers: FORM_HEADERS }), res),
        `${method} ${path}`,
      ).toBe(false);
    }
  });

  it('but /setup/health keeps answering, so the installer can still probe', async () => {
    const fx = fixture();
    writeSetupState(fx.stateDir, { ...freshSetupState(0), completedAt: '2026-09-03T00:00:00.000Z' });
    writeFileSync(fx.ownersFile, JSON.stringify({ owners: ['a@s.whatsapp.net'] }));
    const { res, out } = response();
    expect(await createSetupHandler(fx.deps)(request('GET', '/setup/health'), res)).toBe(true);
    expect(out.status).toBe(204);
  });

  it('re-opens when the owners file is gone, even though setup was completed', async () => {
    const fx = fixture();
    writeSetupState(fx.stateDir, { ...freshSetupState(0), completedAt: '2026-09-03T00:00:00.000Z' });
    const { res, out } = response();
    expect(await createSetupHandler(fx.deps)(request('GET', '/setup'), res)).toBe(true);
    expect(out.status).toBe(200);
  });
});

describe('POST defences', () => {
  it('rejects a POST whose Origin is another site', async () => {
    const fx = fixture();
    const csrf = await csrfToken(fx.deps);
    const { res, out } = response();
    await createSetupHandler(fx.deps)(
      request('POST', '/setup/owner', {
        headers: { ...FORM_HEADERS, origin: 'https://evil.example.com' },
        body: form({ csrf, number: '420123456789' }),
      }),
      res,
    );
    expect(out.status).toBe(403);
    expect(out.body).toContain('another origin');
    // Nothing was written.
    expect(() => readFileSync(fx.ownersFile, 'utf8')).toThrow();
  });

  it('accepts a POST from its own origin', async () => {
    const fx = fixture();
    const csrf = await csrfToken(fx.deps);
    const { res, out } = response();
    await createSetupHandler(fx.deps)(
      request('POST', '/setup/owner', {
        headers: { ...FORM_HEADERS, origin: `https://${HOST}` },
        body: form({ csrf, number: '+420 123 456 789' }),
      }),
      res,
    );
    expect(out.status).toBe(303);
    expect(JSON.parse(readFileSync(fx.ownersFile, 'utf8')).owners).toEqual([
      '420123456789@s.whatsapp.net',
    ]);
  });

  it('rejects a POST with no CSRF value', async () => {
    const fx = fixture();
    await csrfToken(fx.deps);
    const { res, out } = response();
    await createSetupHandler(fx.deps)(
      request('POST', '/setup/owner', {
        headers: FORM_HEADERS,
        body: form({ number: '420123456789' }),
      }),
      res,
    );
    expect(out.status).toBe(403);
    expect(out.body).toContain('went stale');
  });

  it('rejects a POST with the wrong CSRF value', async () => {
    const fx = fixture();
    await csrfToken(fx.deps);
    const { res, out } = response();
    await createSetupHandler(fx.deps)(
      request('POST', '/setup/owner', {
        headers: FORM_HEADERS,
        body: form({ csrf: 'not-the-token', number: '420123456789' }),
      }),
      res,
    );
    expect(out.status).toBe(403);
  });

  it('rejects a body over the size cap', async () => {
    const fx = fixture();
    const csrf = await csrfToken(fx.deps);
    const oversized = Buffer.from(`csrf=${csrf}&number=${'9'.repeat(MAX_BODY_BYTES + 1)}`);
    const { res, out } = response();
    await createSetupHandler(fx.deps)(
      request('POST', '/setup/owner', { headers: FORM_HEADERS, body: oversized }),
      res,
    );
    expect(out.status).toBe(413);
    expect(out.body).toContain('too large');
  });

  it('rejects a body just over the cap even when it would otherwise be valid', async () => {
    const fx = fixture();
    const csrf = await csrfToken(fx.deps);
    const padding = 'x'.repeat(MAX_BODY_BYTES);
    const { res, out } = response();
    await createSetupHandler(fx.deps)(
      request('POST', '/setup/owner', {
        headers: FORM_HEADERS,
        body: form({ csrf, number: '420123456789', pad: padding }),
      }),
      res,
    );
    expect(out.status).toBe(413);
    expect(() => readFileSync(fx.ownersFile, 'utf8')).toThrow();
  });
});

describe('routes', () => {
  it('renders the first pending step by default and honours ?step=', async () => {
    const fx = fixture();
    const handler = createSetupHandler(fx.deps);
    const first = response();
    await handler(request('GET', '/setup'), first.res);
    expect(first.out.status).toBe(200);
    expect(first.out.body).toContain('Who owns this assistant');

    const asked = response();
    await handler(request('GET', '/setup?step=vault'), asked.res);
    expect(asked.out.body).toContain('Back the vault up to git');
  });

  it('sets a no-store, no-external-resource policy on every page', async () => {
    const fx = fixture();
    const { res, out } = response();
    await createSetupHandler(fx.deps)(request('GET', '/setup'), res);
    expect(out.headers['cache-control']).toBe('no-store');
    expect(out.headers['content-security-policy']).toContain("default-src 'none'");
    expect(out.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('serves the QR from its own endpoint with an image type', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    const fx = fixture({
      fetchImpl: ((url: string) =>
        Promise.resolve(
          String(url).endsWith('/qr.svg')
            ? new Response(svg, { status: 200 })
            : new Response(JSON.stringify({ status: 'waiting', qrCount: 1 }), { status: 200 }),
        )) as unknown as typeof fetch,
    });
    const { res, out } = response();
    await createSetupHandler(fx.deps)(request('GET', '/setup/whatsapp/qr.svg'), res);
    expect(out.status).toBe(200);
    expect(out.headers['content-type']).toBe('image/svg+xml');
    expect(out.body).toBe(svg);
  });

  it('answers 404 for the QR before the first code exists', async () => {
    const fx = fixture();
    const { res, out } = response();
    await createSetupHandler(fx.deps)(request('GET', '/setup/whatsapp/qr.svg'), res);
    expect(out.status).toBe(404);
    expect(out.body).toContain('pnpm pair:qr');
  });

  it('reports the pairing state as JSON for the poller', async () => {
    const fx = fixture({
      fetchImpl: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ status: 'waiting', attempt: 2, qrCount: 4 }), {
            status: 200,
          }),
        )) as unknown as typeof fetch,
    });
    const { res, out } = response();
    await createSetupHandler(fx.deps)(request('GET', '/setup/whatsapp/status'), res);
    expect(JSON.parse(out.body)).toMatchObject({ status: 'waiting', qrCount: 4, polling: true });
  });

  it('never echoes the Claude token back, only saved and the last four', async () => {
    const fx = fixture();
    const csrf = await csrfToken(fx.deps);
    const secret = 'sk-ant-oat-01-THE-WHOLE-SECRET-7788';
    const { res, out } = response();
    await createSetupHandler(fx.deps)(
      request('POST', '/setup/claude/token', {
        headers: FORM_HEADERS,
        body: form({ csrf, token: secret }),
      }),
      res,
    );
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ saved: true, last4: '7788', next: '/setup' });
    expect(out.body).not.toContain('THE-WHOLE-SECRET');
    expect(readFileSync(fx.envFilePath, 'utf8')).toContain(secret);
  });

  it('never echoes the API key back either', async () => {
    const fx = fixture();
    const csrf = await csrfToken(fx.deps);
    const secret = 'sk-ant-api03-ANOTHER-SECRET-4321';
    const { res, out } = response();
    await createSetupHandler(fx.deps)(
      request('POST', '/setup/claude/api-key', {
        headers: FORM_HEADERS,
        body: form({ csrf, apikey: secret }),
      }),
      res,
    );
    expect(out.body).not.toContain('ANOTHER-SECRET');
    expect(JSON.parse(out.body).last4).toBe('4321');
  });

  it('never renders a saved secret back into the Claude page', async () => {
    const fx = fixture();
    const csrf = await csrfToken(fx.deps);
    const secret = 'sk-ant-oat-01-NEVER-RENDER-ME-5566';
    const handler = createSetupHandler(fx.deps);
    const saved = response();
    await handler(
      request('POST', '/setup/claude/token', {
        headers: FORM_HEADERS,
        body: form({ csrf, token: secret }),
      }),
      saved.res,
    );
    const page = response();
    await handler(request('GET', '/setup?step=claude'), page.res);
    expect(page.out.body).not.toContain('NEVER-RENDER-ME');
    expect(page.out.body).toContain('5566');
  });

  it('starts the Google flow, writes the client details to google.env only, and redirects', async () => {
    const fx = fixture();
    const csrf = await csrfToken(fx.deps);
    const { res, out } = response();
    await createSetupHandler(fx.deps)(
      request('POST', '/setup/google/start', {
        headers: FORM_HEADERS,
        body: form({
          csrf,
          clientId: 'cid.apps',
          clientSecret: 'THE-CLIENT-SECRET',
          ownerEmail: 'alfonso@example.com',
        }),
      }),
      res,
    );
    expect(out.status).toBe(303);
    const location = out.headers['location'] ?? '';
    expect(location).toContain('accounts.google.com');
    expect(location).not.toContain('THE-CLIENT-SECRET');
    expect(readFileSync(fx.googleEnvPath, 'utf8')).toContain('THE-CLIENT-SECRET');
    // The secret is never held in setup.json.
    expect(JSON.stringify(readSetupState(fx.stateDir))).not.toContain('THE-CLIENT-SECRET');
    expect(readSetupState(fx.stateDir).googleOauthState).toBeTypeOf('string');
  });

  it('rejects a Google callback whose state does not match', async () => {
    const fx = fixture();
    const csrf = await csrfToken(fx.deps);
    const handler = createSetupHandler(fx.deps);
    const started = response();
    await handler(
      request('POST', '/setup/google/start', {
        headers: FORM_HEADERS,
        body: form({ csrf, clientId: 'cid', clientSecret: 'sec', ownerEmail: 'a@b.c' }),
      }),
      started.res,
    );
    const { res, out } = response();
    await handler(request('GET', '/setup/google/callback?code=abc&state=wrong'), res);
    expect(out.status).toBe(200);
    expect(out.body).toContain('did not match the request this box started');
    expect(readSetupState(fx.stateDir).steps.google.status).toBe('pending');
  });

  it('rejects a Google callback with no state at all', async () => {
    const fx = fixture();
    const { res, out } = response();
    await createSetupHandler(fx.deps)(request('GET', '/setup/google/callback?code=abc'), res);
    expect(out.body).toContain('did not match');
  });

  it('records the production confirmation without touching anything else', async () => {
    const fx = fixture();
    const csrf = await csrfToken(fx.deps);
    const { res, out } = response();
    await createSetupHandler(fx.deps)(
      request('POST', '/setup/google/confirm-production', {
        headers: FORM_HEADERS,
        body: form({ csrf, confirmed: 'yes' }),
      }),
      res,
    );
    expect(out.status).toBe(303);
    expect(readSetupState(fx.stateDir).googleConsentConfirmed).toBe(true);
  });

  it('saves the timezone and flips only the routines that were ticked', async () => {
    const fx = fixture();
    const csrf = await csrfToken(fx.deps);
    const a = join(fx.routinesDir, 'a.md');
    const b = join(fx.routinesDir, 'b.md');
    writeFileSync(a, '---\nname: a\nenabled: false\n---\nbody\n');
    writeFileSync(b, '---\nname: b\nenabled: true\n---\nbody\n');
    const { res, out } = response();
    await createSetupHandler(fx.deps)(
      request('POST', '/setup/routines', {
        headers: FORM_HEADERS,
        body: `${form({ csrf, timezone: 'Europe/Prague' })}&enabled=a`,
      }),
      res,
    );
    expect(out.status).toBe(303);
    expect(readFileSync(a, 'utf8')).toContain('enabled: true');
    expect(readFileSync(b, 'utf8')).toContain('enabled: false');
    expect(readFileSync(fx.envFilePath, 'utf8')).toContain('CXW_TZ=Europe/Prague');
  });

  it('shows a rejected timezone as a message rather than a stack trace', async () => {
    const fx = fixture();
    const csrf = await csrfToken(fx.deps);
    const { res, out } = response();
    await createSetupHandler(fx.deps)(
      request('POST', '/setup/routines', {
        headers: FORM_HEADERS,
        body: form({ csrf, timezone: 'Mars/Olympus' }),
      }),
      res,
    );
    expect(out.status).toBe(200);
    expect(out.body).toContain('not a timezone this box knows');
  });

  it('refuses to skip the owner step', async () => {
    const fx = fixture();
    const csrf = await csrfToken(fx.deps);
    const { res, out } = response();
    await createSetupHandler(fx.deps)(
      request('POST', '/setup/owner', { headers: FORM_HEADERS, body: form({ csrf, skip: 'owner' }) }),
      res,
    );
    expect(out.body).toContain('cannot be skipped');
    expect(readSetupState(fx.stateDir).steps.owner.status).toBe('pending');
  });

  it('records a skipped step and moves on', async () => {
    const fx = fixture();
    const csrf = await csrfToken(fx.deps);
    const { res, out } = response();
    await createSetupHandler(fx.deps)(
      request('POST', '/setup/vault', { headers: FORM_HEADERS, body: form({ csrf, skip: 'vault' }) }),
      res,
    );
    expect(out.status).toBe(303);
    expect(readSetupState(fx.stateDir).steps.vault.status).toBe('skipped');
  });

  it('spawns the pairing helper at most once across two starts', async () => {
    const fx = fixture();
    const csrf = await csrfToken(fx.deps);
    const handler = createSetupHandler(fx.deps);
    for (let i = 0; i < 2; i += 1) {
      const { res } = response();
      await handler(
        request('POST', '/setup/whatsapp/start', { headers: FORM_HEADERS, body: form({ csrf }) }),
        res,
      );
    }
    expect(fx.spawned.filter((call) => call[0] === 'pnpm')).toHaveLength(1);
  });

  it('finishing setup stamps completedAt and sends the person to the console', async () => {
    const fx = fixture();
    const csrf = await csrfToken(fx.deps);
    const { res, out } = response();
    await createSetupHandler(fx.deps)(
      request('POST', '/setup/done', { headers: FORM_HEADERS, body: form({ csrf }) }),
      res,
    );
    expect(out.status).toBe(303);
    expect(out.headers['location']).toBe('/');
    expect(readSetupState(fx.stateDir).completedAt).toBeTypeOf('string');
  });

  it('is idempotent: running the owner step twice leaves the same file and state', async () => {
    const fx = fixture();
    const csrf = await csrfToken(fx.deps);
    const handler = createSetupHandler(fx.deps);
    for (let i = 0; i < 2; i += 1) {
      const { res } = response();
      await handler(
        request('POST', '/setup/owner', {
          headers: FORM_HEADERS,
          body: form({ csrf, number: '420123456789' }),
        }),
        res,
      );
    }
    expect(JSON.parse(readFileSync(fx.ownersFile, 'utf8')).owners).toEqual([
      '420123456789@s.whatsapp.net',
    ]);
    expect(readSetupState(fx.stateDir).steps.owner.status).toBe('done');
  });

  it('does not answer a POST to an unknown /setup path', async () => {
    const fx = fixture();
    const csrf = await csrfToken(fx.deps);
    const { res } = response();
    expect(
      await createSetupHandler(fx.deps)(
        request('POST', '/setup/nonsense', { headers: FORM_HEADERS, body: form({ csrf }) }),
        res,
      ),
    ).toBe(false);
  });
});
