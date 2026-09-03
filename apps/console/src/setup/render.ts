/**
 * The wizard's HTML. Server-rendered strings, no template engine, no client framework.
 *
 * Two rules hold this file together.
 *
 * 1. **It works with JavaScript off.** Every step is a plain `<form method="post">` that
 *    redirects on success. JavaScript appears exactly once, on the WhatsApp step, and only to
 *    re-request the QR image and the pairing state while the code rotates. Turn it off and that
 *    step still works with the reload button.
 * 2. **No secret is ever passed in.** Not one function here takes a token, a key or a client
 *    secret. What the page shows about a saved credential is at most its last four characters,
 *    which the step module produced. `guardrails.test.ts` enforces it by scanning this file.
 */

import { escapeHtml } from './escape.js';
import { SETUP_CSS } from './styles.js';
import { STEP_IDS } from './state.js';
import type { SetupState, StepId } from './state.js';
import type { PairView } from './steps/whatsapp.js';
import { PAIR_COMMAND } from './steps/whatsapp.js';
import type { RoutineListing } from './steps/routines.js';
import type { DoneView } from './steps/done.js';
import { capabilityLabel } from './steps/done.js';
import { AUDIENCE_PAGE_URL } from './steps/google.js';
import { SETUP_TOKEN_COMMAND } from './steps/claude.js';

export type Screen = StepId | 'done';

export interface Banner {
  readonly kind: 'note' | 'warn' | 'bad';
  readonly text: string;
}

export interface PageContext {
  readonly state: SetupState;
  readonly screen: Screen;
  readonly consoleHostname: string;
  /** The CSRF value every form carries. Not a secret to the person, only to another origin. */
  readonly csrf: string;
  readonly banner?: Banner;
}

const TITLES: Readonly<Record<Screen, string>> = {
  owner: 'Who owns this assistant',
  whatsapp: 'Link WhatsApp',
  claude: 'Log Claude in',
  google: 'Connect Gmail and Calendar',
  routines: 'Routines and your timezone',
  vault: 'Back the vault up to git',
  done: 'Setup is finished',
};

const LEADS: Readonly<Record<Screen, string>> = {
  owner: 'Only this number can ask the assistant to do anything. Everything else is treated as data.',
  whatsapp: 'Scan the code with the phone that holds your WhatsApp account.',
  claude:
    'Your Claude Max subscription is the preferred path. An API key is the metered fallback.',
  google: 'Optional. Skip it and everything except Gmail and Calendar still works.',
  routines: 'Choose what runs on a schedule, and tell the box which clock to use.',
  vault: 'Optional. Push your notes to a private repository so a lost box is not a lost brain.',
  done: 'The wizard is closed. This address is the console from now on.',
};

function banner(value: Banner | undefined): string {
  if (value === undefined) return '';
  return `<div class="${escapeHtml(value.kind)}">${escapeHtml(value.text)}</div>`;
}

/** The numbered rail: where the person is, what is behind them, what is left. */
export function renderRail(state: SetupState, screen: Screen): string {
  const items = STEP_IDS.map((id, index) => {
    const status = state.steps[id].status;
    const classes = [status === 'done' ? 'done' : '', status === 'skipped' ? 'skipped' : ''];
    if (id === screen) classes.push('current');
    const className = classes.filter((part) => part !== '').join(' ');
    return `<li class="${escapeHtml(className)}"><span class="n">${String(index + 1)}</span>${escapeHtml(TITLES[id])}</li>`;
  });
  const doneClass = screen === 'done' ? 'current' : '';
  items.push(
    `<li class="${escapeHtml(doneClass)}"><span class="n">${String(STEP_IDS.length + 1)}</span>Done</li>`,
  );
  return `<ol class="rail">${items.join('')}</ol>`;
}

/** The whole document. `body` is one step's markup, already escaped by its own renderer. */
export function renderPage(context: PageContext, body: string, headExtra = ''): string {
  const title = TITLES[context.screen];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} · ClaudeXWhatsapp setup</title>
