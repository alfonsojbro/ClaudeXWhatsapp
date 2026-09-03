import { describe, expect, it } from 'vitest';
import type { gmail_v1 } from 'googleapis';
import { decodeBase64Url, extractBody, headerValue, htmlToText, listAttachments } from './parse.js';

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

describe('decodeBase64Url', () => {
  it('handles empty and missing data', () => {
    expect(decodeBase64Url(undefined)).toBe('');
    expect(decodeBase64Url(null)).toBe('');
    expect(decodeBase64Url(b64('héllo'))).toBe('héllo');
  });
});

describe('headerValue', () => {
  const headers = [
    { name: 'From', value: 'ana@example.com' },
    { name: 'Message-ID', value: '<abc@mail>' },
    { name: 'Empty', value: '' },
  ];

  it('is case-insensitive', () => {
    expect(headerValue(headers, 'from')).toBe('ana@example.com');
    expect(headerValue(headers, 'MESSAGE-ID')).toBe('<abc@mail>');
  });

  it('returns undefined for missing or empty', () => {
    expect(headerValue(headers, 'Cc')).toBeUndefined();
    expect(headerValue(headers, 'Empty')).toBeUndefined();
    expect(headerValue(undefined, 'From')).toBeUndefined();
  });
});

describe('htmlToText', () => {
  it('drops script and style, keeps line structure, decodes entities', () => {
    const html =
      '<style>p{color:red}</style><script>alert(1)</script>' +
      '<p>Hello&nbsp;&amp; welcome</p><div>Line<br>Break</div>&#39;quoted&#39;';
    expect(htmlToText(html)).toBe("Hello & welcome\nLine\nBreak\n'quoted'");
  });
});

describe('extractBody', () => {
  it('prefers text/plain in a nested multipart', () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64('plain body') } },
            { mimeType: 'text/html', body: { data: b64('<p>html body</p>') } },
          ],
        },
        {
          mimeType: 'application/pdf',
          filename: 'invoice.pdf',
          body: { attachmentId: 'att-1', size: 1234 },
        },
      ],
    };
    const body = extractBody(payload);
    expect(body.text).toBe('plain body');
    expect(body.html).toBe('<p>html body</p>');
  });

  it('falls back to the html part converted to text', () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: 'text/html',
      body: { data: b64('<h1>Title</h1><p>Body &amp; more</p>') },
    };
    expect(extractBody(payload).text).toBe('Title\nBody & more');
  });

  it('is empty for a missing payload', () => {
    expect(extractBody(undefined)).toEqual({ text: '', html: '' });
  });
});

describe('listAttachments', () => {
  it('lists parts that have a filename and an attachment id', () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('hi') } },
        {
          mimeType: 'application/pdf',
          filename: 'invoice.pdf',
          body: { attachmentId: 'att-1', size: 1234 },
        },
        { mimeType: 'image/png', filename: 'inline.png', body: { size: 10 } },
      ],
    };
    expect(listAttachments(payload)).toEqual([
      { filename: 'invoice.pdf', mimeType: 'application/pdf', size: 1234, attachmentId: 'att-1' },
    ]);
    expect(listAttachments(null)).toEqual([]);
  });
});
