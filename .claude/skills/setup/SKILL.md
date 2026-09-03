---
name: setup
description: First-time setup of ClaudeXWhatsapp, driven from docs/GETTING_STARTED.md one section at a time. Checks what is already done and skips it, mints the exact link or command for every connector (Anthropic, WhatsApp, Google, Hetzner, Tailscale, Cloudflare), shows the WhatsApp QR in the browser, and hands every login to the person. Use when the user says "set this up", "get started", "install", "connect WhatsApp", "pair", or "onboard me".
---

# /setup — walk a newcomer through docs/GETTING_STARTED.md

You are driving the guide for a person who does not know this project. The guide is the source
of truth. This skill tells you how to run it: check first, skip what is done, do the routine work
yourself, and hand over every step that needs the person's phone, browser, or account.

## Rules that never bend

1. **Order.** Sections of the guide run in order: 3 local, 4 Google, 5 box, 6 Cloudflare, 7 first
   day. Never jump ahead. A later section can be skipped when its phase is not merged (rule 5).
2. **Keyboard steps are theirs.** A step marked **Needs you at the keyboard** is done by the
   person. You print the exact link or command in a `bash` block, say what they will see, and wait
   for them to say it is done. Then you re-check. You never run a command that carries a secret on
   its command line, and you never run an interactive login for them.
3. **Never touch a secret.** Never type, paste, or generate a password, API key, OAuth token,
   Tailscale auth key, pairing code, or verification code for the person. Never `cat` a file that
   holds one (`.env`, `google.env`, `/srv/cxw/cxw.env`, `data/session/`). Check presence with
   `scripts/setup-check.sh`, which prints shape only. Never write a secret into this repo, the
   vault, a memory file, or a chat reply. If one shows up in output you did not ask for, say so and
   move on without repeating it.
4. **Check before every section.** Run the check script, filtered to the section, and skip every
   step that reports `ok`. Tell the person in one line what was skipped and why.
5. **Phase markers are promises you cannot make.** The guide marks steps **Lands with phase N**.
   Before you start, read the `phases.present` line of the check script; it lists the phases whose
   code is in this checkout. A step whose phase is not in that list gets one sentence: "this lands with phase N; not merged yet; skipping". Never
   present unmerged work as working. The final section of this skill carries the same markers.
6. **One section per turn.** Finish a section, show the re-check, and stop. Let the person set the
   pace. Keep replies short: the guide already has the prose.
7. **Routine work is yours.** Copying example files, editing `.env` paths, generating the bridge
   token with `openssl`, writing the person's own phone number into `config/owners.json`, running
   `pnpm install` and `pnpm test`, starting `pnpm pair:qr` and `pnpm bridge`: do these yourself in
   the repo folder and report the result. The phone number is not a secret, but it only goes into
   `config/owners.json` (git-ignored), nowhere else.

## The check script

```bash
scripts/setup-check.sh
```

One line per check: `ok`, `todo`, or `skip`, a name, and a detail. Names are grouped: `tools.*`,
`env.*`, `owners`, `whatsapp.*`, `google.*`, `anthropic.*`, `box.*`, `cloudflare.*`, `phases.*`.
Pass a prefix to run one group, for example `scripts/setup-check.sh box`. The script reads, never
writes, and never prints a value.

Run it in full at the start. Show the person the `todo` lines only, then start with the first
section that has one.

## Section 3 — local first (guide §3)

**3.1 Node and pnpm.** Check `tools.node`, `tools.pnpm`. If Node is not v22, hand over the nvm
install from guide 3.1: the person installs nvm and runs `nvm install 22`. You cannot change their
shell for them. Once `node -v` says v22, install pnpm yourself:

```bash
npm install -g pnpm@10.34.5
```

**3.2 Install and test.** Check `tools.deps`. Run `pnpm install` and `pnpm test` in the repo root
and report pass or fail. A yellow "Ignored build scripts" warning is normal.

**3.3 Configure.** Check `env.file`, `env.bridge_token`, `owners`. Do the todo ones. Paths in
`.env` stay relative; the bridge resolves them against the repo folder (guide step 11):

```bash
cp .env.example .env
```

```bash
perl -pi -e "s#^BRIDGE_TOKEN=.*#BRIDGE_TOKEN=$(openssl rand -hex 24)#" .env
```

The token line lands with phase 1; on `main` the variable is not in `.env.example` yet, so append
it if the perl finds no line. Then ask the person for their WhatsApp number, country code and
digits only, and write it into `config/owners.json` in place of `420123456789`. Do not read the
number back into chat more than once.

