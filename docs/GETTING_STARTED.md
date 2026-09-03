# Getting started

This guide takes you from the repo link to a working assistant. Follow the steps in order.
You do not need to know the project. Each step is one action. Each command sits in its own block.

Two markers appear in the steps:

- **Needs you at the keyboard.** The step uses your phone, one of your accounts, or the box.
  Nobody can do it for you. The guide tells you what you will see and what to type.
- **Lands with phase N.** The feature is written on branch `phase-N-...` and is not merged into
  `main` yet. The step works once that branch merges. Until then, skip it. The phase list is at
  the end of this guide.

## 1. What you get

- A private Claude assistant that lives on a small Hetzner server and talks to you over WhatsApp.
- It reads your own WhatsApp history, your Gmail, and your Calendar when you ask.
- It understands photos, PDFs, voice notes, and video you send to the chat.
- It runs routines on a schedule: a morning brief, an evening close, a weekly review.
- It grows a second brain: Markdown notes in a git-backed Obsidian vault, inside this repo.

## 2. What you need

Accounts:

1. **Anthropic.** A Claude Max subscription, or an API key from <https://console.anthropic.com>.
   The subscription is the preferred path. The API key is the fallback.
2. **GitHub.** Access to the private repo `alfonsojbro/ClaudeXWhatsapp`, with an SSH key on your account.
3. **Hetzner.** A Cloud account for the server and a Robot account for the Storage Box (backups).
4. **Tailscale.** A free account. The box accepts SSH only over Tailscale.
5. **Google Cloud.** A project for Gmail and Calendar access. Lands with phase 4.
6. **Cloudflare.** An account with one domain on it, for the web console. Lands with phase 8.
7. **OpenAI.** Optional. An API key for voice note transcription. Lands with phase 3.

Hardware and software:

1. A phone with WhatsApp on your own number.
2. A Mac or Linux machine. This guide calls it "the Mac".
3. On the Mac: `git`, `ssh`, `openssl`, `curl`, and `nc`. macOS has all of them.
4. On the Mac: Node 22 and pnpm 10. Section 3 installs them.
5. Optional on the Mac: the `hcloud` CLI (`brew install hcloud`) and the Tailscale app.
6. Optional on the Mac: `ffmpeg` for local media tests. Lands with phase 3.

## 3. Local first

Run the assistant on the Mac before you touch a server. This proves the WhatsApp link works.

### 3.1 Install Node 22 and pnpm

1. Install nvm if you do not have it. Follow <https://github.com/nvm-sh/nvm#installing-and-updating>.
2. Install Node 22:

```bash
nvm install 22
```

3. Use it in this terminal:

```bash
nvm use 22
```

4. Install pnpm:

```bash
npm install -g pnpm@10.34.5
```

5. Check both. Expect `v22.x.x` and `10.34.5`:

```bash
node -v && pnpm -v
```

### 3.2 Clone and install

6. Clone the repo:

```bash
git clone git@github.com:alfonsojbro/ClaudeXWhatsapp.git
```

7. Enter it. Every command from here on runs from this folder:

```bash
cd ClaudeXWhatsapp
```

8. Install dependencies. A yellow warning about "Ignored build scripts" is normal. Ignore it:

```bash
pnpm install
```

9. Run the tests. Every line must say "passed":

```bash
pnpm test
```

### 3.3 Configure

10. Copy the example environment file:

```bash
cp .env.example .env
```

11. Keep the paths in `.env` relative. The apps resolve `./data` and `./config/owners.json`
    against the repo folder, whatever folder the command runs from.

12. Generate the bridge token. It guards the local API. **Lands with phase 1.**

```bash
perl -pi -e "s#^BRIDGE_TOKEN=.*#BRIDGE_TOKEN=$(openssl rand -hex 24)#" .env
```

13. Create the owner allowlist. Only numbers in this file can give the assistant commands:

```bash
cp config/owners.example.json config/owners.json
```

14. Open `config/owners.json`. Replace `420123456789` with your own WhatsApp number.
    Use the country code and digits only. No `+`, no spaces. Example: `420777123456`.

15. Nothing to load. `pnpm pair` and `pnpm bridge` read `.env` from the repo folder by themselves.
    A variable already set in your shell wins over the file.

