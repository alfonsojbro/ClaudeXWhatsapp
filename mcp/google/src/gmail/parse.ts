/** Pure readers for Gmail message payloads: headers, body, attachments. */
import type { gmail_v1 } from 'googleapis';

export interface Attachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

export interface MessageBody {
  text: string;
  html: string;
}

/** Decode Gmail's base64url body data. */
export function decodeBase64Url(data: string | null | undefined): string {
  if (data === null || data === undefined || data === '') return '';
  return Buffer.from(data, 'base64url').toString('utf8');
}

/** Case-insensitive header lookup. */
export function headerValue(
  headers: gmail_v1.Schema$MessagePartHeader[] | null | undefined,
  name: string,
): string | undefined {
  if (!Array.isArray(headers)) return undefined;
  const wanted = name.toLowerCase();
  for (const h of headers) {
    if ((h.name ?? '').toLowerCase() === wanted) {
      const value = h.value ?? '';
      return value === '' ? undefined : value;
    }
  }
  return undefined;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/** Good-enough HTML → text, used when a message has no `text/plain` part. */
export function htmlToText(html: string): string {
  let out = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, '');
  out = out.replace(/<br\s*\/?>/giu, '\n');
  out = out.replace(/<\/(p|div|tr|li|h[1-6])\s*>/giu, '\n');
  out = out.replace(/<[^>]+>/gu, '');
  out = out.replace(/&#(\d+);/gu, (_m, code: string) => String.fromCodePoint(Number(code)));
  for (const [entity, char] of Object.entries(ENTITIES)) {
    out = out.split(entity).join(char);
  }
  out = out.replace(/[ \t\u00A0]+/gu, ' ');
  out = out.replace(/[ \t]*\n[ \t]*/gu, '\n');
  out = out.replace(/\n{3,}/gu, '\n\n');
  return out.trim();
}

function walk(
  part: gmail_v1.Schema$MessagePart,
  visit: (p: gmail_v1.Schema$MessagePart) => void,
): void {
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
}

/** Collect the plain-text and HTML bodies, preferring `text/plain`. */
export function extractBody(payload: gmail_v1.Schema$MessagePart | null | undefined): MessageBody {
  if (payload === null || payload === undefined) return { text: '', html: '' };
  const texts: string[] = [];
  const htmls: string[] = [];
  walk(payload, (part) => {
    const mime = (part.mimeType ?? '').toLowerCase();
    const isAttachment = (part.filename ?? '') !== '';
    if (isAttachment) return;
    const data = decodeBase64Url(part.body?.data);
    if (data === '') return;
    if (mime === 'text/plain') texts.push(data);
    else if (mime === 'text/html') htmls.push(data);
  });
  const text = texts.join('\n').trim();
  const html = htmls.join('\n').trim();
  return { text: text !== '' ? text : htmlToText(html), html };
}

/** List attachment parts (anything with a filename and an attachment id). */
export function listAttachments(
  payload: gmail_v1.Schema$MessagePart | null | undefined,
): Attachment[] {
  if (payload === null || payload === undefined) return [];
  const out: Attachment[] = [];
  walk(payload, (part) => {
    const filename = part.filename ?? '';
    const attachmentId = part.body?.attachmentId ?? '';
    if (filename === '' || attachmentId === '') return;
    out.push({
      filename,
      mimeType: part.mimeType ?? 'application/octet-stream',
      size: part.body?.size ?? 0,
      attachmentId,
    });
  });
  return out;
}
