# ClaudeXWhatsapp — Runbook

Phase 0 operations: create the box, bootstrap it, log Claude Code in, back up, restore.
All commands assume the Mac has the Tailscale client and `hcloud` CLI installed (`brew install hcloud`).

## 0. Box bootstrap (manual checklist)

Every step below is run by hand, once, by Alfonso. CI does none of it and no script here runs it
for you. Work top to bottom. Each item points at the section with the exact commands.

1. [ ] Create the Hetzner **CX33** in `fsn1`, image Ubuntu 24.04, name `cxw`, with your SSH key. → §1
2. [ ] Create the Hetzner **Cloud firewall** `cxw-fw`. Allow inbound `41641/udp` only, plus a
   temporary `22/tcp` from your current IP. Apply it to the server. → §1
3. [ ] Create the **Storage Box** (BX11) in Robot and enable SSH support. Note the `uXXXXXX` user
   and the `uXXXXXX.your-storagebox.de` host. → §1
4. [ ] Copy `deploy/hetzner` to the box over the public IP with `scp`. → §2
5. [ ] Get a **Tailscale** auth key from the admin console, then run `bootstrap.sh` as root with
   `TS_AUTHKEY=...` and `CXW_TIMEZONE=Europe/Prague`. Without the key the script prints a login
   URL: open it, approve the machine, re-run. The script is idempotent. → §2
   This run enables the app services before their env files exist. If the box reboots before you
   reach step 15 (bootstrap also enables unattended upgrades, 04:30), they start with placeholder
   values and latch into `failed`. That is recoverable with `systemctl reset-failed`, not a
   problem, but do not be surprised by it.
6. [ ] Confirm Tailscale is up and **ufw** is correct: default deny incoming, SSH allowed only on
   `tailscale0`, `41641/udp` open. Then confirm `ssh root@cxw` works over Tailscale. → §2
7. [ ] Confirm the public SSH port is dead (`nc -vz <PUBLIC_IP> 22` must fail), then **delete the
   temporary 22/tcp rule** from the Hetzner Cloud firewall. From here on Tailscale is the only
   way in. → §2
8. [ ] Confirm the runtime: `node -v` is 22.x, `pnpm -v` is 10.x, `claude --version` prints. The
   bootstrap script installs all three. → §7
9. [ ] Generate the **deploy key** as user `cxw` at `/home/cxw/.ssh/cxw_deploy` (0600, owned by
   `cxw`), then register the public half at GitHub → repo → Settings → Deploy keys with **Allow
   write access** ticked. The box pushes vault commits, so read-only will not do. → §3
10. [ ] Add github.com to `/home/cxw/.ssh/known_hosts` with `ssh-keyscan`. Skip this and the clone
    fails on host key verification, because a non-interactive `ssh` has no terminal to ask on. → §3
11. [ ] Clone the repo to `/srv/cxw/repo` **as user `cxw`** over SSH with that key, set
    `core.sshCommand` on the clone, and run `pnpm install --frozen-lockfile`. → §3
12. [ ] Fill in `/srv/cxw/cxw.env` and `/srv/cxw/restic.env`. Both are root-owned and 0600.
    Bootstrap left placeholders. Use `ssh -t`, since an editor needs a terminal. → §3
13. [ ] Log **Claude Code** in as user `cxw` with the Max subscription device flow (`ssh -t`), then
    generate a long-lived token with `claude setup-token` and paste it into `/srv/cxw/cxw.env` as
    `CLAUDE_CODE_OAUTH_TOKEN`. Headless services need the token, not the interactive session.
    Fallback is `ANTHROPIC_API_KEY` with a monthly spend limit set in the Console. → §4
14. [ ] Verify auth: `claude -p "hi"` as `cxw` must answer in one line. → §4
15. [ ] **Only now** re-run `bootstrap.sh` from the clone to install the systemd units and start the
    services and timers. Starting them earlier, with a placeholder token, crash-loops `cxw-brain`
    into `failed` and then needs `systemctl reset-failed`. → §4
16. [ ] Create the **Storage Box SSH key** at `/root/.ssh/storagebox_ed25519`, register the public
    half in Robot → Storage Box → SSH keys, add the host block from `restic.env.example` to
    `/root/.ssh/config`, add the box to `/root/.ssh/known_hosts`, and prove it with
    `ssh -p 23 storagebox mkdir -p cxw`. → §5