### 3.4 Pair WhatsApp

**Needs you at the keyboard. Lands with phase 1.**

16. Start pairing:

```bash
pnpm pair
```

17. The terminal prints `starting whatsapp socket`, then:

```
Scan this with WhatsApp → Settings → Linked devices:
```

    and a QR code made of block characters.

18. On the phone: WhatsApp → Settings → Linked devices → Link a device. Scan the QR code.
19. The terminal prints `Linked. Credentials saved under the data directory.` and exits.
    The login now lives in `data/session/`. Never commit it. Never delete it unless you want to re-pair.

No camera? Use a pairing code instead. Put your number in the command:

```bash
pnpm pair --code 420777123456
```

The terminal prints `Pairing code: XXXX-XXXX` and
`On the phone: WhatsApp → Settings → Linked devices → Link with phone number.`
Type the code on the phone.

### 3.5 Run the bridge and say ping

**Needs you at the keyboard. Lands with phase 1.**

20. Start the bridge. It links to WhatsApp and stores your chats in `data/bridge.sqlite`:

```bash
pnpm bridge
```

21. Read the log lines. You must see `http api listening` with port `7801`, then `whatsapp connected`.
    If you see `whatsapp is not linked. Stop the service and run "pnpm pair".`, step 16 did not finish.
22. The first run downloads your chat history. This can take a few minutes. Leave it running.
23. Open a second terminal in the repo folder. Check the health endpoint. Expect `"connected":true`:

```bash
curl -s 127.0.0.1:7801/health
```

24. On the phone, open the chat with yourself. WhatsApp shows it as your own name with "(You)".
25. Send the word `ping`. Within two seconds the reply `pong` arrives.
    This is echo mode. The bridge answers by itself, without Claude.
26. Stop the bridge with Ctrl+C when you are done.

### 3.6 Run the brain locally (optional)

**Lands with phase 2.** The brain is the Claude part. It needs Anthropic credentials.

27. Install Claude Code on the Mac:

```bash
npm install -g @anthropic-ai/claude-code
```

28. Create a long-lived token from your subscription. **Needs you at the keyboard.**
    The command opens a browser page. Approve it. The terminal prints a token that starts with `sk-ant-oat`:

```bash
claude setup-token
```

29. Open `.env`. Paste the token as the value of `CLAUDE_CODE_OAUTH_TOKEN`.
    No subscription? Put an API key in `ANTHROPIC_API_KEY` instead and leave the token empty.
30. In `.env`, point the bridge at the brain and turn echo mode off:

```
BRAIN_INBOUND_URL=http://127.0.0.1:7802/inbound
ECHO_MODE=0
```

31. The brain does not read `.env` yet. Load it into the shell of terminal 2:

```bash
set -a; source .env; set +a
```

    Start the bridge in terminal 1 (step 20). Start the brain in terminal 2:

```bash
pnpm brain
```

32. Expect `brain listening` with port `7802`. A warning `no Anthropic credentials: chat turns will be refused`
    means step 29 is missing.
33. Send `/help` to yourself on WhatsApp. The assistant answers with its command list.

Note: phases 1 and 2 were built on separate branches. Their `.env.example` files disagree on the
brain port (`7412` vs `7802`) and the database variable (`CXW_DB_PATH` vs `DB_PATH`). After both
merge, re-read `.env.example` and trust it over this note.

## 4. Google consent flow, once

**Lands with phase 4. Needs you at the keyboard.**

You authorise Google once on the Mac. The box never opens a browser. The result is a small file,
`google.env`, that you copy to the box in section 5.

34. Open <https://console.cloud.google.com>. Create a project. Name it `cxw-assistant`.
35. Go to APIs & Services → Library. Enable three APIs: **Gmail API**, **Google Calendar API**, **People API**.
36. Go to APIs & Services → OAuth consent screen. Choose user type **External**.
    Fill in the app name and your own e-mail. Add yourself under **Test users**.
37. **Publish the consent screen to Production.** Do not skip this.

> **Warning.** While the consent screen stays in **Testing**, Google expires the refresh token
> after 7 days. The assistant then loses Gmail and Calendar without saying anything.
> Production tokens do not expire on a timer. An unverified app is fine for one personal account.
> You will click through a "Google hasn't verified this app" page once: choose Advanced, then
> "Go to cxw-assistant".

