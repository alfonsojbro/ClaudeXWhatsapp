import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from '../src/db.js';
import {
  emptySentinelState,
  executeHit,
  isHandled,
  isKillSwitchText,
  markHandled,
  pollOnce,
  runSentinel,
  sentinelTick,
} from '../src/sentinel.js';
import {
  cleanupTempDirs,
  makeConfig,
  OWNER,
  seedBridgeDb,
  STRANGER,
  writeFakeCtl,
} from './helpers.js';

afterAll(cleanupTempDirs);

describe('isKillSwitchText', () => {
  it('matches the kill switch words with or without a slash', () => {
    expect(isKillSwitchText('panic')).toBe('panic');
    expect(isKillSwitchText('  PANIC ')).toBe('panic');
    expect(isKillSwitchText('/Resume ')).toBe('resume');
  });

  it('ignores anything else', () => {
    expect(isKillSwitchText('panic mode please')).toBeNull();
    expect(isKillSwitchText('resumen')).toBeNull();
    expect(isKillSwitchText(null)).toBeNull();
    expect(isKillSwitchText('')).toBeNull();
  });
});

function db(rows: Parameters<typeof seedBridgeDb>[1]): { db: DatabaseSync; close: () => void } {
  const cfg = makeConfig();
  seedBridgeDb(cfg.bridgeDb, rows);
  const handle = new DatabaseSync(cfg.bridgeDb, { readOnly: true });
  return { db: handle, close: () => handle.close() };
}

