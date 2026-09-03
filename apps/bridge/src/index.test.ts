import { describe as suite, expect, it } from 'vitest';
import { SERVICE, describe } from './index.js';

suite('@cxw/bridge', () => {
  it('identifies itself', () => {
    expect(SERVICE).toBe('bridge');
    expect(describe()).toContain('claudexwhatsapp/bridge started');
  });
});