38. Go to APIs & Services → Credentials → Create credentials → OAuth client ID.
    Application type: **Desktop app**. Download the JSON file. It lands in `~/Downloads/client_secret_….json`.
39. Run the auth command from the repo folder. Put your file name in it:

```bash
pnpm google:auth --client-secret ~/Downloads/client_secret_XXXX.json
```

40. A browser tab opens on the Google consent page. Sign in with the account you added as a test user.
    Allow the three permissions: modify Gmail, manage Calendar, read Contacts.
41. The tab shows `Authorised. You can close this tab and go back to the terminal.`
42. The terminal prints `Wrote ./google.env (0600) for you@gmail.com.`, then two commands to copy
    the file to the box, then the same Production warning as above.
43. Keep `google.env` out of git. The `.gitignore` already excludes it. Section 5 copies it to the box.

If the terminal says `Google returned no refresh token`: open <https://myaccount.google.com/permissions>,
remove the app, and run step 39 again.

If the terminal says `Pass --client-secret <client_secret_*.json> …`, the path in step 39 is wrong.

## 5. The box

**Needs you at the keyboard for every step.** This section follows `docs/RUNBOOK.md` sections 0 to 5.
When a step here is unclear, the runbook has the long form.

### 5.1 Create the server

44. In Hetzner Cloud, add a server. Location **Falkenstein (fsn1)**. Image **Ubuntu 24.04**.
    Type **CX33** (4 vCPU, 8 GB, 80 GB). Add your SSH key. Name it `cxw`.
    Or use the CLI, three commands:

```bash
hcloud context create cxw
```

```bash
hcloud ssh-key create --name mac --public-key-from-file ~/.ssh/id_ed25519.pub
```

```bash
hcloud server create --name cxw --type cx33 --image ubuntu-24.04 --location fsn1 --ssh-key mac
```

45. Note the server's public IP. The guide calls it `<PUBLIC_IP>`.
46. Add a Cloud firewall named `cxw-fw`. Allow inbound `41641/udp` from everywhere (Tailscale).
    Add a temporary rule: inbound `22/tcp` from your current IP only. Apply it to the server.
    With the CLI:

```bash
hcloud firewall create --name cxw-fw && hcloud firewall add-rule cxw-fw --direction in --protocol udp --port 41641 --source-ips 0.0.0.0/0 --source-ips ::/0 && hcloud firewall apply-to-resource cxw-fw --type server --server cxw
```

47. In Hetzner Robot, order a **Storage Box** (BX11 is the smallest). Enable SSH support.
    Note the user `uXXXXXX` and the host `uXXXXXX.your-storagebox.de`.

### 5.2 Tailscale and bootstrap

48. Install the Tailscale app on the Mac and log in. The box will join the same network.
49. In the Tailscale admin console, go to Settings → Keys → Generate auth key.
    Copy the key. It starts with `tskey-auth-`.
50. Copy the deploy folder to the box over the public IP. This is the only time you use that IP:

```bash
scp -r deploy/hetzner root@<PUBLIC_IP>:/root/hetzner
```

51. Run the bootstrap script as root. Put your auth key in the command:

```bash
ssh root@<PUBLIC_IP> 'TS_AUTHKEY=<tailscale-auth-key> CXW_TIMEZONE=Europe/Prague bash /root/hetzner/bootstrap.sh'
```

52. Watch the output. Each stage prints a blue `==>` line: `apt packages`, `tailscale`, `sshd hardening`,
    `ufw: default deny, SSH only on tailscale0`, `node 22`, `pnpm + claude code (global)`,
    `user cxw and /srv/cxw`, `systemd units`, `done`.
53. Two lines in the middle matter. `tailscale ip: 100.x.y.z` is the box's private address.
    `created /srv/cxw/cxw.env from example — fill in the placeholders` means the config files exist.
    `repo not present at /srv/cxw/repo yet; app services enabled, not started` is expected now.
54. No auth key? The script prints `Tailscale is not connected. Run the login flow now (URL below), then re-run this script.`
    Open the URL, approve the machine, run step 51 again. The script is safe to re-run.
