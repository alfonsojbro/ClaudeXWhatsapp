# Plan — Phase 10: Installer and setup wizard

**Date:** 2026-09-03 · **Branch (intended):** `phase-10-installer` · **Author:** orchestrator (Claude)
**Depends on:** phase 0 bootstrap (merged), phase 8 console (in flight), the getting-started guide.
**Revised the same day:** Alfonso hosts the site; people sign up there. See "Hosted model".

## Goal

A person who receives the repo sets the whole thing up through a browser: the cloud machine, the
tunnel, WhatsApp, Claude, Google, routines. No terminal. Alfonso's words: "make the onboarding
easy to do through our cloudflare deployment, so they connect everything through an interface"
and "setup even their cloud machine there".

## Two stages, because the box does not exist yet

**Stage A, the installer, runs on Cloudflare Pages before any server exists.** It is a static page
plus one Pages Function on the person's own Cloudflare account. It creates the Hetzner server,
the Cloudflare tunnel and the Access policy, then hands over.

**Stage B, the setup wizard, runs on the box** as a mode of the phase 8 console. It appears at
`https://cxw.<their domain>/setup` as soon as the box has booted and the tunnel is up, and walks
through everything that needs the box: owner number, WhatsApp QR, Claude login, Google consent,
starter routines, vault remote. When the last step completes, setup mode switches off and the same
address is the console.

## Hosted model (revision, 2026-09-03 evening)

Alfonso's words: "I just share the website and they sign up and then they can easy set it up and
connect to their whatsapp, and get the step by step".

So the installer is not something each person deploys. It is **one website on Alfonso's Cloudflare
account**, with a public landing page and a sign-up. After sign-up, the same site runs Stage A for
that person and hands over to Stage B on their own box.

**Sign-up** is Cloudflare Access with the one-time PIN identity provider: any email address, a
six-digit code by mail, no password to store and no Google account required. The email becomes
the person's identity for the whole flow and the Access policy on their console.

**Where their console lives.** Two options, chosen on the first setup screen:

1. *Hosted address (default, easiest).* Their console is `<name>.cxw.<Alfonso's domain>`. The
   tunnel and the Access policy are created on Alfonso's Cloudflare account, scoped to their email.
   They need only a Hetzner token and their phone. The trade, stated on the page: Alfonso's
   Cloudflare account is the front door to their console; it sees console traffic, never WhatsApp
   messages, mail bodies or tokens, which never leave their box.
2. *Bring your own Cloudflare (private).* They supply a scoped token for their own zone; the site
   creates the tunnel and policy there instead. Nothing of theirs passes through Alfonso's account
   after setup.

**What the site stores per person:** their email, the chosen hostname, the Hetzner server id, and
step progress. Never a Hetzner token, a Tailscale key, a deploy key or an Anthropic credential.
Tokens are held in memory for the duration of one request in the Pages Function and discarded.
This is written on the page next to each field.

**Tailscale becomes optional.** With a hosted address the console is reachable without it. The
site still offers a Tailscale key field for SSH access, marked optional.

**The person's own accounts still do the logging in.** Hetzner, Anthropic, Google: the site shows
the link or code, the person signs in on the provider's site. The site never asks for a password.

**Landing page.** Public, designed, one job: explain what this is and start setup. Copy and layout
follow the taste guidance: no templated hero, one accent, one CTA intent ("Start setup"), the
product shown as the chat it really is, plus a real preview of the console.

## Stage A: the installer

Inputs, each with a link to the exact page where the person creates it, and a note that it is
used once from their own browser and their own Cloudflare account, never sent anywhere else:

1. Hetzner Cloud API token, read and write, for one project.
2. Tailscale auth key, reusable off, tagged `tag:cxw`, so SSH works from day one.
3. Cloudflare API token scoped to this zone: Tunnel write, Access write, DNS write.
4. The domain on that zone, and the email that Access should allow.
5. A GitHub deploy key. The installer generates an Ed25519 pair in the browser with WebCrypto,
   shows the public half with a link to the repo's deploy-keys page, and waits until the person
   confirms it is added. The private half goes only into the cloud-init payload.

What it does, in order, with a visible progress line for each:

1. Creates a Cloudflare tunnel, a DNS record `cxw.<domain>` pointing at it, and an Access
   application on that hostname allowing only the given email.