**3.4 Pair WhatsApp.** *Needs the phone. Lands with phase 1.* Check `whatsapp.session`; if `ok`,
skip the whole step. Otherwise show the QR in the browser, not only in the terminal:

```bash
pnpm pair:qr
```

Run it in the background with output to a log. It starts `pnpm pair`, parses each QR the bridge
prints, and serves it at `http://127.0.0.1:7899/`. Open that URL in the Browser pane so the person
sees the code next to the chat. Tell them: WhatsApp → Settings → Linked devices → Link a device,
scan the code. The page follows the code as WhatsApp rotates it every 20 seconds and relaunches
the pairing after WhatsApp closes the socket at 60 seconds. It stops with `Linked.` on the page and
in the log, or after 40 runs. Re-check `whatsapp.session` before moving on.

No camera? Hand over the pairing-code path from guide step 19 (`pnpm pair --code <number>`). The
code prints in the person's own terminal and they type it on the phone. Never relay it.

Depends on in-flight work on branch `phase-1-bridge`: `.env` auto-loading, creating the `data/`
folder for the SQLite file, and reconnecting through WhatsApp's QR timeout. `pnpm pair:qr` covers
all three itself (it loads `.env` into the child, resolves relative `CXW_*` paths against the repo
root, and relaunches), so it works before and after those fixes merge. Plain `pnpm pair` needs
them.

**3.5 Bridge and ping.** *Needs the phone. Lands with phase 1.* Start the bridge in the
background with output to a log:

```bash
pnpm bridge
```

Wait for `http api listening` and `whatsapp connected` in the log. Then ask the person to send
`ping` to themselves in WhatsApp. Confirm `pong` in the log or from the person. If `ping` gets no
`pong` and the number is in `owners.json`, it is the LID defect (WhatsApp addresses the self-chat
as `…@lid`). Its fix is in flight on `phase-1-bridge`; say so and move on.

**3.6 Brain (optional).** *Lands with phase 2.* Check `tools.claude`, `env.anthropic`,
`anthropic.login`. Install the CLI yourself if missing:

```bash
npm install -g @anthropic-ai/claude-code
```

Then hand over the Anthropic login. The person runs, in their own terminal, either the interactive
login or the token generator:

```bash
claude login
```

```bash
claude setup-token
```

The second opens a browser page to approve and prints a token starting with `sk-ant-oat`. The
person pastes it into `.env` as `CLAUDE_CODE_OAUTH_TOKEN` themselves. No subscription: they put an
API key from <https://console.anthropic.com/settings/keys> into `ANTHROPIC_API_KEY` instead. You
re-check `env.anthropic`; you never open `.env` to look. Then set `BRAIN_INBOUND_URL` and
`ECHO_MODE=0` per guide step 30. The brain does not read `.env` yet, so start it with the file
loaded into that shell only (guide step 31): `set -a; source .env; set +a; pnpm brain`. Ask the
person to send `/help`.

## Section 4 — Google consent, once (guide §4)

*Lands with phase 4. Needs the browser.* Check `google.env`, `google.auth_script`. If `google.env`
is `ok`, skip. Give the person these links and the four things to do on them:

- <https://console.cloud.google.com/projectcreate> — create project `cxw-assistant`.
- <https://console.cloud.google.com/apis/library> — enable Gmail API, Google Calendar API, People API.
- <https://console.cloud.google.com/apis/credentials/consent> — user type External, add themselves
  as a test user, then **Publish to Production**. Say why: in Testing, Google expires the refresh
  token after 7 days and Gmail and Calendar silently stop.
- <https://console.cloud.google.com/apis/credentials> — Create credentials → OAuth client ID →
  Desktop app → download the JSON.

Ask for the path of the downloaded JSON file (the path, not its contents). Then run the desktop
flow yourself in the background with output to a log:

```bash
pnpm google:auth --client-secret ~/Downloads/client_secret_XXXX.json
```

It prints `Open this URL and grant access:` followed by a long `accounts.google.com` URL. Copy that
URL from the log into the chat and open it in the Browser pane. The person signs in and allows the
three permissions. The command then prints `Wrote ./google.env (0600) for <email>.` and the
Production warning again. Repeat the Production reminder once. Never open `google.env`.

## Section 5 — the box (guide §5)

