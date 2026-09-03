import { describe, expect, it } from 'vitest';
import { attr, escapeHtml } from './escape.js';

describe('escapeHtml', () => {
  it('escapes every character that can break out of text or an attribute', () => {
    expect(escapeHtml(`<script>alert("x") & 'y'</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;',
    );
  });

  it('escapes the ampersand first, so entities are not double-decoded by a browser', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('renders null and undefined as the empty string', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('stringifies non-strings', () => {
    expect(escapeHtml(42)).toBe('42');
  });

  it('attr wraps in quotes and escapes the quote', () => {
    expect(attr('a" onload="evil()')).toBe('"a&quot; onload=&quot;evil()"');
  });
});
