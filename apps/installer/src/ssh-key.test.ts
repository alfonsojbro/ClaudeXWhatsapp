import { describe, expect, it } from 'vitest';
import {
  DEPLOY_KEY_COMMENT,
  encodeOpenSshPrivateKey,
  encodeOpenSshPublicKey,
  fingerprintOpenSshPublicKey,
  fromBase64,
  generateDeployKey,
  parseOpenSshPrivateKey,
  parseOpenSshPublicKey,
  seedFromPkcs8,
  toBase64,
} from './ssh-key.js';

function hex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// RFC 8032, section 7.1, TEST 1.
const VECTOR_SEED = hex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
const VECTOR_PUBLIC = hex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');

describe('base64', () => {
  it('round-trips and pads', () => {
    expect(toBase64(new Uint8Array([1, 2, 3]))).toBe('AQID');
    expect(toBase64(new Uint8Array([1, 2]))).toBe('AQI=');
    expect(toBase64(new Uint8Array([1]))).toBe('AQ==');
    expect(toBase64(new Uint8Array([1]), { pad: false })).toBe('AQ');
    expect([...fromBase64(toBase64(VECTOR_SEED))]).toEqual([...VECTOR_SEED]);
  });
});

describe('encodeOpenSshPublicKey', () => {
  it('matches the fixed vector byte for byte', () => {
    const line = encodeOpenSshPublicKey(VECTOR_PUBLIC, DEPLOY_KEY_COMMENT);
    expect(line.startsWith('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI')).toBe(true);
    expect(line).toBe(
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINdamAGCsQq31Uv+08lkBzoO4XLz2qYjJa8CGmj3B1Ea cxw-installer',
    );
  });

  it('parses back to the same algorithm, key and comment', () => {
    const parsed = parseOpenSshPublicKey(encodeOpenSshPublicKey(VECTOR_PUBLIC, 'someone@example.com'));
    expect(parsed.algorithm).toBe('ssh-ed25519');
    expect([...parsed.rawPublicKey]).toEqual([...VECTOR_PUBLIC]);
    expect(parsed.comment).toBe('someone@example.com');
  });

  it('rejects a public key that is not 32 bytes', () => {
    expect(() => encodeOpenSshPublicKey(new Uint8Array(31), 'x')).toThrow(/32 bytes/);
  });
});

describe('encodeOpenSshPrivateKey', () => {
  const pem = encodeOpenSshPrivateKey(VECTOR_SEED, VECTOR_PUBLIC, DEPLOY_KEY_COMMENT);

  it('is PEM-armoured at 70 columns with a trailing newline', () => {
    const lines = pem.split('\n');
    expect(lines[0]).toBe('-----BEGIN OPENSSH PRIVATE KEY-----');
    expect(lines[lines.length - 2]).toBe('-----END OPENSSH PRIVATE KEY-----');
    expect(lines[lines.length - 1]).toBe('');
    for (const line of lines.slice(1, -2)) expect(line.length).toBeLessThanOrEqual(70);
    expect((lines[1] as string).length).toBe(70);
  });

  it('parses back to the same seed, public key and comment', () => {
    const parsed = parseOpenSshPrivateKey(pem);
    expect(parsed.cipherName).toBe('none');
    expect(parsed.kdfName).toBe('none');
    expect(parsed.algorithm).toBe('ssh-ed25519');
    expect([...parsed.seed32]).toEqual([...VECTOR_SEED]);
    expect([...parsed.rawPublicKey]).toEqual([...VECTOR_PUBLIC]);
    expect(parsed.comment).toBe(DEPLOY_KEY_COMMENT);
  });

  it('writes the checkint twice, identically', () => {
    const parsed = parseOpenSshPrivateKey(encodeOpenSshPrivateKey(VECTOR_SEED, VECTOR_PUBLIC, 'c', 0xa1b2c3d4));
    expect(parsed.checkint).toBe(0xa1b2c3d4);
  });

  it('pads the private section to a multiple of 8 for every comment length', () => {
    for (let n = 0; n < 16; n += 1) {
      const parsed = parseOpenSshPrivateKey(encodeOpenSshPrivateKey(VECTOR_SEED, VECTOR_PUBLIC, 'x'.repeat(n)));
      expect(parsed.privateSectionLength % 8).toBe(0);
      expect(parsed.comment).toBe('x'.repeat(n));
    }
  });

  it('rejects a seed that is not 32 bytes', () => {
    expect(() => encodeOpenSshPrivateKey(new Uint8Array(16), VECTOR_PUBLIC, 'x')).toThrow(/32 bytes/);
  });
});

describe('seedFromPkcs8', () => {
  it('rejects the wrong length and the wrong prefix', () => {
    expect(() => seedFromPkcs8(new Uint8Array(47))).toThrow(/48-byte/);
    const wrong = new Uint8Array(48);
    expect(() => seedFromPkcs8(wrong)).toThrow(/prefix/);
  });
});

describe('generateDeployKey', () => {
  it('round-trips a real WebCrypto key through both encoders', async () => {
    const key = await generateDeployKey();
    const pub = parseOpenSshPublicKey(key.publicKeyOpenSsh);
    const priv = parseOpenSshPrivateKey(key.privateKeyOpenSsh);

    expect(pub.comment).toBe(DEPLOY_KEY_COMMENT);
    expect(priv.comment).toBe(DEPLOY_KEY_COMMENT);
    expect([...priv.rawPublicKey]).toEqual([...pub.rawPublicKey]);
    expect(priv.seed32.length).toBe(32);
    expect(priv.privateSectionLength % 8).toBe(0);

    // The re-parsed seed must rebuild the same public key WebCrypto gave us.
    const pkcs8 = new Uint8Array([
      0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
      ...priv.seed32,
    ]);
    const imported = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
    const signature = await crypto.subtle.sign({ name: 'Ed25519' }, imported, new TextEncoder().encode('cxw'));
    const verifier = await crypto.subtle.importKey('raw', pub.rawPublicKey, { name: 'Ed25519' }, true, ['verify']);
    expect(
      await crypto.subtle.verify({ name: 'Ed25519' }, verifier, signature, new TextEncoder().encode('cxw')),
    ).toBe(true);
  });

  it('fingerprints like ssh-keygen -lf: SHA256 plus unpadded base64', async () => {
    const fingerprint = await fingerprintOpenSshPublicKey(VECTOR_PUBLIC);
    expect(fingerprint).toBe('SHA256:bbXpuKG6zhzdmnxq256TlqzFBzRl2f6OOg722cYNbU8');
    expect(fingerprint.includes('=')).toBe(false);
  });

  it('generates distinct keys', async () => {
    const a = await generateDeployKey();
    const b = await generateDeployKey();
    expect(a.publicKeyOpenSsh).not.toBe(b.publicKeyOpenSsh);
  });
});
