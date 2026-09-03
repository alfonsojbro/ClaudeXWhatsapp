/**
 * The setup wizard, as a handler that can be mounted in an existing server.
 *
 * INTEGRATION IP-1: phase 8's `apps/console/src/server.ts` mounts this in two lines, at the top
 * of `handle()`, immediately after the `/api/health` early return and *before* its own Access
 * check (this handler does its own):
 *
 *     const setup = createSetupHandler({ ...deps.config, verifyAccess: deps.verifier.verifyToken });
 *     if (await setup(request, response)) return;
 *
 * `createSetupHandler` returns `true` when it answered the request and `false` when it did not,
 * so the console keeps every route it owns. When setup is finished the handler returns `false`
 * for everything except `/setup/health`, which is what makes `/setup` a 404 rather than a way
 * back in.
 *
 * There is no approval route here and there never will be. Approving a confirm token is the
 * owner replying in WhatsApp, HMAC-bound to a chat JID; a browser control for it would be a
 * second, weaker path to the same authority. `guardrails.test.ts` asserts the absence.
 */

import { randomBytes } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { parseEnvFile, readEnvFile } from './envfile.js';
import { completeSetup, isSetupMode } from './mode.js';
import {
  renderClaude,
  renderFinish,
  renderGoogle,
  renderOwner,
  renderPage,
  renderRoutines,
  renderVault,
  renderWhatsapp,
  WHATSAPP_POLL_SCRIPT,
} from './render.js';
import type { Banner, PageContext, Screen } from './render.js';
import { markStep, readSetupState, STEP_IDS, writeSetupState } from './state.js';
import type { SetupState, StepId } from './state.js';
import type { VerifyAccess } from './access-verify.js';
import { last4, parseDeviceFlow, saveApiKey, saveOauthToken, startClaudeSetupToken } from './steps/claude.js';
import { renderDone } from './steps/done.js';
import {
  buildAuthUrl,
  exchangeCode,
  newOauthState,
  stateMatches,
  writeGoogleEnv,
} from './steps/google.js';
import { saveOwner } from './steps/owner.js';
import { listRoutines, setRoutineEnabled, setTimezone } from './steps/routines.js';
import { gitRunner, setVaultRemote } from './steps/vault.js';
import {
  createPairing,
  fetchPairStatus,
  fetchQrSvg,
  PAIR_COMMAND,
  PAIR_QR_DEFAULT_BASE_URL,
  toPairView,
} from './steps/whatsapp.js';

/** A body larger than this is refused unread. Every form here is a few hundred bytes. */
export const MAX_BODY_BYTES = 16 * 1024;

export interface SpawnLikeOptions {
  readonly cwd?: string;
  readonly detached?: boolean;
  readonly stdio?: unknown;
}

export type SetupSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnLikeOptions,
) => ChildProcess;

export interface SetupDeps {
  readonly stateDir: string;
  readonly ownersFile: string;
  /** `cxw.env`: the Anthropic credentials and the timezone. */
  readonly envFilePath: string;
  /** `google.env`: the four GOOGLE_ keys. */
  readonly googleEnvPath: string;
  readonly vaultDir: string;
  readonly routinesDir: string;
  /** `cxw.example.com`. Used for the redirect URI, the origin check and the console link. */
  readonly consoleHostname: string;
  readonly verifyAccess: VerifyAccess;
  readonly fetchImpl?: typeof fetch;
  readonly spawn: SetupSpawn;
  readonly now?: () => number;
  readonly pairQrBaseUrl?: string;
  /** Phases that have actually merged. Drives the "lands with phase N" wording. */
  readonly mergedPhases?: readonly number[];
}

export type SetupHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<boolean>;

class HandledError extends Error {
  readonly screen: Screen;
  constructor(screen: Screen, message: string) {
    super(message);
    this.name = 'HandledError';
    this.screen = screen;
  }
}

function html(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // The page loads nothing from anywhere. Its one script is inline and the CSS is inline.
    'content-security-policy':
      "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(body);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(JSON.stringify(body));
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location, 'cache-control': 'no-store' });
  response.end();
}

