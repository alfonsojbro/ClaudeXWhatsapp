import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  createPairing,
  fetchPairStatus,
  fetchQrSvg,
  PAIR_COMMAND,
  PAIR_QR_DEFAULT_BASE_URL,
  startPairing,
  toPairView,
} from './whatsapp.js';
import type { PairServiceStatus, SpawnLike } from './whatsapp.js';

const BASE = PAIR_QR_DEFAULT_BASE_URL;

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )) as unknown as typeof fetch;
}

const ALL: readonly PairServiceStatus[] = [
  'starting',
  'waiting',
  'linked',
  'logged-out',
  'gave-up',
  'unavailable',
];

describe('fetchPairStatus', () => {
  it('reads the documented shape', async () => {
    const impl = jsonFetch({
      status: 'waiting',
      attempt: 2,
      qrCount: 5,
      updatedAt: '2026-09-03T10:00:00.000Z',
      note: '',
    });
    await expect(fetchPairStatus(BASE, impl)).resolves.toEqual({
      status: 'waiting',
      attempt: 2,
      qrCount: 5,
      updatedAt: '2026-09-03T10:00:00.000Z',
      note: '',
    });
  });

  it('requests /status.json off the base URL, trailing slash or not', async () => {
    const seen: string[] = [];
    const impl = ((url: string) => {
      seen.push(String(url));
      return Promise.resolve(new Response('{"status":"starting"}', { status: 200 }));
    }) as unknown as typeof fetch;
    await fetchPairStatus('http://127.0.0.1:7899/', impl);
    expect(seen[0]).toBe('http://127.0.0.1:7899/status.json');
  });

  it('reports unavailable when the service refuses the connection', async () => {
    const impl = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    await expect(fetchPairStatus(BASE, impl)).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('reports unavailable on a non-200', async () => {
    await expect(fetchPairStatus(BASE, jsonFetch({}, 500))).resolves.toMatchObject({
      status: 'unavailable',
    });
  });

  it('reports unavailable on a body that is not the documented shape', async () => {
    const impl = (() =>
      Promise.resolve(new Response('not json', { status: 200 }))) as unknown as typeof fetch;
    await expect(fetchPairStatus(BASE, impl)).resolves.toMatchObject({ status: 'unavailable' });
    await expect(fetchPairStatus(BASE, jsonFetch({ status: 'nonsense' }))).resolves.toMatchObject({
      status: 'unavailable',
    });
  });

  it('defaults the numeric fields rather than propagating rubbish', async () => {
    const status = await fetchPairStatus(BASE, jsonFetch({ status: 'waiting', qrCount: 'many' }));
    expect(status.qrCount).toBe(0);
    expect(status.attempt).toBe(0);
  });
});

describe('fetchQrSvg', () => {
  it('returns the SVG body', async () => {
    const impl = (() =>
      Promise.resolve(
        new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', {
          status: 200,
          headers: { 'content-type': 'image/svg+xml' },
        }),
      )) as unknown as typeof fetch;
    await expect(fetchQrSvg(BASE, impl)).resolves.toContain('<svg');
  });

  it('returns null on the 404 the service gives before the first code', async () => {
    const impl = (() =>
      Promise.resolve(new Response('', { status: 404 }))) as unknown as typeof fetch;
    await expect(fetchQrSvg(BASE, impl)).resolves.toBeNull();
  });

  it('returns null when the service is unreachable', async () => {
    const impl = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    await expect(fetchQrSvg(BASE, impl)).resolves.toBeNull();
  });

  it('returns null on an empty body', async () => {
    const impl = (() =>
      Promise.resolve(new Response('   ', { status: 200 }))) as unknown as typeof fetch;
    await expect(fetchQrSvg(BASE, impl)).resolves.toBeNull();
  });
});

describe('toPairView', () => {
  it('gives every status a human sentence', () => {
    for (const status of ALL) {
      const view = toPairView({ status, attempt: 1, qrCount: 0, updatedAt: '', note: '' });
      expect(view.sentence.length).toBeGreaterThan(20);
      expect(view.status).toBe(status);
    }
  });

  it('polls only while starting or waiting', () => {
    for (const status of ALL) {
      const view = toPairView({ status, attempt: 1, qrCount: 1, updatedAt: '', note: '' });
      expect(view.polling).toBe(status === 'starting' || status === 'waiting');
    }
  });

  it('asks for the QR only while waiting with a code captured', () => {
    expect(
      toPairView({ status: 'waiting', attempt: 1, qrCount: 0, updatedAt: '', note: '' }).showQr,
    ).toBe(false);
    expect(
      toPairView({ status: 'waiting', attempt: 1, qrCount: 3, updatedAt: '', note: '' }).showQr,
    ).toBe(true);
    expect(
      toPairView({ status: 'linked', attempt: 1, qrCount: 3, updatedAt: '', note: '' }).showQr,
    ).toBe(false);
  });

  it('marks only linked as done', () => {
    for (const status of ALL) {
      expect(
        toPairView({ status, attempt: 0, qrCount: 0, updatedAt: '', note: '' }).done,
      ).toBe(status === 'linked');
    }
  });

  it('names the exact command when the service is unreachable', () => {
    const view = toPairView({
      status: 'unavailable',
      attempt: 0,
      qrCount: 0,
      updatedAt: '',
      note: '',
    });
    expect(view.sentence).toContain(PAIR_COMMAND);
  });

  it('prefers the service note when it has one, except while waiting', () => {
    expect(
      toPairView({ status: 'gave-up', attempt: 9, qrCount: 0, updatedAt: '', note: 'gave up after 9' })
        .sentence,
    ).toBe('gave up after 9');
    expect(
      toPairView({ status: 'waiting', attempt: 1, qrCount: 1, updatedAt: '', note: 'noise' })
        .sentence,
    ).toContain('Linked devices');
  });
});

describe('createPairing', () => {
  function fakeChild(): ChildProcess {
    const emitter = new EventEmitter() as unknown as ChildProcess;
    (emitter as unknown as { exitCode: number | null }).exitCode = null;
    (emitter as unknown as { killed: boolean }).killed = false;
    (emitter as unknown as { unref: () => void }).unref = (): void => undefined;
    return emitter;
  }

  it('launches the helper once and not twice', () => {
    const spawn = vi.fn(() => fakeChild()) as unknown as SpawnLike;
    const pairing = createPairing(spawn);
    expect(pairing.start()).toBe(true);
    expect(pairing.start()).toBe(false);
    expect(pairing.running()).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('passes arguments as an array, never through a shell', () => {
    const spawn = vi.fn(() => fakeChild()) as unknown as SpawnLike;
    createPairing(spawn).start();
    const call = (spawn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(call?.[0]).toBe('pnpm');
    expect(Array.isArray(call?.[1])).toBe(true);
    expect(call?.[2]).toMatchObject({ stdio: 'ignore' });
  });

  it('allows a relaunch after the child exits', () => {
    let child = fakeChild();
    const spawn = vi.fn(() => {
      child = fakeChild();
      return child;
    }) as unknown as SpawnLike;
    const pairing = createPairing(spawn);
    pairing.start();
    child.emit('exit', 0, null);
    expect(pairing.running()).toBe(false);
    expect(pairing.start()).toBe(true);
  });

  it('startPairing launches one helper', () => {
    const spawn = vi.fn(() => fakeChild()) as unknown as SpawnLike;
    expect(startPairing(spawn)).toBe(true);
  });
});
