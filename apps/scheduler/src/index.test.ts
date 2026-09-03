import { describe as suite, expect, it } from 'vitest';
import { SERVICE, describe } from './index.js';

suite('@cxw/scheduler', () => {
  it('identifies itself', () => {
    expect(SERVICE).toBe('scheduler');
    expect(describe()).toContain('claudexwhatsapp/scheduler started');
  });
});