*Needs the person at the keyboard for every step.* Check the `box.*` group first. If `box.ssh` is
`ok`, the server exists and Tailscale works: skip 5.1 and 5.2 and continue at the first `todo`.

**5.1 Hetzner.** Hand over. Links:

- <https://console.hetzner.cloud/> — new server: Falkenstein, Ubuntu 24.04, CX33, their SSH key,
  name `cxw`. Or the three `hcloud` commands from guide step 44; `hcloud context create cxw` asks
  for an API token, which only they type.
- Firewall `cxw-fw` per guide step 46: 41641/udp from everywhere, 22/tcp from their IP for now.
- <https://robot.hetzner.com/storage> — order a Storage Box, enable SSH, note `uXXXXXX` and host.

Ask for the public IP. Store it in this conversation only.

**5.2 Tailscale and bootstrap.** Hand over. Links and commands:

- <https://tailscale.com/download> — install and log in on the Mac.
- <https://login.tailscale.com/admin/settings/keys> — Generate auth key. It starts with `tskey-auth-`.
  They keep it; you never see it.
- You may run the copy, it carries no secret: `scp -r deploy/hetzner root@<PUBLIC_IP>:/root/hetzner`.
- They run the bootstrap, because the auth key rides on the command line (guide step 51):

```bash
ssh root@<PUBLIC_IP> 'TS_AUTHKEY=<tailscale-auth-key> CXW_TIMEZONE=Europe/Prague bash /root/hetzner/bootstrap.sh'
```

Tell them the `==>` stage lines to expect and the two lines that matter (guide steps 52–54). Then
you verify: `ssh root@cxw 'node -v; pnpm -v; claude --version'` and the closed-port check from
guide step 56. Remind them to delete the temporary 22/tcp rule.

**5.3 Deploy key and clone.** You run the keygen and print the public key (guide step 59). They
add it at `https://github.com/<owner>/<repo>/settings/keys/new` with **Allow write access**. You
run the `ssh-keyscan` and the clone (guide steps 61–62). Public keys are not secrets.

**5.4 Config files.** You print the two generated secrets with the guide's command only if the
person asks you to; the default is that they run guide step 63 themselves. They edit `cxw.env` and
`restic.env` in `nano` (guide step 64). You copy `config/owners.json` and `google.env` to the box
with the guide's `scp` lines: those move files, they do not show contents.

**5.5 Claude Code on the box.** Hand over, both commands need a browser approval on the Mac:

```bash
ssh -t root@cxw 'sudo -u cxw -H claude auth login'
```

```bash
ssh -t root@cxw 'sudo -u cxw -H claude setup-token'
```

They paste the token into `/srv/cxw/cxw.env`. You verify with
`ssh root@cxw 'sudo -u cxw -H claude -p "hi"'` and read only whether it answered.

**5.6 First deploy.** You run bootstrap from the clone, the status checks, and `reset-failed` when
needed (guide steps 75–77). Pairing on the box (step 78) is theirs, or better: if `whatsapp.session`
is `ok` on the Mac, stop the local bridge and copy `data/session/` to `/srv/cxw/data/session/` on
the box, owned by `cxw` (guide step 79). One phone link runs in one place at a time.

**5.7 Backups.** You run the keygen on the box and print the public key. They paste it at
<https://robot.hetzner.com/storage> → SSH keys. They edit `/root/.ssh/config`. You run the keyscan,
the connection test, the first backup, and the restore test (guide steps 85–90).

## Section 6 — Cloudflare (guide §6)

*Lands with phase 8. Needs the person at the keyboard.* If phase 8 is not merged, say so in one
line and skip. When it is, follow `deploy/cloudflare/access-policy.md` and runbook §7 exactly:

- <https://dash.cloudflare.com/> — a domain on the account.
- <https://pkg.cloudflare.com/> — install `cloudflared` on the box (you run the apt lines).
- They run the login, it prints a URL to open on the Mac:

```bash
ssh -t root@cxw 'sudo -u cxw -H cloudflared tunnel login'
```

- You run `cloudflared tunnel create cxw-console`, move the credentials JSON, write
  `/srv/cxw/cloudflared/config.yml` from `tunnel.example.yml`, and route DNS (runbook §7.1).
- <https://one.dash.cloudflare.com/> → Access → Applications → Add → Self-hosted. They create the
  application and the single `Owner only` Allow policy with their Google address, no bypass, no
  service token. They read the team name and the AUD tag and paste both into `/srv/cxw/cxw.env`.
