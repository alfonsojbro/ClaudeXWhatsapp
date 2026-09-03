/**
 * Step 3: log Claude Code in.
 *
 * `claude setup-token` prints a URL and a one-time code, waits for the person to approve the
 * device on anthropic.com, then prints a token. The wizard runs it on the box, shows the URL
 * and the code, and takes the token.
 *
 * The rule this module exists to enforce: **neither the OAuth token nor the API key is ever
 * echoed back**. Not into a form value, not into a confirmation page, not into an error. The
 * handler answers `{ saved: true, last4 }` and the page says "saved". `guardrails.test.ts` and
 * `router.test.ts` both assert it, because the failure would be silent and permanent — a token
 * rendered once into HTML is in someone's browser history and in whatever proxied it.
 */

import type { ChildProcess } from 'node:child_process';
import { updateEnvFile } from '../envfile.js';

export const OAUTH_TOKEN_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';
export const API_KEY_KEY = 'ANTHROPIC_API_KEY';

/** What a person runs by hand if the wizard cannot spawn it. */
export const SETUP_TOKEN_COMMAND = 'claude setup-token';
export const SETUP_TOKEN_ARGV: readonly [string, readonly string[]] = ['claude', ['setup-token']];

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { readonly stdio: readonly ['ignore', 'pipe', 'pipe'] },
) => ChildProcess;

export interface DeviceFlow {
  readonly url: string;
  /** Empty when the output carried a URL but no separate code, which some versions do. */
  readonly code: string;
}

/**
 * Pull the sign-in URL and the one-time code out of whatever `claude setup-token` printed.
 *
 * Deliberately loose. The exact wording of that output is not a contract and has changed
 * between releases, so this looks for the two things that are stable: the first https URL, and
 * a short code near it. When only a URL appears, the code is empty and the page shows the URL
 * alone — which is still enough to finish, because the code is also shown on the page the URL
 * opens.
 */
export function parseDeviceFlow(text: string): DeviceFlow | null {
  const source = String(text ?? '');
  const url = /https:\/\/[^\s"'<>)\]]+/.exec(source);
  if (url === null) return null;
  const found = url[0].replace(/[.,;]+$/, '');

  // A code is a short run of A-Z/0-9, optionally hyphenated in groups, that is not part of the
  // URL and is not an ordinary English word. Case-sensitive on purpose: these codes are upper.
  const withoutUrl = source.split(found).join(' ');
  const candidates = withoutUrl.match(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})*\b/g) ?? [];
  const code = candidates.find((value) => /[0-9]/.test(value) || value.includes('-')) ?? '';
  return { url: found, code };
}

/** Run `claude setup-token` on the box. The caller streams stdout into `parseDeviceFlow`. */
export function startClaudeSetupToken(spawn: SpawnLike): ChildProcess {
  const [command, args] = SETUP_TOKEN_ARGV;
  return spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

export interface SaveResult {
  readonly saved: true;
  /** The last four characters, so a person can tell two tokens apart. Never more. */
  readonly last4: string;
  /** A sentence when the shape looks wrong. Advisory: the value is saved either way. */
  readonly warning?: string;
}

export function last4(secret: string): string {
  const trimmed = secret.trim();
  return trimmed.length <= 4 ? '' : trimmed.slice(-4);
}

/**
 * Shape checks are warnings, never blocks.
 *
 * Anthropic's prefixes are a convention, not a promise, and a wizard that refuses a token
 * because a prefix changed would be unusable on the day it changes — while a wizard that warns
 * costs a person one glance. Blocking here would be a guess about someone else's format.
 */
function shapeWarning(value: string, expectedPrefix: string, what: string): string | undefined {
  if (value.startsWith(expectedPrefix)) return undefined;
  return `That does not look like ${what} — they normally start with \`${expectedPrefix}\`. It has been saved; if the assistant cannot reach Claude, come back and paste it again.`;
}

function requireValue(value: string, what: string): string {
  const trimmed = String(value ?? '').trim();
  if (trimmed === '') throw new Error(`Paste ${what} before saving.`);
  if (/\s/.test(trimmed)) {
    throw new Error(`That ${what} has a space in it, so something was cut off in the copy.`);
  }
  return trimmed;
}

/** Write `CLAUDE_CODE_OAUTH_TOKEN` into `cxw.env`, mode 0600. */
export function saveOauthToken(envPath: string, token: string): SaveResult {
  const value = requireValue(token, 'the token from `claude setup-token`');
  updateEnvFile(envPath, { [OAUTH_TOKEN_KEY]: value });
  const warning = shapeWarning(value, 'sk-ant-oat', 'a Claude Code OAuth token');
  return { saved: true, last4: last4(value), ...(warning === undefined ? {} : { warning }) };
}

/** Write `ANTHROPIC_API_KEY` into `cxw.env`, mode 0600. The metered fallback. */
export function saveApiKey(envPath: string, key: string): SaveResult {
  const value = requireValue(key, 'the API key');
  updateEnvFile(envPath, { [API_KEY_KEY]: value });
  const warning = shapeWarning(value, 'sk-ant-', 'an Anthropic API key');
  return { saved: true, last4: last4(value), ...(warning === undefined ? {} : { warning }) };
}
