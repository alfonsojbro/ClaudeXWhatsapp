import { describe, expect, it } from 'vitest';
import { SECRET_KEYS, redactForLog, redactedMessage } from './redact.js';

describe('redactForLog', () => {
  it('masks bearer tokens in free text', () => {
    expect(redactForLog('Authorization: Bearer abcdef0123456789')).toBe('Authorization: [redacted]');
  });

  it('masks tailscale auth keys', () => {
    expect(redactForLog('joining with tskey-auth-kabcDEF123-xyz now')).toContain('[redacted]');
    expect(redactForLog('joining with tskey-auth-kabcDEF123-xyz now')).not.toContain('tskey-auth');
  });

  it('masks a whole private key block', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nZm9v\n-----END OPENSSH PRIVATE KEY-----';
    expect(redactForLog(`key was ${pem} ok`)).toBe('key was [redacted] ok');
  });

  it('masks long opaque blobs', () => {
    const token = 'a'.repeat(60);
    expect(redactForLog(`token=${token}`)).toBe('token=[redacted]');
  });

  it('masks every secret key by name, whatever the value looks like', () => {
    const out = redactForLog({ tunnelToken: 'x', password: 'y', domain: 'example.com' }) as Record<string, unknown>;
    expect(out['tunnelToken']).toBe('[redacted]');
    expect(out['password']).toBe('[redacted]');
    expect(out['domain']).toBe('example.com');
  });

  it('walks arrays and nested objects, and survives cycles', () => {
    const node: Record<string, unknown> = { token: 'secret', list: [{ secret: 'nope' }] };
    node['self'] = node;
    const out = redactForLog(node) as Record<string, unknown>;
    expect(out['token']).toBe('[redacted]');
    expect((out['list'] as Record<string, unknown>[])[0]?.['secret']).toBe('[redacted]');
    expect(out['self']).toBe('[circular]');
  });

  it('reduces an Error to a redacted name and message', () => {
    const out = redactForLog(new Error('failed with Bearer abcdef0123456789')) as Record<string, unknown>;
    expect(out).toEqual({ name: 'Error', message: 'failed with [redacted]' });
  });

  it('leaves non-string primitives alone', () => {
    expect(redactForLog(7)).toBe(7);
    expect(redactForLog(null)).toBe(null);
    expect(redactForLog(true)).toBe(true);
  });

  it('lists the keys it knows about', () => {
    expect(SECRET_KEYS).toContain('token');
    expect(SECRET_KEYS).toContain('deployKeyPrivate');
  });
});

describe('redactedMessage', () => {
  it('never returns a stack', () => {
    const error = new Error('boom Bearer abcdef0123456789');
    expect(redactedMessage(error)).toBe('boom [redacted]');
    expect(redactedMessage('plain')).toBe('plain');
  });
});