describe('pollOnce', () => {
  const base = 1_760_000_000_000;

  it('picks up owner kill-switch messages and marks them handled', () => {
    const h = db([
      { jid: OWNER, id: 'm1', ts: base + 1000, fromMe: true, text: 'panic' },
      { jid: OWNER, id: 'm2', ts: base + 2000, sender: OWNER, text: '/Resume ' },
    ]);
    try {
      const { next, hits } = pollOnce(h.db, { lastSeen: base, handled: [] }, [OWNER]);
      expect(hits.map((x) => x.word)).toEqual(['panic', 'resume']);
      expect(next.handled).toEqual(['m1', 'm2']);
      expect(next.lastSeen).toBe(base + 2000);
    } finally {
      h.close();
    }
  });

  it('ignores non-owner senders', () => {
    const h = db([{ jid: STRANGER, id: 'x1', ts: base + 1000, sender: STRANGER, text: 'panic' }]);
    try {
      const { hits, next } = pollOnce(h.db, { lastSeen: base, handled: [] }, [OWNER]);
      expect(hits).toEqual([]);
      expect(next.lastSeen).toBe(base + 1000);
    } finally {
      h.close();
    }
  });

  it('ignores rows at or before lastSeen', () => {
    const h = db([{ jid: OWNER, id: 'old', ts: base, fromMe: true, text: 'panic' }]);
    try {
      const { hits } = pollOnce(h.db, { lastSeen: base, handled: [] }, [OWNER]);
      expect(hits).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('never fires twice for the same message id', () => {
    const h = db([{ jid: OWNER, id: 'm1', ts: base + 1000, fromMe: true, text: 'panic' }]);
    try {
      const { hits } = pollOnce(h.db, { lastSeen: base, handled: ['m1'] }, [OWNER]);
      expect(hits).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('understands timestamps in seconds', () => {
    const sec = Math.floor(base / 1000);
    const h = db([{ jid: OWNER, id: 'm1', ts: sec + 5, fromMe: true, text: 'panic' }]);
    try {
      const { hits } = pollOnce(h.db, { lastSeen: base, handled: [] }, [OWNER]);
      expect(hits.map((x) => x.id)).toEqual(['m1']);
    } finally {
      h.close();
    }
  });
});

describe('handled-id state', () => {
  it('is shared between the brain handler and the sentinel', () => {
    const cfg = makeConfig();
    expect(isHandled(cfg, 'A')).toBe(false);
    markHandled(cfg, 'A');
    expect(isHandled(cfg, 'A')).toBe(true);
    markHandled(cfg, 'A');
    expect(isHandled(cfg, 'B')).toBe(false);
  });

  it('starts from now so history is never replayed', () => {
    const state = emptySentinelState(12345);
    expect(state).toEqual({ lastSeen: 12345, handled: [] });
  });
});

describe('owner-chat gating', () => {
  const base = 1_760_000_000_000;

  it('ignores from_me messages sent to a third party', () => {
    const h = db([
      { jid: STRANGER, id: 'x1', ts: base + 1000, fromMe: true, sender: OWNER, text: 'panic' },
    ]);
    try {
      const { hits } = pollOnce(h.db, { lastSeen: base, handled: [] }, [OWNER]);
      expect(hits).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('accepts from_me messages in the owner self-chat', () => {
    const h = db([{ jid: OWNER, id: 'x2', ts: base + 1000, fromMe: true, text: 'panic' }]);
    try {
      const { hits } = pollOnce(h.db, { lastSeen: base, handled: [] }, [OWNER]);
      expect(hits.map((x) => x.id)).toEqual(['x2']);
    } finally {
      h.close();
    }
  });
});

describe('executeHit', () => {
  it('runs panic even when the acknowledgement cannot be delivered', async () => {
    const cfg = makeConfig({
      CXW_ALERT_TRANSPORT: 'live',
      BRIDGE_URL: 'http://127.0.0.1:1',
      HEALTH_TIMEOUT_MS: '300',
    });
    const ctl = writeFakeCtl(cfg.stateDir);
    const withCtl = { ...cfg, ctl: { ...cfg.ctl, bin: ctl.bin } };

    await executeHit(withCtl, [OWNER], { id: 'm1', jid: OWNER, word: 'panic', ts: Date.now() });

    expect(fs.existsSync(path.join(cfg.stateDir, 'panic'))).toBe(true);
    expect(ctl.calls()).toEqual(['stop scheduler', 'stop brain']);
  });
});

describe('pollOnce re-reads the persisted handled set', () => {
  it('skips an id the brain handler marked after the state object was created', () => {
    // The sentinel is a Restart=always unit, so its in-memory set is older than whatever
    // the brain handler wrote a moment ago. Without the re-read both paths fire.
    const cfg = makeConfig();
    const base = Date.now();
    seedBridgeDb(cfg.bridgeDb, [
      { jid: OWNER, id: 'k1', ts: base + 1000, fromMe: true, text: 'panic' },
    ]);
    const state = emptySentinelState(base);
    markHandled(cfg, 'k1');

    const handle = new DatabaseSync(cfg.bridgeDb, { readOnly: true });
    try {
      expect(pollOnce(handle, state, [OWNER]).hits).toHaveLength(1);
      const polled = pollOnce(handle, state, [OWNER], cfg);
      expect(polled.hits).toEqual([]);
      expect(polled.next.handled).toContain('k1');
    } finally {
      handle.close();
    }
  });
});

describe('sentinelTick', () => {
  it('skips an id the brain handler marked on disk after the loop state was created', async () => {
    // This is the loop body `runSentinel` calls, so it proves the running sentinel passes
    // the persisted re-read into `pollOnce` instead of trusting its older in-memory set.
    const cfg = makeConfig();
    const fake = writeFakeCtl(cfg.stateDir);
    const withCtl = { ...cfg, ctl: { ...cfg.ctl, bin: fake.bin } };
    const base = Date.now();
    seedBridgeDb(cfg.bridgeDb, [
      { jid: OWNER, id: 't1', ts: base + 1000, fromMe: true, text: 'panic' },
    ]);
    const state = emptySentinelState(base);
    markHandled(cfg, 't1');

    const next = await sentinelTick(withCtl, state, [OWNER]);

    expect(fs.existsSync(path.join(cfg.stateDir, 'panic'))).toBe(false);
    expect(fake.calls()).toEqual([]);
    expect(next.handled).toContain('t1');
    expect(next.lastSeen).toBe(base + 1000);
  });

  it('acts on an unhandled kill-switch row', async () => {
    const cfg = makeConfig();
    const fake = writeFakeCtl(cfg.stateDir);
    const withCtl = { ...cfg, ctl: { ...cfg.ctl, bin: fake.bin } };
    const base = Date.now();
    seedBridgeDb(cfg.bridgeDb, [
      { jid: OWNER, id: 't2', ts: base + 1000, fromMe: true, text: 'panic' },
    ]);

    await sentinelTick(withCtl, emptySentinelState(base), [OWNER]);

    expect(fs.existsSync(path.join(cfg.stateDir, 'panic'))).toBe(true);
    expect(fake.calls()).toEqual(['stop scheduler', 'stop brain']);
  });
});

describe('runSentinel', () => {
  it('acts on a kill-switch message and marks it handled even with no bridge', async () => {
    const cfg = makeConfig({
      CXW_ALERT_TRANSPORT: 'live',
      BRIDGE_URL: 'http://127.0.0.1:1',
      HEALTH_TIMEOUT_MS: '300',
    });
    const ctl = writeFakeCtl(cfg.stateDir);
    const withCtl = { ...cfg, ctl: { ...cfg.ctl, bin: ctl.bin } };
    // The sentinel starts from "now", so the row must be newer than that.
    seedBridgeDb(cfg.bridgeDb, [
      { jid: OWNER, id: 'k1', ts: Date.now() + 2000, fromMe: true, text: 'panic' },
    ]);

    const handle = runSentinel(withCtl);
    const panicFile = path.join(cfg.stateDir, 'panic');
    for (let i = 0; i < 120 && !fs.existsSync(panicFile); i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    handle.stop();
    await handle.done;

    expect(fs.existsSync(panicFile)).toBe(true);
    expect(ctl.calls()).toEqual(['stop scheduler', 'stop brain']);
    const state = JSON.parse(fs.readFileSync(path.join(cfg.stateDir, 'sentinel.json'), 'utf8')) as {
      handled: string[];
    };
    expect(state.handled).toContain('k1');
  });
});
