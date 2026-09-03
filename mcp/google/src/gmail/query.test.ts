import { describe, expect, it } from 'vitest';
import {
  buildGmailQuery,
  buildRawMessage,
  encodeAddressValue,
  encodeHeaderValue,
  fromBase64Url,
  quoteValue,
  replyReferences,
  replySubject,
  toGmailDate,
} from './query.js';

describe('toGmailDate', () => {
  it('accepts both spellings', () => {
    expect(toGmailDate('2026-09-01')).toBe('2026/09/01');
    expect(toGmailDate('2026/09/01')).toBe('2026/09/01');
  });

  it('rejects junk', () => {
    expect(() => toGmailDate('yesterday')).toThrow(/YYYY-MM-DD/u);
  });
});

describe('quoteValue', () => {
  it('quotes only when needed', () => {
    expect(quoteValue('ana@example.com')).toBe('ana@example.com');
    expect(quoteValue('project update')).toBe('"project update"');
    expect(quoteValue('say "hi"')).toBe('"say \\"hi\\""');
  });
});

describe('buildGmailQuery', () => {
  it('is empty for no filters', () => {
    expect(buildGmailQuery({})).toBe('');
  });

  it('renders each filter', () => {
    expect(buildGmailQuery({ from: 'ana@example.com' })).toBe('from:ana@example.com');
    expect(buildGmailQuery({ to: 'me@example.com' })).toBe('to:me@example.com');
    expect(buildGmailQuery({ subject: 'project update' })).toBe('subject:"project update"');
    expect(buildGmailQuery({ after: '2026-09-01' })).toBe('after:2026/09/01');
    expect(buildGmailQuery({ before: '2026-09-30' })).toBe('before:2026/09/30');
    expect(buildGmailQuery({ newerThanDays: 7 })).toBe('newer_than:7d');
    expect(buildGmailQuery({ unread: true })).toBe('is:unread');
    expect(buildGmailQuery({ unread: false })).toBe('-is:unread');
    expect(buildGmailQuery({ label: 'Invoices' })).toBe('label:Invoices');
    expect(buildGmailQuery({ hasAttachment: true })).toBe('has:attachment');
    expect(buildGmailQuery({ inInbox: true })).toBe('in:inbox');
    expect(buildGmailQuery({ text: 'quarterly report' })).toBe('"quarterly report"');
  });

  it('combines filters and appends free q last', () => {
    expect(
      buildGmailQuery({
        q: 'category:primary',
        from: 'ana@example.com',
        unread: true,
        newerThanDays: 3,
      }),
    ).toBe('from:ana@example.com newer_than:3d is:unread category:primary');
  });

  it('rejects a bad newer_than', () => {
    expect(() => buildGmailQuery({ newerThanDays: 0 })).toThrow(/positive whole number/u);
    expect(() => buildGmailQuery({ newerThanDays: 1.5 })).toThrow(/positive whole number/u);
  });
});

describe('encodeHeaderValue', () => {
  it('leaves ASCII alone', () => {
    expect(encodeHeaderValue('Project update')).toBe('Project update');
  });

  it('encodes non-ASCII as RFC 2047', () => {
    expect(encodeHeaderValue('Café ☕')).toBe(
      `=?UTF-8?B?${Buffer.from('Café ☕', 'utf8').toString('base64')}?=`,
    );
  });
});

