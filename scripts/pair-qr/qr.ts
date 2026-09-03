/**
 * Half-block QR parsing and SVG rendering for the output of `pnpm pair`.
 *
 * `qrcode-terminal` in small mode prints two module rows per text line:
 *
 *   '█'  both modules light      '▀'  top light, bottom dark
 *   '▄'  top dark, bottom light  ' '  both modules dark
 *
 * "Light" here is what the terminal draws in the foreground colour. The QR
 * dark modules are the spaces, because the library assumes a dark terminal.
 * The first and last text lines carry a half-row of terminal background; they
 * show up as fully dark rows and are not part of the code, so they are dropped.
 *
 * No dependencies. Pure functions, so `tests/pair-qr.test.ts` can cover them.
 */

/** 1 is a dark module, 0 is a light one. */
export type Module = 0 | 1;

export interface QrMatrix {
  /** Rows of modules, top to bottom. Every row has `width` entries. */
  readonly rows: readonly (readonly Module[])[];
  readonly width: number;
  readonly height: number;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const QR_CHARS = new Set(['█', '▀', '▄', ' ']);
/** A real code is never shorter than this; it keeps stray lines out. */
const MIN_BLOCK_LINES = 5;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** True when the line is made only of half-block characters and is not blank. */
export function isQrLine(line: string): boolean {
  if (line.trim() === '') return false;
  for (const ch of line) if (!QR_CHARS.has(ch)) return false;
  return true;
}

export interface ExtractOptions {
  /**
   * The text is complete (a finished log file), so a block at its very end
   * counts even without a closing line. Default false: while a process is
   * still writing, a block is only reported once a non-QR line follows it.
   * qrcode-terminal always prints an empty line after the code, so that
   * closing line arrives with the code itself.
   */
  readonly final?: boolean;
}

/** Every complete QR block in `text`, in order of appearance. */
export function extractQrBlocks(text: string, options: ExtractOptions = {}): string[][] {
  const lines = stripAnsi(text).split('\n');
  lines.pop(); // the unterminated tail, possibly half a line
  const blocks: string[][] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length >= MIN_BLOCK_LINES) blocks.push(current);
    current = [];
  };
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (isQrLine(line)) current.push(line);
    else flush();
  }
  if (options.final === true) flush();
  return blocks;
}

/** Decode one block of half-block lines into a module matrix. */
export function blockToMatrix(block: readonly string[]): QrMatrix {
  const width = Math.max(...block.map((line) => line.length));
  const rows: Module[][] = [];
  for (const line of block) {
    const top: Module[] = [];
    const bottom: Module[] = [];
    for (const ch of line.padEnd(width, ' ')) {
      switch (ch) {
        case '█':
          top.push(0);
          bottom.push(0);
          break;
        case '▀':
          top.push(0);
          bottom.push(1);
          break;
        case '▄':
          top.push(1);
          bottom.push(0);
          break;
        default:
          top.push(1);
          bottom.push(1);
      }
    }
    rows.push(top, bottom);
  }
  // Terminal background shows as fully dark half-rows at the top and bottom.
  const allDark = (row: readonly Module[]): boolean => row.every((m) => m === 1);
  while (rows.length > 0 && allDark(rows[0] as Module[])) rows.shift();
  while (rows.length > 0 && allDark(rows[rows.length - 1] as Module[])) rows.pop();
  return { rows, width, height: rows.length };
}

/** The most recent complete QR in `text`, or null when there is none yet. */
export function latestQr(text: string, options: ExtractOptions = {}): QrMatrix | null {
  const blocks = extractQrBlocks(text, options);
  const last = blocks[blocks.length - 1];
  return last === undefined ? null : blockToMatrix(last);
}

export interface SvgOptions {
  /** Light modules of border around the code. The QR spec asks for 4. */
  readonly quiet?: number;
  /** Pixels per module in the SVG's width/height attributes. */
  readonly scale?: number;
}

/** Render a matrix as a crisp SVG: one path, one square per dark module. */
export function toSvg(matrix: QrMatrix, options: SvgOptions = {}): string {
  const quiet = options.quiet ?? 4;
  const scale = options.scale ?? 8;
  const w = matrix.width + quiet * 2;
  const h = matrix.height + quiet * 2;
  const parts: string[] = [];
  matrix.rows.forEach((row, y) => {
    row.forEach((module, x) => {
      if (module === 1) parts.push(`M${String(x + quiet)} ${String(y + quiet)}h1v1h-1z`);
    });
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(w)} ${String(h)}" width="${String(w * scale)}" height="${String(h * scale)}" shape-rendering="crispEdges" role="img" aria-label="WhatsApp link QR code">`,
    `<rect width="${String(w)}" height="${String(h)}" fill="#fff"/>`,
    `<path d="${parts.join('')}" fill="#000"/>`,
    '</svg>',
  ].join('');
}
