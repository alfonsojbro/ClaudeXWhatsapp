import { afterAll, describe, expect, it } from 'vitest';
import type { AlertState, CheckLike } from '../src/alerts.js';
import { alertTargetJid, deliver, reconcile } from '../src/alerts.js';
import { loadConfig } from '../src/config.js';
import { captureStdout, cleanupTempDirs, makeConfig, OWNER, STRANGER } from './helpers.js';

afterAll(cleanupTempDirs);

const OPTS = { repeatMin: 60, afterFailures: 1 };
const failing: CheckLike[] = [{ name: 'whatsapp', ok: false, detail: 'bridge not connected' }];
const healthy: CheckLike[] = [{ name: 'whatsapp', ok: true, detail: 'connected' }];

describe('reconcile', () => {
  it('alerts the first time a check fails', () => {
    const { next, toSend } = reconcile({}, failing, 1000, OPTS);
    expect(toSend).toHaveLength(1);
    expect(toSend[0]?.kind).toBe('failing');
    expect(toSend[0]?.text).toContain('whatsapp FAILING');
    expect(next['whatsapp']?.alertCount).toBe(1);
    expect(next['whatsapp']?.lastAlertAt).toBe(1000);
  });

  it('waits for ALERT_AFTER_FAILURES consecutive failures', () => {
    const opts = { repeatMin: 60, afterFailures: 2 };
    const first = reconcile({}, failing, 1000, opts);
    expect(first.toSend).toHaveLength(0);
    expect(first.next['whatsapp']?.failures).toBe(1);
    const second = reconcile(first.next, failing, 2000, opts);
    expect(second.toSend).toHaveLength(1);
  });

  it('dedupes while the check keeps failing', () => {
    let state: AlertState = {};
    let sent = 0;
    for (let i = 0; i < 3; i += 1) {
      const r = reconcile(state, failing, 1000 + i * 1000, OPTS);
      state = r.next;
      sent += r.toSend.length;
    }
    expect(sent).toBe(1);
  });

  it('re-alerts once the repeat interval has passed', () => {
    const first = reconcile({}, failing, 0, OPTS);
    const soon = reconcile(first.next, failing, 30 * 60_000, OPTS);
    expect(soon.toSend).toHaveLength(0);
    const later = reconcile(soon.next, failing, 61 * 60_000, OPTS);
    expect(later.toSend).toHaveLength(1);
    expect(later.next['whatsapp']?.alertCount).toBe(2);
  });

  it('sends one recovery message and resets the entry', () => {
    const first = reconcile({}, failing, 0, OPTS);
    const recovered = reconcile(first.next, healthy, 5 * 60_000, OPTS);
    expect(recovered.toSend).toHaveLength(1);
    expect(recovered.toSend[0]?.kind).toBe('recovered');
    expect(recovered.toSend[0]?.text).toContain('recovered after 5m');
    expect(recovered.next['whatsapp']).toEqual({
      status: 'ok',
      failures: 0,
      firstFailedAt: null,
      lastAlertAt: null,
      alertCount: 0,
    });
    const again = reconcile(recovered.next, healthy, 6 * 60_000, OPTS);
    expect(again.toSend).toHaveLength(0);
  });

  it('does not announce a recovery for an outage that never alerted', () => {
    const opts = { repeatMin: 60, afterFailures: 5 };
    const first = reconcile({}, failing, 0, opts);
    const recovered = reconcile(first.next, healthy, 1000, opts);
    expect(recovered.toSend).toHaveLength(0);
  });
});

describe('deliver', () => {
  it('uses WhatsApp while the bridge is healthy', async () => {
    const cfg = makeConfig();
    const outText = await captureStdout(async () => {
      const r = await deliver(['boom'], { whatsappOk: true, owners: [OWNER] }, cfg);
      expect(r.channel).toBe('whatsapp');
    });
    expect(outText.trim()).toBe('[alert:whatsapp] boom');
  });

  it('falls back to email when the bridge is down', async () => {
    const cfg = makeConfig({
      SMTP_HOST: 'smtp.invalid',
      ALERT_EMAIL_FROM: 'a@b',
      ALERT_EMAIL_TO: 'c@d',
    });
    const outText = await captureStdout(async () => {
      const r = await deliver(['a', 'b'], { whatsappOk: false, owners: [OWNER] }, cfg);
      expect(r.channel).toBe('email');
    });
    expect(outText.trim()).toBe('[alert:email] a\nb');
  });

  it('reports no channel when nothing is configured', async () => {
    const cfg = makeConfig();
    const r = await deliver(['x'], { whatsappOk: false, owners: [OWNER] }, cfg);
    expect(r.channel).toBeNull();
  });

  it('refuses a non-owner alert JID', async () => {
    const cfg = makeConfig({ CXW_ALERT_WHATSAPP_JID: STRANGER });
    expect(alertTargetJid(cfg, [OWNER])).toBeNull();
    const r = await deliver(['x'], { whatsappOk: true, owners: [OWNER] }, cfg);
    expect(r.channel).toBeNull();
  });
});

describe('placeholder secrets', () => {
  it('treats CHANGEME exactly like an unset key', () => {
    const cfg = loadConfig({
      BRIDGE_TOKEN: 'CHANGEME',
      SMTP_USER: 'changeme',
      SMTP_PASS: 'CHANGEME',
      TELEGRAM_BOT_TOKEN: 'CHANGEME',
      TELEGRAM_CHAT_ID: 'CHANGEME',
      GOOGLE_CLIENT_ID: 'CHANGEME',
      GOOGLE_CLIENT_SECRET: 'CHANGEME',
      GOOGLE_REFRESH_TOKEN: 'CHANGEME',
      CLAUDE_CODE_OAUTH_TOKEN: 'CHANGEME',
      ANTHROPIC_API_KEY: 'CHANGEME',
    });
    expect(cfg.bridgeToken).toBeUndefined();
    expect(cfg.smtp.user).toBeUndefined();
    expect(cfg.smtp.pass).toBeUndefined();
    expect(cfg.telegram.botToken).toBeUndefined();
    expect(cfg.telegram.chatId).toBeUndefined();
    expect(cfg.google.clientId).toBeUndefined();
    expect(cfg.google.clientSecret).toBeUndefined();
    expect(cfg.google.refreshToken).toBeUndefined();
    expect(cfg.claude.oauthToken).toBeUndefined();
    expect(cfg.claude.apiKey).toBeUndefined();
  });

  it('keeps a real secret untouched', () => {
    const cfg = loadConfig({ BRIDGE_TOKEN: 'a-real-token', SMTP_PASS: 'hunter2' });
    expect(cfg.bridgeToken).toBe('a-real-token');
    expect(cfg.smtp.pass).toBe('hunter2');
  });

  it('sends no Authorization header when the token is a placeholder', async () => {
    const cfg = makeConfig({ BRIDGE_TOKEN: 'CHANGEME' });
    expect(cfg.bridgeToken).toBeUndefined();
    const captured = await captureStdout(async () => {
      await deliver(['x'], { whatsappOk: true, owners: [OWNER] }, cfg);
    });
    expect(captured).toContain('[alert:whatsapp] x');
  });
});