describe('buildRawMessage', () => {
  const base = {
    from: 'me@example.com',
    to: ['ana@example.com'],
    subject: 'Hello',
    text: 'Line one\nLine two',
  };

  it('round-trips through base64url with CRLF endings', () => {
    const raw = buildRawMessage(base);
    const text = fromBase64Url(raw);
    expect(text).toContain('From: me@example.com\r\n');
    expect(text).toContain('To: ana@example.com\r\n');
    expect(text).toContain('Subject: Hello\r\n');
    expect(text).toContain('MIME-Version: 1.0\r\n');
    expect(text).toContain('Content-Type: text/plain; charset="UTF-8"\r\n');
    expect(text).toContain('Content-Transfer-Encoding: 8bit\r\n');
    expect(text).toContain('\r\n\r\nLine one\r\nLine two');
    expect(raw).not.toContain('+');
    expect(raw).not.toContain('/');
    expect(raw).not.toContain('=');
  });

  it('renders cc, bcc and reply headers', () => {
    const raw = buildRawMessage({
      ...base,
      cc: ['bob@example.com', ' '],
      bcc: ['secret@example.com'],
      inReplyTo: '<abc@mail>',
      references: '<root@mail> <abc@mail>',
    });
    const text = fromBase64Url(raw);
    expect(text).toContain('Cc: bob@example.com\r\n');
    expect(text).toContain('Bcc: secret@example.com\r\n');
    expect(text).toContain('In-Reply-To: <abc@mail>\r\n');
    expect(text).toContain('References: <root@mail> <abc@mail>\r\n');
  });

  it('encodes a non-ASCII subject', () => {
    const text = fromBase64Url(buildRawMessage({ ...base, subject: 'Café' }));
    expect(text).toContain('Subject: =?UTF-8?B?');
    expect(text).not.toContain('Subject: Café');
  });

  it('rejects header injection', () => {
    expect(() => buildRawMessage({ ...base, subject: 'Hi\r\nBcc: evil@example.com' })).toThrow(
      /header injection/u,
    );
    expect(() => buildRawMessage({ ...base, to: ['a@example.com\nBcc: evil@x'] })).toThrow(
      /header injection/u,
    );
  });

  it('requires a recipient', () => {
    expect(() => buildRawMessage({ ...base, to: [' '] })).toThrow(/recipient/u);
  });
});

describe('reply helpers', () => {
  it('prefixes the subject once', () => {
    expect(replySubject('Standup')).toBe('Re: Standup');
    expect(replySubject('Re: Standup')).toBe('Re: Standup');
    expect(replySubject('RE:Standup')).toBe('RE:Standup');
    expect(replySubject(undefined)).toBe('Re:');
  });

  it('merges references with the message id', () => {
    expect(replyReferences('<a@m>', '<b@m>')).toBe('<a@m> <b@m>');
    expect(replyReferences(undefined, '<b@m>')).toBe('<b@m>');
    expect(replyReferences(undefined, undefined)).toBeUndefined();
  });
});

// --- Review round 1 -------------------------------------------------------

describe('encodeAddressValue (F4)', () => {
  it('encodes only the display name of a Name <addr> entry', () => {
    const out = encodeAddressValue('Ana Ramírez <ana@example.com>');
    expect(out).toBe('=?UTF-8?B?QW5hIFJhbcOtcmV6?= <ana@example.com>');
    expect(out.endsWith('<ana@example.com>')).toBe(true);
  });

  it('leaves a plain address untouched', () => {
    expect(encodeAddressValue('ana@example.com')).toBe('ana@example.com');
    expect(encodeAddressValue('  ana@example.com  ')).toBe('ana@example.com');
  });

  it('drops an empty display name', () => {
    expect(encodeAddressValue('<ana@example.com>')).toBe('<ana@example.com>');
  });

  it('still encodes a non-ASCII address that has no angle brackets', () => {
    expect(encodeAddressValue('anä@example.com')).toContain('=?UTF-8?B?');
  });

  it('keeps a non-ASCII To header parseable end to end', () => {
    const raw = fromBase64Url(
      buildRawMessage({
        from: 'me@example.com',
        to: ['Ana Ramírez <ana@example.com>'],
        subject: 'Hola',
        text: 'body',
      }),
    );
    expect(raw).toContain('To: =?UTF-8?B?QW5hIFJhbcOtcmV6?= <ana@example.com>\r\n');
  });

  it('still rejects header injection through an address', () => {
    expect(() =>
      buildRawMessage({
        from: 'me@example.com',
        to: ['ana@example.com\r\nBcc: evil@example.com'],
        subject: 'Hola',
        text: 'body',
      }),
    ).toThrow(/header injection rejected/u);
  });
});