2. Builds a cloud-init user-data document: Tailscale install and `tailscale up` with the key,
   the deploy key at `/root/.ssh/cxw_deploy`, a clone of the repo, `deploy/hetzner/bootstrap.sh`
   with the tunnel token in `cxw.env`, and `cxw-console` started in setup mode.
3. Creates a Hetzner CX33 in fsn1 on Ubuntu 24.04 with that user-data and the Hetzner firewall
   from the plan (no inbound rules). Polls until the server reports running.
4. Polls `https://cxw.<domain>/setup/health` through the tunnel until it answers, then shows one
   button: "Continue setup". Typical wait is three to five minutes.

Fallback on every step: if an API call is refused, the installer shows the equivalent command
or the exact web form to fill by hand, so a permission mistake never strands the person.

Why a Pages Function and not the browser alone: the Hetzner and Cloudflare APIs do not answer
cross-origin browser requests. The Function is twenty lines, stateless, deployed on the person's
own account, and forwards each request with the token it was just given. It stores nothing.

## Stage B: the setup wizard on the box

Served by `apps/console` (phase 8) when no owner is configured yet. Behind Cloudflare Access from
the first second, because the installer created the policy before the box booted. Steps:

1. **Owner.** Their WhatsApp number. Written to `/srv/cxw/state/owners.json`.
2. **WhatsApp.** The live QR, rendered from the bridge's pairing output and refreshed as WhatsApp
   rotates it. Pairing code as the alternative. Success detected from the session folder.
3. **Claude.** Runs `claude login` on the box and shows the URL and the one-time code from the
   device flow. The person signs in on anthropic.com. API key as fallback, entered once, stored
   root-only on the box, never echoed back.
4. **Google.** A "Connect Google" button that starts the OAuth flow with the console's own
   `https://cxw.<domain>/setup/google/callback` as redirect. The refresh token lands in
   `/srv/cxw/google.env`. The page checks the consent screen is in Production and warns if not.
5. **Routines.** Toggles for the starter set and the timezone.
6. **Vault.** Optional git remote for the vault, using the same deploy key.
7. **Done.** Setup mode off. Link to the console, and the "what you can do now" page from the
   guide, marked by phase so nothing unmerged is promised.

Every step is re-runnable from the console later (re-pair WhatsApp, reconnect Google).

## Security, stated once

- Tokens typed into the installer are used from the person's browser and their own Pages
  Function, then discarded. The page says so next to each field.
- The cloud-init payload carries the deploy key and the tunnel token. Hetzner sees user-data by
  design; the person should know that. Bootstrap deletes the user-data copy after first boot.
- The setup wizard is behind Access before it exists. There is no window where it is public.
- The wizard cannot approve a confirm token, same as the console.
- Nothing from setup is written to the vault or the repo.

## Files touched

- `apps/site/` (new, hosted by Alfonso): landing page, sign-up gate (Access one-time PIN), the
  installer flow, `functions/api/[[route]].ts` (Pages Function), a KV namespace for per-person
  progress, `cloud-init.template.yml`, tests for the payload builder, the fallbacks and the
  "never store a token" rule
- `apps/console/src/setup/` (new, inside phase 8's package): `mode.ts`, `steps/*.ts`,
  `google-oauth.ts`, `claude-login.ts`, `pair.ts` (reuses `scripts/pair-qr/`)
- `deploy/hetzner/bootstrap.sh` (modify): accept the tunnel token and setup mode from cloud-init,
  delete user-data after first boot
- `deploy/hetzner/cloud-init.example.yml` (new)
- `docs/GETTING_STARTED.md` (modify): a new first section "The easy way", pointing at the
  installer; the manual path stays as the fallback
- `docs/IMPLEMENTATION_PLAN.md`: §3.10 and a phase 10 row

## Acceptance

- A new person with only an email and a Hetzner token, and no terminal, reaches a working setup
  wizard behind Access within ten minutes of signing up.
- The KV store holds no token of any kind after a full run, verified by a test that dumps it.
- Every wizard step passes against fixtures with the provider mocked, and re-runs cleanly.
- The installer's payload builder never includes a token in a place other than `cxw.env`, the
  deploy key path, or the Tailscale command, verified by a test.
- The manual path in the guide still works unchanged.

## Estimate

1.5 days after phase 8 lands. Needs Alfonso once, to test on his own accounts.
