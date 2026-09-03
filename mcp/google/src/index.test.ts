import { describe as suite, expect, it } from 'vitest';
import { SERVICE, describe } from './index.js';

suite('@cxw/mcp-google', () => {
  it('identifies itself', () => {
    expect(SERVICE).toBe('mcp-google');
    expect(describe()).toContain('claudexwhatsapp/mcp-google started');
  });
});
