/**
 * Split long text into WhatsApp-sized pieces.
 */

/** Default chunk ceiling, comfortably under the WhatsApp message limit. */
export const DEFAULT_CHUNK_MAX = 3500;

/**
 * Split `text` into chunks of at most `max` characters.
 *
 * Preference order for the split point: a blank line, then a line break, then a hard cut at
 * `max`. No chunk is empty and none exceeds `max`; the only characters dropped are the
 * whitespace at the split points.
 */
export function chunkText(text: string, max: number = DEFAULT_CHUNK_MAX): string[] {
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError('max must be a positive integer');
  }

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > max) {
    const window = rest.slice(0, max + 1);

    let cut = window.lastIndexOf('\n\n');
    let skip = 2;
    if (cut < 1) {
      cut = window.lastIndexOf('\n');
      skip = 1;
    }
    if (cut < 1) {
      cut = max;
      skip = 0;
    }

    const piece = skip === 0 ? rest.slice(0, cut) : rest.slice(0, cut).replace(/\s+$/, '');
    if (piece.length === 0) {
      // A boundary that yields nothing but whitespace: fall back to a hard cut.
      chunks.push(rest.slice(0, max));
      rest = rest.slice(max);
      continue;
    }

    chunks.push(piece);
    rest = skip === 0 ? rest.slice(cut) : rest.slice(cut + skip).replace(/^\s+/, '');
  }

  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