<style>${SETUP_CSS}</style>${headExtra}
</head>
<body>
<div class="wrap">
<header class="top"><h1>Set up your assistant</h1><span class="host">${escapeHtml(context.consoleHostname)}</span></header>
${renderRail(context.state, context.screen)}
${banner(context.banner)}
<section class="step">
<h2>${escapeHtml(title)}</h2>
<p class="lead">${escapeHtml(LEADS[context.screen])}</p>
${body}
</section>
</div>
</body>
</html>
`;
}

/** The hidden CSRF field every POST form carries. */
function csrfField(csrf: string): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
}

function skipButton(step: StepId, csrf: string, action: string): string {
  return `<form method="post" action="${escapeHtml(action)}" style="display:inline">${csrfField(csrf)}<input type="hidden" name="skip" value="${escapeHtml(step)}"><button class="ghost" type="submit">Skip this step</button></form>`;
}

export function renderOwner(context: PageContext, currentDigits: string): string {
  return `<form method="post" action="/setup/owner">
${csrfField(context.csrf)}
<label for="number">Your WhatsApp number</label>
<p class="hint">With the country code. Spaces, dashes and a leading + are all fine.</p>
<input class="mono" id="number" name="number" type="text" inputmode="tel" autocomplete="tel"
  placeholder="+420 123 456 789" value="${escapeHtml(currentDigits)}" required>
<div class="row"><button type="submit">Save and continue</button></div>
</form>`;
}

export function renderWhatsapp(context: PageContext, view: PairView): string {
  const image = view.showQr
    ? `<img class="qr" id="qr" alt="WhatsApp linking code" src="/setup/whatsapp/qr.svg?v=${String(view.qrCount)}">`
    : '';
  const help = view.status === 'unavailable' ? `<pre>${escapeHtml(PAIR_COMMAND)}</pre>` : '';
  const start =
    view.status === 'unavailable' || view.status === 'gave-up' || view.status === 'logged-out'
      ? `<form method="post" action="/setup/whatsapp/start" style="display:inline">${csrfField(context.csrf)}<button type="submit">Start pairing</button></form>`
      : '';
  const next = view.done
    ? `<form method="post" action="/setup/whatsapp/start" style="display:inline">${csrfField(context.csrf)}<input type="hidden" name="confirm" value="linked"><button type="submit">Continue</button></form>`
    : '';
  return `<div class="note">${escapeHtml(view.sentence)}</div>
${help}
${image}
<p class="state" id="state">code ${String(view.qrCount)} · attempt ${String(view.attempt)} · ${escapeHtml(view.status)}</p>
<div class="row">${start}${next}
<form method="post" action="/setup/whatsapp/pair-code" style="display:inline">${csrfField(context.csrf)}
<button class="ghost" type="submit">Use a pairing code instead</button></form>
${skipButton('whatsapp', context.csrf, '/setup/whatsapp/start')}
</div>
<noscript><p class="state">Reload this page to refresh the code.</p></noscript>`;
}

/** The only JavaScript on the wizard: re-request the QR and the state while the code rotates. */
export const WHATSAPP_POLL_SCRIPT = `<script>
(function () {
  var img = document.getElementById('qr');
  var state = document.getElementById('state');
  var shown = -1;
  function tick() {
    fetch('/setup/whatsapp/status?t=' + Date.now(), { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (state) state.textContent = 'code ' + s.qrCount + ' \\u00b7 attempt ' + s.attempt + ' \\u00b7 ' + s.status;
        if (s.done) { window.location.reload(); return; }
        if (img && s.showQr && s.qrCount !== shown) { shown = s.qrCount; img.src = '/setup/whatsapp/qr.svg?v=' + s.qrCount; }
        if (s.polling) setTimeout(tick, 2000);
      })
      .catch(function () { setTimeout(tick, 5000); });
  }
  tick();
})();
</script>`;

export interface ClaudeViewModel {
  /** The device-flow URL, when `claude setup-token` has printed one. */
  readonly url: string;
  readonly code: string;
  readonly running: boolean;
  /** The last four characters of whatever is already saved. Never more than four. */
  readonly savedLast4: string;
  readonly savedKind: 'oauth' | 'api-key' | 'none';
}

export function renderClaude(context: PageContext, view: ClaudeViewModel): string {
  const saved =
    view.savedKind === 'none'
      ? ''
      : `<div class="note">Saved: ${escapeHtml(
          view.savedKind === 'oauth' ? 'subscription token' : 'API key',
        )} ending <span class="mono">${escapeHtml(view.savedLast4)}</span>. Saving again replaces it.</div>`;

  const flow =
    view.url === ''
      ? `<form method="post" action="/setup/claude/start">${csrfField(context.csrf)}
