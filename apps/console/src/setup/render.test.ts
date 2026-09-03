import { describe, expect, it } from 'vitest';
import {
  renderClaude,
  renderDonePage,
  renderFinish,
  renderGoogle,
  renderOwner,
  renderPage,
  renderRail,
  renderRoutines,
  renderVault,
  renderWhatsapp,
  WHATSAPP_POLL_SCRIPT,
} from './render.js';
import type { PageContext, Screen } from './render.js';
import { freshSetupState, markStep, STEP_IDS } from './state.js';
import { toPairView } from './steps/whatsapp.js';
import type { PairServiceStatus } from './steps/whatsapp.js';
import { renderDone } from './steps/done.js';

/** A string that escapes its context if anything is interpolated raw. */
const HOSTILE = `"><script>alert('xss')</script>`;

function context(screen: Screen = 'owner'): PageContext {
  return {
    state: freshSetupState(0),
    screen,
    consoleHostname: 'cxw.example.com',
    csrf: 'csrf-value-1',
  };
}

function pairView(status: PairServiceStatus, qrCount = 0) {
  return toPairView({ status, attempt: 1, qrCount, updatedAt: '', note: '' });
}

describe('renderPage', () => {
  it('renders one document with the shell, the rail and the body', () => {
    const page = renderPage(context(), '<p>body</p>');
    expect(page.startsWith('<!doctype html>')).toBe(true);
    expect(page).toContain('<title>');
    expect(page).toContain('<ol class="rail">');
    expect(page).toContain('<p>body</p>');
    expect(page).toContain('cxw.example.com');
    expect(page.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('inlines the stylesheet and requests nothing from the network', () => {
    const page = renderPage(context(), '');
    expect(page).toContain('--wa:');
    expect(page).toContain('prefers-color-scheme: dark');
    expect(page).not.toContain('<link');
    expect(page).not.toMatch(/src="https?:/);
  });

  it('escapes a hostile hostname', () => {
    const page = renderPage({ ...context(), consoleHostname: HOSTILE }, '');
    expect(page).not.toContain('<script>alert');
    expect(page).toContain('&lt;script&gt;');
  });

  it('escapes a hostile banner rather than rendering it', () => {
    const page = renderPage({ ...context(), banner: { kind: 'bad', text: HOSTILE } }, '');
    expect(page).not.toContain('<script>alert');
    expect(page).toContain('&lt;script&gt;');
  });

  it('renders a title for every screen', () => {
    const screens: Screen[] = [...STEP_IDS, 'done'];
    for (const screen of screens) {
      const page = renderPage(context(screen), '');
      expect(page, screen).toMatch(/<title>[^<]+ · ClaudeXWhatsapp setup<\/title>/);
    }
  });
});

describe('renderRail', () => {
  it('marks the current step and the completed ones', () => {
    const state = markStep(freshSetupState(0), 'owner', 'done', 0);
    const rail = renderRail(state, 'whatsapp');
    expect(rail).toContain('class="done"');
    expect(rail).toContain('current');
    expect((rail.match(/<li/g) ?? []).length).toBe(STEP_IDS.length + 1);
  });

  it('marks a skipped step distinctly from a done one', () => {
    const state = markStep(freshSetupState(0), 'vault', 'skipped', 0);
    expect(renderRail(state, 'done')).toContain('skipped');
  });
});

describe('step bodies', () => {
  it('renderOwner is a plain POST form carrying the CSRF value', () => {
    const body = renderOwner(context(), '420123456789');
    expect(body).toContain('<form method="post" action="/setup/owner">');
    expect(body).toContain('name="csrf" value="csrf-value-1"');
    expect(body).toContain('value="420123456789"');
  });

  it('renderOwner escapes a hostile previous value', () => {
    expect(renderOwner(context(), HOSTILE)).not.toContain('<script>');
  });

  it('renderWhatsapp shows the QR from its own endpoint, never inlined', () => {
    const body = renderWhatsapp(context('whatsapp'), pairView('waiting', 3));
    expect(body).toContain('src="/setup/whatsapp/qr.svg?v=3"');
    expect(body).not.toContain('<svg');
  });

  it('renderWhatsapp offers the command by hand when the service is unavailable', () => {
    const body = renderWhatsapp(context('whatsapp'), pairView('unavailable'));
    expect(body).toContain('pnpm pair:qr');
    expect(body).toContain('Start pairing');
  });

  it('renderWhatsapp works without JavaScript', () => {
    const body = renderWhatsapp(context('whatsapp'), pairView('waiting', 1));
    expect(body).toContain('<noscript>');
    expect(body).not.toContain('<script');
  });

  it('the poll script is the only JavaScript, and is opt-in per render', () => {
    expect(WHATSAPP_POLL_SCRIPT).toContain('<script>');
    const page = renderPage(context('whatsapp'), renderWhatsapp(context('whatsapp'), pairView('linked')));
    expect(page).not.toContain('<script>');
  });

  it('renderClaude never shows more than the last four characters', () => {
    const body = renderClaude(context('claude'), {
      url: 'https://claude.ai/oauth/authorize',
      code: 'WXYZ-1234',
      running: true,
      savedLast4: 'abcd',
      savedKind: 'oauth',
    });
    expect(body).toContain('ending <span class="mono">abcd</span>');
    expect(body).toContain('https://claude.ai/oauth/authorize');
    expect(body).toContain('WXYZ-1234');
    expect(body).not.toContain('sk-ant-oat-');
  });

  it('renderClaude escapes a hostile device-flow URL and code', () => {
    const body = renderClaude(context('claude'), {
      url: `https://x/${HOSTILE}`,
      code: HOSTILE,
      running: false,
      savedLast4: '',
      savedKind: 'none',
    });
    expect(body).not.toContain('<script>alert');
  });

  it('renderGoogle links the audience page and never shows a secret field value', () => {
    const body = renderGoogle(context('google'), {
      connected: true,
      ownerEmail: 'alfonso@example.com',
      consentConfirmed: false,
      redirectUri: 'https://cxw.example.com/setup/google/callback',
    });
    expect(body).toContain('console.cloud.google.com/auth/audience');
    expect(body).toContain('In production');
    expect(body).toContain('https://cxw.example.com/setup/google/callback');
    // The client secret input is always empty: nothing stored is echoed back into it.
    expect(body).toMatch(/id="clientSecret"[^>]*>/);
    expect(body).not.toMatch(/id="clientSecret"[^>]*value=/);
  });

  it('renderGoogle drops the warning once production is confirmed', () => {
    const body = renderGoogle(context('google'), {
      connected: true,
      ownerEmail: '',
      consentConfirmed: true,
      redirectUri: 'https://x/cb',
    });
    expect(body).toContain('confirmed the consent screen is published');
    expect(body).not.toContain('class="warn"');
  });

  it('renderRoutines explains the empty state when phase 5 has not landed', () => {
    const body = renderRoutines(context('routines'), { routines: [], present: false }, 'UTC');
    expect(body).toContain('Routines land with phase 5');
    expect(body).toContain('name="timezone"');
  });

  it('renderRoutines renders one checkbox per routine and escapes their names', () => {
    const body = renderRoutines(
      context('routines'),
      {
        present: true,
        routines: [
          { name: 'morning-brief', file: '/x/a.md', enabled: true, description: 'At seven.' },
          { name: HOSTILE, file: '/x/b.md', enabled: false, description: HOSTILE },
        ],
      },
      'Europe/Prague',
    );
    expect((body.match(/type="checkbox"/g) ?? []).length).toBe(2);
    expect(body).toContain('value="morning-brief"');
    expect(body).toContain(' checked');
    expect(body).not.toContain('<script>alert');
  });

  it('renderVault offers a skip and escapes an existing remote', () => {
    const body = renderVault(context('vault'), HOSTILE);
    expect(body).toContain('Skip this step');
    expect(body).not.toContain('<script>alert');
  });
});

describe('renderDonePage', () => {
  it('renders an unmerged capability with the "lands with" wording', () => {
    const body = renderDonePage(context('done'), renderDone(freshSetupState(0), [1]));
    expect(body).toContain('lands with phase');
    expect(body).toContain('https://cxw.example.com/');
  });

  it('carries the Google warning when production was never confirmed', () => {
    const state = markStep(freshSetupState(0), 'google', 'done', 0);
    const body = renderDonePage(context('done'), renderDone(state, []));
    expect(body).toContain('class="warn"');
    expect(body).toContain('7 days');
  });

  it('names the steps that were skipped', () => {
    const state = markStep(freshSetupState(0), 'vault', 'skipped', 0);
    expect(renderDonePage(context('done'), renderDone(state, []))).toContain('You skipped: vault');
  });

  it('renderFinish adds the confirmation form', () => {
    const body = renderFinish(context('done'), renderDone(freshSetupState(0), []));
    expect(body).toContain('action="/setup/done"');
    expect(body).toContain('name="csrf"');
  });
});