55. Connect over Tailscale. From now on this is the only way in:

```bash
ssh root@cxw
```

56. Prove the public SSH port is closed. Expect `public 22 closed: OK`:

```bash
nc -vz -w 3 <PUBLIC_IP> 22 || echo "public 22 closed: OK"
```

57. Delete the temporary `22/tcp` rule from the Cloud firewall `cxw-fw`.
58. Check the runtime. Expect `v22.x`, `10.x`, and a Claude Code version:

```bash
ssh root@cxw 'node -v; pnpm -v; claude --version'
```

### 5.3 Deploy key and clone

The box pulls and pushes this repo with its own key. Your personal GitHub token never goes on the box.

59. Generate the key as the service user `cxw`. The command prints the public half:

```bash
ssh root@cxw 'sudo -u cxw -H ssh-keygen -t ed25519 -N "" -f /home/cxw/.ssh/cxw_deploy -C cxw-deploy && cat /home/cxw/.ssh/cxw_deploy.pub'
```

60. On GitHub: repo → Settings → Deploy keys → Add deploy key. Paste the line that starts with
    `ssh-ed25519`. Tick **Allow write access**. The box pushes vault commits, so read-only will not do.
61. Trust github.com on the box. Without this the clone fails with `Host key verification failed`:

```bash
ssh root@cxw 'sudo -u cxw -H sh -c "ssh-keyscan github.com >> /home/cxw/.ssh/known_hosts"'
```

62. Clone and install as `cxw`:

```bash
ssh root@cxw 'sudo -u cxw -H env GIT_SSH_COMMAND="ssh -i /home/cxw/.ssh/cxw_deploy -o IdentitiesOnly=yes" git clone git@github.com:alfonsojbro/ClaudeXWhatsapp.git /srv/cxw/repo && sudo -u cxw -H git -C /srv/cxw/repo config core.sshCommand "ssh -i /home/cxw/.ssh/cxw_deploy -o IdentitiesOnly=yes" && sudo -u cxw -H pnpm --dir /srv/cxw/repo install --frozen-lockfile'
```

### 5.4 Fill in the config files

63. Generate two secrets on the Mac and keep them in your password manager.
    The first is the bridge token. The second is the backup password. Lose the second and the backups are unreadable:

```bash
echo "BRIDGE_TOKEN=$(openssl rand -hex 24)"; echo "RESTIC_PASSWORD=$(openssl rand -hex 32)"
```

64. Open both config files on the box. `nano` needs a terminal, so the command uses `ssh -t`:

```bash
ssh -t root@cxw 'nano /srv/cxw/cxw.env; nano /srv/cxw/restic.env'
```

65. In `cxw.env`: set `BRIDGE_TOKEN` (lands with phase 1). Leave `CLAUDE_CODE_OAUTH_TOKEN` as `CHANGEME`
    for now. Section 5.5 fills it. Leave `ANTHROPIC_API_KEY` as `CHANGEME` unless you use the API key path.
    `OPENAI_API_KEY` is optional. Save with Ctrl+O, Enter, then Ctrl+X.
66. In `restic.env`: set `RESTIC_PASSWORD`. Replace `uXXXXXX` in the comment block with your Storage Box user.
67. Copy your owner allowlist to the box. **Lands with phase 1.** On the box it lives in the state folder:

```bash
scp config/owners.json root@cxw:/srv/cxw/state/owners.json && ssh root@cxw 'chown cxw:cxw /srv/cxw/state/owners.json && chmod 0600 /srv/cxw/state/owners.json'
```

68. Copy the Google file from section 4. **Lands with phase 4.**

```bash
scp google.env root@cxw:/srv/cxw/google.env && ssh root@cxw 'chown root:root /srv/cxw/google.env && chmod 0600 /srv/cxw/google.env'
```

**Do not re-run bootstrap yet.** It starts the brain, and a brain with a placeholder token crash-loops.

### 5.5 Log Claude Code in on the box

69. Sign in with the subscription. The command prints a URL and a code:

```bash
ssh -t root@cxw 'sudo -u cxw -H claude auth login'
```

70. Open the URL on the Mac. Approve. Paste the code back into the terminal when asked.
71. Check the login:

