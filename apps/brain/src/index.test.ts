import { describe as suite, expect, it } from 'vitest';
import { SERVICE, describe } from './index.js';

suite('@cxw/brain', () => {
  it('identifies itself', () => {
    expect(SERVICE).toBe('brain');
    expect(describe()).toContain('claudexwhatsapp/brain started');
  });
});
