import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  capStatusLine,
  checkCap,
  computeCost,
  dailyCostLine,
  monthTotals,
  notifyCap,
  priceFor,
  readCostPause,
  recordUsage,
  todayTotals,
  unpause,
} from '../src/costs.js';
import { getPauseState } from '../src/killswitch.js';
import { dayKey, monthKey } from '../src/state.js';
import { cleanupTempDirs, makeConfig } from './helpers.js';

afterAll(cleanupTempDirs);

describe('pricing', () => {
  it('matches dated model ids by prefix', () => {
    expect(priceFor('claude-haiku-4-5-20251001')).toEqual({
      input: 1,
      output: 5,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    });
  });

  it('prefers the longest matching prefix', () => {
    expect(priceFor('claude-fable-5-1').cacheRead).toBe(0.25);
    expect(priceFor('claude-fable-5-20260101').cacheRead).toBe(1);
  });

  it('falls back to opus-5 rates for an unknown model', () => {
    expect(priceFor('gpt-nonsense')).toEqual(priceFor('claude-opus-5'));
  });

  it('computes cost from tokens', () => {
    const cost = computeCost({
      source: 'chat',
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(1 + 5 + 0.1 + 1.25, 10);
  });

  it('passes an explicit costUsd through untouched', () => {
    const cost = computeCost({
      source: 'chat',
      model: 'claude-fable-5-1',
      inputTokens: 999_999,
      outputTokens: 999_999,
      costUsd: 0.42,
    });
    expect(cost).toBe(0.42);
  });
});

describe('totals and the cost line', () => {
  it('sums today and the month and formats the line', () => {
    const cfg = makeConfig({ CXW_COST_MONTHLY_CAP_USD: '100' });
    recordUsage(
      {
        source: 'chat',
        model: 'claude-opus-5',
        inputTokens: 12_300,
        outputTokens: 4_500,
        costUsd: 1.23,
      },
      cfg,
    );
    recordUsage(
      {
        source: 'routine',
        routine: 'x',
        model: 'claude-opus-5',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      },
      cfg,
    );
    const today = todayTotals(cfg);
    expect(today.calls).toBe(2);
    expect(today.costUsd).toBeCloseTo(1.23, 6);
    expect(monthTotals(cfg).costUsd).toBeCloseTo(1.23, 6);
    expect(dailyCostLine(cfg)).toBe(
      '💸 Today: $1.23 (12.3k in / 4.5k out, 2 calls) · Month: $1.23 / $100 (1%)',
    );
  });
});

describe('checkCap', () => {
  it('reports the warn level and never suppresses the text', () => {
    const cfg = makeConfig({ CXW_COST_MONTHLY_CAP_USD: '10', CXW_COST_WARN_PCT: '80' });
    recordUsage(
      { source: 'chat', model: 'claude-opus-5', inputTokens: 0, outputTokens: 0, costUsd: 8.5 },
      cfg,
    );
    const first = checkCap(cfg);
    expect(first.level).toBe('warn');
    expect(first.pct).toBe(85);
    expect(first.text).toContain('85% of the monthly cost cap');
    // The state half is idempotent: a second read says exactly the same thing.
    expect(checkCap(cfg).text).toBe(first.text);
    expect(readCostPause(cfg)).toBeNull();
  });

  it('writes the cost-paused flag at the cap and pauses the scheduler', () => {
    const cfg = makeConfig({ CXW_COST_MONTHLY_CAP_USD: '10' });
    recordUsage(
      { source: 'chat', model: 'claude-opus-5', inputTokens: 0, outputTokens: 0, costUsd: 11 },
      cfg,
    );
    const flag = readCostPause(cfg);
    expect(flag?.reason).toBe('cost-cap');
    expect(flag?.cap).toBe(10);
    expect(getPauseState(cfg)).toEqual({ paused: true, reasons: ['cost-cap'] });
    expect(checkCap(cfg).level).toBe('paused');
  });

  it('clears a flag left over from a previous month', () => {
    const cfg = makeConfig({ CXW_COST_MONTHLY_CAP_USD: '10' });
    fs.writeFileSync(
      path.join(cfg.stateDir, 'cost-paused'),
      JSON.stringify({
        since: '2020-01-01T00:00:00Z',
        reason: 'cost-cap',
        month: '2020-01',
        total: 99,
        cap: 10,
      }),
    );
    expect(getPauseState(cfg).paused).toBe(false);
    expect(checkCap(cfg).level).toBe('ok');
    expect(readCostPause(cfg)).toBeNull();
  });

  it('recordUsage never consumes the owner warning', () => {
    const cfg = makeConfig({ CXW_COST_MONTHLY_CAP_USD: '10', CXW_COST_WARN_PCT: '80' });
    const sent: string[] = [];
    recordUsage(
      { source: 'chat', model: 'claude-opus-5', inputTokens: 0, outputTokens: 0, costUsd: 9 },
      cfg,
    );
    // No marker was claimed by the hot path, so the monitor tick still delivers.
    expect(fs.readdirSync(cfg.stateDir).filter((f) => f.startsWith('cost-warned'))).toEqual([]);
    return notifyCap((t) => sent.push(t), cfg).then((r) => {
      expect(r.delivered).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('90% of the monthly cost cap');
    });
  });

  it('unpause removes the flag', () => {
    const cfg = makeConfig({ CXW_COST_MONTHLY_CAP_USD: '1' });
    recordUsage(
      { source: 'chat', model: 'claude-opus-5', inputTokens: 0, outputTokens: 0, costUsd: 2 },
      cfg,
    );
    expect(readCostPause(cfg)).not.toBeNull();
    expect(unpause(cfg)).toBe(true);
    expect(readCostPause(cfg)).toBeNull();
    expect(getPauseState(cfg).paused).toBe(false);
  });

  it('records one row per model when the caller splits modelUsage', () => {
    const cfg = makeConfig();
    recordUsage({ source: 'chat', model: 'claude-opus-5', inputTokens: 10, outputTokens: 20 }, cfg);
    recordUsage(
      { source: 'chat', model: 'claude-haiku-4-5', inputTokens: 30, outputTokens: 40 },
      cfg,
    );
    expect(todayTotals(cfg).calls).toBe(2);
    expect(todayTotals(cfg).inputTokens).toBe(40);
  });
});

describe('notifyCap', () => {
  it('delivers once at warn and once at pause, never twice in the same month', async () => {
    const cfg = makeConfig({ CXW_COST_MONTHLY_CAP_USD: '10', CXW_COST_WARN_PCT: '80' });
    const sent: string[] = [];
    const deliver = (t: string): void => {
      sent.push(t);
    };

    recordUsage(
      { source: 'chat', model: 'claude-opus-5', inputTokens: 0, outputTokens: 0, costUsd: 8.5 },
      cfg,
    );
    expect((await notifyCap(deliver, cfg)).delivered).toBe(true);
    expect((await notifyCap(deliver, cfg)).delivered).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('⚠️');

    recordUsage(
      { source: 'chat', model: 'claude-opus-5', inputTokens: 0, outputTokens: 0, costUsd: 5 },
      cfg,
    );
    expect((await notifyCap(deliver, cfg)).delivered).toBe(true);
    expect((await notifyCap(deliver, cfg)).delivered).toBe(false);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('🛑');
  });

  it('does not burn the month marker when every alert channel is down', async () => {
    const cfg = makeConfig({ CXW_COST_MONTHLY_CAP_USD: '10' });
    recordUsage(
      { source: 'chat', model: 'claude-opus-5', inputTokens: 0, outputTokens: 0, costUsd: 12 },
      cfg,
    );
    // `deliver()` resolves with `{ channel: null }` when nothing got through; it does not throw.
    const failing = (): Promise<{ channel: string | null }> => Promise.resolve({ channel: null });
    const first = await notifyCap(failing, cfg);
    expect(first.level).toBe('paused');
    expect(first.delivered).toBe(false);
    expect(first.status).toBe('delivery failed');
    expect(fs.readdirSync(cfg.stateDir).filter((f) => f.startsWith('cost-warned'))).toEqual([]);
    expect(fs.readdirSync(cfg.stateDir).filter((f) => f.startsWith('cost-paused-alerted'))).toEqual(
      [],
    );

    // The next monitor tick retries and, once a channel is back, delivers exactly once.
    const sent: string[] = [];
    expect((await notifyCap((t) => sent.push(t), cfg)).status).toBe('notified');
    expect((await notifyCap((t) => sent.push(t), cfg)).status).toBe('already notified this month');
    expect(sent).toHaveLength(1);
  });

  it('formats one status line for `costs check`', async () => {
    const cfg = makeConfig({ CXW_COST_MONTHLY_CAP_USD: '10' });
    recordUsage(
      { source: 'chat', model: 'claude-opus-5', inputTokens: 0, outputTokens: 0, costUsd: 9 },
      cfg,
    );
    const result = await notifyCap(() => undefined, cfg);
    expect(capStatusLine(result)).toBe('cost: warn $9.00 / $10 (90%) — notified');
    expect(capStatusLine(await notifyCap(() => undefined, cfg))).toBe(
      'cost: warn $9.00 / $10 (90%) — already notified this month',
    );
  });

  it('says nothing below the warn threshold', async () => {
    const cfg = makeConfig({ CXW_COST_MONTHLY_CAP_USD: '100' });
    const sent: string[] = [];
    recordUsage(
      { source: 'chat', model: 'claude-opus-5', inputTokens: 0, outputTokens: 0, costUsd: 1 },
      cfg,
    );
    const result = await notifyCap((t) => sent.push(t), cfg);
    expect(result.level).toBe('ok');
    expect(result.delivered).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe('time zone', () => {
  it('the cost month follows the process TZ, not UTC', () => {
    const original = process.env['TZ'];
    // 00:30 UTC on the 1st: still the previous month in Los Angeles.
    const boundary = Date.parse('2026-09-01T00:30:00Z');
    try {
      process.env['TZ'] = 'UTC';
      expect(monthKey(boundary)).toBe('2026-09');
      process.env['TZ'] = 'America/Los_Angeles';
      expect(monthKey(boundary)).toBe('2026-08');
      expect(dayKey(boundary)).toBe('2026-08-31');
    } finally {
      if (original === undefined) delete process.env['TZ'];
      else process.env['TZ'] = original;
    }
  });
});
