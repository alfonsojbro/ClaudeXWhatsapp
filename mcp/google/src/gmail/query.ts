/**
 * Pure builders for Gmail: the search query string and the RFC 5322 raw message.
 * No I/O here, so every rule is unit-tested.
 */

export interface GmailQueryFilters {
  q?: string;
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  /** `YYYY-MM-DD` or `YYYY/MM/DD`. */
  after?: string;
  before?: string;
  newerThanDays?: number;
  unread?: boolean;
  label?: string;
  hasAttachment?: boolean;
  inInbox?: boolean;
}

/** Gmail wants `2026/09/01`; accept the ISO spelling too. */
export function toGmailDate(value: string): string {
  const trimmed = value.trim();
  if (!/^\d{4}[-/]\d{2}[-/]\d{2}$/u.test(trimmed)) {
    throw new Error(`bad date ${JSON.stringify(value)}: use YYYY-MM-DD`);
  }
  return trimmed.replace(/-/gu, '/');
}

/** Quote a value when it contains whitespace or a quote character. */
export function quoteValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return trimmed;
  if (!/[\s"]/u.test(trimmed)) return trimmed;
  return `"${trimmed.replace(/"/gu, '\\"')}"`;
}

/** Compose a Gmail search string. The free-form `q` is appended last. */
export function buildGmailQuery(f: GmailQueryFilters): string {
  const parts: string[] = [];
  const push = (op: string, value: string | undefined): void => {
    if (value === undefined) return;
    const quoted = quoteValue(value);
    if (quoted === '') return;
    parts.push(`${op}:${quoted}`);
  };
  push('from', f.from);
  push('to', f.to);
  push('subject', f.subject);
  if (f.after !== undefined) parts.push(`after:${toGmailDate(f.after)}`);
  if (f.before !== undefined) parts.push(`before:${toGmailDate(f.before)}`);
  if (f.newerThanDays !== undefined) {
    if (!Number.isInteger(f.newerThanDays) || f.newerThanDays < 1) {
      throw new Error('newer_than_days must be a positive whole number of days');
    }
    parts.push(`newer_than:${f.newerThanDays}d`);
  }
  if (f.unread === true) parts.push('is:unread');
  if (f.unread === false) parts.push('-is:unread');
  push('label', f.label);
  if (f.hasAttachment === true) parts.push('has:attachment');
  if (f.inInbox === true) parts.push('in:inbox');
  if (f.text !== undefined && f.text.trim() !== '') parts.push(quoteValue(f.text));
  if (f.q !== undefined && f.q.trim() !== '') parts.push(f.q.trim());
  return parts.join(' ');
}

export interface RawMessageInput {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
}

const HEADER_INJECTION = /[\r\n]/u;

function assertHeaderSafe(name: string, value: string): void {
  if (HEADER_INJECTION.test(value)) {
    throw new Error(`header injection rejected in ${name}`);
  }
}

/** RFC 2047 encoded-word for headers that are not pure ASCII. */
export function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/u.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/**
 * RFC 2047 for an address header entry. `Ana Ramírez <ana@example.com>` must encode
 * only the display name: an encoded-word that swallowed the angle brackets would make
 * the whole `To:` unparseable and Gmail would reject the send *after* the owner had
 * already confirmed it. A bare `ana@example.com` is returned untouched.
 */
export function encodeAddressValue(value: string): string {
  const trimmed = value.trim();
  const match = /^([\s\S]*?)\s*(<[^<>]*>)$/u.exec(trimmed);
  if (match === null) return encodeHeaderValue(trimmed);
  const display = (match[1] ?? '').trim();
  const addr = match[2] ?? '';
  if (display === '') return addr;
  return `${encodeHeaderValue(display)} ${addr}`;
}

/** Base64url without padding, the encoding Gmail's `raw` field expects. */
export function toBase64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** Decode a base64url payload back to a UTF-8 string. */
export function fromBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

/**
 * Build the RFC 5322 message Gmail sends. Plain text only (no HTML mail),
 * CRLF line endings, UTF-8 8bit body.
 */
export function buildRawMessage(input: RawMessageInput): string {
  const to = input.to.map((v) => v.trim()).filter((v) => v !== '');
  if (to.length === 0) throw new Error('at least one recipient is required');
  const cc = (input.cc ?? []).map((v) => v.trim()).filter((v) => v !== '');
  const bcc = (input.bcc ?? []).map((v) => v.trim()).filter((v) => v !== '');

  const headers: [string, string][] = [
    ['From', encodeAddressValue(input.from)],
    ['To', to.map(encodeAddressValue).join(', ')],
  ];
  if (cc.length > 0) headers.push(['Cc', cc.map(encodeAddressValue).join(', ')]);
  if (bcc.length > 0) headers.push(['Bcc', bcc.map(encodeAddressValue).join(', ')]);
  headers.push(['Subject', encodeHeaderValue(input.subject)]);
  if (input.inReplyTo !== undefined && input.inReplyTo !== '') {
    headers.push(['In-Reply-To', input.inReplyTo]);
  }
  if (input.references !== undefined && input.references !== '') {
    headers.push(['References', input.references]);
  }
  headers.push(['MIME-Version', '1.0']);
  headers.push(['Content-Type', 'text/plain; charset="UTF-8"']);
  headers.push(['Content-Transfer-Encoding', '8bit']);

  for (const [name, value] of headers) assertHeaderSafe(name, value);

  const body = input.text.replace(/\r\n/gu, '\n').replace(/\n/gu, '\r\n');
  const head = headers.map(([name, value]) => `${name}: ${value}`).join('\r\n');
  return toBase64Url(`${head}\r\n\r\n${body}`);
}

/** `Re: x` stays `Re: x`; anything else gains the prefix. */
export function replySubject(original: string | undefined): string {
  const base = (original ?? '').trim();
  if (base === '') return 'Re:';
  return /^re\s*:/iu.test(base) ? base : `Re: ${base}`;
}

/** Merge the original `References` with its `Message-ID`, per RFC 5322. */
export function replyReferences(
  references: string | undefined,
  messageId: string | undefined,
): string | undefined {
  const parts = [references, messageId]
    .map((v) => (v ?? '').trim())
    .filter((v) => v !== '')
    .join(' ')
    .trim();
  return parts === '' ? undefined : parts;
}