<div class="row"><button type="submit">Start the Claude sign-in</button></div>
<p class="hint">This runs <span class="mono">${escapeHtml(SETUP_TOKEN_COMMAND)}</span> on the box.</p>
</form>`
      : `<div class="note">Open <a href="${escapeHtml(view.url)}" target="_blank" rel="noreferrer noopener">this sign-in page</a>${
          view.code === ''
            ? ''
            : ` and enter the code <span class="mono">${escapeHtml(view.code)}</span>`
        }, then paste the token it gives you below.</div>`;

  return `${saved}${flow}
<form method="post" action="/setup/claude/token">
${csrfField(context.csrf)}
<label for="token">Token from <span class="mono">${escapeHtml(SETUP_TOKEN_COMMAND)}</span></label>
<p class="hint">It starts with <span class="mono">sk-ant-oat</span>. It is written to cxw.env at mode 0600 and never shown again.</p>
<input class="mono" id="token" name="token" type="text" autocomplete="off" spellcheck="false" placeholder="sk-ant-oat…">
<div class="row"><button type="submit">Save the token</button></div>
</form>
<details><summary>Use an API key instead</summary>
<form method="post" action="/setup/claude/api-key">
${csrfField(context.csrf)}
<label for="apikey">Anthropic API key</label>
<p class="hint">Metered fallback, from console.anthropic.com. Starts with <span class="mono">sk-ant-</span>.</p>
<input class="mono" id="apikey" name="apikey" type="text" autocomplete="off" spellcheck="false" placeholder="sk-ant-…">
<div class="row"><button class="ghost" type="submit">Save the API key</button></div>
</form>
</details>`;
}

export interface GoogleViewModel {
  /** True once a refresh token has been written. Never carries the token itself. */
  readonly connected: boolean;
  readonly ownerEmail: string;
  readonly consentConfirmed: boolean;
  readonly redirectUri: string;
}

export function renderGoogle(context: PageContext, view: GoogleViewModel): string {
  const status = view.connected
    ? `<div class="note">Connected as <span class="mono">${escapeHtml(view.ownerEmail)}</span>. Running this again replaces the stored authorisation.</div>`
    : '';
  const consent = view.consentConfirmed
    ? '<div class="note">You confirmed the consent screen is published.</div>'
    : `<form method="post" action="/setup/google/confirm-production">
${csrfField(context.csrf)}
<div class="warn">Google publishes no way to check this automatically, so we have to ask.
Open <a href="${escapeHtml(AUDIENCE_PAGE_URL)}" target="_blank" rel="noreferrer noopener">the audience page</a>
and read the publishing status. While it says <em>Testing</em>, Google expires the sign-in after seven days
and Gmail and Calendar stop answering with no warning.</div>
<label class="checkline"><input type="checkbox" name="confirmed" value="yes">
It reads <strong>In production</strong>.</label>
<div class="row"><button class="ghost" type="submit">Record that</button></div>
</form>`;

  return `${status}${consent}
