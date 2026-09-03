import { describe, expect, it } from 'vitest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { accessCertsUrl, accessIssuer, createAccessVerifier, readAssertion } from './access-verify.js';

const TEAM = 'alfonso';
const AUD = 'aud-tag-0123456789abcdef';
const NOW_MS = 1_800_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

interface Pair {
  readonly kid: string;
  readonly publicJwk: Record<string, unknown>;
  readonly privateKey: KeyObject;
}

function keypair(kid: string): Pair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return { kid, publicJwk: { ...jwk, kid, alg: 'RS256', use: 'sig' }, privateKey };
}

const b64 = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

function sign(pair: Pair, claims: Record<string, unknown>, header?: Record<string, unknown>): string {
  const head = b64({ alg: 'RS256', kid: pair.kid, typ: 'JWT', ...header });
  const body = b64(claims);
  const signature = createSign('RSA-SHA256')
    .update(`${head}.${body}`)
    .sign(pair.privateKey)
    .toString('base64url');
  return `${head}.${body}.${signature}`;
}

function goodClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aud: [AUD],
    iss: accessIssuer(TEAM),
    exp: NOW_S + 3600,
    nbf: NOW_S - 10,
    iat: NOW_S - 10,
    email: 'alfonso@example.com',
    ...over,
  };
}

