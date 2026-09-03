import { describe, expect, it } from 'vitest';
import { banner, serviceInfo, PROJECT } from './index.js';

describe('serviceInfo', () => {
  it('records project, service, node and time', () => {
    const now = new Date('2026-09-03T10:00:00Z');
    const info = serviceInfo('bridge', now);
    expect(info.project).toBe(PROJECT);
    expect(info.service).toBe('bridge');
    expect(info.node).toBe(process.version);
    expect(info.startedAt).toBe('2026-09-03T10:00:00.000Z');
  });

  it('renders a one-line banner', () => {
    const info = serviceInfo('brain', new Date('2026-09-03T10:00:00Z'));
    expect(banner(info)).toBe(
      `claudexwhatsapp/brain started (node ${process.version}) at 2026-09-03T10:00:00.000Z`,
    );
  });
});
