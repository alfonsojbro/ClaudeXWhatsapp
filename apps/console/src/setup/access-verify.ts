/**
 * Cloudflare Access verification, self-contained.
 *
 * INTEGRATION IP-2: phase 8's `apps/console/src/access.ts` does the same job and supersedes
 * this file on merge. When phase 8 lands, delete this module and `standalone.ts`, and pass
 * phase 8's `AccessVerifier` into `createSetupHandler` as the `verifyAccess` dep — the dep is
 * a plain function of the request precisely so the swap is a one-line change at the call site.
 * Until then this branch has to verify Access itself, because the wizard is reachable from the
 * internet through the tunnel and a tunnel misconfiguration must not be enough to expose it.
 *
 * `node:crypto` only. No JOSE library, no new dependency: `@cxw/console` has none and keeps none.
 */

import { createPublicKey, createVerify } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export class AccessError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AccessError';
  }
}

export interface AccessIdentity {
  readonly email: string;
}

export interface AccessVerifyOptions {
  /** Cloudflare Access team name, e.g. `alfonso`. */
  readonly team: string;
  /** The application's audience tag. */
  readonly aud: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  /** JWKS cache lifetime in milliseconds. */
  readonly cacheTtlMs?: number;
  /** Allowed clock skew in seconds. */
  readonly skewSeconds?: number;
}

/** What `createSetupHandler` is handed. Throws on any failure; never returns a partial answer. */
export type VerifyAccess = (request: IncomingMessage) => Promise<AccessIdentity>;

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SKEW_S = 60;
/** One unknown-kid refresh per window, so attacker-chosen kids cannot amplify to Cloudflare. */
const UNKNOWN_KID_COOLDOWN_MS = 60_000;

interface JwtHeader {
  readonly alg?: string;
  readonly kid?: string;
}

interface JwtClaims {
  readonly aud?: string | readonly string[];
  readonly iss?: string;
  readonly exp?: number;
  readonly nbf?: number;
  readonly iat?: number;
  readonly email?: string;
}

interface CertsResponse {
  readonly keys?: readonly (JsonWebKey & { kid?: string })[];
}

export function accessIssuer(team: string): string {
  return `https://${team}.cloudflareaccess.com`;
}

export function accessCertsUrl(team: string): string {
  return `${accessIssuer(team)}/cdn-cgi/access/certs`;
}

/** The assertion, from the header Cloudflare sets, else from its cookie. */
export function readAssertion(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): string | undefined {
  const header = headers['cf-access-jwt-assertion'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (fromHeader !== undefined && fromHeader.trim() !== '') return fromHeader.trim();

  const rawCookie = headers['cookie'];
  const cookie = Array.isArray(rawCookie) ? rawCookie[0] : rawCookie;
  if (cookie === undefined) return undefined;
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'CF_Authorization' && rest.length > 0) {
      const value = rest.join('=').trim();
      if (value !== '') return value;
    }
  }
  return undefined;
}

function decodeSegment(segment: string, what: string): unknown {
  let json: string;
  try {
    json = Buffer.from(segment, 'base64url').toString('utf8');
  } catch {
    throw new AccessError(`access: ${what} is not base64url`);
  }
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new AccessError(`access: ${what} is not JSON`);
  }
}

