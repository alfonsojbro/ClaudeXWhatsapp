import { describe, expect, it } from 'vitest';
import {
  blockToMatrix,
  extractQrBlocks,
  isQrLine,
  latestQr,
  toSvg,
  type Module,
} from '../scripts/pair-qr/qr.js';

/** Encode a module matrix the way qrcode-terminal small mode prints it. */
function encode(rows: readonly (readonly Module[])[]): string[] {
  const out: string[] = [];
  for (let y = 0; y < rows.length; y += 2) {
    const top = rows[y] ?? [];
    const bottom = rows[y + 1] ?? top.map(() => 1 as Module);
    let line = '';
    top.forEach((t, x) => {
      const b = bottom[x] ?? 1;
      line += t === 0 && b === 0 ? '█' : t === 0 ? '▀' : b === 0 ? '▄' : ' ';
    });
    out.push(line);
  }
  return out;
}

/** A deterministic 12x12 pattern with a light border, like a real code's quiet zone. */
function sample(seed: number): Module[][] {
  const size = 12;
  const rows: Module[][] = [];
  for (let y = 0; y < size; y += 1) {
    const row: Module[] = [];
    for (let x = 0; x < size; x += 1) {
      const edge = x === 0 || y === 0 || x === size - 1 || y === size - 1;
      row.push(edge ? 0 : (((x * 7 + y * 3 + seed) % 5 < 2 ? 1 : 0) as Module));
    }
    rows.push(row);
  }
  return rows;
}

describe('isQrLine', () => {
  it('accepts half-block lines and rejects prose and blanks', () => {
    expect(isQrLine('█ ▄▄▄ █')).toBe(true);
    expect(isQrLine('   ')).toBe(false);
    expect(isQrLine('Scan this with WhatsApp')).toBe(false);
    expect(isQrLine('')).toBe(false);
  });
});

describe('extractQrBlocks', () => {
  it('finds each block, strips ANSI, and ignores an unterminated tail', () => {
    const a = encode(sample(1));
    const b = encode(sample(2));
    const text = [
      '{"level":30,"msg":"starting whatsapp socket"}',
      '\x1b[32mScan this with WhatsApp\x1b[0m',
      '',
      ...a.map((line) => `\x1b[0m${line}`),
      '',
      'noise',
      ...b,
      '',
      '█▀▄ partial line still being written',
    ].join('\n');
    const blocks = extractQrBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual(a);
    expect(blocks[1]).toEqual(b);
  });

  it('keeps a block open until a non-QR line closes it, unless the text is final', () => {
    const a = encode(sample(3));
    expect(extractQrBlocks(a.join('\n'))).toHaveLength(0);
    expect(extractQrBlocks(`${a.join('\n')}\n`)).toHaveLength(0);
    expect(extractQrBlocks(`${a.join('\n')}\n`, { final: true })).toHaveLength(1);
    expect(extractQrBlocks(`${a.join('\n')}\n\n`)).toHaveLength(1);
  });

  it('ignores stray short runs of block characters', () => {
    expect(extractQrBlocks('█▀\n▄▄\n\n')).toHaveLength(0);
  });
});

describe('blockToMatrix', () => {
  it('round-trips a matrix and strips the terminal-background half rows', () => {
    const original = sample(4);
    const dark = original[0]?.map(() => 1 as Module) ?? [];
    // qrcode-terminal's first and last text lines carry one dark half-row each.
    const withBorders = [dark, ...original, dark];
    const matrix = blockToMatrix(encode(withBorders));
    expect(matrix.width).toBe(12);
    expect(matrix.height).toBe(12);
    expect(matrix.rows).toEqual(original);
  });

  it('pads ragged lines with dark modules', () => {
    const lines = ['██', '█', '██', '██', '██'];
    const matrix = blockToMatrix(lines);
    expect(matrix.width).toBe(2);
    expect(matrix.rows[2]).toEqual([0, 1]);
  });
});

describe('latestQr', () => {
  it('returns the newest complete block, or null', () => {
    expect(latestQr('nothing here\n')).toBeNull();
    const text = `${encode(sample(5)).join('\n')}\n\n${encode(sample(6)).join('\n')}\n`;
    expect(latestQr(text)?.rows).toEqual(sample(5)); // the newest block is still open
    expect(latestQr(text, { final: true })?.rows).toEqual(sample(6));
    expect(latestQr(`${text}\n`)?.rows).toEqual(sample(6));
  });
});

describe('toSvg', () => {
  it('draws one square per dark module inside a quiet zone', () => {
    const rows: Module[][] = [
      [1, 0],
      [0, 1],
    ];
    const svg = toSvg({ rows, width: 2, height: 2 }, { quiet: 1, scale: 10 });
    expect(svg).toContain('viewBox="0 0 4 4"');
    expect(svg).toContain('width="40" height="40"');
    expect(svg.match(/h1v1h-1z/g)).toHaveLength(2);
    expect(svg).toContain('M1 1h1v1h-1z');
    expect(svg).toContain('M2 2h1v1h-1z');
  });
});
