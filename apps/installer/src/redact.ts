/**
 * Redaction for anything that might be logged or shown back to the person.
 *
 * The installer never stores a token, but an API client can still throw an error
 * whose message quotes the request. This runs over every such string first.
 *
 * Browser-safe: no `node:` imports.
 */

/** Object keys whose values are secret wherever they appear. */
export const SECRET_KEYS: readonly string[] = [
  'authorization',
  'token',
  'tunnel_token',
  'tunnelToken',
  'api_token',
  'apiToken',
  'auth_key',
  'authKey',
  'authkey',
  'tailscaleAuthKey',
  'deployKeyPrivate',
  'private_key',
  'privateKey',
  'client_secret',
  'clientSecret',
  'refresh_token',
  'refreshToken',
  'password',
  'secret',
];

const MASK = '[redacted]';

const PATTERNS: readonly RegExp[] = [
  // Bearer/authorization headers.
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  // Tailscale auth keys and OAuth client secrets.
  /\btskey-[A-Za-z0-9-]+/g,
  // OpenSSH private key bodies.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Long opaque blobs: Cloudflare tunnel tokens, Hetzner tokens, JWTs.
  /\b[A-Za-z0-9_-]{40,}={0,2}\b/g,
];

function maskString(value: string): string {
  let out = value;
  for (const pattern of PATTERNS) out = out.replace(pattern, MASK);
  return out;
}

/**
 * Mask every token-shaped run in `value`. Objects and arrays are walked; any key in
 * {@link SECRET_KEYS} is masked whole, whatever its value looks like.
 */
export function redactForLog(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return maskString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redactForLog(item, seen));

  if (value instanceof Error) {
    return { name: value.name, message: maskString(value.message) };
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.includes(key.toLowerCase()) || SECRET_KEYS.includes(key)
      ? MASK
      : redactForLog(item, seen);
  }
  return out;
}

/** Convenience for error paths: a single redacted line, never a stack. */
export function redactedMessage(error: unknown): string {
  if (error instanceof Error) return maskString(error.message);
  return maskString(String(error));
}