```bash
ssh root@cxw 'sudo -u cxw -H claude auth status'
```

72. Services run without a terminal, so they need a long-lived token. Generate one.
    The terminal prints a token that starts with `sk-ant-oat`:

```bash
ssh -t root@cxw 'sudo -u cxw -H claude setup-token'
```

73. Open `cxw.env` again (step 64). Paste the token as `CLAUDE_CODE_OAUTH_TOKEN`.
    API key path instead: set `ANTHROPIC_API_KEY`, leave the token empty, and set a monthly spend
    limit on the key in the Anthropic Console.
74. Prove that auth works. A one-line answer means success. `Invalid API key` or `Not logged in` means step 69 or 73 failed:

```bash
ssh root@cxw 'sudo -u cxw -H claude -p "hi"'
```

### 5.6 First deploy

75. Now re-run bootstrap from the clone. This installs the systemd units and starts the services and timers:

```bash
ssh root@cxw 'bash /srv/cxw/repo/deploy/hetzner/bootstrap.sh'
```

76. Check the three services. Each must show `active (running)`:

```bash
ssh root@cxw 'systemctl status cxw-bridge cxw-brain cxw-scheduler --no-pager'
```

77. A unit stuck in `failed` from an earlier start needs its counter reset first. A plain restart says
    "start request repeated too quickly" and does nothing:

```bash
ssh root@cxw 'systemctl reset-failed cxw-brain cxw-bridge cxw-scheduler && systemctl restart cxw-brain cxw-bridge cxw-scheduler'
```

78. Pair WhatsApp on the box. **Lands with phase 1. Needs the phone.** The box has no display,
    so the QR code prints in your terminal. The command loads the config as root, then runs pairing as `cxw`:

```bash
ssh -t root@cxw 'systemctl stop cxw-bridge; set -a; . /srv/cxw/cxw.env; set +a; sudo -u cxw -H env BRIDGE_TOKEN="$BRIDGE_TOKEN" CXW_DATA_DIR="$CXW_DATA_DIR" CXW_DB_PATH="$CXW_DB_PATH" CXW_OWNERS_FILE="$CXW_OWNERS_FILE" pnpm --dir /srv/cxw/repo pair; systemctl start cxw-bridge'
```

79. Scan the QR code as in step 18. Wait for `Linked. Credentials saved under the data directory.`
    Already paired on the Mac? Stop the local bridge first. Then copy `data/session/` from the Mac to
    `/srv/cxw/data/session/` on the box, owned by `cxw`. One phone link can run in one place at a time.
80. Send `ping` to yourself. `pong` now comes from the box.
81. Later code updates are one command. It pulls, installs, and restarts:

```bash
ssh root@cxw '/srv/cxw/repo/deploy/hetzner/update.sh'
```

### 5.7 First backup and restore test

Backups go to the Storage Box with restic, encrypted, every 6 hours.

82. Create a key on the box for the Storage Box. The command prints the public half:

```bash
ssh root@cxw 'ssh-keygen -t ed25519 -N "" -f /root/.ssh/storagebox_ed25519 && cat /root/.ssh/storagebox_ed25519.pub'
```

83. In Robot → Storage Box → SSH keys, paste the public key.
84. Add the host block to `/root/.ssh/config` on the box. The block is in `deploy/hetzner/restic.env.example`.
    Replace `uXXXXXX` with your user:

```bash
ssh -t root@cxw 'nano /root/.ssh/config'
```

85. Trust the Storage Box host key. Put your host in the command:

```bash
ssh root@cxw 'ssh-keyscan -p 23 uXXXXXX.your-storagebox.de >> /root/.ssh/known_hosts'
```

86. Test the connection. Expect `storagebox OK`:

```bash
ssh root@cxw 'ssh -p 23 storagebox mkdir -p cxw && echo storagebox OK'
```

87. Run the first backup by hand and check the timer. The timer line must show a next run time:

```bash
ssh root@cxw '/srv/cxw/repo/deploy/hetzner/backup.sh && systemctl list-timers cxw-backup.timer --no-pager'
```

88. Test the restore. A backup nobody has restored is not a backup. This restores into a scratch folder:

```bash
ssh root@cxw '/srv/cxw/repo/deploy/hetzner/restore.sh latest'
```

