import { describe as suite, expect, it } from 'vitest';
import { SERVICE, describe } from './index.js';

suite('@cxw/mcp-vault', () => {
  it('identifies itself', () => {
    expect(SERVICE).toBe('mcp-vault');
    expect(describe()).toContain('claudexwhatsapp/mcp-vault started');
  });
});