17. [ ] Run the first **restic** backup by hand and confirm `cxw-backup.timer` is active. → §5
18. [ ] **Test the restore.** Restore `latest` into a scratch folder and diff it against live data.
    A backup nobody has restored is not a backup. → §5
19. [ ] Run `monitor.sh` once and read `/srv/cxw/state/monitor.status`. → §6
20. [ ] Walk §7 and tick every acceptance box.

Two notes on keys. The deploy key sits under `/home/cxw/.ssh/`, not `/root/.ssh/`, because git
runs as the service user `cxw` and that user must read it. The plan doc §3.7 still says
`/root/.ssh/cxw_deploy`; that path cannot work for a repo cloned and pushed by `cxw`. The Storage
Box key is the opposite: restic runs as root, so it stays at `/root/.ssh/`. Never put either key
in the repo.

Anything interactive needs `ssh -t`. That covers the editor in step 12 and both Claude Code login
commands in step 13. Without a terminal they fail in confusing ways.

## 1. Create the Hetzner box (CX33, fsn1)

Console: Cloud → project → Servers → Add server. Location **Falkenstein (fsn1)**, image **Ubuntu 24.04**,
type **CX33** (4 vCPU / 8 GB / 80 GB), your SSH key, name `cxw`. Or with the CLI:

```bash
hcloud context create cxw
```

```bash
hcloud ssh-key create --name mac --public-key-from-file ~/.ssh/id_ed25519.pub
```

```bash
hcloud server create --name cxw --type cx33 --image ubuntu-24.04 --location fsn1 --ssh-key mac
```

Add a Hetzner Cloud firewall as the second layer (ufw is the first). Allow inbound only
`41641/udp` (Tailscale) and, until Tailscale is up, `22/tcp` from your current IP. Remove the
22/tcp rule after step 2.

```bash
hcloud firewall create --name cxw-fw && hcloud firewall add-rule cxw-fw --direction in --protocol udp --port 41641 --source-ips 0.0.0.0/0 --source-ips ::/0 && hcloud firewall apply-to-resource cxw-fw --type server --server cxw
```

Create the **Storage Box** (BX11, 1 TB is the smallest) in Robot → Storage Boxes. Enable SSH
support. Note the user `uXXXXXX` and host `uXXXXXX.your-storagebox.de`.

## 2. Bootstrap

Copy the repo's deploy folder to the box over the public IP once, then run bootstrap as root:

```bash
scp -r deploy/hetzner root@<PUBLIC_IP>:/root/hetzner
```

```bash
ssh root@<PUBLIC_IP> 'TS_AUTHKEY=<tailscale-auth-key> CXW_TIMEZONE=Europe/Prague bash /root/hetzner/bootstrap.sh'
```

Without `TS_AUTHKEY` the script prints a Tailscale login URL. Open it, approve, re-run the script.
The script is idempotent and ends by printing the Tailscale IP. From now on connect only via Tailscale:

```bash
ssh root@cxw
```

Then verify the public SSH port is closed and Tailscale is the only way in:

```bash
nc -vz -w 3 <PUBLIC_IP> 22 || echo "public 22 closed: OK"
```

```bash
ssh root@cxw 'ufw status verbose && tailscale status'
```

Remove the temporary 22/tcp rule from the Hetzner Cloud firewall now.

## 3. Clone the repo and install

The box uses a read-write **deploy key** scoped to this one private repo. No personal GitHub token on the box.

```bash
ssh root@cxw 'sudo -u cxw -H ssh-keygen -t ed25519 -N "" -f /home/cxw/.ssh/cxw_deploy -C cxw-deploy && cat /home/cxw/.ssh/cxw_deploy.pub'
```

Paste the public key at GitHub → repo → Settings → Deploy keys, tick "Allow write access" (the box pushes vault commits).

Trust github.com first. Without this the clone dies with `Host key verification failed`: `ssh host 'cmd'`
gives no terminal, so ssh cannot ask the operator to confirm the fingerprint.

```bash
ssh root@cxw 'sudo -u cxw -H sh -c "ssh-keyscan github.com >> /home/cxw/.ssh/known_hosts"'
```

Then clone as `cxw`:

