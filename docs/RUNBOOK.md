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

## 8. Google OAuth (Phase 4)

The box never runs a browser. You authorise once on the Mac, and copy the resulting
refresh token to `/srv/cxw/google.env`.

### 8.1 Google Cloud, once

1. <https://console.cloud.google.com> → create a project (e.g. `cxw-assistant`).
2. **APIs & Services → Library** → enable **Gmail API**, **Google Calendar API**,
   **People API**.
3. **APIs & Services → OAuth consent screen** → User type **External** → fill in app
   name and your own e-mail → add yourself under **Test users**.
4. **Publish the consent screen to Production.** This matters. An unverified app is
   fine for one personal account (you will click through a "Google hasn't verified
   this app" warning once), but while the screen stays in **Testing** Google expires
   refresh tokens **after 7 days**, and the assistant silently loses Gmail and
   Calendar until you notice. Production tokens do not expire on a timer.
5. **Credentials → Create credentials → OAuth client ID → Application type: Desktop
   app** → download the JSON (`client_secret_….json`).

Scopes requested (exactly three, see `mcp/google/src/scopes.ts`):
`gmail.modify`, `calendar`, `contacts.readonly`.

### 8.2 Authorise on the Mac

```bash
pnpm google:auth --client-secret ~/Downloads/client_secret_XXXX.json
```

It opens the consent screen, catches the callback on `127.0.0.1`, and writes
`./google.env` with mode `0600` (`--out <file>` to change it, `--force` to overwrite,
`--no-open` to print the URL instead of opening a browser).

If it reports "Google returned no refresh token": revoke the app at
<https://myaccount.google.com/permissions> and run it again.

### 8.3 Copy it to the box

```bash
scp google.env root@cxw:/srv/cxw/google.env
ssh root@cxw 'chown root:root /srv/cxw/google.env && chmod 0600 /srv/cxw/google.env && systemctl restart cxw-brain'
```

`cxw-brain.service` reads it with `EnvironmentFile=-/srv/cxw/google.env` (the dash
makes it optional, so the brain still starts before Phase 4 is deployed).

### 8.4 Verify

```bash
ssh root@cxw 'set -a; . /srv/cxw/google.env; set +a; cd /srv/cxw/repo && sudo -u cxw -H pnpm --filter @cxw/mcp-google token-check'
```

`{"ok": true, …}` and exit 0. Exit 1 means the token is dead, exit 2 means the file is
incomplete. `monitor.sh` runs the same check every 10 minutes once `google.env` exists.

### 8.5 Rotate or revoke

Re-run 8.2, replace the file as in 8.3, restart `cxw-brain`. To revoke entirely:
<https://myaccount.google.com/permissions>, then delete `/srv/cxw/google.env`.

### 8.6 Phase 4 acceptance checklist

- [ ] `pnpm --filter @cxw/mcp-google token-check` prints `"ok": true` on the box.
- [ ] "What's on tomorrow?" answers from the real calendar.
- [ ] "Reply to Ana's mail: I'll be there" returns a preview plus a token and sends
      nothing; `yes <TOKEN>` sends it; the same token a second time is refused.
- [ ] An event with an outside attendee asks before inviting; one with only you does not.
- [ ] `monitor.sh` still prints `ok`.
