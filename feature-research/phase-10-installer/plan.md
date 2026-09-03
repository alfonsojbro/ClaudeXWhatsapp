# Plan — Phase 10: Installer and setup wizard

**Date:** 2026-09-03 · **Branch:** `phase-10-installer` (from `origin/main` @ `50b0da4`) · **Author:** orchestrator (Claude)
**Depends on:** phase 0 bootstrap (merged), phase 8 console (landed on `phase-8-console`, **not** merged to main),
the getting-started guide and `scripts/pair-qr/` (on `docs-getting-started`, **not** merged to main).

## Revision history

- **Rev 1 (morning).** Each person deploys the installer to their own Cloudflare account.
- **Rev 2 (evening).** "Hosted model": one site on Alfonso's account, Access one-time-PIN sign-up,
  a KV namespace for per-person progress, `apps/site`.
- **Rev 3 (this document, 2026-09-03).** **Rev 2 is withdrawn.** Alfonso chose rev 1's shape when
  asked directly: `apps/installer`, deployed to **the person's own Cloudflare account**, with **no
  sign-up gate and no stored state of any kind**. Reasons he was given and accepted: it is the
  simplest thing that satisfies the "never stores a token" acceptance test, and a peer session is
  already building the `apps/site` landing page, so keeping out of that package avoids two sessions
  writing one directory. Everywhere below, `apps/installer` supersedes `apps/site`, and the KV
  acceptance item is replaced by the stronger "no storage API is referenced at all".

## Goal

A person who receives the repo sets the whole thing up through a browser: the cloud machine, the
tunnel, WhatsApp, Claude, Google, routines. No terminal. Alfonso's words: "make the onboarding easy
to do through our cloudflare deployment, so they connect everything through an interface" and
"setup even their cloud machine there".

## Two stages, because the box does not exist yet

**Stage A, the installer,** is a static page plus one Pages Function, deployed to the person's own
Cloudflare account. It runs before any server exists. It creates the Hetzner server, the Cloudflare
tunnel, the DNS record and the Access application, then hands over.

**Stage B, the setup wizard,** runs on the box as a mode of the phase 8 console. It appears at
`https://cxw.<their domain>/setup` as soon as the box has booted and the tunnel is up, and walks
through everything that needs the box. When the last step completes, setup mode switches off and the
same address is the console.

## What "phase 8 has not landed" means for this branch

`apps/console` does not exist on `origin/main`. The instruction is to build the wizard as
`apps/console/src/setup/` against phase 8's plan and mark the integration points. Concretely:

- This branch adds `apps/console/package.json`, `tsconfig.json` and `vitest.config.ts` **copied byte
  for byte** from `phase-8-console`, so the later merge sees both branches adding an identical file
  and produces no conflict. It adds no other file that phase 8 already owns.
- The wizard is a **mountable handler**, not a server. `createSetupHandler(deps)` returns
  `(req, res) => Promise<boolean>` (`true` = it handled the request). Phase 8's `server.ts` mounts it
  in two lines. That wiring is integration point **IP-1**.
- So the branch is runnable and testable on its own, it also ships
  `apps/console/src/setup/standalone.ts`, a small `node:http` entry that mounts the handler with real
  Cloudflare Access verification (`src/setup/access-verify.ts`). When phase 8 merges, its
  `access.ts` supersedes `access-verify.ts` and `standalone.ts` is deleted. Integration point **IP-2**.
- `scripts/pair-qr/` is not on main either. The WhatsApp step is written against its documented HTTP
  interface (`127.0.0.1:7899`, `GET /status.json`, `GET /qr.svg`) and is tested against a fake of that
  interface. Integration point **IP-3**.