function certsFetch(pairs: readonly Pair[]): { impl: typeof fetch; calls: () => number } {
  let calls = 0;
  const impl = ((url: string | URL): Promise<Response> => {
    calls += 1;
    expect(String(url)).toBe(accessCertsUrl(TEAM));
    return Promise.resolve(
      new Response(JSON.stringify({ keys: pairs.map((p) => p.publicJwk) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function verifier(pairs: readonly Pair[], fetchImpl?: typeof fetch) {
  return createAccessVerifier({
    team: TEAM,
    aud: AUD,
    fetchImpl: fetchImpl ?? certsFetch(pairs).impl,
    now: () => NOW_MS,
  });
}

describe('readAssertion', () => {
  it('prefers the header', () => {
    expect(
      readAssertion({ 'cf-access-jwt-assertion': ' abc ', cookie: 'CF_Authorization=def' }),
    ).toBe('abc');
  });

  it('falls back to the CF_Authorization cookie', () => {
    expect(readAssertion({ cookie: 'other=1; CF_Authorization=a.b.c; x=2' })).toBe('a.b.c');
  });

  it('returns undefined when neither is present', () => {
    expect(readAssertion({ cookie: 'other=1' })).toBeUndefined();
    expect(readAssertion({})).toBeUndefined();
  });
});

describe('createAccessVerifier', () => {
  const one = keypair('kid-one');

  it('accepts a valid assertion and returns the email', async () => {
    const verify = verifier([one]);
    const identity = await verify(request({ 'cf-access-jwt-assertion': sign(one, goodClaims()) }));
    expect(identity).toEqual({ email: 'alfonso@example.com' });
  });

  it('accepts the assertion from the cookie too', async () => {
    const verify = verifier([one]);
    const token = sign(one, goodClaims());
    await expect(verify(request({ cookie: `CF_Authorization=${token}` }))).resolves.toEqual({
      email: 'alfonso@example.com',
    });
  });

  it('rejects a missing token', async () => {
    await expect(verifier([one])(request({}))).rejects.toThrow(/no Cloudflare Access assertion/);
  });

  it('rejects the wrong audience', async () => {
    const token = sign(one, goodClaims({ aud: ['someone-elses-app'] }));
    await expect(
      verifier([one])(request({ 'cf-access-jwt-assertion': token })),
    ).rejects.toThrow(/different application/);
  });

  it('rejects the wrong issuer', async () => {
    const token = sign(one, goodClaims({ iss: 'https://evil.cloudflareaccess.com' }));
    await expect(
      verifier([one])(request({ 'cf-access-jwt-assertion': token })),
    ).rejects.toThrow(/different team/);
  });

  it('rejects an expired assertion', async () => {
    const token = sign(one, goodClaims({ exp: NOW_S - 3600 }));
    await expect(
      verifier([one])(request({ 'cf-access-jwt-assertion': token })),
    ).rejects.toThrow(/expired/);
  });

  it('rejects an assertion with no exp at all', async () => {
    const claims = goodClaims();
    delete claims['exp'];
    await expect(
      verifier([one])(request({ 'cf-access-jwt-assertion': sign(one, claims) })),
    ).rejects.toThrow(/expired/);
  });

  it('rejects a not-yet-valid assertion', async () => {
    const token = sign(one, goodClaims({ nbf: NOW_S + 3600 }));
    await expect(
      verifier([one])(request({ 'cf-access-jwt-assertion': token })),
    ).rejects.toThrow(/not valid yet/);
  });

  it('rejects an assertion issued in the future', async () => {
    const token = sign(one, goodClaims({ iat: NOW_S + 3600 }));
    await expect(
      verifier([one])(request({ 'cf-access-jwt-assertion': token })),
    ).rejects.toThrow(/issued in the future/);
  });

  it('rejects a bad signature', async () => {
    const other = keypair('kid-one');
    // Signed by a different key that claims the same kid the team publishes.
    const token = sign(other, goodClaims());
    await expect(
      verifier([one])(request({ 'cf-access-jwt-assertion': token })),
    ).rejects.toThrow(/signature does not verify/);
  });

  it('rejects an assertion whose payload was swapped after signing', async () => {
    const token = sign(one, goodClaims());
    const [head, , signature] = token.split('.');
    const tampered = `${head}.${b64(goodClaims({ email: 'attacker@example.com' }))}.${signature}`;
    await expect(
      verifier([one])(request({ 'cf-access-jwt-assertion': tampered })),
    ).rejects.toThrow(/signature does not verify/);
  });

  it('rejects an algorithm that is not RS256', async () => {
    const token = sign(one, goodClaims(), { alg: 'none' });
    await expect(
      verifier([one])(request({ 'cf-access-jwt-assertion': token })),
    ).rejects.toThrow(/unsupported algorithm/);
  });

  it('rejects a token that is not a JWS', async () => {
    await expect(
      verifier([one])(request({ 'cf-access-jwt-assertion': 'not-a-jwt' })),
    ).rejects.toThrow(/not a JWS/);
  });

  it('rejects an assertion with no email claim', async () => {
    const claims = goodClaims();
    delete claims['email'];
    await expect(
      verifier([one])(request({ 'cf-access-jwt-assertion': sign(one, claims) })),
    ).rejects.toThrow(/carries no identity/);
  });

  it('selects the right key by kid out of a JWKS with several', async () => {
    const a = keypair('kid-a');
    const b = keypair('kid-b');
    const c = keypair('kid-c');
    const verify = verifier([a, b, c]);
    for (const pair of [a, b, c]) {
      await expect(
        verify(request({ 'cf-access-jwt-assertion': sign(pair, goodClaims()) })),
      ).resolves.toEqual({ email: 'alfonso@example.com' });
    }
  });

  it('caches the JWKS across verifications', async () => {
    const certs = certsFetch([one]);
    const verify = verifier([one], certs.impl);
    const token = sign(one, goodClaims());
    await verify(request({ 'cf-access-jwt-assertion': token }));
    await verify(request({ 'cf-access-jwt-assertion': token }));
    expect(certs.calls()).toBe(1);
  });

  it('refuses an unknown kid and does not refetch on every attempt', async () => {
    const certs = certsFetch([one]);
    const verify = verifier([one], certs.impl);
    const stranger = keypair('kid-unknown');
    const token = sign(stranger, goodClaims());
    await expect(verify(request({ 'cf-access-jwt-assertion': token }))).rejects.toThrow(
      /no public key for kid/,
    );
    await expect(verify(request({ 'cf-access-jwt-assertion': token }))).rejects.toThrow(
      /no public key for kid/,
    );
    // One initial fetch plus at most one unknown-kid refresh inside the cooldown window.
    expect(certs.calls()).toBeLessThanOrEqual(2);
  });

  it('reports a JWKS that cannot be fetched', async () => {
    const failing = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    await expect(
      verifier([one], failing)(request({ 'cf-access-jwt-assertion': sign(one, goodClaims()) })),
    ).rejects.toThrow(/could not be fetched/);
  });

  it('reports a JWKS with no usable keys', async () => {
    const empty = (() =>
      Promise.resolve(new Response(JSON.stringify({ keys: [] }), { status: 200 }))) as unknown as typeof fetch;
    await expect(
      verifier([one], empty)(request({ 'cf-access-jwt-assertion': sign(one, goodClaims()) })),
    ).rejects.toThrow(/no usable keys/);
  });
});
