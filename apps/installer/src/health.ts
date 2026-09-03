/**
 * Readiness classification for `https://cxw.<domain>/setup/health`.
 *
 * The wizard is behind Cloudflare Access from its very first request, so a healthy
 * box does NOT answer 200. It answers a redirect to the Access login. A 200 means
 * Access is not in front of it, which is a warning, not a success.
 *
 * Browser-safe: no `node:` imports.
 */

export type HealthState = 'pending' | 'ready' | 'error';

export interface HealthProbe {
  /** HTTP status, or 0 when the request never completed (DNS, TLS, connect). */
  readonly status: number;
  readonly location?: string | undefined;
  readonly body?: string | undefined;
}

export interface HealthVerdict {
  readonly state: HealthState;
  readonly reason: string;
  /** True when the hostname answers but Access is not enforcing. */
  readonly warning: boolean;
}

const ACCESS_HOST_SUFFIX = 'cloudflareaccess.com';

function isAccessRedirect(location: string | undefined): boolean {
  if (location === undefined || location === '') return false;
  try {
    const host = new URL(location).hostname.toLowerCase();
    return host === ACCESS_HOST_SUFFIX || host.endsWith(`.${ACCESS_HOST_SUFFIX}`);
  } catch {
    return false;
  }
}

export function classifyHealthProbe(probe: HealthProbe): HealthVerdict {
  const body = probe.body ?? '';

  // 530 is Cloudflare's "origin unreachable"; 1033 is the tunnel-specific error code
  // inside its body. Status 0 is our own marker for a request that never completed.
  if (probe.status === 0) {
    return { state: 'pending', reason: 'no answer yet — DNS or the tunnel is still coming up', warning: false };
  }
  if (probe.status === 530 || body.includes('1033')) {
    return { state: 'pending', reason: 'Cloudflare 530/1033 — the tunnel is not connected yet', warning: false };
  }

  if (probe.status === 302 || probe.status === 303 || probe.status === 307) {
    if (isAccessRedirect(probe.location)) {
      return { state: 'ready', reason: 'the hostname is live and Cloudflare Access is in front of it', warning: false };
    }
    return {
      state: 'error',
      reason: `redirected to ${probe.location ?? 'nowhere'}, which is not a Cloudflare Access login`,
      warning: false,
    };
  }

  if (probe.status === 200) {
    return {
      state: 'ready',
      reason: 'the wizard answered directly — Cloudflare Access is NOT enforcing on this hostname',
      warning: true,
    };
  }

  return { state: 'error', reason: `unexpected HTTP ${probe.status}`, warning: false };
}

export interface PollOptions {
  readonly attempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly intervalMs?: number;
  readonly onProgress?: (verdict: HealthVerdict, attempt: number) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Probe until the verdict stops being `pending`. Returns the last verdict either way,
 * so the caller can show "still pending after N tries" rather than throwing.
 */
export async function pollSetupHealth(
  probe: () => Promise<HealthProbe>,
  options: PollOptions = {},
): Promise<HealthVerdict> {
  const attempts = options.attempts ?? 60;
  const sleep = options.sleep ?? defaultSleep;
  const intervalMs = options.intervalMs ?? 5_000;

  let verdict: HealthVerdict = { state: 'pending', reason: 'not probed yet', warning: false };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    verdict = classifyHealthProbe(await probe());
    options.onProgress?.(verdict, attempt);
    if (verdict.state !== 'pending') return verdict;
    if (attempt < attempts) await sleep(intervalMs);
  }
  return verdict;
}
