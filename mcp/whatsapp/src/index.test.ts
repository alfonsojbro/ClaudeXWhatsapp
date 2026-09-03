import { describe as suite, expect, it } from 'vitest';
import { SERVICE, describe } from './index.js';

suite('@cxw/mcp-whatsapp', () => {
  it('identifies itself', () => {
    expect(SERVICE).toBe('mcp-whatsapp');
    expect(describe()).toContain('claudexwhatsapp/mcp-whatsapp started');
  });
});