- `mcp/google/src/auth.ts` is not on main. The wizard needs a different redirect anyway (the console's
  own callback, not phase 4's ephemeral loopback port), so the OAuth code here is genuinely new and
  not a duplicate. Integration point **IP-4** only covers sharing the `google.env` key names.
- `vault/routines/*.md` are not on main. The routines step reads whatever routine files exist and
  renders an empty, explained state when there are none. Integration point **IP-5**.
- `docs/GETTING_STARTED.md` is not on main. The "easy way" section is written to `docs/INSTALLER.md`
  and must be spliced into the guide when `docs-getting-started` merges. Integration point **IP-6**.

Every integration point is marked in the source with a comment beginning `INTEGRATION IP-n:`.

## Stage A: the installer (`apps/installer`)

### Inputs

Each field has a link to the exact page that creates it, and a sentence saying it is used once from
the person's own browser and their own Pages Function and is never stored.

1. Hetzner Cloud API token, read and write, for one project.
2. Tailscale auth key, reusable off, tagged `tag:cxw`. **Optional**, for SSH from day one.
3. Cloudflare API token scoped to this zone: Tunnel write, Access write, DNS write.
4. The domain on that zone, and the email that Access should allow.
5. A GitHub deploy key, generated in the browser (below).

### The deploy key

`src/ssh-key.ts` generates an Ed25519 pair with `crypto.subtle.generateKey({name:'Ed25519'}, …)`,
exports the public half as `ssh-ed25519 <base64> cxw-installer` and the private half as a real
unencrypted OpenSSH private key (`openssh-key-v1` container, PEM-armoured). The page shows the public
half with a link to the repo's deploy-keys page and blocks until the person confirms it is added. The
private half goes only into the cloud-init payload.

The encoders are pure functions and are tested two ways: against a fixed Ed25519 test vector, and by a
round trip that generates a real key and re-parses the emitted blobs.

### Order of operations

Each step renders a progress line, and each has a fallback.

1. `findZone(domain)` → zone id and account id.
2. `createTunnel(name)` with `config_src: 'cloudflare'` → tunnel id and tunnel token.
3. `putTunnelConfig(tunnelId, hostname, 'http://127.0.0.1:7803')` → ingress to the console port.
4. `upsertDnsRecord(zoneId, 'cxw', tunnelId)` → proxied CNAME to `<tunnelId>.cfargotunnel.com`.
5. `createAccessApp(accountId, 'cxw.<domain>')` → application id and **audience tag**.
6. `createAccessPolicy(accountId, appId, email)` → allow that one email.
7. `buildCloudInit(...)` → the user-data document.
8. `createFirewall('cxw-fw')` with **no inbound rules**, then `createServer(...)`: CX33, `fsn1`,
   `ubuntu-24.04`, that firewall, that user-data. Poll `getServer(id)` until `status === 'running'`.
9. Poll `https://cxw.<domain>/setup/health` **through the Pages Function**, not the browser, and
   classify the result (below). Then show one button: "Continue setup". Typical wait: three to five
   minutes.

The audience tag from step 5 and the team name are written into `cxw.env` by cloud-init, so the
console enforces Access on its very first request. There is no window where the wizard is public.

### Readiness, honestly

The wizard is behind Access, so a successful probe is *not* a 200. `classifyHealthProbe` maps:

| Observed | Meaning |
| --- | --- |
| Cloudflare 530 / 1033, or connect error | `pending` — the tunnel is not up yet |
| 302 to `<team>.cloudflareaccess.com` | `ready` — the hostname is live *and* Access is in front |
| 200 from `/setup/health` | `ready` — Access is not enforcing, which the page flags as a warning |
| anything else | `error`, with the status shown |

### Fallbacks

Every API call throws `CloudflareApiError` / `HetznerApiError` carrying a `fallback` string: the exact
`curl` command or the exact dashboard form to fill by hand. A permission mistake never strands the
person. The fallback text is part of the step table in `src/steps.ts` and is asserted by a test that
every step has one.

### Why a Pages Function

The Hetzner and Cloudflare APIs do not answer cross-origin browser requests. The Function is a
stateless forwarder on the person's own account: it takes the token from a request header, forwards
one request, returns the response. It declares no KV, D1, R2, Durable Object or cache binding, sets no
cookie, and logs no body.

### Build

No bundler. `pnpm --filter @cxw/installer build` runs `tsc` into `public/assets/`, and
`public/index.html` imports `./assets/index.js` as an ES module. Browser-facing modules therefore may
not import `node:` builtins, which a test enforces.

## Stage B: the setup wizard (`apps/console/src/setup/`)

Server-rendered HTML from the console package, which has zero dependencies, so escaping and the CSS
tokens are local copies of phase 8's (`--bg --surface --sunk --ink --muted --line --wa --warn --bad`).
Forms work without JavaScript; JavaScript only polls the QR and the pairing state.

Progress lives in `<stateDir>/setup.json` (`CXW_STATE_DIR`, default `/srv/cxw/state`), mode 0600.
Setup mode is on while that file has no `completedAt`, or while the owners file is missing.

1. **Owner.** Their WhatsApp number. `normalizeOwnerNumber` strips `+`, spaces and dashes and rejects
   anything that is not 8–15 digits. Written to `CXW_OWNERS_FILE` as
   `{"owners":["<digits>@s.whatsapp.net"]}`, mode 0600.
2. **WhatsApp.** The live QR as SVG, polled from the pair-qr service and refreshed as WhatsApp
   rotates it. Pairing code as the alternative. Link state comes from `status.json`
   (`starting|waiting|linked|logged-out|gave-up|unavailable`).
3. **Claude.** Runs `claude setup-token` on the box and shows the URL and the one-time code parsed
   from its output. The person signs in on anthropic.com. The token lands in `cxw.env` as
   `CLAUDE_CODE_OAUTH_TOKEN`. API key fallback writes `ANTHROPIC_API_KEY`; neither is ever echoed
   back, the response carries only `{saved:true, last4}`.
4. **Google.** "Connect Google" starts the OAuth flow with `https://cxw.<domain>/setup/google/callback`
   as the redirect and a random `state` nonce held in `setup.json` and checked on return. Scopes match
   phase 4: `gmail.modify`, `calendar`, `contacts.readonly`. The exchange writes `google.env` (mode
   0600) with `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_OWNER_EMAIL`.
   **Production check, stated honestly:** no public Google API reports the consent screen's publishing
   status. The step therefore links straight to the audience page, requires an explicit confirmation
   that it reads "In production", and records `googleConsentConfirmed`. If it is not confirmed, the
   done page carries a standing warning that refresh tokens expire after seven days in Testing.
5. **Routines.** A toggle per routine file and a timezone. Toggling flips only the `enabled:` line in
   the routine's frontmatter, byte-preserving, the same behaviour as phase 5's `setEnabled`. The
   timezone is validated and written to `cxw.env` as `TZ` and `CXW_TZ`.
6. **Vault.** Optional git remote for the vault, using the same deploy key via `core.sshCommand`.
7. **Done.** Setup mode off. Link to the console, and a "what you can do now" list where every item
   carries the phase that provides it; items from unmerged phases render as "lands with phase N", so
   nothing unmerged is promised.

Every step is re-runnable and idempotent, and each has a test that runs it twice.

## Security, stated once

- Tokens typed into the installer are used from the person's browser and their own Pages Function,
  then discarded. The page says so next to each field. Nothing is stored anywhere.
- The cloud-init payload carries the deploy key and the tunnel token. Hetzner shows user-data by
  design; the page says so. Bootstrap shreds the user-data copy after first boot.
- The wizard is behind Access before it exists, because the installer creates the policy and writes
  the audience tag into `cxw.env` before the box boots.
- **The wizard cannot approve a confirm token.** Approval is the owner replying `yes <TOKEN>` in
  WhatsApp, HMAC-bound to a chat JID. A test asserts no file under `src/setup/` references
  `mint`, `consume`, or the confirm secret.
- Nothing from setup is written to the vault or the repo, with two named exceptions the plan itself
  asks for: the `enabled:` frontmatter flip on routine files, and the vault's own git remote config.
  No credential, token or captured content ever lands there. A test asserts the write paths.

## Files touched

**New — `apps/installer` (`@cxw/installer`)**
- `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` (ignores `public/assets`)
- `src/ssh-key.ts` + `.test.ts` — Ed25519 generation and OpenSSH encoding
- `src/cloud-init.ts` + `.test.ts` — `buildCloudInit`, `assertNoSecretLeaks`
- `src/cloud-init.template.yml`
- `src/cloudflare.ts` + `.test.ts` — zone, tunnel, tunnel config, DNS, Access app, Access policy
- `src/hetzner.ts` + `.test.ts` — firewall, server, poll
- `src/health.ts` + `.test.ts` — `classifyHealthProbe`, `pollSetupHealth`
- `src/steps.ts` + `.test.ts` — ordered steps, fallback text, `runInstall`
- `src/redact.ts` + `.test.ts`
- `src/index.ts`
- `src/no-storage.test.ts` — the acceptance scan (storage APIs, `node:` imports in browser modules)
- `functions/api/[[route]].ts` — the stateless forwarder
- `public/index.html`, `public/styles.css`, `public/app.js`
- `README.md` — how to deploy it to your own account

**New — `apps/console/src/setup/` (inside phase 8's package)**
- `apps/console/package.json`, `tsconfig.json`, `vitest.config.ts` — verbatim copies from `phase-8-console`
- `src/setup/state.ts`, `mode.ts`, `router.ts`, `render.ts`, `escape.ts`, `styles.ts`, `envfile.ts`
- `src/setup/access-verify.ts` (IP-2), `src/setup/standalone.ts` (IP-2)
- `src/setup/steps/{owner,whatsapp,claude,google,routines,vault,done}.ts`
- co-located `*.test.ts` for each of the above
- `src/setup/guardrails.test.ts` — no confirm-token surface, no writes outside the allowed paths

**Modified**
- `deploy/hetzner/bootstrap.sh` — accept `CXW_TUNNEL_TOKEN`, `CXW_SETUP_MODE`,
  `CXW_CONSOLE_HOSTNAME`, `CF_ACCESS_TEAM`, `CF_ACCESS_AUD` from cloud-init and merge them into
  `cxw.env`; install cloudflared and register it with `cloudflared service install <token>` (its own
  unit, so no unit file of phase 8's is touched); shred the cloud-init user-data after first boot,
  guarded by a stamp file. Defaults unchanged when none of the new variables are set.
- `deploy/hetzner/cxw.env.example` — one short Phase 10 block (`CXW_SETUP_MODE`). The console block
  belongs to phase 8 and is left alone.
- `docs/RUNBOOK.md` — new section: the exact steps Alfonso runs to test on his own accounts.
- `docs/IMPLEMENTATION_PLAN.md` — `### 3.9 Installer and setup wizard`, and a phase 10 row.

**New — docs**
- `deploy/hetzner/cloud-init.example.yml`
- `docs/INSTALLER.md` — "The easy way", to be spliced into `GETTING_STARTED.md` (IP-6)

**Explicitly not touched:** `apps/site` (a peer session owns it), any existing file under
`apps/console/src/` other than the three scaffolding files, `scripts/pair-qr/`, `mcp/google/`.

## Acceptance

1. A new person with only an email and a Hetzner token, and no terminal, reaches a working setup
   wizard behind Access. Automated: `runInstall` completes the full ordered step list against mocked
   Cloudflare and Hetzner APIs and ends with `classifyHealthProbe` returning `ready`. Manual: the
   RUNBOOK section Alfonso runs on his own accounts.
2. **Nothing is stored.** `src/no-storage.test.ts` scans `functions/`, `public/` and `src/` and fails
   on any reference to `localStorage`, `sessionStorage`, `indexedDB`, `caches.`, `document.cookie`,
   `KVNamespace`, `D1Database`, `R2Bucket` or `DurableObject`.
3. Every wizard step passes against fixtures with the provider mocked, and re-runs cleanly. Each step
   test runs the step twice and asserts the second run is a no-op with the same end state.
4. The payload builder never includes a token anywhere other than `cxw.env`, the deploy key path, or
   the Tailscale command. `assertNoSecretLeaks` is called by `buildCloudInit` itself and tested
   directly with a deliberately leaking template.
5. The manual path in the guide still works unchanged: with none of the new variables set,
   `bootstrap.sh` behaves exactly as before, asserted by a test that reads the script.
6. No confirm-token control exists in the wizard (`guardrails.test.ts`).
7. `pnpm typecheck`, `pnpm lint` and `pnpm test` pass at the repo root.

**No real Cloudflare or Hetzner resources are created by this work.** Both APIs are injected as a
`fetchImpl` and mocked in every test. The only real run is Alfonso's, from the RUNBOOK.

## Estimate

1.5 days. Needs Alfonso once, to test on his own accounts.

---

## Rev 4 (2026-09-03, later) — landing page hand-off and provider neutrality

**Provenance, so it can be corrected:** both changes below reached this session through the peer
session `claudexwhatsapp-c9`, which reports Alfonso decided them in its conversation. They were not
typed to me directly. Everything else in this plan came from Alfonso's own instruction.

### 4.1 A shared landing page hands off to a per-visitor installer

Rev 3 stands unchanged: `apps/installer` is a static page plus a stateless Pages Function that runs
on **the visitor's own Cloudflare account**, with no sign-up, no KV and no stored token. Added on top:
Alfonso hosts one public, static landing page (`apps/site`, **owned by a different session, not this
one**) whose single call to action deploys `apps/installer` into the visitor's own Cloudflare with one
click, then opens it.

**The one-click flow needs the installer in a public repository.** Cloudflare's "Deploy to Cloudflare"
button is a URL of the form `https://deploy.workers.cloudflare.com/?url=<public git repo>`, and
Cloudflare's build step clones that URL anonymously. The main repository is private and holds the
vault, the deploy scripts and the runbook.

**Decision: mirror, do not open the main repository.** A GitHub Action pushes only `apps/installer`
to a small public repository. Reasons: making any part of the main repo public is a one-way door
(history included), the vault and runbook must never be public, and the mirror is reversible by
deleting one repository. Concretely this branch adds `.github/workflows/mirror-installer.yml`,
triggered on pushes to `main` that touch `apps/installer/**`, publishing that subtree to
`alfonsojbro/cxw-installer` with a `wrangler.toml` and a deploy button in its README. The public
repository and the token the Action needs are Alfonso's to create; the workflow is inert until he
does, and the RUNBOOK carries the one-time steps. **This session creates no repository and no token.**

**First screen.** It must assume the visitor arrived from the landing page with no context: one line
saying what is about to happen and roughly how long it takes, then the input fields, each with its
"used once from this page, never stored" note. No preamble, no second explanation of the product.

### 4.2 The assistant is not tied to Hetzner

A "bring your own server" path sits beside the Hetzner one-click.

- `src/providers/types.ts` defines a small `ServerProvider` interface: `id`, `label`,
  `capabilities` (whether it can create a cloud firewall), `createServer(input)` and
  `waitForRunning(id)`. Adding DigitalOcean or Vultr later is one file each, and nothing outside
  `src/providers/` has to change.
- `src/providers/hetzner.ts` wraps the existing client to implement it. The empty-rules firewall stays
  Hetzner-specific; for every other provider `bootstrap.sh`'s ufw default-deny is the firewall, and
  the page says so rather than pretending a cloud firewall exists.
- `src/providers/manual.ts` implements the same interface with no API at all. It offers two routes:
  1. **A new server anywhere.** Show the generated cloud-init user-data with a copy button, to paste
     into any provider's create-server form that accepts cloud-init on Ubuntu 24.04 (DigitalOcean,
     Vultr, Linode, OVH, Scaleway are named on the page as known-good).
  2. **A server that already exists.** One command to run as root over SSH. It is a single
     self-contained line that base64-decodes an embedded payload and runs it. It deliberately does
     **not** curl a script from the internet and pipe it to a shell: the payload carries the person's
     own deploy key and tunnel token, and it is pasted by them into their own session, so nothing is
     fetched from a third party and nothing secret crosses another host. `buildBootstrapCommand(input)`
     produces it from the same inputs as `buildCloudInit`, and `assertNoSecretLeaks` guards it too.
- **Everything after server creation is provider-neutral.** The tunnel, the DNS record, the Access
  application, the readiness probe and the entire Stage B wizard neither know nor care which provider
  made the box. Only steps 8 of the installer's order of operations is provider-specific. A test
  asserts that no module outside `src/providers/` imports `hetzner.ts`.

### 4.3 Additions to Files touched

- `apps/installer/src/providers/types.ts`, `hetzner.ts`, `manual.ts`, and their tests
- `apps/installer/src/bootstrap-command.ts` + test — the SSH one-liner builder
- `apps/installer/wrangler.toml` — so the mirrored repository is deployable as-is
- `.github/workflows/mirror-installer.yml` — the public mirror, inert until Alfonso creates the repo
- `docs/RUNBOOK.md` — one-time mirror setup, and the bring-your-own-server test

### 4.4 Additions to Acceptance

8. The provider interface holds: a test asserts no module outside `src/providers/` imports the
   Hetzner client, and that `manual.ts` satisfies the same interface without any network call.
9. The SSH one-liner and the cloud-init payload are built from the same inputs and both pass
   `assertNoSecretLeaks`.
10. No repository, token or Cloudflare resource is created by this work. The mirror workflow is
    committed but cannot run until Alfonso creates the public repository and its secret.
