# The easy way: set the assistant up from a browser

> **IP-6.** This file is written to be spliced into `docs/GETTING_STARTED.md` when the branch
> `docs-getting-started` merges. It becomes a new section immediately after "2. What you need",
> and the existing manual sections keep their numbering as "the manual path" below it.

There are two ways to get a working assistant.

- **The easy way**, on this page. A web installer creates the server, the tunnel, the DNS record
  and the access policy, then hands you a setup wizard in the browser that links WhatsApp, logs
  Claude in, connects Google, and switches the routines on. No terminal.
- **The manual path**, the rest of the getting-started guide. It still works, it is still
  supported, and it is the fallback whenever anything here does not fit. Nothing on this page
  replaces it. If a step of the installer fails, it prints the exact command or dashboard form
  that does the same thing by hand, and you carry on from the guide.

Use the manual path if you want to understand every moving part, if your provider is unusual, or
if you would rather not paste API tokens into a web page at all.

## 1. What you need before you start

Accounts:

1. **Anthropic.** A Claude Max subscription, or an API key from <https://console.anthropic.com>.
2. **Cloudflare.** One account with one domain on it. The console lives at `cxw.<your domain>`.
3. **A server.** Either a Hetzner Cloud account, or any other provider that runs Ubuntu 24.04,
   or a server you already have.
4. **GitHub.** Access to the repository, so the box can clone it.
5. Optional: **Google Cloud**, for Gmail and Calendar. Optional: **Tailscale**, for SSH.

To hand:

1. A phone with WhatsApp on your own number.
2. About twenty minutes, of which three to five are waiting for the box to boot.

## 2. The five inputs, and the page that creates each one

The installer asks for these, one screen, each field with a link straight to the page that makes
it. Every one of them is used once, from your own browser and your own Cloudflare Pages Function,
and none is stored anywhere.

| Input | Where it comes from |
| --- | --- |
| Cloudflare API token, scoped to your zone: Tunnel write, Access write, DNS write | <https://dash.cloudflare.com/profile/api-tokens> → Create Token → Custom token |
| Your domain, and the email address that should be allowed in | The domain is the zone you added to Cloudflare. The email is yours. |
| Hetzner Cloud API token, read and write, for one project *(only for the Hetzner path)* | Hetzner Cloud Console → your project → Security → API tokens |
| A GitHub deploy key | The installer generates it in your browser. You paste the public half into your repository's Settings → Deploy keys, with write access. |
| Tailscale auth key, reusable off, tagged `tag:cxw`. **Optional** | <https://login.tailscale.com/admin/settings/keys> |

## 3. Two ways to get a server

### 3.1 Hetzner, one click

Give the installer a Hetzner token and it creates the machine for you: a CX33 in `fsn1` on
Ubuntu 24.04, behind a cloud firewall with **no inbound rules at all**. Nothing reaches the box
from the internet except through the Cloudflare tunnel, which dials outward.

### 3.2 Bring your own server

You do not have to use Hetzner, and the assistant is not tied to it. Everything after the machine
exists — the tunnel, the DNS record, the access policy, the setup wizard — is the same either way.

- **A new server anywhere.** The installer shows you the cloud-init document it would have used,
  with a copy button. Paste it into any provider's "user data" box on an Ubuntu 24.04 image.
  DigitalOcean, Vultr, Linode, OVH and Scaleway are known to accept it.
- **A server you already have.** The installer gives you one command to run as root over SSH. It
  is self-contained: it decodes a payload the page built in your browser and runs it. It does
  **not** download a script from the internet and pipe it to a shell, because the payload carries
  your own deploy key and tunnel token and nothing secret should cross a third party.

On any provider other than Hetzner there is no cloud firewall to create, so the box's own `ufw`
default-deny is the firewall. The installer says so on the page rather than implying a firewall
it did not create.

## 4. What the installer does

In order, showing a line per step, each with a fallback if it fails:

1. Finds your Cloudflare zone.
2. Creates a tunnel, and points it at the console port on the box.
3. Adds a proxied `cxw` DNS record for the tunnel.
4. Creates an Access application for `cxw.<your domain>`, and a policy allowing your one email.
5. Builds the cloud-init document that sets the box up on first boot.
6. Creates the server, or hands you the payload for your own (section 3).
7. Waits for `https://cxw.<your domain>/setup/health` to answer, then shows one button.

The Access policy exists **before the box boots**, and the audience tag is written into the box's
configuration by cloud-init. There is no window in which the wizard is public.

Waiting for the box is normally three to five minutes. A successful probe is not a `200`: it is a
redirect to your Cloudflare Access login, which is the page proving Access is in front.

## 5. What the wizard asks

At `https://cxw.<your domain>/setup`, behind your Access login:

1. **Your WhatsApp number.** Only this number can ask the assistant to do anything. Everything
   else — every other chat, every email, every web page — is data, never instructions.
2. **Link WhatsApp.** A QR code that refreshes as WhatsApp rotates it. Scan it with
   WhatsApp → Settings → Linked devices → Link a device.
3. **Log Claude in.** The box runs `claude setup-token`, shows you the sign-in link and code, and
   takes the token you get back. An API key is the fallback.
4. **Connect Gmail and Calendar.** Optional. Skip it and everything else still works.
5. **Routines and your timezone.** Which routines run, and the clock they run on.
6. **Back the vault up to git.** Optional. A private repository for your notes.
7. **Done.** The wizard closes and the same address becomes the console.

Every step can be re-run, and every step but the first can be skipped and done later.

**One thing the wizard deliberately cannot do:** approve anything. When the assistant wants to
send an email or create an event it asks *you in WhatsApp*, and you reply `yes <token>`. There is
no button for that in the browser, on purpose, and a test enforces its absence.

## 6. What is not stored

- **The tokens you type into the installer are not stored anywhere.** They are used from your own
  browser and your own Pages Function, then discarded. The installer declares no KV namespace, no
  D1 database, no R2 bucket and no Durable Object; it sets no cookie and logs no request body. A
  test scans the whole package and fails on any reference to a storage API.
- **There is no sign-up and no account.** The installer runs in your Cloudflare account, not
  anyone else's. Nobody else can see that you ran it.
- **The credentials the box needs live on the box.** `cxw.env` and `google.env`, mode 0600, root
  only. The wizard writes them and never reads them back into a page: after saving, all you are
  ever shown is the last four characters.
- **Nothing from setup goes into your vault or the repository**, with two exceptions the wizard
  tells you about: the `enabled:` line of a routine file, and the vault's own git remote.
- **The cloud-init payload carries your deploy key and tunnel token.** Hetzner shows user-data in
  its console by design; the installer says so on the page, and the box shreds its copy after the
  first boot.

## 7. If something goes wrong

Every installer step carries the exact `curl` command or dashboard form that does the same thing,
so a permissions mistake on a token never strands you. And the whole manual path in this guide
still works: you can stop after the server exists and finish by hand from section 4 onwards.
