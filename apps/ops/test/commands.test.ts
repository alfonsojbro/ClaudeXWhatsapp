import { afterAll, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { handleOpsCommand } from '../src/commands.js';
import { recordUsage } from '../src/costs.js';
import { readPanic } from '../src/killswitch.js';
import { runHealth } from '../src/health.js';
import {
  cleanupTempDirs,
  makeConfig,
  OWNER,
  seedBridgeDb,
  STRANGER,
  writeFakeCtl,
} from './helpers.js';

afterAll(cleanupTempDirs);

function ctlConfig(env: Record<string, string> = {}) {
  const base = makeConfig(env);
  const fake = writeFakeCtl(base.stateDir);
  const cfg: Config = { ...base, ctl: { bin: fake.bin, sudo: [] } };
  return { cfg, fake };
}

const ownerCtx = { senderJid: OWNER, isOwner: true };

describe('handleOpsCommand', () => {
  it('ignores non-owners', async () => {
    const { cfg } = ctlConfig();
    const reply = await handleOpsCommand('panic', { senderJid: STRANGER, isOwner: false }, { cfg });
    expect(reply).toBeNull();
    expect(readPanic(cfg)).toBeNull();
  });

  it('ignores text that is not an ops command', async () => {
    const { cfg } = ctlConfig();
    expect(await handleOpsCommand('what is the weather', ownerCtx, { cfg })).toBeNull();
  });

  it('acks panic before the stop runs, then stops the services', async () => {
    const { cfg, fake } = ctlConfig();
    let deferred: (() => void) | null = null;
    const reply = await handleOpsCommand('/PANIC', ownerCtx, {
      cfg,
      schedule: (fn) => {
        deferred = fn;
      },
    });
    expect(reply).toBe('🛑 Panic: scheduler and brain stopping. Send `resume` to restart.');
    expect(fake.calls()).toEqual([]);
    expect(deferred).not.toBeNull();
    (deferred as unknown as () => void)();
    const deadline = Date.now() + 5000;
    while (fake.calls().length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(fake.calls()).toEqual(['stop scheduler', 'stop brain']);
    expect(readPanic(cfg)).not.toBeNull();
  });

  it('resumes', async () => {
    const { cfg, fake } = ctlConfig();
    expect(await handleOpsCommand('resume', ownerCtx, { cfg })).toBe('▶️ Resumed.');
    expect(fake.calls()).toEqual(['start brain', 'start scheduler']);
  });

  it('reports status from the last health report', async () => {
    const { cfg } = ctlConfig({ CXW_DISK_LIMIT_PCT: '0' });
    await runHealth(cfg);
    const reply = await handleOpsCommand('status', ownerCtx, { cfg });
    expect(reply).toContain('❌ disk');
    expect(reply).toContain('▶️ running');
    expect(reply).toContain('💸 Today:');
  });

  it('runs a dry-run purge and reports counts', async () => {
    const { cfg } = ctlConfig();
    seedBridgeDb(cfg.bridgeDb, [
      { jid: STRANGER, id: 's1', ts: Date.now() - 400 * 86_400_000, text: 'old' },
    ]);
    const reply = await handleOpsCommand('purge --dry-run', ownerCtx, { cfg });
    expect(reply).toContain('dry run');
    expect(reply).toContain('1 text rows');
  });

  it('answers costs today, month and the default line', async () => {
    const { cfg } = ctlConfig();
    recordUsage(
      { source: 'chat', model: 'claude-opus-5', inputTokens: 10, outputTokens: 20, costUsd: 0.5 },
      cfg,
    );
    expect(await handleOpsCommand('costs today', ownerCtx, { cfg })).toContain('Today: $0.50');
    expect(await handleOpsCommand('costs month', ownerCtx, { cfg })).toContain('Month: $0.50');
    expect(await handleOpsCommand('costs', ownerCtx, { cfg })).toContain('💸 Today: $0.50');
  });

  it('unpauses the cost cap', async () => {
    const { cfg } = ctlConfig({ CXW_COST_MONTHLY_CAP_USD: '1' });
    recordUsage(
      { source: 'chat', model: 'claude-opus-5', inputTokens: 0, outputTokens: 0, costUsd: 2 },
      cfg,
    );
    const reply = await handleOpsCommand('costs unpause', ownerCtx, { cfg });
    expect(reply).toContain('Cost cap override on');
  });

  it('consumes a message id only once', async () => {
    const { cfg, fake } = ctlConfig();
    const ctx = { senderJid: OWNER, isOwner: true, messageId: 'MSG1' };
    const first = await handleOpsCommand('resume', ctx, { cfg });
    const second = await handleOpsCommand('resume', ctx, { cfg });
    expect(first).toBe('▶️ Resumed.');
    expect(second).toBeNull();
    expect(fake.calls()).toEqual(['start brain', 'start scheduler']);
  });
});