```bash
ssh root@cxw 'sudo -u cxw -H env GIT_SSH_COMMAND="ssh -i /home/cxw/.ssh/cxw_deploy -o IdentitiesOnly=yes" git clone git@github.com:<you>/ClaudeXWhatsapp.git /srv/cxw/repo && sudo -u cxw -H git -C /srv/cxw/repo config core.sshCommand "ssh -i /home/cxw/.ssh/cxw_deploy -o IdentitiesOnly=yes" && sudo -u cxw -H pnpm --dir /srv/cxw/repo install --frozen-lockfile'
```

Fill in the two env files (root-owned, 0600, placeholders were created by bootstrap):

```bash
ssh -t root@cxw 'nano /srv/cxw/cxw.env; nano /srv/cxw/restic.env'
```

Leave `CLAUDE_CODE_OAUTH_TOKEN` for now; §4 generates it. **Do not re-run bootstrap yet.**
Bootstrap starts `cxw-brain`, and a brain started with a placeholder token crash-loops until it
hits `StartLimitBurst` and latches into `failed`. Finish §4 first.

## 4. Log Claude Code in (subscription first, API key fallback)

Claude Code runs as user `cxw`. Log in with the Max subscription using the device flow:

```bash
ssh -t root@cxw 'sudo -u cxw -H claude auth login'
```

Open the printed URL on the Mac, approve, paste the code back. Check:

```bash
ssh root@cxw 'sudo -u cxw -H claude auth status'
```

For headless services a long-lived token is more robust than the interactive login. Generate one
and paste it into `/srv/cxw/cxw.env` as `CLAUDE_CODE_OAUTH_TOKEN`:

```bash
ssh -t root@cxw 'sudo -u cxw -H claude setup-token'
```

Fallback: set `ANTHROPIC_API_KEY` in `/srv/cxw/cxw.env` and leave `CLAUDE_CODE_OAUTH_TOKEN` empty.
Set a monthly spend limit on the key in the Anthropic Console. Verify Anthropic's current terms
for subscription use in headless mode before relying on it. Acceptance check:

```bash
ssh root@cxw 'sudo -u cxw -H claude -p "hi"'
```

A one-line reply means auth works. `Invalid API key` or `Not logged in` means step 4 failed.

Now that `/srv/cxw/cxw.env` is complete, re-run bootstrap from the clone to install the systemd
units and start the services and timers:

```bash
ssh root@cxw 'bash /srv/cxw/repo/deploy/hetzner/bootstrap.sh'
```

If a unit already latched into `failed` from an earlier run with placeholder values, clear the
counter before restarting it. A plain `systemctl restart` answers "start request repeated too
quickly" and does nothing:

```bash
ssh root@cxw 'systemctl reset-failed cxw-brain cxw-bridge cxw-scheduler && systemctl restart cxw-brain cxw-bridge cxw-scheduler'
```

## 5. Backups: restic to the Storage Box

On the box as root, create a key for the Storage Box and register it:

```bash
ssh root@cxw 'ssh-keygen -t ed25519 -N "" -f /root/.ssh/storagebox_ed25519 && cat /root/.ssh/storagebox_ed25519.pub'
```

Paste the public key into Robot → Storage Box → SSH keys (or `ssh-copy-id -p 23 -i ... uXXXXXX@uXXXXXX.your-storagebox.de`).
Add the host entry from `deploy/hetzner/restic.env.example` to `/root/.ssh/config`.

The Storage Box host key has the same no-terminal problem as github.com, so accept it explicitly.
Both this and the github.com keyscan are trust-on-first-use: they record whatever key answers,
without checking it against a published fingerprint.

```bash
ssh root@cxw 'ssh-keyscan -p 23 uXXXXXX.your-storagebox.de >> /root/.ssh/known_hosts'
```

Then test:

```bash
ssh root@cxw 'ssh -p 23 storagebox mkdir -p cxw && echo storagebox OK'
```

Run the first backup by hand and check the timer:

```bash
ssh root@cxw '/srv/cxw/repo/deploy/hetzner/backup.sh && systemctl list-timers cxw-backup.timer --no-pager'
```

### Test a restore (acceptance)

Restore `latest` into a scratch folder, check the SQLite integrity lines, compare with live data:

```bash
ssh root@cxw '/srv/cxw/repo/deploy/hetzner/restore.sh latest'
```