<form method="post" action="/setup/google/start" style="display:contents">
${csrfField(context.csrf)}
<label for="clientId">OAuth client ID</label>
<p class="hint">From the Google Cloud credentials page, for a Web application client.</p>
<input class="mono" id="clientId" name="clientId" type="text" autocomplete="off" placeholder="…apps.googleusercontent.com">
<label for="clientSecret" style="margin-top:14px">OAuth client secret</label>
<p class="hint">Written to google.env at mode 0600 and never shown again.</p>
<input class="mono" id="clientSecret" name="clientSecret" type="text" autocomplete="off">
<label for="ownerEmail" style="margin-top:14px">The Google account to read</label>
<input class="mono" id="ownerEmail" name="ownerEmail" type="email" autocomplete="off" value="${escapeHtml(view.ownerEmail)}">
<div class="note">Add this exact redirect URI to the client first:<pre>${escapeHtml(view.redirectUri)}</pre></div>
<div class="row"><button type="submit">Connect Google</button>
${skipButton('google', context.csrf, '/setup/google/start')}</div>
</form>`;
}

export function renderRoutines(
  context: PageContext,
  listing: RoutineListing,
  timezone: string,
): string {
  const rows = listing.present
    ? listing.routines.length === 0
      ? '<div class="note">There are no routine files in the vault yet.</div>'
      : `<ul class="caps">${listing.routines
          .map(
            (routine) =>
              `<li><label class="checkline"><input type="checkbox" name="enabled" value="${escapeHtml(routine.name)}"${
                routine.enabled ? ' checked' : ''
              }><span><strong>${escapeHtml(routine.name)}</strong>${
                routine.description === ''
                  ? ''
                  : `<br><span class="later">${escapeHtml(routine.description)}</span>`
              }</span></label></li>`,
          )
          .join('')}</ul>`
    : '<div class="note">Routines land with phase 5. Nothing to switch on yet — come back after that lands and the toggles appear here.</div>';

  return `<form method="post" action="/setup/routines">
${csrfField(context.csrf)}
${rows}
<label for="timezone" style="margin-top:16px">Your timezone</label>
<p class="hint">An IANA name, for example Europe/Prague or America/Panama. It sets when routines run.</p>
<input class="mono" id="timezone" name="timezone" type="text" value="${escapeHtml(timezone)}" placeholder="Europe/Prague" required>
<div class="row"><button type="submit">Save and continue</button>
${skipButton('routines', context.csrf, '/setup/routines')}</div>
</form>`;
}

export function renderVault(context: PageContext, currentRemote: string): string {
  return `<form method="post" action="/setup/vault">
${csrfField(context.csrf)}
<label for="remote">Repository URL for your vault</label>
<p class="hint">The box already has a deploy key. Add its public half to the repository first.</p>
<input class="mono" id="remote" name="remote" type="text" autocomplete="off"
  placeholder="git@github.com:you/vault.git" value="${escapeHtml(currentRemote)}">
<div class="row"><button type="submit">Save the remote</button>
${skipButton('vault', context.csrf, '/setup/vault')}</div>
</form>`;
}

export function renderDonePage(context: PageContext, view: DoneView): string {
  const warning = view.warning === null ? '' : `<div class="warn">${escapeHtml(view.warning)}</div>`;
  const skipped =
    view.skipped.length === 0
      ? ''
      : `<div class="note">You skipped: ${escapeHtml(view.skipped.join(', '))}. Each one can be done later from the console.</div>`;
  const items = view.items
    .map(
      (item) =>
        `<li>${item.available ? escapeHtml(item.text) : `<span class="later">${escapeHtml(capabilityLabel(item))}</span>`}</li>`,
    )
    .join('');
  return `${warning}${skipped}
<p>What you can do now:</p>
<ul class="caps">${items}</ul>
<div class="row"><a class="btn" href="https://${escapeHtml(context.consoleHostname)}/">Open the console</a></div>`;
}

/** The final confirmation form, shown before setup mode is switched off. */
export function renderFinish(context: PageContext, view: DoneView): string {
  return `${renderDonePage(context, view)}
<form method="post" action="/setup/done">${csrfField(context.csrf)}
<div class="row"><button type="submit">Finish setup</button></div>
<p class="hint">This closes the wizard. This address becomes the console.</p>
</form>`;
}
