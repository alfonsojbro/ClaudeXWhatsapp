# ClaudeXWhatsapp — Runbook

Sections 1–7 are Phase 0: create the box, bootstrap it, log Claude Code in, back up, restore.
Sections 8–18 are Phase 7 operations: install the ops layer, update, pair, restore, rotate
tokens, panic, purge, costs, alerts, chaos, and the common-failures table.
The design behind all of it is in [ARCHITECTURE.md](ARCHITECTURE.md).
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

## 8. Phase 7: install the ops layer

Run `install-ops.sh` once, as root, after `bootstrap.sh` and after the repo is cloned and
`pnpm install` has run. It is idempotent, so re-run it after every change to the units,
`cxw-ctl`, or `ops.env.example`.

```bash
ssh root@cxw '/srv/cxw/repo/deploy/hetzner/install-ops.sh'
```

It installs:

- `/usr/local/bin/cxw-ctl` (0755 root:root) — the only privileged action the `cxw` user gets.
- `/etc/sudoers.d/cxw-ctl` (0440 root:root), validated with `visudo -c` before it is installed.
- `/usr/local/bin/cxw-ops` — a wrapper that runs `tsx apps/ops/src/cli.ts` as the calling user.
- Units `cxw-monitor.service`, `cxw-monitor.timer`, `cxw-purge.service`, `cxw-purge.timer`,
  `cxw-sentinel.service`.
- The missing keys from `deploy/hetzner/ops.env.example`, appended to `/srv/cxw/cxw.env`, plus
  `CXW_ALERT_CMD`. The file stays root:root 0600.
