/* global document, window, navigator, fetch, crypto, console */

/**
 * The installer page.
 *
 * No bundler and no framework. `pnpm --filter @cxw/installer build` runs tsc with
 * rootDir "." into public/assets/, so the browser entry point lands at
 * ./assets/src/index.js — the "src/" segment is a consequence of the package tsconfig
 * having to cover functions/ as well.
 *
 * Nothing on this page is stored: no browser storage API of any kind, and no cookie.
 * Tokens live in a form field and in one request to this site's own Pages Function,
 * then they are gone. src/no-storage.test.ts scans this file and fails on any of them.
 */

import {
  INSTALLER_STEPS,
  buildCloudInit,
  createCloudflareClient,
  createHetznerProvider,
  createManualProvider,
  generateDeployKey,
  runInstall,
} from './assets/src/index.js';

const $ = (id) => document.getElementById(id);

const state = {
  deployKey: null,
  values: null,
};

/** Turn a git SSH or https URL into the repository's deploy-keys settings page. */
function deployKeysUrl(repoUrl) {
  const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(repoUrl);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}/settings/keys`;
  const https = /^https:\/\/([^/]+)\/(.+?)(?:\.git)?$/.exec(repoUrl);
  if (https) return `https://${https[1]}/${https[2]}/settings/keys`;
  return repoUrl;
}

function readValues() {
  return {
    domain: $('domain').value.trim().toLowerCase(),
    ownerEmail: $('ownerEmail').value.trim(),
    cfToken: $('cfToken').value.trim(),
    hzToken: $('hzToken').value.trim(),
    providerId: $('provider').value,
    repoUrl: $('repoUrl').value.trim(),
    branch: $('branch').value.trim(),
    timezone: $('timezone').value.trim(),
    tailscaleAuthKey: $('tsKey').value.trim(),
  };
}

function renderSteps() {
  const list = $('steps');
  list.textContent = '';
  for (const step of INSTALLER_STEPS) {
    const li = document.createElement('li');
    li.id = `step-${step.id}`;
    const head = document.createElement('div');
    head.className = 'step-head';
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = '·';
    const body = document.createElement('div');
    const title = document.createElement('span');
    title.className = 'step-title';
    title.textContent = step.title;
    const detail = document.createElement('span');
    detail.className = 'step-detail';
    detail.textContent = step.detail;
    body.append(title, detail);
    head.append(mark, body);
    li.append(head);
    list.append(li);
  }
}

const MARKS = { running: '…', done: '✓', failed: '✗' };

function markStep(event) {
  const li = $(`step-${event.stepId}`);
  if (!li) return;
  li.className = event.state;
  li.querySelector('.mark').textContent = MARKS[event.state] || '·';
}

function showFallback(stepId, text) {
  const li = $(`step-${stepId}`);
  if (!li || li.querySelector('.fallback')) return;
  const box = document.createElement('div');
  box.className = 'fallback';
  box.textContent = text;
  li.append(box);
}

