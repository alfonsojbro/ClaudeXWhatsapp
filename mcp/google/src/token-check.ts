/**
 * Refresh-token health check. Used by the monitor (CLI) and by the model
 * (`google_token_check`). It fails loudly instead of opening a browser: the
 * whole point is that a dead token shows up in `monitor.sh`, not as a hang.
 *
 * CLI: `pnpm --filter @cxw/mcp-google token-check [--quiet]`
 *   exit 0 = ok, 1 = the token is not usable, 2 = the environment is incomplete.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GoogleConfig } from './config.js';
import { loadGoogleConfig } from './config.js';
import type { Deps } from './deps.js';
import type { TextResult } from './tools/result.js';
import { guard, ok } from './tools/result.js';

export interface TokenCheckResult {
  ok: boolean;
  checkedAt: string;
  expiresInSec?: number;
  scopes?: string[];
  error?: string;
}

export type TokenCheckConfig = Pick<
  GoogleConfig,
  'clientId' | 'clientSecret' | 'refreshToken' | 'tokenUrl'
>;

/**
 * Exchange the refresh token for an access token. Nothing about the tokens
 * themselves is ever put in the result — only whether the exchange worked.
 */
export async function checkGoogleToken(
  cfg: TokenCheckConfig,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<TokenCheckResult> {
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
    });
    const res = await fetchImpl(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });
    let payload: Record<string, unknown> = {};
    try {
      payload = (await res.json()) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    if (res.status === 200 && typeof payload['access_token'] === 'string') {
      const result: TokenCheckResult = { ok: true, checkedAt };
      if (typeof payload['expires_in'] === 'number') result.expiresInSec = payload['expires_in'];
      if (typeof payload['scope'] === 'string') {
        result.scopes = payload['scope'].split(' ').filter((s) => s !== '');
      }
      return result;
    }
    const error = typeof payload['error'] === 'string' ? payload['error'] : `HTTP ${res.status}`;
    const detail =
      typeof payload['error_description'] === 'string' ? `: ${payload['error_description']}` : '';
    return { ok: false, checkedAt, error: `${error}${detail}` };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, checkedAt, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/** Human hint for a failed check. */
export function tokenCheckHint(result: TokenCheckResult): string {
  if (result.ok) return '';
  const error = result.error ?? '';
  if (error.includes('invalid_grant')) {
    return 'The refresh token was revoked or expired. If the OAuth consent screen is still in Testing, publish it to Production (Testing tokens die after 7 days), then re-run `pnpm google:auth`.';
  }
  return 'Re-run `pnpm google:auth` on the Mac and copy google.env to the box (docs/RUNBOOK.md §8).';
}

export function registerTokenCheckTool(server: McpServer, deps: Deps): void {
  server.registerTool(
    'google_token_check',
    {
      title: 'Check the Google refresh token',
      description:
        'Verify that the stored Google refresh token still exchanges for an access token. ' +
        'Returns JSON with ok, scopes and expiry. No arguments; no secrets are echoed.',
      inputSchema: {},
    },
    async (): Promise<TextResult> =>
      guard(async () => {
        const result = await checkGoogleToken(deps.tokenConfig);
        const hint = tokenCheckHint(result);
        return ok(JSON.stringify(result, null, 2) + (hint === '' ? '' : `\n${hint}`));
      }),
  );
}

async function cli(argv: string[]): Promise<number> {
  const quiet = argv.includes('--quiet');
  let cfg: GoogleConfig;
  try {
    cfg = loadGoogleConfig();
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const result = await checkGoogleToken(cfg);
  if (quiet) {
    console.log(result.ok ? 'ok' : `fail ${result.error ?? 'unknown'}`);
  } else {
    console.log(JSON.stringify(result, null, 2));
    const hint = tokenCheckHint(result);
    if (hint !== '') console.error(hint);
  }
  return result.ok ? 0 : 1;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === new URL(`file://${entry}`).href) {
  cli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    });
}
