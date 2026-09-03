import { describe, expect, it } from 'vitest';
import { DEFAULT_CHUNK_MAX, chunkText } from '../src/chunk.js';

describe('chunkText', () => {
  it('returns short text untouched', () => {
    expect(chunkText('hello')).toEqual(['hello']);
  });

  it('returns nothing for empty text', () => {
    expect(chunkText('')).toEqual([]);
  });

  it('rejects a non-positive max', () => {
    expect(() => chunkText('abc', 0)).toThrow(RangeError);
    expect(() => chunkText('abc', 1.5)).toThrow(RangeError);
  });

  it('splits on a blank line first', () => {
    const text = 'para one\n\npara two';
    expect(chunkText(text, 12)).toEqual(['para one', 'para two']);
  });

  it('falls back to a line break', () => {
    const text = 'line one\nline two';
    expect(chunkText(text, 12)).toEqual(['line one', 'line two']);
  });

  it('hard-cuts text with no whitespace', () => {
    const text = 'x'.repeat(25);
    const chunks = chunkText(text, 10);
    expect(chunks).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
    expect(chunks.join('')).toBe(text);
  });

  it('never returns an empty chunk and never exceeds max', () => {
    const text = Array.from({ length: 200 }, (_, i) => `paragraph ${String(i)} body`).join('\n\n');
    const chunks = chunkText(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeGreaterThan(0);
      expect(c.length).toBeLessThanOrEqual(100);
    }
  });

  it('loses only the whitespace at the split points', () => {
    const text = Array.from({ length: 60 }, (_, i) => `paragraph ${String(i)}`).join('\n\n');
    const chunks = chunkText(text, 90);
    expect(chunks.join('').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
  });

  it('prefers the latest blank line inside the window', () => {
    const text = 'a\n\nbb\n\nccc\n\ndddd';
    const chunks = chunkText(text, 8);
    expect(chunks[0]).toBe('a\n\nbb');
    expect(chunks.join('\n\n')).toBe(text);
  });

  it('handles a giant single line inside otherwise short text', () => {
    const text = `short\n\n${'y'.repeat(30)}\n\nend`;
    const chunks = chunkText(text, 10);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(10);
    expect(chunks.join('').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
  });

  it('exposes a sane default max', () => {
    expect(DEFAULT_CHUNK_MAX).toBe(3500);
    expect(chunkText('a'.repeat(DEFAULT_CHUNK_MAX))).toHaveLength(1);
    expect(chunkText('a'.repeat(DEFAULT_CHUNK_MAX + 1))).toHaveLength(2);
  });
});
