# @cxw/installer

The browser installer for ClaudeXWhatsapp. It runs **before any server exists**: it creates
the machine, the Cloudflare tunnel, the DNS record and the Cloudflare Access application,
then hands over to the setup wizard that runs on the box itself.

It is a static page plus **one** Pages Function, deployed to **your own** Cloudflare account.

## It stores nothing

There is no sign-up, no account and no database. The tokens you type are used once, from
your browser and from your own Pages Function, and then they are gone. Concretely:

- no KV namespace, D1 database, R2 bucket, Durable Object or cache binding — `wrangler.toml`
  declares no bindings at all;
- no cookie, no `localStorage`, no `sessionStorage`, no `indexedDB`;
- the Function reads no `env` binding and logs nothing.

`src/no-storage.test.ts` reads every file under `src/`, `functions/` and `public/` and fails
on any of those names, so this is asserted rather than promised.

## Deploy it to your own Cloudflare account

Cloudflare Pages, from this directory:

```
pnpm install
pnpm --filter @cxw/installer build     # tsc → public/assets/
npx wrangler pages deploy public --project-name cxw-installer
```

Or connect the public mirror repository (`alfonsojbro/cxw-installer`) to Cloudflare Pages and
let it build; `wrangler.toml` already points at `public/`.

`public/index.html` loads `./app.js` as a module, and `app.js` imports the compiled entry point
from `./assets/src/index.js`. The `src/` segment is there because the package `tsconfig.json`
uses `rootDir: "."` so it can also typecheck `functions/`.

## What you need before you start

1. A domain that is already a site on your Cloudflare account.
2. A Cloudflare API token with **Zone:Read**, **DNS:Edit**, **Cloudflare Tunnel:Edit** and
   **Access: Apps and Policies:Edit**, scoped to that zone.
3. Either a Hetzner Cloud API token (read and write, one project), **or** any other server —
   see below.
4. Optionally a Tailscale auth key (reusable off, tagged `tag:cxw`) if you want SSH from day one.

## Where the server comes from

Two routes, and everything after the server is identical either way:

- **Hetzner (one click).** One API call creates a firewall with no inbound rules, then a CX33
  in `fsn1` on Ubuntu 24.04 with the payload as user-data.
- **Any other server.** The page shows you the cloud-init payload to paste into any provider's
  "user data" field on Ubuntu 24.04 — DigitalOcean, Vultr, Linode, OVH and Scaleway are known
  to work — or a single root command to run over SSH on a server you already have. That command
  is one line that base64-decodes an embedded payload and runs it; it downloads no script from
  anyone, because the payload carries your own deploy key and tunnel token.

On anything but Hetzner there is no cloud firewall in this installer. The box firewalls itself:
`bootstrap.sh` sets ufw to deny all inbound, allows SSH only over the Tailscale interface, and
the console is reached through the Cloudflare tunnel, which is an outbound connection. The page
says exactly that rather than implying a cloud firewall exists.

## The deploy key

The page generates an Ed25519 pair with WebCrypto, shows you the public half with a link to your
repository's deploy-keys page, and will not continue until you confirm you added it. The private
half goes only into the payload.

## The payload is visible in your provider's console

Hetzner (and most providers) show a server's user-data in their own console by design. The payload
carries the deploy key and the tunnel token, so treat it accordingly: the deploy key is for one
repository and the tunnel token is revocable from the Cloudflare dashboard. `bootstrap.sh` shreds
the on-disk copy on first boot.

## Readiness is not a 200

The wizard is behind Access from its very first request, so a healthy probe is a redirect to
`<team>.cloudflareaccess.com`. A plain `200` means Access is **not** enforcing, and the page
flags that as a warning rather than as success. Cloudflare `530` or error `1033` means the
tunnel has not connected yet.

## Development

```
pnpm --filter @cxw/installer typecheck
pnpm --filter @cxw/installer test
```

No test reaches the network: every API client takes an injected `fetchImpl`, and every clock takes
an injected `sleep`. Nothing here creates a real Cloudflare or Hetzner resource.

## Adding another provider

Write one file in `src/providers/` implementing `ServerProvider` from `src/providers/types.ts`,
and nothing outside that directory changes. A test asserts that no module outside
`src/providers/` imports the Hetzner client.