```bash
ssh root@cxw 'd=$(ls -d /srv/cxw/backups/restore-* | tail -n1); diff -rq $d/srv/cxw/data /srv/cxw/data && echo "restore matches live data"; rm -rf $d'
```

A real in-place restore (stops services, keeps the old data under `backups/pre-restore-*`):

```bash
ssh -t root@cxw '/srv/cxw/repo/deploy/hetzner/restore.sh latest --in-place'
```

## 6. Day-to-day

```bash
ssh root@cxw 'systemctl status cxw-bridge cxw-brain cxw-scheduler --no-pager'
```

```bash
ssh root@cxw 'journalctl -u cxw-brain -f'
```

```bash
ssh root@cxw '/srv/cxw/repo/deploy/hetzner/monitor.sh; cat /srv/cxw/state/monitor.status'
```

Update the code (pull `--ff-only`, install, restart):

```bash
ssh root@cxw '/srv/cxw/repo/deploy/hetzner/update.sh'
```

## 7. Phase 0 acceptance checklist

- [ ] `ssh root@cxw` works over Tailscale; `nc <PUBLIC_IP> 22` is refused.
- [ ] `ufw status` shows default deny incoming, allow only on `tailscale0` port 22 and `41641/udp`.
- [ ] `node -v` is 22.x, `pnpm -v` is 10.x, `claude --version` prints.
- [ ] `sudo -u cxw -H claude -p "hi"` answers.
- [ ] `backup.sh` completes; `restic snapshots` lists one snapshot; `cxw-backup.timer` is active.
- [ ] `restore.sh latest` restores to a scratch folder and the diff against live data is empty.
- [ ] `monitor.sh` prints `ok` (or lists only "bridge /health" until Phase 1).

---

## 8. Testing the installer on your own accounts

**Nothing in the test suite creates a real resource.** Every Cloudflare, Hetzner and Google call in
`apps/installer` and `apps/console/src/setup` takes an injected `fetchImpl` and is mocked. This
section is the only place real servers, tunnels, DNS records, Access applications and API tokens
are made — and the only place they have to be removed again. Read section 8.6 before you start, so
you know what you will be tearing down.

Budget: about an hour end to end, most of it waiting. Cost: one CX33 for the length of the test
(cents), everything else free.

### 8.0 One-time: the public mirror for the deploy button

The landing page's one-click flow uses Cloudflare's "Deploy to Cloudflare" button, and Cloudflare
clones the repository anonymously. The main repository is private and holds the vault and this
runbook, so only `apps/installer` is mirrored to a small public repository. Do this once.

1. Create an empty **public** repository `alfonsojbro/cxw-installer` on GitHub. No README, no
   licence, no `.gitignore` — the workflow writes everything.
2. Create a fine-grained personal access token at
   <https://github.com/settings/personal-access-tokens/new>:
   - Resource owner: your account. Repository access: **only** `alfonsojbro/cxw-installer`.
   - Permissions: **Contents: Read and write**. Nothing else. Not the main repository.
   - Expiry: 90 days, and put a reminder in the calendar to rotate it.
3. In the **main** repository, Settings → Secrets and variables → Actions → New repository secret:
   name `MIRROR_INSTALLER_TOKEN`, value the token from step 2.
4. Push anything that touches `apps/installer/**` to `main`. The workflow
   `.github/workflows/mirror-installer.yml` runs and the public repository fills up.
5. Check the mirror: it must contain `apps/installer`'s files, a `wrangler.toml` and a README with
   the deploy button, and **nothing else**. If `deploy/`, `docs/`, `vault/` or git history from the
   main repository appears there, stop, take the public repository down, and fix the workflow
   before recreating it.

Until steps 1 and 3 are done the workflow is inert — it fails to authenticate and changes nothing.
No part of this repository becomes public by accident.

### 8.1 Make the two API tokens

**Cloudflare.** <https://dash.cloudflare.com/profile/api-tokens> → Create Token → **Custom token**.

- Permissions, exactly these four:
  - Account · Cloudflare Tunnel · **Edit**
  - Account · Access: Apps and Policies · **Edit**
  - Zone · DNS · **Edit**
  - Zone · Zone · **Read**
- Account resources: the one account. Zone resources: **the one zone you are testing with**, not
  "All zones".
- TTL: one day. You are revoking it at the end of this section anyway.
- Copy the token. Cloudflare shows it once.