- You enable `cxw-console` and `cxw-tunnel` and open `https://console.<their-domain>` for them.

## Section 7 — after setup: what you can do now

Read this to the person once everything above is green, with the phase markers exactly as below.
Read the `phases.present` line of `scripts/setup-check.sh phases` again and mark each block
present or not.

**Echo test — phase 1.** Send `ping` to yourself. `pong` comes back from the bridge alone. This
proves the WhatsApp link and the owner allowlist.

**The chat — phase 2.** Everything in the chat with yourself goes to Claude, with your vault and
your WhatsApp history as tools. Commands never reach the model: `/help`, `/status` (auth, model,
session, spend today), `/new` (fresh session, the old one is summarised into the vault),
`/forget <name>`. It answers in the language you wrote in. Long answers arrive in chunks or as a
vault file plus a five-line summary.

**Captures — phase 2.** Prefix a message with `idea:`, `note:`, `bookmark:`, `braindump:`,
`decision:`, `person:`, `article:`, or say `remember: …`. The assistant writes
`vault/raw/<type>-<topic>.md` or a memory file and commits. Captures are never deleted.

**The confirm gate — phase 2.** The one rule to remember. The assistant cannot message, e-mail, or
invite anyone but you on its own. It shows a preview and a 6-character token. You reply
`yes <TOKEN>` within 10 minutes, or nothing goes out.

**Media — phase 3.** Send a photo, a PDF, a voice note, a video, or a link. Images and PDFs go to
Claude directly. Voice notes are transcribed (OpenAI key, or `whisper.cpp` on the box). Video is
sampled into keyframes. Links are fetched, summarised, and offered as a bookmark capture.

**Gmail, Calendar, Contacts — phase 4.** Ask about your inbox, your day, or a person. Sending mail
and creating events with other attendees go through the confirm gate.

**Routines — phase 5.** Markdown files in `vault/routines/` with a cron line in the frontmatter.
Starters: `morning-brief` 07:00 weekdays, `evening-close` 21:00, `weekly-review` Sunday 18:00,
`meeting-prep` 15 minutes before a meeting, `inbox-digest` 12:00 and 18:00, `followups` 09:00,
`health-check` every 10 minutes without an LLM. Chat commands without a slash: `routines`,
`run <name>`, `pause <name>`, `resume <name>`, `history <name>`,
`new routine every weekday at 7: <prompt>`, `remind me Friday 9am to call Marco`.

**Memory in Obsidian — phase 2 basic, phase 6 full.** Open `vault/` in Obsidian with the Obsidian
Git plugin pulling every 10 minutes. `memory/MEMORY.md` is what the assistant knows about you, one
fact per file under `memory/`. `raw/` holds captures as they arrived. Phase 6 adds `wiki/`, compiled
nightly with `[[links]]`, plus `forget <topic>`, `what do you know about <topic>`, `who is <person>`,
and a Sunday memory digest to approve or delete facts by number.

**Ops from the chat — phase 7.** `panic` stops the brain and the scheduler, `resume` starts them,
`status`, `purge`, and `costs` report on the box. Alerts arrive on WhatsApp, by e-mail when
WhatsApp itself is down.

**The console — phase 8.** A status page at `https://console.<your-domain>` behind Cloudflare
Access with your Google login: service health, routines and runs, pending confirmations, vault
growth, cost. A window, not a second command line: it cannot approve a send or read message
bodies.

**Follow-ups — phase 9.** `follow up with <name> about <what>`, `open loops`, `done <id>`,
`snooze <id> 3 days`, and a daily list of promises found in what you sent.

**When something breaks.** Guide §8 has the symptom table. `docs/RUNBOOK.md` has the long form.
Logs on the box: `journalctl -u cxw-bridge -f`, same for `cxw-brain` and `cxw-scheduler`.

## Depends on unmerged work

Say these plainly when they come up; do not work around them silently.

- `phase-1-bridge` in flight: `.env` auto-load, `data/` folder creation, reconnect through the QR
  timeout, and owner checks for `…@lid` addresses. `pnpm pair:qr` covers the first three on its own.
  The LID fix decides whether `ping` answers in the self-chat.
- Phases 5 to 9 are plans or partial code. Section 7 above marks each one.
- `.env.example` on `phase-1-bridge` and `phase-2-brain` disagree on the brain port (`7412` vs
  `7802`) and the database variable (`CXW_DB_PATH` vs `DB_PATH`). After both merge, trust
  `.env.example` over the guide's numbers.
