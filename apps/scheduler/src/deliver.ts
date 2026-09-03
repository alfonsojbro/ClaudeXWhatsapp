/**
 * Delivery of routine output to WhatsApp through the bridge.
 *
 * Contract (Phase 1 bridge): `POST ${bridgeUrl}/send` with JSON `{ to, text }` and
 * `GET ${bridgeUrl}/health` returning `{ connected: boolean }`.
 *
 * Privacy: this module handles delivered text. It never logs it.
 */
import { chunkText, DEFAULT_CHUNK_MAX } from './chunk.js';
import type { Deliverer } from './types.js';

/** Minimal shape of a `fetch` response that this module needs. */
export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** Minimal `fetch` signature. The global `fetch` satisfies it. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<HttpResponse>;

const SEND_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 5_000;
const INTER_CHUNK_DELAY_MS = 2_000;

const realFetch: FetchLike = (url, init) => fetch(url, init);

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Construction options for {@link BridgeDeliverer}. */
export interface BridgeDelivererOptions {
  bridgeUrl: string;
  /** Bearer token for `POST /send`. The header is omitted when this is not set. */
  token?: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Injected for tests so no test ever waits two seconds. */
  sleep?: (ms: number) => Promise<void>;
  chunkMax?: number;
  interChunkDelayMs?: number;
  timeoutMs?: number;
}

function authHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined && token !== '') headers.authorization = `Bearer ${token}`;
  return headers;
}

/** Sends text to the bridge, chunked and paced. */
export class BridgeDeliverer implements Deliverer {
  private readonly bridgeUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly chunkMax: number;
  private readonly delayMs: number;
  private readonly timeoutMs: number;

  constructor(options: BridgeDelivererOptions) {
    this.bridgeUrl = options.bridgeUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? realFetch;
    this.sleep = options.sleep ?? realSleep;
    this.chunkMax = options.chunkMax ?? DEFAULT_CHUNK_MAX;
    this.delayMs = options.interChunkDelayMs ?? INTER_CHUNK_DELAY_MS;
    this.timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS;
  }

  /**
   * Deliver `text` to `to` (`owner` or a WhatsApp JID).
   *
   * @throws {Error} when any chunk is refused; the caller re-spools the delivery.
   */
  async send(to: string, text: string): Promise<void> {
    const chunks = chunkText(text, this.chunkMax);
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      if (chunk === undefined) continue;
      if (i > 0) await this.sleep(this.delayMs);
      await this.postChunk(to, chunk);
    }
  }

  private async postChunk(to: string, text: string): Promise<void> {
    const res = await this.fetchImpl(`${this.bridgeUrl}/send`, {
      method: 'POST',
      headers: authHeaders(this.token),
      body: JSON.stringify({ to, text }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        detail = '';
      }
      throw new Error(
        `bridge send failed: ${String(res.status)}${detail === '' ? '' : ` ${detail}`}`,
      );
    }
  }
}

/**
 * Ask the bridge whether WhatsApp is connected.
 *
 * Never throws: any transport error, timeout or malformed body counts as "not connected".
 */
export async function isBridgeConnected(
  bridgeUrl: string,
  token?: string,
  fetchImpl: FetchLike = realFetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${bridgeUrl.replace(/\/+$/, '')}/health`, {
      method: 'GET',
      headers: authHeaders(token),
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { connected?: unknown };
    return body.connected === true;
  } catch {
    return false;
  }
}