export class BodyTooLargeError extends Error {
  constructor() {
    super('that form was too large');
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Read a form body, refusing anything over the cap.
 *
 * The check is per chunk and stops reading, so an attacker cannot make the box buffer a
 * gigabyte before being told no. Every form on this wizard is a few hundred bytes.
 */
async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export function createSetupHandler(deps: SetupDeps): SetupHandler {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? ((): number => Date.now());
  const pairBase = deps.pairQrBaseUrl ?? PAIR_QR_DEFAULT_BASE_URL;
  const pairing = createPairing(deps.spawn);

  /** `claude setup-token`'s output, held only while the flow is in progress. */
  let claudeChild: ChildProcess | null = null;
  let claudeOutput = '';

  function state(): SetupState {
    return readSetupState(deps.stateDir, now());
  }

  /** The CSRF value, minted once and held in setup.json alongside the rest of the progress. */
  function csrfFor(current: SetupState): { state: SetupState; csrf: string } {
    if (typeof current.csrfToken === 'string' && current.csrfToken !== '') {
      return { state: current, csrf: current.csrfToken };
    }
    const csrf = randomBytes(24).toString('base64url');
    const next: SetupState = { ...current, csrfToken: csrf };
    writeSetupState(deps.stateDir, next);
    return { state: next, csrf };
  }

  /** The first step that is still pending, or the done screen. */
  function nextScreen(current: SetupState): Screen {
    for (const id of STEP_IDS) if (current.steps[id].status === 'pending') return id;
    return 'done';
  }

  function context(current: SetupState, screen: Screen, banner?: Banner): PageContext {
    const held = csrfFor(current);
    return {
      state: held.state,
      screen,
      consoleHostname: deps.consoleHostname,
      csrf: held.csrf,
      ...(banner === undefined ? {} : { banner }),
    };
  }

  /**
   * A POST is accepted only from this console's own origin, and only with the CSRF value that
   * is in `setup.json`. Same shape as phase 8's console defence, for the same reason: Access
   * authenticates the person, not the page that made the request.
   */
  function originAllowed(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (origin === undefined || origin === 'null') return true;
    return origin === `https://${deps.consoleHostname}`;
  }

  function csrfOk(form: URLSearchParams, current: SetupState): boolean {
    const held = current.csrfToken;
    if (typeof held !== 'string' || held === '') return false;
    return form.get('csrf') === held;
  }

  function googleRedirectUri(): string {
    return `https://${deps.consoleHostname}/setup/google/callback`;
  }

  /** What is already in `google.env`, so a re-run does not ask for it twice. */
  function googleEnv(): Map<string, string> {
    return parseEnvFile(readEnvFile(deps.googleEnvPath));
  }

  function claudeSaved(): { kind: 'oauth' | 'api-key' | 'none'; last4: string } {
    const env = parseEnvFile(readEnvFile(deps.envFilePath));
    const oauth = env.get('CLAUDE_CODE_OAUTH_TOKEN') ?? '';
    if (oauth !== '' && oauth !== 'CHANGEME') return { kind: 'oauth', last4: last4(oauth) };
    const key = env.get('ANTHROPIC_API_KEY') ?? '';
    if (key !== '' && key !== 'CHANGEME') return { kind: 'api-key', last4: last4(key) };
    return { kind: 'none', last4: '' };
  }

  async function renderScreen(
    response: ServerResponse,
    current: SetupState,
    screen: Screen,
    banner?: Banner,
  ): Promise<void> {
    const ctx = context(current, screen, banner);
    if (screen === 'owner') {
      html(response, 200, renderPage(ctx, renderOwner(ctx, '')));
      return;
    }
    if (screen === 'whatsapp') {
      const view = toPairView(await fetchPairStatus(pairBase, fetchImpl));
      const head = view.polling ? WHATSAPP_POLL_SCRIPT : '';
      html(response, 200, renderPage(ctx, renderWhatsapp(ctx, view), head));
      return;
    }
    if (screen === 'claude') {
      const flow = parseDeviceFlow(claudeOutput);
      const saved = claudeSaved();
      html(
        response,
        200,
        renderPage(
          ctx,
          renderClaude(ctx, {
            url: flow?.url ?? '',
            code: flow?.code ?? '',
            running: claudeChild !== null,
            savedLast4: saved.last4,
            savedKind: saved.kind,
          }),
        ),
      );
      return;
    }
    if (screen === 'google') {
      const env = googleEnv();
      html(
        response,
        200,
        renderPage(
          ctx,
          renderGoogle(ctx, {
            connected: (env.get('GOOGLE_REFRESH_TOKEN') ?? '') !== '',
            ownerEmail: env.get('GOOGLE_OWNER_EMAIL') ?? '',
            consentConfirmed: current.googleConsentConfirmed === true,
            redirectUri: googleRedirectUri(),
          }),
        ),
      );
      return;
    }
    if (screen === 'routines') {
      const listing = listRoutines(deps.routinesDir);
      const tz = current.timezone ?? parseEnvFile(readEnvFile(deps.envFilePath)).get('TZ') ?? '';
      html(response, 200, renderPage(ctx, renderRoutines(ctx, listing, tz)));
      return;
    }
    if (screen === 'vault') {
      html(response, 200, renderPage(ctx, renderVault(ctx, '')));
      return;
    }
    html(response, 200, renderPage(ctx, renderFinish(ctx, renderDone(current, deps.mergedPhases ?? []))));
  }

  function advance(current: SetupState, id: StepId, status: 'done' | 'skipped'): SetupState {
    const next = markStep(current, id, status, now());
    writeSetupState(deps.stateDir, next);
    return next;
  }

  function toNext(response: ServerResponse, current: SetupState): void {
    const screen = nextScreen(current);
    redirect(response, screen === 'done' ? '/setup?step=done' : `/setup?step=${screen}`);
  }

  // ---------------------------------------------------------------- POST handlers

  async function postOwner(
    response: ServerResponse,
    form: URLSearchParams,
    current: SetupState,
  ): Promise<void> {
    if (form.get('skip') !== null) {
      // The owner step is the one step that cannot be skipped: with no owner the assistant
      // answers nobody, and the box would come out of setup unusable.
      throw new HandledError('owner', 'The assistant needs an owner. This step cannot be skipped.');
    }
    saveOwner(deps.ownersFile, form.get('number') ?? '');
    toNext(response, advance(current, 'owner', 'done'));
    return Promise.resolve();
  }

  async function postWhatsapp(
    response: ServerResponse,
    form: URLSearchParams,
    current: SetupState,
  ): Promise<void> {
    if (form.get('skip') !== null) {
      toNext(response, advance(current, 'whatsapp', 'skipped'));
      return;
    }
    if (form.get('confirm') === 'linked') {
      toNext(response, advance(current, 'whatsapp', 'done'));
      return;
    }
    pairing.start();
    const view = toPairView(await fetchPairStatus(pairBase, fetchImpl));
    if (view.done) {
      toNext(response, advance(current, 'whatsapp', 'done'));
      return;
    }
    redirect(response, '/setup?step=whatsapp');
  }

  function postClaudeStart(response: ServerResponse): void {
    if (claudeChild === null) {
      claudeOutput = '';
      const child = startClaudeSetupToken(deps.spawn);
      claudeChild = child;
      const collect = (chunk: Buffer): void => {
        // Bounded: the device-flow banner is a few hundred bytes, and this buffer is only
        // ever scanned for a URL and a code. It is not the token, which the person pastes.
        if (claudeOutput.length < 8192) claudeOutput += chunk.toString('utf8');
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      child.on('exit', () => {
        claudeChild = null;
      });
      child.on('error', () => {
        claudeChild = null;
      });
    }
    redirect(response, '/setup?step=claude');
  }

  function postGoogleStart(
    response: ServerResponse,
    form: URLSearchParams,
    current: SetupState,
  ): void {
    if (form.get('skip') !== null) {
      toNext(response, advance(current, 'google', 'skipped'));
      return;
    }
    const env = googleEnv();
    const clientId = (form.get('clientId') ?? env.get('GOOGLE_CLIENT_ID') ?? '').trim();
    const clientSecret = (form.get('clientSecret') ?? env.get('GOOGLE_CLIENT_SECRET') ?? '').trim();
    const ownerEmail = (form.get('ownerEmail') ?? env.get('GOOGLE_OWNER_EMAIL') ?? '').trim();
    if (clientId === '' || clientSecret === '') {
      throw new HandledError('google', 'Enter both the OAuth client ID and the client secret.');
    }
    // The client secret goes straight to `google.env` at 0600. It is never held in setup.json
    // and never reaches a rendered page; the callback reads it back from the file.
    writeGoogleEnv(deps.googleEnvPath, {
      clientId,
      clientSecret,
      refreshToken: env.get('GOOGLE_REFRESH_TOKEN') ?? '',
      ownerEmail,
    });
    const nonce = newOauthState();
    writeSetupState(deps.stateDir, { ...current, googleOauthState: nonce });
    redirect(
      response,
      buildAuthUrl({ clientId, redirectUri: googleRedirectUri(), state: nonce }),
    );
  }

  async function getGoogleCallback(
    response: ServerResponse,
    url: URL,
    current: SetupState,
  ): Promise<void> {
    const error = url.searchParams.get('error');
    if (error !== null && error !== '') {
      throw new HandledError('google', `Google refused the authorisation: ${error}`);
    }
    if (!stateMatches(current.googleOauthState, url.searchParams.get('state') ?? undefined)) {
      throw new HandledError(
        'google',
        'That callback did not match the request this box started. Begin the Google step again.',
      );
    }
    const code = url.searchParams.get('code') ?? '';
    if (code === '') throw new HandledError('google', 'Google returned no authorisation code.');

    const env = googleEnv();
    const clientId = env.get('GOOGLE_CLIENT_ID') ?? '';
    const clientSecret = env.get('GOOGLE_CLIENT_SECRET') ?? '';
    if (clientId === '' || clientSecret === '') {
      throw new HandledError('google', 'The client details are gone. Begin the Google step again.');
    }
    const tokenUrl = parseEnvFile(readEnvFile(deps.envFilePath)).get('GOOGLE_TOKEN_URL');
    const result = await exchangeCode(
      {
        clientId,
        clientSecret,
        code,
        redirectUri: googleRedirectUri(),
        ...(tokenUrl === undefined || tokenUrl === '' ? {} : { tokenUrl }),
      },
      fetchImpl,
    );
    writeGoogleEnv(deps.googleEnvPath, {
      clientId,
      clientSecret,
      refreshToken: result.refreshToken,
      ownerEmail: env.get('GOOGLE_OWNER_EMAIL') ?? '',
    });
    // The nonce is single use: clear it so a replayed callback cannot land twice.
    const cleared: SetupState = { ...current };
    delete (cleared as { googleOauthState?: string }).googleOauthState;
    toNext(response, advance(cleared, 'google', 'done'));
  }

  function postRoutines(
    response: ServerResponse,
    form: URLSearchParams,
    current: SetupState,
  ): void {
    if (form.get('skip') !== null) {
      toNext(response, advance(current, 'routines', 'skipped'));
      return;
    }
    const timezone = setTimezone(deps.envFilePath, form.get('timezone') ?? '');
    const wanted = new Set(form.getAll('enabled'));
    const listing = listRoutines(deps.routinesDir);
    for (const routine of listing.routines) {
      setRoutineEnabled(routine.file, wanted.has(routine.name));
    }
    toNext(response, advance({ ...current, timezone }, 'routines', 'done'));
  }

  async function postVault(
    response: ServerResponse,
    form: URLSearchParams,
    current: SetupState,
  ): Promise<void> {
    if (form.get('skip') !== null) {
      toNext(response, advance(current, 'vault', 'skipped'));
      return;
    }
    await setVaultRemote(deps.vaultDir, form.get('remote') ?? '', gitRunner(deps.spawn));
    toNext(response, advance(current, 'vault', 'done'));
  }

  // ---------------------------------------------------------------- the handler

  async function route(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    method: string,
  ): Promise<boolean> {
    const path = url.pathname;
    let current = state();

    if (method === 'GET' && (path === '/setup' || path === '/setup/')) {
      const asked = url.searchParams.get('step');
      const screen: Screen =
        asked === 'done'
          ? 'done'
          : STEP_IDS.includes(asked as StepId)
            ? (asked as StepId)
            : nextScreen(current);
      await renderScreen(response, current, screen);
      return true;
    }

    if (method === 'GET' && path === '/setup/whatsapp/status') {
      json(response, 200, toPairView(await fetchPairStatus(pairBase, fetchImpl)));
      return true;
    }

    if (method === 'GET' && path === '/setup/whatsapp/qr.svg') {
      const svg = await fetchQrSvg(pairBase, fetchImpl);
      if (svg === null) {
        json(response, 404, { error: `no code yet; run \`${PAIR_COMMAND}\` on the box` });
        return true;
      }
      // Served from its own endpoint with its own type, never inlined into the page.
      response.writeHead(200, {
        'content-type': 'image/svg+xml',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      });
      response.end(svg);
      return true;
    }

    if (method === 'GET' && path === '/setup/claude/status') {
      const flow = parseDeviceFlow(claudeOutput);
      json(response, 200, {
        url: flow?.url ?? '',
        code: flow?.code ?? '',
        running: claudeChild !== null,
      });
      return true;
    }

    if (method === 'GET' && path === '/setup/google/start') {
      // The GET form of the step: re-run the consent redirect with details already on the box.
      postGoogleStart(response, new URLSearchParams(), current);
      return true;
    }

    if (method === 'GET' && path === '/setup/google/callback') {
      await getGoogleCallback(response, url, current);
      return true;
    }

    if (method !== 'POST') return false;

    if (!originAllowed(request)) {
      html(
        response,
        403,
        `<!doctype html><meta charset="utf-8"><p>That request came from another origin.`,
      );
      return true;
    }
    let form: URLSearchParams;
    try {
      form = await readForm(request);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        json(response, 413, { error: 'that form was too large' });
        return true;
      }
      throw error;
    }
    if (!csrfOk(form, current)) {
      html(
        response,
        403,
        `<!doctype html><meta charset="utf-8"><p>This page went stale. Reload it and try again.`,
      );
      return true;
    }

    switch (path) {
      case '/setup/owner':
        await postOwner(response, form, current);
        return true;
      case '/setup/whatsapp/start':
        await postWhatsapp(response, form, current);
        return true;
      case '/setup/whatsapp/pair-code':
        // The pairing service exposes a QR, not a pairing code. Rather than pretend, the page
        // says exactly what to run for the code path. IP-3: revisit if pair-qr grows one.
        await renderScreen(response, current, 'whatsapp', {
          kind: 'note',
          text: `The pairing-code path is not wired into this box yet. On the box run \`${PAIR_COMMAND}\` and follow its terminal output, which offers the code.`,
        });
        return true;
      case '/setup/claude/start':
        postClaudeStart(response);
        return true;
      case '/setup/claude/token': {
        const result = saveOauthToken(deps.envFilePath, form.get('token') ?? '');
        current = advance(current, 'claude', 'done');
        // Only `saved` and the last four characters. The token itself is never echoed.
        json(response, 200, { saved: result.saved, last4: result.last4, next: '/setup' });
        return true;
      }
      case '/setup/claude/api-key': {
        const result = saveApiKey(deps.envFilePath, form.get('apikey') ?? '');
        current = advance(current, 'claude', 'done');
        json(response, 200, { saved: result.saved, last4: result.last4, next: '/setup' });
        return true;
      }
      case '/setup/google/start':
        postGoogleStart(response, form, current);
        return true;
      case '/setup/google/confirm-production': {
        const confirmed = form.get('confirmed') === 'yes';
        writeSetupState(deps.stateDir, { ...current, googleConsentConfirmed: confirmed });
        redirect(response, '/setup?step=google');
        return true;
      }
      case '/setup/routines':
        postRoutines(response, form, current);
        return true;
      case '/setup/vault':
        await postVault(response, form, current);
        return true;
      case '/setup/done': {
        completeSetup(deps.stateDir, now());
        redirect(response, '/');
        return true;
      }
      default:
        return false;
    }
  }

  return async function handle(request, response): Promise<boolean> {
    const url = new URL(request.url ?? '/', `https://${deps.consoleHostname}`);
    const path = url.pathname;
    const method = request.method ?? 'GET';

    if (path !== '/setup' && !path.startsWith('/setup/')) return false;

    /**
     * The one route that answers without Access, so the installer can tell "the tunnel is up"
     * from "the box is not there yet" before an Access policy could possibly be satisfied. It
     * carries no body at all — 204 and nothing else — so it leaks not one fact about the box.
     */
    if (path === '/setup/health') {
      response.writeHead(204, { 'cache-control': 'no-store' });
      response.end();
      return true;
    }

    // Setup is over: every other /setup route stops existing, so the wizard is not a back door.
    if (!isSetupMode({ stateDir: deps.stateDir, ownersFile: deps.ownersFile }, now())) return false;

    try {
      await deps.verifyAccess(request);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'access: refused';
      json(response, 403, { error: reason });
      return true;
    }

    try {
      return await route(request, response, url, method);
    } catch (error) {
      const current = state();
      if (error instanceof HandledError) {
        await renderScreen(response, current, error.screen, { kind: 'bad', text: error.message });
        return true;
      }
      const message =
        error instanceof Error ? error.message : 'the setup wizard could not do that';
      await renderScreen(response, current, nextScreen(current), { kind: 'bad', text: message });
      return true;
    }
  };
}
