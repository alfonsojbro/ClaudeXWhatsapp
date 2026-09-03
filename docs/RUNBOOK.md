# ClaudeXWhatsapp — Runbook

Phase 0 operations: create the box, bootstrap it, log Claude Code in, back up, restore.
All commands assume the Mac has the Tailscale client and `hcloud` CLI installed (`brew install hcloud`).

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

```bash
ssh root@cxw 'sudo -u cxw -H git clone https://github.com/<you>/ClaudeXWhatsapp.git /srv/cxw/repo && cd /srv/cxw/repo && sudo -u cxw -H pnpm install --frozen-lockfile'
```

Fill in the two env files (root-owned, 0600, placeholders were created by bootstrap):

```bash
ssh root@cxw 'nano /srv/cxw/cxw.env; nano /srv/cxw/restic.env'
```

Re-run bootstrap from the clone to install the units and start services and timers:

```bash
ssh root@cxw 'bash /srv/cxw/repo/deploy/hetzner/bootstrap.sh'
```

## 4. Log Claude Code in (subscription first, API key fallback)

Claude Code runs as user `cxw`. Log in with the Max subscription using the device flow:

```bash
ssh root@cxw 'sudo -u cxw -H claude auth login'
```

Open the printed URL on the Mac, approve, paste the code back. Check:

```bash
ssh root@cxw 'sudo -u cxw -H claude auth status'
```

For headless services a long-lived token is more robust than the interactive login. Generate one
and paste it into `/srv/cxw/cxw.env` as `CLAUDE_CODE_OAUTH_TOKEN`:

```bash
ssh root@cxw 'sudo -u cxw -H claude setup-token'
```

Fallback: set `ANTHROPIC_API_KEY` in `/srv/cxw/cxw.env` and leave `CLAUDE_CODE_OAUTH_TOKEN` empty.
Set a monthly spend limit on the key in the Anthropic Console. Verify Anthropic's current terms
for subscription use in headless mode before relying on it. Acceptance check:

```bash
ssh root@cxw 'sudo -u cxw -H claude -p "hi"'
```

A one-line reply means auth works. `Invalid API key` or `Not logged in` means step 4 failed.

## 5. Backups: restic to the Storage Box

On the box as root, create a key for the Storage Box and register it:

```bash
ssh root@cxw 'ssh-keygen -t ed25519 -N "" -f /root/.ssh/storagebox_ed25519 && cat /root/.ssh/storagebox_ed25519.pub'
```

Paste the public key into Robot → Storage Box → SSH keys (or `ssh-copy-id -p 23 -i ... uXXXXXX@uXXXXXX.your-storagebox.de`).
Add the host entry from `deploy/hetzner/restic.env.example` to `/root/.ssh/config`, then test:

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

Update the code:

```bash
ssh root@cxw 'cd /srv/cxw/repo && sudo -u cxw -H git pull --ff-only && sudo -u cxw -H pnpm install --frozen-lockfile && systemctl restart cxw-bridge cxw-brain cxw-scheduler'
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