export function createAccessVerifier(options: AccessVerifyOptions): VerifyAccess {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? ((): number => Date.now());
  const ttlMs = options.cacheTtlMs ?? DEFAULT_TTL_MS;
  const skewS = options.skewSeconds ?? DEFAULT_SKEW_S;
  const issuer = accessIssuer(options.team);
  const certsUrl = accessCertsUrl(options.team);

  let cache = new Map<string, JsonWebKey>();
  let fetchedAtMs = 0;
  let unknownKidCooldownUntilMs = 0;

  async function refresh(nowMs: number): Promise<void> {
    let response: Response;
    try {
      response = await fetchImpl(certsUrl, { signal: AbortSignal.timeout(2000) });
    } catch {
      throw new AccessError('access: the team public keys could not be fetched');
    }
    if (!response.ok) throw new AccessError(`access: team public keys returned ${response.status}`);
    let body: CertsResponse;
    try {
      body = (await response.json()) as CertsResponse;
    } catch {
      throw new AccessError('access: the team public keys are not JSON');
    }
    const next = new Map<string, JsonWebKey>();
    for (const jwk of body.keys ?? []) {
      if (typeof jwk.kid === 'string' && jwk.kid !== '') next.set(jwk.kid, jwk);
    }
    if (next.size === 0) throw new AccessError('access: the team published no usable keys');
    cache = next;
    fetchedAtMs = nowMs;
  }

  async function keyFor(kid: string, nowMs: number): Promise<JsonWebKey> {
    if (cache.size === 0 || nowMs - fetchedAtMs > ttlMs) await refresh(nowMs);
    const hit = cache.get(kid);
    if (hit !== undefined) return hit;
    if (nowMs < unknownKidCooldownUntilMs) {
      throw new AccessError(`access: no public key for kid ${kid}`);
    }
    unknownKidCooldownUntilMs = nowMs + UNKNOWN_KID_COOLDOWN_MS;
    await refresh(nowMs);
    const retry = cache.get(kid);
    if (retry === undefined) throw new AccessError(`access: no public key for kid ${kid}`);
    return retry;
  }

  async function verifyToken(token: string | undefined): Promise<AccessIdentity> {
    const nowMs = now();
    if (token === undefined || token.trim() === '') {
      throw new AccessError('access: no Cloudflare Access assertion on the request');
    }
    const parts = token.trim().split('.');
    if (parts.length !== 3) throw new AccessError('access: the assertion is not a JWS');
    const [headerPart, claimsPart, signaturePart] = parts as [string, string, string];

    const header = decodeSegment(headerPart, 'header') as JwtHeader;
    if (header.alg !== 'RS256') {
      throw new AccessError(`access: unsupported algorithm ${String(header.alg)}`);
    }
    if (typeof header.kid !== 'string' || header.kid === '') {
      throw new AccessError('access: the assertion has no kid');
    }
    if (signaturePart === '') throw new AccessError('access: the assertion is unsigned');

    const jwk = await keyFor(header.kid, nowMs);
    let verified: boolean;
    try {
      const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
      verified = createVerify('RSA-SHA256')
        .update(`${headerPart}.${claimsPart}`)
        .verify(publicKey, Buffer.from(signaturePart, 'base64url'));
    } catch {
      verified = false;
    }
    if (!verified) throw new AccessError('access: the assertion signature does not verify');

    const claims = decodeSegment(claimsPart, 'claims') as JwtClaims;
    const audience = typeof claims.aud === 'string' ? [claims.aud] : (claims.aud ?? []);
    if (!audience.includes(options.aud)) {
      throw new AccessError('access: the assertion is for a different application');
    }
    if (claims.iss !== issuer) {
      throw new AccessError('access: the assertion is from a different team');
    }

    const nowS = Math.floor(nowMs / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + skewS < nowS) {
      throw new AccessError('access: the assertion has expired');
    }
    if (typeof claims.nbf === 'number' && claims.nbf - skewS > nowS) {
      throw new AccessError('access: the assertion is not valid yet');
    }
    if (typeof claims.iat === 'number' && claims.iat - skewS > nowS) {
      throw new AccessError('access: the assertion was issued in the future');
    }

    const email = typeof claims.email === 'string' ? claims.email : '';
    if (email === '') throw new AccessError('access: the assertion carries no identity');
    return { email };
  }

  return (request: IncomingMessage): Promise<AccessIdentity> =>
    verifyToken(readAssertion(request.headers));
}

/**
 * Verifier for local development only, used when `CONSOLE_REQUIRE_ACCESS=false`.
 * `standalone.ts` refuses to start in that mode unless it is asked for explicitly.
 */
export function createOpenVerifier(email = 'dev@localhost'): VerifyAccess {
  return (): Promise<AccessIdentity> => Promise.resolve({ email });
}
