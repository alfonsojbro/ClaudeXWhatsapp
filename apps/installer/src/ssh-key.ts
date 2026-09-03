/**
 * Ed25519 deploy-key generation and OpenSSH encoding.
 *
 * Browser-safe: no `node:` imports, no DOM. Everything here runs on WebCrypto,
 * which Node 22 and every current browser expose as `crypto.subtle`.
 *
 * The person generates the pair in their own browser, pastes the public half into
 * the repository's deploy-key page, and the private half travels only inside the
 * cloud-init payload.
 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 of raw bytes. `pad: false` drops the `=` tail (fingerprint form). */
export function toBase64(bytes: Uint8Array, options: { pad?: boolean } = {}): string {
  const pad = options.pad ?? true;
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64_ALPHABET[b0 >> 2] as string;
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)] as string;
    out += b1 === undefined ? (pad ? '=' : '') : (BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)] as string);
    out += b2 === undefined ? (pad ? '=' : '') : (BASE64_ALPHABET[b2 & 0x3f] as string);
  }
  return out;
}

/** Inverse of {@link toBase64}. Ignores whitespace and padding. */
export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let n = 0;
  for (const ch of clean) {
    const v = BASE64_ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`not base64: ${ch}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n] = (acc >> bits) & 0xff;
      n += 1;
    }
  }
  return out.subarray(0, n);
}

function u32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** SSH wire "string": a 4-byte big-endian length followed by the bytes. */
export function sshString(value: Uint8Array | string): Uint8Array {
  const bytes = typeof value === 'string' ? utf8(value) : value;
  return concat([u32(bytes.length), bytes]);
}

/** Sequential reader for the SSH wire format, used by the encoders' own tests. */
export class SshReader {
  private at = 0;

  constructor(private readonly bytes: Uint8Array) {}

  readUint32(): number {
    if (this.at + 4 > this.bytes.length) throw new Error('truncated uint32');
    const b0 = this.bytes[this.at] as number;
    const b1 = this.bytes[this.at + 1] as number;
    const b2 = this.bytes[this.at + 2] as number;
    const b3 = this.bytes[this.at + 3] as number;
    this.at += 4;
    return ((b0 << 24) >>> 0) + (b1 << 16) + (b2 << 8) + b3;
  }

  readBytes(length: number): Uint8Array {
    if (this.at + length > this.bytes.length) throw new Error('truncated bytes');
    const out = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return out;
  }

  readString(): Uint8Array {
    return this.readBytes(this.readUint32());
  }

  readText(): string {
    return new TextDecoder().decode(this.readString());
  }

  rest(): Uint8Array {
    return this.bytes.subarray(this.at);
  }
}

export const SSH_ED25519 = 'ssh-ed25519';
const OPENSSH_MAGIC = 'openssh-key-v1\0';
const PEM_HEADER = '-----BEGIN OPENSSH PRIVATE KEY-----';
const PEM_FOOTER = '-----END OPENSSH PRIVATE KEY-----';
const PEM_WIDTH = 70;

/** `string "ssh-ed25519" || string <32 raw bytes>` — the blob every form embeds. */
export function ed25519PublicKeyBlob(rawPublicKey: Uint8Array): Uint8Array {
  if (rawPublicKey.length !== 32) throw new Error(`ed25519 public key must be 32 bytes, got ${rawPublicKey.length}`);
  return concat([sshString(SSH_ED25519), sshString(rawPublicKey)]);
}

/** `ssh-ed25519 <base64 blob> <comment>` — the authorized_keys / deploy-key line. */
export function encodeOpenSshPublicKey(rawPublicKey: Uint8Array, comment: string): string {
  return `${SSH_ED25519} ${toBase64(ed25519PublicKeyBlob(rawPublicKey))} ${comment}`;
}

export interface ParsedPublicKey {
  readonly algorithm: string;
  readonly rawPublicKey: Uint8Array;
  readonly comment: string;
}

export function parseOpenSshPublicKey(line: string): ParsedPublicKey {
  const parts = line.trim().split(/\s+/);
  const algorithm = parts[0];
  const blob = parts[1];
  if (algorithm === undefined || blob === undefined) throw new Error('public key line has too few fields');
  const reader = new SshReader(fromBase64(blob));
  const inner = reader.readText();
  if (inner !== algorithm) throw new Error(`blob algorithm ${inner} does not match prefix ${algorithm}`);
  return { algorithm, rawPublicKey: reader.readString(), comment: parts.slice(2).join(' ') };
}

/**
 * An unencrypted OpenSSH private key.
 *
 * Container: `openssh-key-v1\0`, string ciphername "none", string kdfname "none",
 * string kdfoptions "", uint32 numkeys 1, string <public blob>, string <private section>.
 * Private section: uint32 checkint twice, string "ssh-ed25519", string <32-byte pub>,
 * string <seed||pub>, string <comment>, then 1,2,3,… padding to a multiple of 8.
 */
export function encodeOpenSshPrivateKey(
  seed32: Uint8Array,
  rawPublicKey: Uint8Array,
  comment: string,
  checkint = 0x12345678,
): string {
  if (seed32.length !== 32) throw new Error(`ed25519 seed must be 32 bytes, got ${seed32.length}`);
  const publicBlob = ed25519PublicKeyBlob(rawPublicKey);

  const body = concat([
    u32(checkint),
    u32(checkint),
    sshString(SSH_ED25519),
    sshString(rawPublicKey),
    sshString(concat([seed32, rawPublicKey])),
    sshString(comment),
  ]);
  // "none" has a nominal block size of 8; pad with 1,2,3,… as OpenSSH does.
  const padding = new Uint8Array((8 - (body.length % 8)) % 8);
  for (let i = 0; i < padding.length; i += 1) padding[i] = i + 1;
  const privateSection = concat([body, padding]);

  const container = concat([
    utf8(OPENSSH_MAGIC),
    sshString('none'),
    sshString('none'),
    sshString(''),
    u32(1),
    sshString(publicBlob),
    sshString(privateSection),
  ]);

  const armour = toBase64(container);
  const lines: string[] = [PEM_HEADER];
  for (let i = 0; i < armour.length; i += PEM_WIDTH) lines.push(armour.slice(i, i + PEM_WIDTH));
  lines.push(PEM_FOOTER);
  return `${lines.join('\n')}\n`;
}

export interface ParsedPrivateKey {
  readonly cipherName: string;
  readonly kdfName: string;
  readonly checkint: number;
  readonly algorithm: string;
  readonly rawPublicKey: Uint8Array;
  readonly seed32: Uint8Array;
  readonly comment: string;
  /** Length of the private section including padding; always a multiple of 8. */
  readonly privateSectionLength: number;
}

export function parseOpenSshPrivateKey(pem: string): ParsedPrivateKey {
  const start = pem.indexOf(PEM_HEADER);
  const end = pem.indexOf(PEM_FOOTER);
  if (start < 0 || end < 0) throw new Error('not an OpenSSH private key');
  const container = fromBase64(pem.slice(start + PEM_HEADER.length, end));

  const magic = new TextDecoder().decode(container.subarray(0, OPENSSH_MAGIC.length));
  if (magic !== OPENSSH_MAGIC) throw new Error('bad openssh-key-v1 magic');

  const reader = new SshReader(container.subarray(OPENSSH_MAGIC.length));
  const cipherName = reader.readText();
  const kdfName = reader.readText();
  reader.readString(); // kdfoptions, empty for an unencrypted key
  const numKeys = reader.readUint32();
  if (numKeys !== 1) throw new Error(`expected 1 key, got ${numKeys}`);
  reader.readString(); // public blob, re-derived from the private section below
  const privateSection = reader.readString();

  const inner = new SshReader(privateSection);
  const checkint = inner.readUint32();
  if (inner.readUint32() !== checkint) throw new Error('checkint mismatch: key is encrypted or corrupt');
  const algorithm = inner.readText();
  const rawPublicKey = inner.readString();
  const secret = inner.readString();
  if (secret.length !== 64) throw new Error(`expected a 64-byte secret, got ${secret.length}`);
  const comment = inner.readText();

  return {
    cipherName,
    kdfName,
    checkint,
    algorithm,
    rawPublicKey,
    seed32: secret.subarray(0, 32),
    comment,
    privateSectionLength: privateSection.length,
  };
}

// PKCS#8 for Ed25519 is exactly 48 bytes: a fixed 16-byte prefix then the 32-byte seed.
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/** Pull the 32-byte Ed25519 seed out of a PKCS#8 export, checking the shape first. */
export function seedFromPkcs8(pkcs8: Uint8Array): Uint8Array {
  if (pkcs8.length !== 48) throw new Error(`expected a 48-byte Ed25519 PKCS#8 key, got ${pkcs8.length}`);
  for (let i = 0; i < PKCS8_ED25519_PREFIX.length; i += 1) {
    if (pkcs8[i] !== PKCS8_ED25519_PREFIX[i]) throw new Error(`unexpected PKCS#8 prefix at byte ${i}`);
  }
  return pkcs8.subarray(16);
}

