import { describe, expect, it } from 'vitest';
import { BridgeDeliverer, isBridgeConnected } from '../src/deliver.js';
import type { FetchLike } from '../src/deliver.js';
import { fakeFetch } from './helpers.js';

const BRIDGE = 'http://127.0.0.1:7801';
const noSleep = (): Promise<void> => Promise.resolve();

function sendRoute(status = 200): { fn: FetchLike; calls: ReturnType<typeof fakeFetch>['calls'] } {
  return fakeFetch([{ match: '/send', status }]);
}

describe('BridgeDeliverer', () => {
  it('posts one chunk to /send with the JSON body the bridge expects', async () => {
    const { fn, calls } = sendRoute();
    await new BridgeDeliverer({ bridgeUrl: BRIDGE, fetchImpl: fn, sleep: noSleep }).send(
      'owner',
      'hello',
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BRIDGE}/send`);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ to: 'owner', text: 'hello' });
  });

  it('chunks long text and posts each chunk in order', async () => {
    const { fn, calls } = sendRoute();
    const text = ['a'.repeat(80), 'b'.repeat(80), 'c'.repeat(80)].join('\n\n');
    await new BridgeDeliverer({
      bridgeUrl: BRIDGE,
      fetchImpl: fn,
      sleep: noSleep,
      chunkMax: 100,
    }).send('owner', text);

    expect(calls.length).toBeGreaterThan(1);
    const sent = calls.map((c) => (JSON.parse(c.body ?? '{}') as { text: string }).text);
    expect(sent[0]).toBe('a'.repeat(80));
    expect(sent.join('')).toContain('c'.repeat(80));
    for (const chunk of sent) expect(chunk.length).toBeLessThanOrEqual(100);
  });

  it('paces the chunks, but never before the first one', async () => {
    const waits: number[] = [];
    const { fn } = sendRoute();
    await new BridgeDeliverer({
      bridgeUrl: BRIDGE,
      fetchImpl: fn,
      chunkMax: 10,
      interChunkDelayMs: 2000,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    }).send('owner', 'aaaaaaaaaa\n\nbbbbbbbbbb\n\ncccccccccc');

    expect(waits).toEqual([2000, 2000]);
  });

  it('sends the bearer header only when a token is configured', async () => {
    const withToken = sendRoute();
    await new BridgeDeliverer({
      bridgeUrl: BRIDGE,
      token: 'shhh',
      fetchImpl: withToken.fn,
      sleep: noSleep,
    }).send('owner', 'hi');
    expect(withToken.calls[0]?.headers.authorization).toBe('Bearer shhh');

    const withoutToken = sendRoute();
    await new BridgeDeliverer({
      bridgeUrl: BRIDGE,
      fetchImpl: withoutToken.fn,
      sleep: noSleep,
    }).send('owner', 'hi');
    expect(withoutToken.calls[0]?.headers.authorization).toBeUndefined();

    const emptyToken = sendRoute();
    await new BridgeDeliverer({
      bridgeUrl: BRIDGE,
      token: '',
      fetchImpl: emptyToken.fn,
      sleep: noSleep,
    }).send('owner', 'hi');
    expect(emptyToken.calls[0]?.headers.authorization).toBeUndefined();
  });

  it('throws on a non-2xx response', async () => {
    const { fn } = sendRoute(502);
    const deliverer = new BridgeDeliverer({ bridgeUrl: BRIDGE, fetchImpl: fn, sleep: noSleep });
    await expect(deliverer.send('owner', 'hi')).rejects.toThrow(/bridge send failed: 502/);
  });

  it('stops at the first refused chunk', async () => {
    const { fn, calls } = sendRoute(500);
    const deliverer = new BridgeDeliverer({
      bridgeUrl: BRIDGE,
      fetchImpl: fn,
      sleep: noSleep,
      chunkMax: 10,
    });
    await expect(deliverer.send('owner', 'aaaaaaaaaa\n\nbbbbbbbbbb')).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('tolerates a trailing slash on the bridge URL', async () => {
    const { fn, calls } = sendRoute();
    await new BridgeDeliverer({
      bridgeUrl: `${BRIDGE}/`,
      fetchImpl: fn,
      sleep: noSleep,
    }).send('owner', 'hi');
    expect(calls[0]?.url).toBe(`${BRIDGE}/send`);
  });
});

describe('isBridgeConnected', () => {
  it('is true only when the body says connected: true', async () => {
    const yes = fakeFetch([{ match: '/health', body: { connected: true } }]);
    await expect(isBridgeConnected(BRIDGE, undefined, yes.fn)).resolves.toBe(true);
    expect(yes.calls[0]?.url).toBe(`${BRIDGE}/health`);

    const no = fakeFetch([{ match: '/health', body: { connected: false } }]);
    await expect(isBridgeConnected(BRIDGE, undefined, no.fn)).resolves.toBe(false);

    const truthy = fakeFetch([{ match: '/health', body: { connected: 'yes' } }]);
    await expect(isBridgeConnected(BRIDGE, undefined, truthy.fn)).resolves.toBe(false);

    const empty = fakeFetch([{ match: '/health', body: {} }]);
    await expect(isBridgeConnected(BRIDGE, undefined, empty.fn)).resolves.toBe(false);
  });

  it('is false for a non-2xx status', async () => {
    const { fn } = fakeFetch([{ match: '/health', status: 503, body: { connected: true } }]);
    await expect(isBridgeConnected(BRIDGE, undefined, fn)).resolves.toBe(false);
  });

  it('is false when the request throws', async () => {
    const boom: FetchLike = () => Promise.reject(new Error('ECONNREFUSED'));
    await expect(isBridgeConnected(BRIDGE, undefined, boom)).resolves.toBe(false);
  });

  it('sends the bearer header only when a token is configured', async () => {
    const withToken = fakeFetch([{ match: '/health', body: { connected: true } }]);
    await isBridgeConnected(BRIDGE, 'shhh', withToken.fn);
    expect(withToken.calls[0]?.headers.authorization).toBe('Bearer shhh');

    const withoutToken = fakeFetch([{ match: '/health', body: { connected: true } }]);
    await isBridgeConnected(BRIDGE, undefined, withoutToken.fn);
    expect(withoutToken.calls[0]?.headers.authorization).toBeUndefined();
  });
});