**Hetzner.** Cloud Console → **create a new project** called `cxw-installer-test`, so the teardown
cannot touch anything else you run → Security → API tokens → Generate → **Read & Write**. Copy it.

### 8.2 Deploy the installer to Cloudflare Pages

```bash
export PATH=$HOME/.nvm/versions/node/v22.23.2/bin:$PATH
cd ~/ClaudeXWhatsapp
pnpm --filter @cxw/installer build          # tsc into apps/installer/public/assets
pnpm dlx wrangler pages project create cxw-installer --production-branch main
pnpm dlx wrangler pages deploy apps/installer/public \
  --project-name cxw-installer --branch main
```

`wrangler` prints a `*.pages.dev` URL. Open it. If it asks you to log in, run
`pnpm dlx wrangler login` first. There is no environment variable to set and no binding to add:
the Function is stateless by design, and having nothing to bind is the point.

Once the mirror in 8.0 exists you can also test the visitor's route: open the public repository's
README and press the deploy button, which walks you through the same deploy into your own account.

### 8.3 Run it, and what you should see at each step

Fill the first screen: Cloudflare token, domain, your email, Hetzner token, and press
**Generate deploy key**. Add the public half at
`https://github.com/alfonsojbro/ClaudeXWhatsapp/settings/keys` with **write access**, then confirm.

| # | Step | What you should see |
| --- | --- | --- |
| 1 | Zone | The zone id and account id for your domain. A wrong token fails here, with the exact `curl` to try by hand. |
| 2 | Tunnel | A tunnel id. Check it at Zero Trust → Networks → Tunnels: name `cxw`, status *Inactive* until the box boots. |
| 3 | Tunnel config | Ingress `cxw.<domain>` → `http://127.0.0.1:7803`. |
| 4 | DNS | A **proxied** CNAME `cxw` → `<tunnel id>.cfargotunnel.com`. |
| 5 | Access app | Zero Trust → Access → Applications shows `cxw.<domain>`, with an **audience tag**. |
| 6 | Access policy | One Allow policy, one rule: Emails → your address. |
| 7 | cloud-init | A payload preview. Confirm it carries your deploy key path and tunnel token and nothing else. |
| 8 | Firewall + server | Hetzner shows firewall `cxw-fw` with **zero inbound rules**, and a CX33 in `fsn1` going `initializing` → `running`. |
| 9 | Readiness | `pending` for three to five minutes, then `ready`. `ready` means a **302 to your Cloudflare Access login**, not a 200. If it reports 200 the page flags it as a warning — Access is not enforcing, and you should stop and fix step 6. |

Then press **Continue setup**.

### 8.4 The nine wizard screens

You land on `https://cxw.<domain>/setup` and Cloudflare Access asks who you are first. Sign in with
the email from step 6.

| # | Screen | Type | Expect |
| --- | --- | --- | --- |
| 1 | Access login | your email | A one-time code by mail, then the wizard. |
| 2 | Owner | your WhatsApp number, e.g. `+420 123 456 789` | It normalises to digits and moves on. Try `12345` first: it should refuse with "That is 5 digits". |
| 3 | WhatsApp | — | A QR within a few seconds, refreshing about every 20 s. Scan it: WhatsApp → Settings → Linked devices → Link a device. The page flips to *linked* on its own. |
| 4 | Claude | press **Start the Claude sign-in** | A claude.ai link and a short code. Sign in, copy the token back into the box, save. The page must answer only "saved, ending `xxxx`" — **if you ever see the whole token on screen, that is a bug: stop and file it.** |
| 5 | Google | client id, client secret, your Gmail address | Google's consent screen with Gmail, Calendar and Contacts. Approve. You come back to the wizard, connected. |
| 6 | Google production check | tick the box only if the audience page really says *In production* | Leave it unticked once, deliberately, and check the warning appears on the last screen. |
| 7 | Routines | tick one, timezone `Europe/Prague` | Try `Mars/Olympus` first: it must refuse. Then the real zone. |
| 8 | Vault | `git@github.com:you/vault-test.git` | Try a value with a semicolon and a shell command in it first: it must refuse as "characters a git remote never contains". Then the real remote, or skip. |
| 9 | Done | — | A list where anything from an unmerged phase reads "lands with phase N", plus the Google warning from step 6. Press **Finish setup**. |