/**
 * The slice of WebCrypto this module uses.
 *
 * Declared structurally rather than as `SubtleCrypto`: the package compiles with
 * `lib: ES2023` and no DOM, and the Node types keep `SubtleCrypto` inside
 * `node:crypto`. A local shape keeps the module free of both.
 */
export interface SubtleLike {
  generateKey(
    algorithm: { name: string },
    extractable: boolean,
    keyUsages: readonly string[],
  ): Promise<{ publicKey: unknown; privateKey: unknown }>;
  exportKey(format: 'raw' | 'pkcs8', key: never): Promise<ArrayBuffer>;
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}

/** The ambient WebCrypto, narrowed to {@link SubtleLike}. */
export const defaultSubtle = (): SubtleLike => crypto.subtle as unknown as SubtleLike;

export interface DeployKey {
  readonly publicKeyOpenSsh: string;
  readonly privateKeyOpenSsh: string;
  /** `SHA256:<unpadded base64>`, byte for byte what `ssh-keygen -lf` prints. */
  readonly fingerprintSha256: string;
}

export const DEPLOY_KEY_COMMENT = 'cxw-installer';

export async function generateDeployKey(
  subtle: SubtleLike = defaultSubtle(),
  comment: string = DEPLOY_KEY_COMMENT,
): Promise<DeployKey> {
  const pair = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const rawPublicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey as never));
  const seed32 = seedFromPkcs8(new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey as never)));
  return {
    publicKeyOpenSsh: encodeOpenSshPublicKey(rawPublicKey, comment),
    privateKeyOpenSsh: encodeOpenSshPrivateKey(seed32, rawPublicKey, comment),
    fingerprintSha256: await fingerprintOpenSshPublicKey(rawPublicKey, subtle),
  };
}

export async function fingerprintOpenSshPublicKey(
  rawPublicKey: Uint8Array,
  subtle: SubtleLike = defaultSubtle(),
): Promise<string> {
  const blob = ed25519PublicKeyBlob(rawPublicKey);
  const digest = new Uint8Array(await subtle.digest('SHA-256', blob));
  return `SHA256:${toBase64(digest, { pad: false })}`;
}
