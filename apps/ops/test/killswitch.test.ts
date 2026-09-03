import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ctl, getPauseState, panic, readPanic, resume } from '../src/killswitch.js';
import { cleanupTempDirs, makeConfig, writeFakeCtl } from './helpers.js';

afterAll(cleanupTempDirs);

function ctlConfig() {
  const cfg = makeConfig();
  const fake = writeFakeCtl(cfg.stateDir);
  return { cfg: { ...cfg, ctl: { bin: fake.bin, sudo: [] } }, fake };
}

describe('ctl', () => {
  it('runs allowlisted action/unit pairs', async () => {
    const { cfg, fake } = ctlConfig();
    const result = await ctl('restart', 'bridge', cfg);
    expect(result.ok).toBe(true);
    expect(fake.calls()).toEqual(['restart bridge']);
  });

  it('rejects an action that is not on the allowlist', async () => {
    const { cfg, fake } = ctlConfig();
    await expect(ctl('rm', 'bridge', cfg)).rejects.toThrow(/not allowed/);
    expect(fake.calls()).toEqual([]);
  });

  it('rejects a unit that is not on the allowlist', async () => {
    const { cfg, fake } = ctlConfig();
    await expect(ctl('restart', 'sshd', cfg)).rejects.toThrow(/not allowed/);
    expect(fake.calls()).toEqual([]);
  });

  it('rejects a unit argument for a bare action', async () => {
    const { cfg } = ctlConfig();
    await expect(ctl('backup', 'bridge', cfg)).rejects.toThrow(/takes no unit/);
    await expect(ctl('backup', undefined, cfg)).resolves.toMatchObject({ ok: true });
  });

  it('honours a sudo prefix without a shell', async () => {
    const { cfg, fake } = ctlConfig();
    const withSudo = { ...cfg, ctl: { bin: fake.bin, sudo: ['/usr/bin/env'] } };
    const result = await ctl('stop', 'brain', withSudo);
    expect(result.ok).toBe(true);
    expect(fake.calls()).toEqual(['stop brain']);
  });
});

describe('panic and resume', () => {
  it('stops the scheduler before the brain and raises the flag', async () => {
    const { cfg, fake } = ctlConfig();
    const flag = await panic('test reason', 'tester', cfg);
    expect(flag.reason).toBe('test reason');
    expect(fake.calls()).toEqual(['stop scheduler', 'stop brain']);
    expect(readPanic(cfg)?.by).toBe('tester');
    expect(getPauseState(cfg)).toEqual({ paused: true, reasons: ['panic'] });
    expect(fs.existsSync(path.join(cfg.stateDir, 'panic'))).toBe(true);
  });

  it('clears the flag and starts the brain before the scheduler', async () => {
    const { cfg, fake } = ctlConfig();
    await panic('x', 'tester', cfg);
    await resume(cfg);
    expect(fake.calls()).toEqual([
      'stop scheduler',
      'stop brain',
      'start brain',
      'start scheduler',
    ]);
    expect(readPanic(cfg)).toBeNull();
    expect(getPauseState(cfg)).toEqual({ paused: false, reasons: [] });
  });
});
