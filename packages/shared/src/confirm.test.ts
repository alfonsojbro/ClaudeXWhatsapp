import { mkdtempSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONFIRM_TTL_MS,
  ConfirmStore,
  TOKEN_ALPHABET,
  TOKEN_RE,
  defaultConfirmDir,
  formatConfirmPrompt,
  generateToken,
  parseConfirmReply,
} from './confirm.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cxw-confirm-'));
  dirs.push(dir);
  return path.join(dir, 'confirm');
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('generateToken', () => {
  it('uses the ambiguity-free alphabet', () => {
    for (let i = 0; i < 200; i += 1) {
      const token = generateToken();
      expect(token).toHaveLength(6);
      expect(TOKEN_RE.test(token)).toBe(true);
      for (const ch of token) expect(TOKEN_ALPHABET).toContain(ch);
    }
  });

  it('never emits 0, O, 1 or I', () => {
    expect(TOKEN_ALPHABET).not.toMatch(/[01OI]/);
  });

  it('is deterministic with an injected random source', () => {
    expect(generateToken(() => 0)).toBe('AAAAAA');
  });
});

describe('ConfirmStore', () => {
  it('mints, peeks, takes once and refuses a second take', async () => {
    const store = new ConfirmStore(tempDir());
    const action = await store.mint({
      kind: 'gmail_send',
      preview: 'Send email',
      payload: { to: ['a@example.com'] },
      source: 'mcp-google',
    });
    expect(TOKEN_RE.test(action.token)).toBe(true);

    const peeked = await store.peek(action.token);
    expect(peeked?.kind).toBe('gmail_send');
    expect(peeked?.payload).toEqual({ to: ['a@example.com'] });

    const taken = await store.take(action.token);
    expect(taken?.token).toBe(action.token);
    expect(await store.take(action.token)).toBeNull();
    expect(await store.peek(action.token)).toBeNull();
  });

  it('writes 0600 files inside a 0700 directory', async () => {
    const dir = tempDir();
    const store = new ConfirmStore(dir);
    const action = await store.mint({ kind: 'k', preview: 'p', payload: 1, source: 's' });
    const dirStat = await fs.stat(dir);
    const fileStat = await fs.stat(path.join(dir, `${action.token}.json`));
    expect(dirStat.mode & 0o777).toBe(0o700);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it('expires entries using the injected clock', async () => {
    let clock = Date.parse('2026-09-03T10:00:00Z');
    const store = new ConfirmStore(tempDir(), { now: () => clock, ttlMs: 60_000 });
    const action = await store.mint({ kind: 'k', preview: 'p', payload: 'x', source: 's' });
    expect(action.expiresAt).toBe('2026-09-03T10:01:00.000Z');
    expect(await store.peek(action.token)).not.toBeNull();
    clock += 60_001;
    expect(await store.peek(action.token)).toBeNull();
    expect(await store.take(action.token)).toBeNull();
  });

  it('retries on a token collision', async () => {
    const tokens = ['AAAAAA', 'AAAAAA', 'BBBBBB'];
    let i = 0;
    const store = new ConfirmStore(tempDir(), {
      token: () => tokens[i++] ?? 'CCCCCC',
    });
    const first = await store.mint({ kind: 'k', preview: 'p', payload: 1, source: 's' });
    const second = await store.mint({ kind: 'k', preview: 'p', payload: 2, source: 's' });
    expect(first.token).toBe('AAAAAA');
    expect(second.token).toBe('BBBBBB');
  });

  it('cancels, lists and sweeps', async () => {
    let clock = Date.parse('2026-09-03T10:00:00Z');
    const store = new ConfirmStore(tempDir(), { now: () => clock, ttlMs: 60_000 });
    const a = await store.mint({ kind: 'k', preview: 'a', payload: 1, source: 's' });
    clock += 1;
    const b = await store.mint({ kind: 'k', preview: 'b', payload: 2, source: 's' });
    expect((await store.list()).map((x) => x.preview)).toEqual(['a', 'b']);
    expect(await store.cancel(a.token)).toBe(true);
    expect(await store.cancel(a.token)).toBe(false);
    expect((await store.list()).map((x) => x.token)).toEqual([b.token]);
    clock += 120_000;
    expect(await store.sweep()).toBe(1);
    expect(await store.sweep()).toBe(0);
    expect(await store.list()).toEqual([]);
  });

  it('is path-traversal safe', async () => {
    const dir = tempDir();
    const store = new ConfirmStore(dir);
    await store.mint({ kind: 'k', preview: 'p', payload: 1, source: 's' });
    await fs.writeFile(path.join(dir, '..', 'outside.json'), 'secret');
    expect(await store.take('../outside')).toBeNull();
    expect(await store.peek('../../etc/passwd')).toBeNull();
    expect(await store.cancel('/etc/passwd')).toBe(false);
    expect(await store.take('AAAAAAA')).toBeNull();
    expect(await store.take('aaaaaa')).toBeNull();
    await expect(fs.readFile(path.join(dir, '..', 'outside.json'), 'utf8')).resolves.toBe('secret');
  });

  it('returns null for an unknown but well-formed token', async () => {
    const store = new ConfirmStore(tempDir());
    expect(await store.peek('ABCDEF')).toBeNull();
    expect(await store.take('ABCDEF')).toBeNull();
    expect(await store.list()).toEqual([]);
  });
});

describe('parseConfirmReply', () => {
  const yes = [
    'yes AB3D9K',
    'y ab3d9k',
    'OK AB3D9K',
    'confirm AB3D9K',
    'si AB3D9K',
    'sí AB3D9K',
    'send AB3D9K',
    '  yes   AB3D9K  ',
    'yes AB3D9K.',
  ];
  const no = ['no AB3D9K', 'n ab3d9k', 'cancel AB3D9K', 'abort AB3D9K', 'NO AB3D9K!'];
  const junk = [
    'yes',
    'AB3D9K',
    'yes AB3D9K please',
    'maybe AB3D9K',
    'yes AB3D9',
    'yes AB3D9K1',
    'yes AB0D9K',
    'yes ABID9K',
    '',
    'yes  ',
  ];

  it.each(yes)('accepts %j as yes', (text) => {
    expect(parseConfirmReply(text)).toEqual({ verb: 'yes', token: 'AB3D9K' });
  });

  it.each(no)('accepts %j as no', (text) => {
    expect(parseConfirmReply(text)).toEqual({ verb: 'no', token: 'AB3D9K' });
  });

  it.each(junk)('rejects %j', (text) => {
    expect(parseConfirmReply(text)).toBeNull();
  });
});

describe('formatConfirmPrompt', () => {
  it('shows the preview, the token and the deadline', () => {
    const action = {
      token: 'AB3D9K',
      kind: 'gmail_send',
      preview: 'Send email to ana@example.com',
      payload: {},
      source: 'mcp-google',
      createdAt: '2026-09-03T10:00:00.000Z',
      expiresAt: '2026-09-03T10:10:00.000Z',
    };
    const text = formatConfirmPrompt(action);
    expect(text).toContain('Send email to ana@example.com');
    expect(text).toContain('yes AB3D9K');
    expect(text).toContain('no AB3D9K');
    expect(text).toContain('10 min');
    expect(CONFIRM_TTL_MS).toBe(600_000);
  });
});

describe('defaultConfirmDir', () => {
  it('prefers CXW_CONFIRM_DIR, then CXW_STATE_DIR, then ./state', () => {
    expect(defaultConfirmDir({ CXW_CONFIRM_DIR: '/a/b' })).toBe('/a/b');
    expect(defaultConfirmDir({ CXW_STATE_DIR: '/srv/cxw/state' })).toBe('/srv/cxw/state/confirm');
    expect(defaultConfirmDir({})).toBe(path.join('./state', 'confirm'));
  });
});