89. Compare the restored data with the live data. Expect `restore matches live data`:

```bash
ssh root@cxw 'd=$(ls -d /srv/cxw/backups/restore-* | tail -n1); diff -rq $d/srv/cxw/data /srv/cxw/data && echo "restore matches live data"; rm -rf $d'
```

90. Run the monitor once and read its status line. Expect a line that starts with `ok`:

```bash
ssh root@cxw '/srv/cxw/repo/deploy/hetzner/monitor.sh; cat /srv/cxw/state/monitor.status'
```

A real in-place restore, for the day you need it, stops the services and asks you to type `RESTORE`:

```bash
ssh -t root@cxw '/srv/cxw/repo/deploy/hetzner/restore.sh latest --in-place'
```

## 6. Cloudflare tunnel, Access policy and Pages for the console

**Lands with phase 8. Needs you at the keyboard.** Phase 8 is a plan today, not code. The shape
below comes from that plan. The exact commands and file names arrive with the phase, in a new
runbook section. Read that section first when it exists.

The console is a status page: service health, routines and runs, pending confirmations, vault
growth, and cost. It cannot approve a send. It cannot read message bodies. It is a window, not a
second command line.

How it is wired:

- The box runs a small JSON API on `127.0.0.1:7803`. It never listens on a public port.
- `cloudflared` runs on the box and dials **out** to Cloudflare. Cloudflare reaches the API through
  that tunnel. The firewall stays closed.
- The page itself is static, hosted on Cloudflare Pages, deployed by a GitHub Action on every push to `main`.
- Cloudflare Access sits in front of both. Only your Google identity gets in. Sessions last 24 hours.
- Tailscale stays as the fallback. `ssh root@cxw` plus `curl 127.0.0.1:7803` always answers.

Steps:

91. Put a domain on Cloudflare, or use one that is already there. The console gets a hostname on it,
    for example `console.<your-domain>`.
92. On the box, install `cloudflared` from Cloudflare's Ubuntu package repository. Follow
    <https://pkg.cloudflare.com>. Then log in. The command prints a URL. Open it on the Mac and pick the domain:

```bash
ssh -t root@cxw 'sudo -u cxw -H cloudflared tunnel login'
```

93. Create the tunnel. The command prints a tunnel UUID and writes a credentials JSON file:

```bash
ssh root@cxw 'sudo -u cxw -H cloudflared tunnel create cxw-console'
```

94. Copy `deploy/cloudflare/tunnel.example.yml` to the tunnel config on the box. Set the hostname
    to `console.<your-domain>` and the service to `http://127.0.0.1:7803`.
95. Point DNS at the tunnel:

```bash
ssh root@cxw 'sudo -u cxw -H cloudflared tunnel route dns cxw-console console.<your-domain>'
```

96. In Cloudflare Zero Trust → Access → Applications, add a **self-hosted** application.
    Domain `console.<your-domain>`. Session duration 24 hours. Identity provider: Google.
97. Add one policy. Action **Allow**. Include → Emails → your Google address. Nothing else.
    No bypass rule, no service token. The exact rule is in `deploy/cloudflare/access-policy.md` when it lands.
98. Note two values. The **team domain** from your Zero Trust URL (`<team>.cloudflareaccess.com`).
    The **Application Audience (AUD) tag** from the application's Overview tab.
99. Fill the console block in `/srv/cxw/cxw.env` (step 64): `CONSOLE_PORT=7803`, `CF_ACCESS_TEAM`,
    `CF_ACCESS_AUD`, and `CONSOLE_EXPOSE_PREVIEWS=false`. The last one keeps draft text off the web.
100. Enable the two new services:

```bash
ssh root@cxw 'systemctl enable --now cxw-console cxw-tunnel'
```

101. Create a Cloudflare Pages project for the static page. Give the GitHub repo a Cloudflare API
     token and your account id as Actions secrets. The workflow `.github/workflows/console-ui.yml`
     names the exact secrets. Push to `main` deploys the page.
102. Open `https://console.<your-domain>`. Cloudflare Access asks you to sign in with Google.
     The console appears. A 403 means the Access policy or the AUD value is wrong.

## 7. First day

### 7.1 The starter routines