Immediately afterwards, reload `https://cxw.<domain>/setup`. It must **404**. The wizard is closed
and cannot be re-entered.

### 8.5 The four things worth proving

1. **The Access policy really excludes everyone else.** Open `https://cxw.<domain>/setup` in a
   private window and sign in with a *different* email you control. Cloudflare must refuse before
   the request reaches the box. Then add that address to the policy, retry, confirm it works, and
   **take it off the policy again**.
2. **`/setup/health` is the only thing without Access.**
   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' https://cxw.<domain>/setup/health   # 204
   curl -sS -o /dev/null -w '%{http_code}\n' https://cxw.<domain>/setup          # 302 to Access
   ```
3. **The box shredded its user-data.** Over Tailscale (or Hetzner's console):
   ```bash
   ssh root@cxw 'ls -la /var/lib/cloud/instance/user-data.txt* ; \
     grep -ri "sk-ant\|BEGIN OPENSSH\|cloudflared.*token" /var/lib/cloud/ 2>/dev/null | head'
   ```
   The user-data copy must be gone or zero bytes, and the grep must return nothing. The Hetzner
   console's own "user data" view still shows it — that is Hetzner's copy, not the box's, and it
   goes away with the server.
4. **Nothing secret is in the repository or the vault.**
   ```bash
   ssh root@cxw 'cd /srv/cxw/repo && git status --short && git diff --stat'
   ```
   The only change may be an `enabled:` line in a routine file. If a token, a key or any file under
   `state/` appears, stop and file it.

### 8.6 Tear it all down

In this order, so nothing is left dangling. Do it the same day.

1. **The server, then its firewall** — Hetzner console, project `cxw-installer-test`. The server
   goes first: a firewall still in use will not go.
2. **The tunnel** — Zero Trust → Networks → Tunnels → `cxw` → Delete.
3. **The DNS record** — your zone → DNS → the `cxw` CNAME → Delete.
4. **The Access application** — Zero Trust → Access → Applications → `cxw.<domain>` → Delete. The
   policy goes with it.
5. **The Pages project** — `pnpm dlx wrangler pages project delete cxw-installer`.
6. **The deploy key** — repository → Settings → Deploy keys → the `cxw-installer` key → Delete.
7. **The Tailscale node**, if you used one — admin console → Machines.

Then revoke **both** API tokens:

- Cloudflare: <https://dash.cloudflare.com/profile/api-tokens> → the test token → **Delete**.
- Hetzner: project → Security → API tokens → **Delete**. Then take down the whole
  `cxw-installer-test` project, which guarantees nothing survives it.

Leave the mirror repository and `MIRROR_INSTALLER_TOKEN` in place — they are not test resources.
Rotate that token on its expiry date.

Last check:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://cxw.<domain>/setup/health   # 000 or 530
dig +short cxw.<domain>                                                       # nothing
```

### 8.7 The bring-your-own-server run

Do this once as a second pass, because it is the path anyone without a Hetzner account takes.

1. Run the installer again through step 7, but choose **Bring your own server** instead of the
   Hetzner path. No Hetzner token is asked for and none is needed.
2. **Route A, a new server elsewhere.** Copy the cloud-init document the page shows. Create an
   Ubuntu 24.04 droplet on DigitalOcean (the smallest is fine for this test), paste the document
   into "User data" on the create form, and boot it. Confirm the readiness probe reaches `ready`
   exactly as in 8.3 step 9, and that the wizard behaves identically — it does not know or care
   which provider made the box.
3. **Route B, a server you already have.** On a spare Ubuntu 24.04 box, copy the single command the
   page shows and run it as root over SSH. Confirm before you run it that it does not pipe a
   download into a shell: it must be self-contained, decoding a payload the page built in your
   browser.
4. Confirm there is **no cloud firewall** on either route, and that the page says so rather than
   implying one. Then check the box's own firewall is doing the job:
   ```bash
   ssh root@<box> 'ufw status verbose'    # default deny incoming
   nc -vz <public ip> 22                  # refused, unless you kept SSH open deliberately
   ```
5. Tear down as in 8.6, minus the Hetzner steps, plus the DigitalOcean droplet.

The manual path in `docs/GETTING_STARTED.md` is unchanged by any of this and remains the fallback:
with none of the new cloud-init variables set, `bootstrap.sh` behaves exactly as it did before.
