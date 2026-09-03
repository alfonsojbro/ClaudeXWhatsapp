/**
 * Step 2: link WhatsApp.
 *
 * INTEGRATION IP-3: the pairing itself is `scripts/pair-qr/pair-qr.ts`, which lives on
 * `docs-getting-started` and is not on this branch. This module is a *client* of its
 * documented HTTP interface on 127.0.0.1:7899 and nothing more:
 *
 *   GET /status.json -> { status, attempt, qrCount, updatedAt, note }
 *                       status: starting | waiting | linked | logged-out | gave-up | unavailable
 *   GET /qr.svg      -> image/svg+xml, or 404 while no code has been captured yet
 *
 * When that branch merges, nothing here changes: the contract is already what it publishes.
 * What must change is only how the service is launched — see `PAIR_COMMAND` below.
 *
 * The QR is never inlined into the page. It is served from the wizard's own `/setup/whatsapp/qr.svg`
 * with `image/svg+xml`, so an SVG the wizard did not author is never parsed as part of the
 * document, and script inside one could not reach the page even if it were there.
 */

import type { ChildProcess } from 'node:child_process';

export const PAIR_QR_DEFAULT_BASE_URL = 'http://127.0.0.1:7899';

/**
 * The command a person runs by hand when the service is not up. It is also what the wizard
 * spawns. IP-3: this is the one line that changes if `scripts/pair-qr` is ever renamed.
 */
export const PAIR_COMMAND = 'pnpm pair:qr';
export const PAIR_ARGV: readonly [string, readonly string[]] = ['pnpm', ['pair:qr']];

/** The states the service publishes. */
export type PairServiceStatus =
  | 'starting'
  | 'waiting'
  | 'linked'
  | 'logged-out'
  | 'gave-up'
  | 'unavailable';

export interface PairStatus {
  readonly status: PairServiceStatus;
  readonly attempt: number;
  readonly qrCount: number;
  readonly updatedAt: string;
  readonly note: string;
}

/** What the wizard shows: a state the page styles on, and one sentence a person can act on. */
export interface PairView {
  readonly status: PairServiceStatus;
  /** True while the page should keep polling. */
  readonly polling: boolean;
  /** True while a QR is worth requesting. */
  readonly showQr: boolean;
  readonly done: boolean;
  readonly sentence: string;
  readonly attempt: number;
  readonly qrCount: number;
}

const UNAVAILABLE: PairStatus = {
  status: 'unavailable',
  attempt: 0,
  qrCount: 0,
  updatedAt: '',
  note: '',
};

function asStatus(value: unknown): PairServiceStatus | null {
  const known: readonly string[] = [
    'starting',
    'waiting',
    'linked',
    'logged-out',
    'gave-up',
    'unavailable',
  ];
  return typeof value === 'string' && known.includes(value) ? (value as PairServiceStatus) : null;
}

function int(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

/**
 * Read `/status.json`. A service that is not listening is not an error page: it is the
 * `unavailable` state, which the wizard renders with the exact command to run by hand.
 */
export async function fetchPairStatus(
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<PairStatus> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/status.json`, {
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    return UNAVAILABLE;
  }
  if (!response.ok) return UNAVAILABLE;
  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch {
    return UNAVAILABLE;
  }
  if (typeof body !== 'object' || body === null) return UNAVAILABLE;
  const raw = body as Record<string, unknown>;
  const status = asStatus(raw['status']);
  if (status === null) return UNAVAILABLE;
  return {
    status,
    attempt: int(raw['attempt']),
    qrCount: int(raw['qrCount']),
    updatedAt: typeof raw['updatedAt'] === 'string' ? raw['updatedAt'] : '',
    note: typeof raw['note'] === 'string' ? raw['note'] : '',
  };
}

/** The current QR as SVG text, or null while there is none (the service answers 404). */
export async function fetchQrSvg(baseUrl: string, fetchImpl: typeof fetch): Promise<string | null> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/qr.svg`, {
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const text = await response.text();
  return text.trim() === '' ? null : text;
}

const SENTENCES: Readonly<Record<PairServiceStatus, string>> = {
  starting: 'Starting the WhatsApp link. The first code takes a few seconds.',
  waiting:
    'On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan this code. ' +
    'It changes every 20 seconds and this page follows it.',
  linked: 'WhatsApp is linked. You can move on.',
  'logged-out':
    'WhatsApp logged this device out. Unlink it on your phone under Linked devices, then start again.',
  'gave-up':
    'The code was never scanned, so pairing stopped. Start it again when you have your phone to hand.',
  unavailable: `The pairing service is not answering on this box. Run \`${PAIR_COMMAND}\` in the repo on the box, then reload this page.`,
};

export function toPairView(status: PairStatus): PairView {
  return {
    status: status.status,
    polling: status.status === 'starting' || status.status === 'waiting',
    showQr: status.status === 'waiting' && status.qrCount > 0,
    done: status.status === 'linked',
    // The service's own `note` is more specific when it has one, and it is our own text.
    sentence:
      status.note.trim() !== '' && status.status !== 'waiting'
        ? status.note.trim()
        : SENTENCES[status.status],
    attempt: status.attempt,
    qrCount: status.qrCount,
  };
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { readonly detached: boolean; readonly stdio: 'ignore' },
) => ChildProcess;

export interface Pairing {
  /** Launch the helper unless one is already alive. Returns true when it launched one. */
  start(): boolean;
  /** True while a child this process launched is still running. */
  running(): boolean;
}

/**
 * Launch the pairing helper at most once.
 *
 * The guard is a live-child check rather than a boolean, so a helper that died (WhatsApp
 * closed the socket, the box rebooted the service) can be started again, while a person
 * clicking the button twice does not get two children fighting over one WhatsApp session.
 */
export function createPairing(spawn: SpawnLike): Pairing {
  let child: ChildProcess | null = null;
  const alive = (): boolean => child !== null && child.exitCode === null && !child.killed;
  return {
    running: alive,
    start(): boolean {
      if (alive()) return false;
      const [command, args] = PAIR_ARGV;
      child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.on('exit', () => {
        child = null;
      });
      child.unref?.();
      return true;
    },
  };
}

/** Convenience for a single call site that has no long-lived `Pairing`. */
export function startPairing(spawn: SpawnLike): boolean {
  return createPairing(spawn).start();
}