**Lands with phase 5.** Routines are Markdown files in `vault/routines/`. The frontmatter holds the
schedule in cron form. The body is the prompt. Edit them in Obsidian. Set `enabled: false` to pause one.

| Routine | When (Europe/Prague) | What it sends |
| --- | --- | --- |
| `morning-brief` | 07:00, weekdays | Today's calendar, unread mail triaged, WhatsApp threads unanswered for 24 h, top 3 project items |
| `evening-close` | 21:00, daily | What happened today, open loops, one journal question |
| `weekly-review` | Sunday 18:00 | The week in numbers, decisions captured, memory changes, next week, 3 questions |
| `meeting-prep` | 15 min before a meeting with other people | Who they are, last contact, agenda |
| `inbox-digest` | 12:00 and 18:00 | New important e-mail only |
| `followups` | 09:00, daily | Promises found in sent messages that are still open |
| `health-check` | every 10 min, no LLM | WhatsApp link, Google token, disk, backup age. Alerts only on change |

Phase 6 adds three memory routines: `compile` at 02:00, `memory-consolidate` at 02:30, and
`memory-review` on Sunday at 17:00. Section 7.3 explains them.

### 7.2 The WhatsApp commands

Everything below goes in the chat with yourself. Commands never reach the model. They run as code.

Available with phase 2:

| You send | What happens |
| --- | --- |
| `/help` | The command list |
| `/status` | Auth, model, session, spend today, vault |
| `/new` | Start a fresh session. The old one is summarised into the vault |
| `/forget <name>` | Delete one memory file |
| `remember: …` | Save a durable fact to memory |
| `idea: …`, `note: …`, `bookmark: …`, `braindump: …`, `decision: …`, `person: …`, `article: …` | Save a capture to `vault/raw/` |
| `yes <TOKEN>` / `no <TOKEN>` | Approve or cancel a send to someone else. Tokens last 10 minutes |

Anything else is a normal chat turn. The assistant answers in the language you wrote in.

Lands with phase 5, no slash:

| You send | What happens |
| --- | --- |
| `routines` | One line per routine with its next run |
| `run <name>` | Run one now. Result within a minute |
| `pause <name>` / `resume <name>` | Flip `enabled` in the file |
| `history <name>` | The last 5 runs |
| `new routine every weekday at 7: <prompt>` | Write a new routine file |
| `remind me Friday 9am to call Marco` | A one-shot reminder |

Lands with phase 6: `forget <topic>`, `what do you know about <topic>`, `who is <person>`.
Spanish forms work too: `recuerda:`, `olvida`, `qué sabés de`, `quién es`.

Lands with phase 7: `panic` stops the brain and the scheduler at once. `resume` starts them.
`status`, `purge`, and `costs` report on the box.

Lands with phase 9: `follow up with <name> about <what>`, `open loops`, `done <id>`, `snooze <id> 3 days`.

The confirm gate is the one rule to remember. The assistant cannot message, e-mail, or invite
anyone but you on its own. It shows you a preview and a 6-character token. You reply `yes <TOKEN>`.
Nothing goes out without that reply.

### 7.3 How memory grows

The vault is `vault/` in this repo. It is an Obsidian vault. Three layers, all Markdown, all in git:

1. **Captures, `vault/raw/`.** Written when you use a capture prefix, or when the assistant spots
   something worth keeping. One file per capture: `raw/<type>-<topic>.md`. Never deleted.
2. **Compiled knowledge, `vault/wiki/`.** Lands with phase 6. The nightly `compile` routine reads
   new captures and updates topic pages with `[[links]]`. Obsidian's graph grows on its own.
3. **Assistant memory, `vault/memory/`.** One fact per file. `memory/MEMORY.md` is the index that
   every session loads. The box regenerates it. Do not edit the index by hand.

Also in the vault: `routines/` (section 7.1) and `runs/` (one log per routine run).

The box commits after every write and pushes. It pulls with rebase before it writes. You edit
anything. The box writes only `raw/`, `wiki/`, `memory/`, and `runs/`.

Every answer that used memory cites the vault path. Open that path in Obsidian to see the source.

### 7.4 Where to look in Obsidian