- `/srv/cxw/state` as 0700 `cxw:cxw`.
- `/srv/cxw/google.env` (root:root 0600) if it does not exist yet — a placeholder with
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN` **commented out**.
  `cxw-monitor.service` reads it with `EnvironmentFile=-`, so the empty placeholder is harmless;
  Phase 4 fills it in. An existing file is never overwritten, only re-chowned and re-chmodded.

It then enables and starts `cxw-monitor.timer`, `cxw-purge.timer` and `cxw-sentinel.service`.

The optional secrets (`BRIDGE_TOKEN`, `SMTP_PASS`, `TELEGRAM_BOT_TOKEN`) are appended **empty**,
never with a placeholder value: empty means the feature is off. Fill in the ones you want and set
`SMTP_HOST` if you want the email fallback:

```bash
ssh root@cxw 'nano /srv/cxw/cxw.env'
```

Create the owner allowlist if it does not exist yet. Group JIDs are never owners.

```bash
ssh root@cxw 'printf "{\n  \"owners\": [\"<digits>@s.whatsapp.net\"]\n}\n" > /srv/cxw/state/owners.json && chown cxw:cxw /srv/cxw/state/owners.json'
```

### Verify

```bash
ssh root@cxw '/srv/cxw/repo/deploy/hetzner/security-check.sh'
```

Every line must be PASS or SKIP. A SKIP means the thing does not exist yet (for example, no
MCP send tools before Phase 4).

```bash
ssh root@cxw 'sudo -u cxw -H /usr/local/bin/cxw-ops health'
```

Before Phase 1 and Phase 2 land, `whatsapp` and `brain` fail because no bridge and no brain
run yet. Everything else must be OK.

```bash
ssh root@cxw "systemctl list-timers 'cxw-*' --no-pager"
```

`cxw-monitor.timer`, `cxw-purge.timer` and `cxw-backup.timer` must all be listed with a next
elapse time.

```bash
ssh root@cxw 'systemctl is-active cxw-sentinel'
```

## 9. Update the code

Deploys are pulls. Restart order is bridge → brain → scheduler.

```bash
ssh root@cxw 'cd /srv/cxw/repo && sudo -u cxw -H git pull --ff-only'
```

```bash
ssh root@cxw 'cd /srv/cxw/repo && sudo -u cxw -H pnpm install --frozen-lockfile'
```

```bash
ssh root@cxw 'systemctl restart cxw-bridge && sleep 5 && systemctl restart cxw-brain && sleep 5 && systemctl restart cxw-scheduler'
```

The sentinel runs the ops CLI from the same checkout, so restart it too after a pull:

```bash
ssh root@cxw 'systemctl restart cxw-sentinel'
```

The timers run oneshot units, so they pick up new code on their next tick. Re-run
`install-ops.sh` if the pull changed anything under `deploy/hetzner/systemd/`,
`deploy/hetzner/cxw-ctl` or `deploy/hetzner/ops.env.example`.

```bash
ssh root@cxw 'sudo -u cxw -H /usr/local/bin/cxw-ops health'
```

## 10. Pairing and re-pairing (Phase 1)

The bridge is Phase 1 and is not built yet. The Phase 1 plan defines the pairing flow as:

- `pnpm pair` prints a QR code in the SSH terminal. Scan it from WhatsApp on the phone
  (Settings → Linked devices → Link a device).
- Baileys pairing-code login is the alternative when a QR is impractical.

The Baileys auth state lives in `/srv/cxw/data/session/` and is backed up every 6 hours.

Re-pair after a logout (the phone unlinked the device, or the session was invalidated):

```bash
ssh root@cxw 'systemctl stop cxw-bridge'
```

```bash
ssh root@cxw 'mv /srv/cxw/data/session /srv/cxw/data/session.bad-$(date -u +%Y%m%dT%H%M%SZ)'
```

```bash
ssh -t root@cxw 'cd /srv/cxw/repo && sudo -u cxw -H pnpm pair'
```

```bash
ssh root@cxw 'systemctl start cxw-bridge && sleep 10 && sudo -u cxw -H /usr/local/bin/cxw-ops health'
```

The `whatsapp` check must read `connected`. Message history is not lost: it lives in
`bridge.sqlite`, not in the session folder.

## 11. Restore from restic

Backups run every 6 hours from `cxw-backup.timer` and cover `/srv/cxw/data`,
`/srv/cxw/state`, the `/srv/cxw/*.env` files, and a consistent `.backup` copy of every SQLite
database. `backup.sh` writes `/srv/cxw/state/last-backup` on success; the `backup` health check
reads that marker.

### 11.1 List the snapshots

```bash
ssh root@cxw '/srv/cxw/repo/deploy/hetzner/restore.sh --list'
```

### 11.2 Test restore into a scratch folder (never touches live data)

```bash
ssh root@cxw '/srv/cxw/repo/deploy/hetzner/restore.sh latest'
```

The script prints the restored tree and runs `PRAGMA integrity_check` on every `*.sqlite` it
finds. Every line must say `ok`. Compare with live data, then delete the scratch copy:

```bash
ssh root@cxw 'd=$(ls -d /srv/cxw/backups/restore-* | tail -n1); diff -rq $d/srv/cxw/data /srv/cxw/data | head; rm -rf $d'
```

### 11.3 In-place restore

This stops `cxw-scheduler`, `cxw-brain` and `cxw-bridge`, moves the current `data/` and
`state/` to `/srv/cxw/backups/pre-restore-<ts>-*`, restores both from the snapshot, fixes the
ownership to `cxw:cxw` and mode 0700, and starts the three services again. It asks you to type
`RESTORE` first, so run it on a TTY.

```bash
ssh -t root@cxw '/srv/cxw/repo/deploy/hetzner/restore.sh latest --in-place'
```

Stop the ops units first so nothing writes to `state/` mid-restore, and start them after:

```bash
ssh root@cxw 'systemctl stop cxw-sentinel cxw-monitor.timer cxw-purge.timer'
```

```bash
ssh root@cxw 'systemctl start cxw-sentinel cxw-monitor.timer cxw-purge.timer'
```

### 11.4 What to check after a restore

```bash
ssh root@cxw 'sqlite3 /srv/cxw/data/bridge.sqlite "PRAGMA integrity_check;" && [ -f /srv/cxw/data/ops.sqlite ] && sqlite3 /srv/cxw/data/ops.sqlite "PRAGMA integrity_check;"'
```

`ops.sqlite` is created on demand the first time a model call is recorded, so on a box that has
not billed anything yet the file does not exist. The `[ -f … ]` guard is why the command above
does not error in that case — an absent `ops.sqlite` is normal, not a failed restore.

```bash
ssh root@cxw 'journalctl -u cxw-bridge -n 50 --no-pager'
```

```bash
ssh root@cxw 'sudo -u cxw -H /usr/local/bin/cxw-ops health'
```

- Both integrity checks print `ok`.
- The bridge journal shows WhatsApp reconnecting, not a logout loop.
- `cxw-ops health` shows `whatsapp` connected. `backup` may say the marker is old; it clears on
  the next backup, or run `cxw-ctl backup` by hand.
- Send `status` from an owner number and check the reply.

### 11.5 Session invalid after the restore

An old snapshot can hold a Baileys session the phone has since replaced. The symptom is the
bridge logging out on start and the `whatsapp` check never reaching `connected`. Do not keep
restarting: re-pair as in section 10. The restored `bridge.sqlite` keeps all history.

## 12. Rotate tokens

Every secret lives in one of three root:root 0600 files: `/srv/cxw/cxw.env` (services and ops),
`/srv/cxw/google.env` (Google OAuth, Phase 4), `/srv/cxw/restic.env` (backups). None of them is
in git.

| Secret                        | Lives in              | Keys                                                                                                    | Restart                      |
| ----------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Google refresh token          | `/srv/cxw/google.env` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`                                      | `cxw-brain` (Phase 4)        |
| Claude subscription token     | `/srv/cxw/cxw.env`    | `CLAUDE_CODE_OAUTH_TOKEN`                                                                               | `cxw-brain`, `cxw-scheduler` |
| Anthropic API key             | `/srv/cxw/cxw.env`    | `ANTHROPIC_API_KEY`                                                                                     | `cxw-brain`, `cxw-scheduler` |
| SMTP (email alerts)           | `/srv/cxw/cxw.env`    | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO` | none                         |
| Telegram (last-resort alerts) | `/srv/cxw/cxw.env`    | `TELEGRAM_ALERTS`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`                                             | none                         |
| Bridge token                  | `/srv/cxw/cxw.env`    | `BRIDGE_TOKEN`                                                                                          | `cxw-bridge`, `cxw-sentinel` |
| restic repository password    | `/srv/cxw/restic.env` | `RESTIC_PASSWORD`                                                                                       | none                         |

"none" means the consumer is a oneshot unit (`cxw-monitor.service`, `cxw-purge.service`) that
reads `EnvironmentFile` on every run.

After editing any env file, re-assert the mode:

```bash
ssh root@cxw 'chown root:root /srv/cxw/*.env && chmod 0600 /srv/cxw/*.env && /srv/cxw/repo/deploy/hetzner/security-check.sh'
```

### 12.1 Google refresh token (Phase 4)

Re-run the Google OAuth consent flow, take the new refresh token, and replace
`GOOGLE_REFRESH_TOKEN` in `/srv/cxw/google.env`. Then prove it:

```bash
ssh root@cxw 'nano /srv/cxw/google.env'
```

```bash
ssh root@cxw 'sudo -u cxw -H /usr/local/bin/cxw-ops health | grep google'
```

The line must read `OK google - refresh token valid`. `cxw-monitor.service` loads
`google.env` with `EnvironmentFile=-`, so it is optional; set `CXW_GOOGLE_CHECK=off` in
`cxw.env` to skip the check entirely before Phase 4 lands.

### 12.2 Claude OAuth token or API key

```bash
ssh root@cxw 'sudo -u cxw -H claude setup-token'
```

Paste the token into `CLAUDE_CODE_OAUTH_TOKEN` in `/srv/cxw/cxw.env`, then:

```bash
ssh root@cxw 'systemctl restart cxw-brain cxw-scheduler && sudo -u cxw -H /usr/local/bin/cxw-ops health | grep claude_auth'
```

The API-key fallback is `ANTHROPIC_API_KEY` with `CLAUDE_CODE_OAUTH_TOKEN` left empty. The
health check accepts either, and falls back to `/home/cxw/.claude/.credentials.json` when
neither is set.

### 12.3 SMTP, Telegram and BRIDGE_TOKEN

Edit `/srv/cxw/cxw.env`, then prove the alert chain still works (section 16):

```bash
ssh root@cxw 'sudo -u cxw -H /usr/local/bin/cxw-ops alert-test "rotation test"'
```

`BRIDGE_TOKEN` is shared with the bridge, so change it in both places at once and restart
`cxw-bridge` and `cxw-sentinel`.

### 12.4 restic password

Never overwrite `RESTIC_PASSWORD` alone: the repository is encrypted with the old key and would
become unreadable. Add a new key, verify it, remove the old one, then update the env file.

```bash
ssh root@cxw 'set -a; . /srv/cxw/restic.env; set +a; restic key list'
```

```bash
ssh root@cxw 'set -a; . /srv/cxw/restic.env; set +a; restic key add'
```

Put the new password into `RESTIC_PASSWORD` in `/srv/cxw/restic.env`, confirm it reads the
repository, then remove the old key id from the `restic key list` output:

```bash
ssh root@cxw 'set -a; . /srv/cxw/restic.env; set +a; restic snapshots --tag cxw --latest 1'
```

```bash
ssh root@cxw 'set -a; . /srv/cxw/restic.env; set +a; restic key remove <old-key-id>'
```

Then run a backup by hand and check the marker moves:

```bash
ssh root@cxw 'systemctl start cxw-backup.service && cat /srv/cxw/state/last-backup'
```

## 13. Panic and resume

Panic stops the two things that can act: the scheduler and the brain. Nothing that only
observes is stopped.

| Keeps running                                              | Stops           |
| ---------------------------------------------------------- | --------------- |
| `cxw-bridge` (WhatsApp stays linked, messages stored)      | `cxw-brain`     |
| `cxw-sentinel` (so `resume` still works)                   | `cxw-scheduler` |
| `cxw-monitor.timer`, `cxw-purge.timer`, `cxw-backup.timer` | —               |

### 13.1 From WhatsApp

Send `panic` (or `/panic`) from an owner number. The reply is:

```
🛑 Panic: scheduler and brain stopping. Send `resume` to restart.
```

The ack is returned first and the stop runs one second later, so the message still gets out
before the brain goes down. `resume` replies `▶️ Resumed.`

Two paths handle the word, and they never double-fire:

1. **Brain path** — the brain router calls `handleOpsCommand()` before any LLM call.
2. **Sentinel path** — `cxw-sentinel` polls `bridge.sqlite` every 5 seconds for a message whose
   text is exactly `panic` or `resume`, and runs the kill switch itself. This is the path that
   works when the brain is dead or hung. It never calls an LLM.

   A row qualifies only if the **sender is an owner**, or the message is yours (`from_me = 1`)
   **in an owner chat** — in practice your own self-chat. Sending the word "panic" to a friend
   or into a group therefore does nothing. That matches the brain path, which is gated on
   `isOwner` too.

   The kill-switch action always runs even if the acknowledgement cannot be delivered: a bridge
   that records messages but cannot send (rate limit, 5xx, daily cap) must not turn the kill
   switch into a no-op. An undelivered ack is logged, and the failure is re-alerted through the
   alert chain.

Both mark the message id as handled in `/srv/cxw/state/sentinel.json`, so whichever gets there
first wins. The sentinel re-reads that file at the top of every 5-second poll instead of trusting
what it loaded at boot — a long-running sentinel would otherwise never see the ids the brain
wrote, and you would get the kill switch and the ack twice. The sentinel starts from "now" on boot
and never replays history.

### 13.2 From SSH

```bash
ssh root@cxw 'sudo -u cxw -H /usr/local/bin/cxw-ops panic "reason here"'
```

```bash
ssh root@cxw 'sudo -u cxw -H /usr/local/bin/cxw-ops resume'
```

### 13.3 The panic flag

`/srv/cxw/state/panic` is a JSON file holding `since`, `by` and `reason`. While it exists:

- The `brain` health check reports `panic mode, expected down`, emits no `restart brain` heal,
  and is excluded from alerting.
- `monitor.sh` refuses the `restart brain` heal even if it somehow sees the line.
- `getPauseState()` returns `{ paused: true, reasons: ['panic'] }`, so the scheduler (Phase 5)
  runs only its essential routines.

`resume` deletes the flag and starts brain then scheduler. If a `panic` was left on by
accident, `resume` is the only correct fix — do not delete the file by hand, or the services
stay stopped.

```bash
ssh root@cxw 'cat /srv/cxw/state/panic 2>/dev/null || echo "no panic flag"'
```

## 14. Purge and retention

Defaults: third-party text 180 days, third-party media 90 days, owner chats forever. Owner
chats include your self-chat. Groups count as third-party.

`cxw-purge.timer` runs `cxw-ops purge` daily at 03:30 with `Persistent=true`, so a missed run
catches up after a reboot. The result is written to `/srv/cxw/state/last-purge.json`.

Always dry-run first:

```bash
ssh root@cxw 'sudo -u cxw -H /usr/local/bin/cxw-ops purge --dry-run'
```

It prints one JSON line: `{ dryRun, emergency, textRows, mediaRows, files, bytes, skipped }`. A
dry run changes nothing on disk or in the database. `skipped` counts media rows whose
`media_path` did not resolve inside `MEDIA_DIR`; those files are left alone, and only the count is
logged, never the path.

A purge can also **refuse**. It exits **2**, prints nothing on stdout, and writes
`refusing to purge: owner list is empty (check CXW_OWNERS_FILE)` on stderr — see §14.2. Nothing
is deleted and `last-purge.json` is not rewritten, dry run included. The monitor logs a refusal as
a failed heal and still exits 0, so watch for it in the journal:

```bash
ssh root@cxw 'journalctl -u cxw-monitor.service --since -1d | grep "heal failed: purge"'
```

```bash
ssh root@cxw 'sudo -u cxw -H /usr/local/bin/cxw-ops purge'
```

From WhatsApp, as an owner: `purge`, `purge --dry-run`, `purge --emergency`.

### 14.1 Emergency purge on low disk

`--emergency` deletes only media, using `CXW_PURGE_EMERGENCY_MEDIA_DAYS` (default 14) instead of 90. Text is untouched. The monitor runs it by itself when the `disk` check fails, then also runs
`cxw-ctl vacuum-journal` to trim the journal to 200 MB.

```bash
ssh root@cxw 'sudo -u cxw -H /usr/local/bin/cxw-ops purge --emergency'
```

```bash
ssh root@cxw 'sudo -n /usr/local/bin/cxw-ctl vacuum-journal'
```

### 14.2 The owner-forever caveat

`CXW_RETENTION_OWNER_FOREVER=false` makes owner chats obey the same cutoffs as everyone else.
It is off by default and there is no undo: the next purge deletes your own history and your own
media. Set it only with a verified backup and a dry run first.

```bash
ssh root@cxw 'sudo -u cxw -H CXW_RETENTION_OWNER_FOREVER=false /usr/local/bin/cxw-ops purge --dry-run'
```

Set `CXW_PURGE_VACUUM=true` to run `VACUUM` after a purge. It reclaims file space but locks the
database for the duration, so leave it off unless disk is tight.

## 15. Costs and the monthly cap

Usage is recorded per model call in `/srv/cxw/data/ops.sqlite` (`usage` table). Cost comes from
the caller's `total_cost_usd` when it is supplied, otherwise from the built-in price table,
matched by longest model-id prefix.

The daily line looks like this and is appended by the scheduler to any routine whose
frontmatter has `cost_line: true` (Phase 5 sets it on `evening-close`):

```
💸 Today: $1.23 (12.3k in / 4.5k out, 3 calls) · Month: $23.45 / $100 (23%)
```

```bash
ssh root@cxw 'sudo -u cxw -H /usr/local/bin/cxw-ops costs line'
```

```bash
ssh root@cxw 'sudo -u cxw -H /usr/local/bin/cxw-ops costs month'
```

From WhatsApp: `costs`, `costs today`, `costs month`, `costs unpause`.

### 15.1 Warn and pause

- At `CXW_COST_WARN_PCT` (default 80 %) of `CXW_COST_MONTHLY_CAP_USD` (default 100) the cap
  check reaches the warn level and drops the marker `/srv/cxw/state/cost-warned-<YYYY-MM>`.
- At 100 % it writes `/srv/cxw/state/cost-paused` (`{ since, reason: 'cost-cap', month, total,
cap }`). `getPauseState()` then reports paused, and the scheduler runs only essential
  routines. Chat still works.

**Who tells you.** The monitor tick runs `cxw-ops costs check` after every health run, i.e.
every 10 minutes. That is the call that delivers the warn and the paused message down the alert
chain — once per month per level, guarded by the `cost-warned-<YYYY-MM>` and
`cost-paused-alerted-<YYYY-MM>` markers. Recording usage only evaluates the cap and writes the
pause flag; it never notifies. So a cap crossing reaches you within ten minutes of the call that
crossed it, and never twice.

The marker is written only **after** a channel accepted the message. If WhatsApp, email and
Telegram all fail, no marker is written and the next tick tries again — a dead alert chain can
no longer eat the month's only warning.

```bash
ssh root@cxw 'sudo -u cxw -H /usr/local/bin/cxw-ops costs check'
```

`costs check` always prints exactly one status line, whether or not it notified anybody, so you
can read the cap state at any time:

```
cost: <level> $<total> / $<cap> (<pct>%) — <status>
cost: paused $103.40 / $100 (103%) — already notified this month
```

`<level>` is `ok`, `warn` or `paused`. `<status>` is one of `notified` (this run delivered the
alert), `already notified this month` (the marker exists, nothing sent), `delivery failed` (every
channel refused — no marker written, the next tick retries) or `no alert needed` (below the warn
threshold). When the run did deliver, the owner-facing text is printed on the following line. The
exit code is always 0.

The flag clears by itself when the month changes. To override it for the rest of the month:

```bash
ssh root@cxw 'sudo -u cxw -H /usr/local/bin/cxw-ops costs unpause'
```

### 15.2 Time zone

Days and months are counted in the process time zone. `TZ=Europe/Prague` is set in
`/srv/cxw/cxw.env` and every unit loads it. Running the CLI from a shell with a different `TZ`
gives different day and month boundaries, so always run it through the units or through
`sudo -u cxw -H`.

## 16. Alerts and fallbacks

The monitor runs every 10 minutes from `cxw-monitor.timer`. When a check fails it sends one
alert down a chain, first channel that accepts wins:

1. **WhatsApp** — `POST /send` on the bridge, to `CXW_ALERT_WHATSAPP_JID` or the first owner.
   Skipped when the `whatsapp` check itself is failing. Ops refuses to send to a non-owner JID.
2. **Email** — SMTP through nodemailer. Disabled when `SMTP_HOST` is empty.
3. **Telegram** — only when `TELEGRAM_ALERTS=true`.

Message format:

```
🚨 cxw: whatsapp FAILING since 2026-09-03T04:10:00.000Z — bridge not connected
✅ cxw: whatsapp recovered after 22m
```

Set `CXW_ALERT_TRANSPORT=log` to print `[alert:<channel>] …` on stdout instead of sending. That
is what the tests and the local chaos run use. Never leave it set on the box.

Prove the chain end to end:

```bash
ssh root@cxw 'sudo -u cxw -H /usr/local/bin/cxw-ops alert-test "runbook check, ignore"'
```

Exit 0 means at least one channel accepted the message. Exit 1 means no channel is configured
or every one failed — check `SMTP_HOST` and `TELEGRAM_ALERTS`.

### 16.1 Repeat interval and dedupe

Alert state lives in `/srv/cxw/state/alerts.json`. A check that keeps failing alerts once, then
again only after `CXW_ALERT_REPEAT_MIN` minutes (default 240). `CXW_ALERT_AFTER_FAILURES`
(default 1) sets how many consecutive failures come before the first alert. A recovery message
is sent once, and only if an alert was actually sent for that outage.

### 16.2 The heal budget

`monitor.sh` self-heals: `restart bridge`, `restart brain`, `purge --emergency` (plus
`vacuum-journal`), `backup`. Each action is allowed at most 3 times per rolling hour, counted in
`/srv/cxw/state/restart-budget.log` as `<epoch> <action>` lines. When an action's budget is
exhausted the monitor stops healing it and alerts `heal budget exhausted for <action>` instead.
That message means the automation gave up and you must look yourself.

```bash
ssh root@cxw 'cat /srv/cxw/state/restart-budget.log'
```

After each heal the monitor waits `CXW_HEAL_RECHECK_S` (default 20) seconds and re-runs
`cxw-ops health --no-alert` to log the outcome. It always exits 0, so the timer never goes into
a failed state; read `/srv/cxw/state/monitor.status` and the journal for the result.

```bash
ssh root@cxw 'cat /srv/cxw/state/monitor.status; journalctl -u cxw-monitor -n 60 --no-pager'
```

## 17. Chaos test

### 17.1 Local, on the Mac (safe)

No root, no services touched. It creates temp data and state directories, starts three HTTP
stubs (bridge 17801, brain 17802, Google token 17803), points a fake `cxw-ctl` at them, seeds a
throwaway `bridge.sqlite`, and runs six scenarios (baseline, bridge down, Google token,
disk pressure, alert dedupe, monthly cost cap). It prints a Markdown table and removes
everything in a trap on exit.

```bash
bash deploy/hetzner/chaos.sh --local
```

Exit 0 means every scenario passed. The last recorded run is in
[docs/runs/chaos-2026-09-03.md](runs/chaos-2026-09-03.md).

### 17.2 On the box (dangerous)

`--box` breaks the real system: it runs `systemctl kill cxw-bridge`, moves `/srv/cxw/google.env`
aside, and `fallocate`s a file that fills the disk to within 1 GB of full. A trap on exit
restores all three. It refuses to run without `--i-know` and refuses to run as a non-root user.

Do not run it unattended, and take a fresh backup first.

```bash
ssh root@cxw 'systemctl start cxw-backup.service'
```

```bash
ssh -t root@cxw '/srv/cxw/repo/deploy/hetzner/chaos.sh --box --i-know'
```

After it finishes, confirm the box is really back:

```bash
ssh root@cxw 'ls -l /srv/cxw/google.env; ls /srv/cxw/data/chaos.fill 2>/dev/null; systemctl is-active cxw-bridge cxw-brain; sudo -u cxw -H /usr/local/bin/cxw-ops health'
```

`chaos.fill` must be gone, `google.env` must be back at root:root 0600, and both services must
be active.

## 18. Common failures

| Symptom                                            | Check                                                                    | Fix                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| No replies; `FAIL whatsapp - bridge not connected` | `systemctl status cxw-bridge`, `journalctl -u cxw-bridge -n 100`         | `systemctl restart cxw-bridge`. The monitor does this by itself up to 3 times an hour.                                 |
| Bridge restarts in a loop, logs a logout           | `journalctl -u cxw-bridge -n 100`                                        | The session was invalidated. Re-pair (section 10). Do not keep restarting.                                             |
| `FAIL google - token endpoint HTTP 401`            | `cxw-ops health \| grep google`                                          | Rotate `GOOGLE_REFRESH_TOKEN` (section 12.1), or set `CXW_GOOGLE_CHECK=off` until Phase 4 lands.                       |
| `FAIL disk - 9x% used`                             | `df -h /srv/cxw/data`, `du -sh /srv/cxw/data/*`                          | `cxw-ops purge --emergency`, then `cxw-ctl vacuum-journal`. The monitor runs both. If it repeats, raise the disk.      |
| `FAIL backup - Nh old` or `no last-backup marker`  | `systemctl status cxw-backup.service`, `journalctl -u cxw-backup -n 50`  | Storage Box unreachable or restic password wrong. `systemctl start cxw-backup.service` and read the error.             |
| `FAIL claude_auth`                                 | `sudo -u cxw -H claude -p hi`                                            | Re-run `claude setup-token` and update `CLAUDE_CODE_OAUTH_TOKEN` (section 12.2), then restart brain and scheduler.     |
| Routines stopped, chat still works                 | `cat /srv/cxw/state/cost-paused`                                         | The monthly cap was hit. `cxw-ops costs unpause`, or raise `CXW_COST_MONTHLY_CAP_USD`. It clears itself next month.    |
| Nothing runs at all; brain is down and stays down  | `cat /srv/cxw/state/panic`                                               | A `panic` was left on. Send `resume`, or `cxw-ops resume`. Never delete the flag by hand.                              |
| `panic` from WhatsApp does nothing                 | `systemctl is-active cxw-sentinel`, `journalctl -u cxw-sentinel -n 50`   | `systemctl restart cxw-sentinel`. Meanwhile use `cxw-ops panic` over SSH.                                              |
| Heals do nothing; `cxw-ctl: denied` in the journal | `sudo -n /usr/local/bin/cxw-ctl is-active bridge`, `visudo -c`           | Re-run `install-ops.sh`. It reinstalls `cxw-ctl` 0755 and the sudoers file after `visudo -c` passes.                   |
| A check fails but no alert arrives                 | `cxw-ops alert-test "test"`, `cat /srv/cxw/state/alerts.json`            | No channel configured (`SMTP_HOST` empty, Telegram off), or still inside `CXW_ALERT_REPEAT_MIN`. Configure a fallback. |
| Alerts stop and `heal budget exhausted` arrives    | `cat /srv/cxw/state/restart-budget.log`                                  | The automation gave up. Diagnose by hand; the budget window is one hour and clears on its own.                         |
| No health data at all; `health.json` is stale      | `systemctl list-timers 'cxw-*'`, `systemctl status cxw-monitor.timer`    | `systemctl enable --now cxw-monitor.timer`, or re-run `install-ops.sh`.                                                |
| Purge never runs                                   | `systemctl list-timers cxw-purge.timer`, `journalctl -u cxw-purge -n 50` | `systemctl enable --now cxw-purge.timer`. Run `cxw-ops purge --dry-run` to see what it would do.                       |
---

## 19. Testing the installer on your own accounts

**Nothing in the test suite creates a real resource.** Every Cloudflare, Hetzner and Google call in
`apps/installer` and `apps/console/src/setup` takes an injected `fetchImpl` and is mocked. This
section is the only place real servers, tunnels, DNS records, Access applications and API tokens
are made — and the only place they have to be removed again. Read section 8.6 before you start, so
you know what you will be tearing down.

Budget: about an hour end to end, most of it waiting. Cost: one CX33 for the length of the test
(cents), everything else free.

### 19.0 One-time: the public mirror for the deploy button

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

### 19.1 Make the two API tokens

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

### 19.2 Deploy the installer to Cloudflare Pages

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

### 19.3 Run it, and what you should see at each step

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

### 19.4 The nine wizard screens

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

### 19.5 The four things worth proving

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

### 19.6 Tear it all down

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

### 19.7 The bring-your-own-server run

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