/** Everything below goes through this site's own Pages Function, never cross-origin. */
function probeHealth(url) {
  return fetch('/api/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
    .then((response) => response.json())
    .then((body) => ({ status: body.status, location: body.location, body: body.snippet }))
    .catch(() => ({ status: 0, location: '', body: '' }));
}

function showManual(instructions) {
  $('cloudInit').textContent = instructions.cloudInit;
  $('sshCommand').textContent = instructions.sshCommand;
  $('firewallNote').textContent = instructions.firewallNote;
  const list = $('knownGood');
  list.textContent = '';
  for (const name of instructions.knownGoodProviders) {
    const li = document.createElement('li');
    li.textContent = name;
    list.append(li);
  }
  $('manualCard').hidden = false;
}

async function start() {
  const values = state.values;
  const key = state.deployKey;
  $('start').disabled = true;
  $('progressCard').hidden = false;
  renderSteps();
  $('summary').textContent = '';
  $('summary').className = '';

  const cloudflare = createCloudflareClient({
    token: values.cfToken,
    baseUrl: '/api/cloudflare',
    extraHeaders: { 'X-CXW-CF-Token': values.cfToken },
  });

  // runInstall calls buildCloudInit before it calls the provider, so the manual
  // provider is built from the finished input at the moment it is needed.
  let finalInput = null;

  const provider =
    values.providerId === 'hetzner'
      ? createHetznerProvider({
          token: values.hzToken,
          baseUrl: '/api/hetzner',
          extraHeaders: { 'X-CXW-HZ-Token': values.hzToken },
        })
      : {
          id: 'manual',
          label: 'Any other server',
          capabilities: { canCreateFirewall: false, canCreateServer: false },
          createServer: (input) => createManualProvider({ input: finalInput }).createServer(input),
          waitForRunning: (id) => Promise.resolve({ id, status: 'manual' }),
        };

  const deps = {
    cloudflare,
    provider,
    buildCloudInit: (input) => {
      finalInput = input;
      return buildCloudInit(input);
    },
    probeHealth,
  };

  const installInput = {
    domain: values.domain,
    ownerEmail: values.ownerEmail,
    repoUrl: values.repoUrl,
    branch: values.branch,
    deployKeyPrivate: key.privateKeyOpenSsh,
    deployKeyPublic: key.publicKeyOpenSsh,
    timezone: values.timezone,
    ...(values.tailscaleAuthKey ? { tailscaleAuthKey: values.tailscaleAuthKey } : {}),
  };

  try {
    const result = await runInstall(deps, installInput, markStep);

    if (result.server.manual) showManual(result.server.manual);

    const summary = $('summary');
    if (result.health.warning) {
      summary.className = 'warn';
      summary.textContent = `Ready, with a warning: ${result.health.reason}`;
    } else if (result.health.state === 'ready') {
      summary.className = 'ok';
      summary.textContent = 'Ready. The login is in front of it.';
    } else {
      summary.textContent = `Still ${result.health.state}: ${result.health.reason}`;
    }

    const link = $('continueLink');
    link.href = result.setupUrl;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.hidden = false;
  } catch (error) {
    const summary = $('summary');
    summary.className = 'bad';
    summary.textContent = error.message || String(error);
    if (error.stepId) showFallback(error.stepId, error.fallback);
    // The manual route needs its instructions even when the wait timed out.
    if (finalInput && values.providerId !== 'hetzner') {
      const created = await createManualProvider({ input: finalInput }).createServer({
        name: 'cxw',
        userData: buildCloudInit(finalInput),
      });
      showManual(created.manual);
    }
    $('start').disabled = false;
  }
}

$('provider').addEventListener('change', () => {
  $('hetznerFields').hidden = $('provider').value !== 'hetzner';
  $('hzToken').required = $('provider').value === 'hetzner';
});

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.values = readValues();
  const key = await generateDeployKey(crypto.subtle);
  state.deployKey = key;
  $('publicKey').textContent = key.publicKeyOpenSsh;
  $('fingerprint').textContent = key.fingerprintSha256;
  $('deployKeysLink').href = deployKeysUrl(state.values.repoUrl);
  $('keyCard').hidden = false;
  $('keyCard').scrollIntoView({ behavior: 'smooth' });
});

$('keyConfirmed').addEventListener('change', () => {
  $('start').disabled = !$('keyConfirmed').checked;
});

$('start').addEventListener('click', () => {
  start().catch((error) => console.error(error));
});

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const text = $(button.dataset.copy).textContent;
    try {
      await navigator.clipboard.writeText(text);
      const original = button.textContent;
      button.textContent = 'Copied';
      window.setTimeout(() => {
        button.textContent = original;
      }, 1500);
    } catch {
      button.textContent = 'Select it and copy by hand';
    }
  });
}

$('timezone').value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Prague';