103. Install the Obsidian Git community plugin. Set it to pull every 10 minutes and push your own edits.
104. In Obsidian: Open folder as vault. Pick the `vault/` folder inside your local clone.
105. Look at these folders first:

| Folder | Open it when |
| --- | --- |
| `memory/MEMORY.md` | You want to see what the assistant knows about you |
| `memory/` | You want to correct or delete a single fact. `/forget <name>` does the same from the chat |
| `raw/` | You want the captures as they arrived |
| `wiki/` | You want the compiled view: Projects, People, Decisions, Topics. Lands with phase 6 |
| `routines/` | You want to change when a routine runs or what it says |
| `runs/<routine>/` | A routine did something odd and you want its log |

## 8. When something breaks

Start with `docs/RUNBOOK.md`. The box section numbers below are on `main` today.

| Symptom | Where to look |
| --- | --- |
| You cannot `ssh root@cxw` | Runbook §2: Tailscale status and `ufw`. Check the Mac's Tailscale app is connected |
| Clone fails with `Host key verification failed` | Runbook §3: the `ssh-keyscan` step |
| Clone fails with `Permission denied (publickey)` | Runbook §3: the deploy key is not on GitHub, or write access is off |
| `claude -p "hi"` says `Invalid API key` or `Not logged in` | Runbook §4: log in again as `cxw`, regenerate the token |
| A service shows `failed` and restart says "start request repeated too quickly" | Runbook §4: `systemctl reset-failed` |
| Backup fails or the timer is inactive | Runbook §5: Storage Box key, `/root/.ssh/config`, `restic.env` |
| You need old data back | Runbook §5, "Test a restore" |
| You want logs | Runbook §6: `journalctl -u cxw-brain -f`, same for `cxw-bridge` and `cxw-scheduler` |
| `pnpm pair` says `BRIDGE_TOKEN: Invalid input` | Step 12 was skipped, or `.env` is not in the repo folder (step 10) |
| `pnpm bridge` says `cannot read owners file` | Step 13 was skipped, or `CXW_OWNERS_FILE` in `.env` points somewhere else |
| The log says `whatsapp session logged out` | The phone dropped the link. Runbook §8.4 (phase 1): stop the bridge, delete `session/`, pair again |
| `ping` gets no `pong` | Your number is not in `owners.json`, or you sent it from a group. Runbook §8.2 (phase 1) |
| Gmail or Calendar stopped after a week | Section 4, step 37: the consent screen is still in Testing. Runbook Google section (phase 4) |
| The monitor status says `fail` | Read the reasons after the word. Runbook §6 |
| Anything on the box feels wrong | Runbook §7 acceptance checklist. Tick every line again |

Phase 7 adds a "Common failures" table and sections for panic, purge, costs, alerts, and token
rotation. Phase 8 adds a console section with "when a tile is red".

## Which phase is where

This guide was written on 2026-09-03 against `main` at `50b0da4` plus the committed tip of each
phase branch. Run this on the Mac to see what has merged since:

```bash
git branch -a --merged origin/main | grep phase
```

| Phase | Branch | State when this guide was written |
| --- | --- | --- |
| 0 | merged | Repo, CI, box bootstrap, backups, monitor |
| 1 | `phase-1-bridge` at `6c4e21b` | Code done: WhatsApp link, store, echo mode, WhatsApp MCP |
| 2 | `phase-2-brain` at `b605c3c` | Code done: Claude loop, commands, captures, confirm gate, vault MCP |
| 3 | `phase-3-media` at `5112c7f` | Code done: images, PDFs, voice notes, video, links |
| 4 | `phase-4-google` at `43d2a71` | Code done: Gmail, Calendar, Contacts, `pnpm google:auth` |
| 5 | `phase-5-routines` at `498e805` | Plan only: scheduler and starter routines |
| 6 | `phase-6-memory` at `928a454` | Plan plus shared helpers: compile, consolidate, review, `who is` |
| 7 | `phase-7-ops` at `f43ad57` | Plan only: alerts, purge, costs, panic switch |
| 8 | `phase-8-console` at `3d9787a` | Plan only: console API, Cloudflare tunnel, Access, Pages |
| 9 | `phase-9-followups` at `078b05b` | Plan only: client follow-ups ledger |
