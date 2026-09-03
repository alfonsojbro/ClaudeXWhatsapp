#!/usr/bin/env bash
# bootstrap.sh — prepare a fresh Hetzner Ubuntu 24.04 box for ClaudeXWhatsapp.
# Idempotent: safe to re-run. Must run as root.
#
#   TS_AUTHKEY=tskey-auth-... ./bootstrap.sh     # non-interactive Tailscale join
#   ./bootstrap.sh                                # prints a Tailscale login URL if needed
#
# What it does:
#   1. apt packages: ufw, curl, jq, ffmpeg, restic, sqlite3, git, build tools
#   2. Tailscale installed and up
#   3. sshd hardened (keys only) and ufw: default deny, SSH only via tailscale0
#   4. Node 22 (NodeSource), pnpm, Claude Code CLI
#   5. system user `cxw`, /srv/cxw/{repo,data,backups,state} (0700)
#   6. systemd units from ./systemd installed and timers enabled
#
# Optional, set by the phase 10 installer's cloud-init payload. With none of them set
# this script behaves exactly as it did before phase 10:
#   CXW_TUNNEL_TOKEN      install cloudflared and register the tunnel
#   CXW_SETUP_MODE        write the console/setup block into cxw.env, shred user-data
#   CXW_CONSOLE_HOSTNAME  the hostname the tunnel serves, e.g. cxw.example.com
#   CF_ACCESS_TEAM        Cloudflare Access team name
#   CF_ACCESS_AUD         Cloudflare Access application audience tag
set -euo pipefail

CXW_ROOT=/srv/cxw
CXW_USER=cxw
NODE_MAJOR=22
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# Merge KEY=VALUE into /srv/cxw/cxw.env in place. Replaces the line for KEY if it is
# already there, appends it otherwise, and preserves every other line byte for byte.
# The file stays root:root 0600.
merge_env() {
  local key=$1 value=$2 file="$CXW_ROOT/cxw.env" tmp
  tmp=$(mktemp)
  chmod 0600 "$tmp"
  if [[ -f "$file" ]] && grep -q "^${key}=" "$file"; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" == "${key}="* ]]; then
        printf '%s=%s\n' "$key" "$value"
      else
        printf '%s\n' "$line"
      fi
    done < "$file" > "$tmp"
  else
    if [[ -f "$file" ]]; then
      cat "$file" > "$tmp"
    fi
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  install -m 0600 -o root -g root "$tmp" "$file"
  rm -f "$tmp"
}

[[ $EUID -eq 0 ]] || die "run as root"
# shellcheck source=/dev/null
[[ -r /etc/os-release ]] && . /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || echo "warning: tested on Ubuntu 24.04, found ${PRETTY_NAME:-unknown}"

export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------- 1. packages
log "apt packages"
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl gnupg jq git ufw ffmpeg restic sqlite3 \
  build-essential python3 pkg-config unattended-upgrades logrotate

if ! grep -q 'Unattended-Upgrade::Automatic-Reboot' /etc/apt/apt.conf.d/50unattended-upgrades 2>/dev/null; then
  cat > /etc/apt/apt.conf.d/52cxw-unattended <<'CONF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
CONF
fi

if [[ -n "${CXW_TIMEZONE:-}" ]]; then
  timedatectl set-timezone "$CXW_TIMEZONE"
fi

# --------------------------------------------------------------- 2. tailscale
log "tailscale"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
systemctl enable --now tailscaled >/dev/null

if ! tailscale status >/dev/null 2>&1; then
  if [[ -n "${TS_AUTHKEY:-}" ]]; then
    tailscale up --auth-key="$TS_AUTHKEY" --ssh=false --hostname="${CXW_TS_HOSTNAME:-cxw}"
  else
    echo "Tailscale is not connected. Run the login flow now (URL below), then re-run this script."
    tailscale up --hostname="${CXW_TS_HOSTNAME:-cxw}"
  fi
fi
TS_IP=$(tailscale ip -4 2>/dev/null | head -n1 || true)
[[ -n "$TS_IP" ]] || die "tailscale has no IPv4 address; fix Tailscale before enabling the firewall"
echo "tailscale ip: $TS_IP"

# ------------------------------------------------------------ 3. sshd + ufw
log "sshd hardening"
mkdir -p /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/10-cxw.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
X11Forwarding no
CONF
sshd -t && systemctl reload ssh || systemctl reload sshd || true

log "ufw: default deny, SSH only on tailscale0"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow in on tailscale0 to any port 22 proto tcp comment 'ssh via tailscale' >/dev/null
ufw allow in 41641/udp comment 'tailscale direct' >/dev/null
ufw --force enable >/dev/null
ufw status verbose

# ------------------------------------------------------- 4. node, pnpm, claude
log "node ${NODE_MAJOR}"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1)" != "v${NODE_MAJOR}" ]]; then
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
node -v

log "pnpm + claude code (global)"
command -v pnpm >/dev/null 2>&1 || npm install -g pnpm@10 >/dev/null
if ! command -v claude >/dev/null 2>&1; then
  npm install -g @anthropic-ai/claude-code >/dev/null
fi
pnpm -v; claude --version

# ------------------------------------------------------ 5. user + directories
log "user ${CXW_USER} and ${CXW_ROOT}"
if ! id -u "$CXW_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/${CXW_USER}" --shell /bin/bash "$CXW_USER"
fi
install -d -m 0711 -o root -g root "$CXW_ROOT"
install -d -m 0700 -o "$CXW_USER" -g "$CXW_USER" "$CXW_ROOT/repo" "$CXW_ROOT/data" "$CXW_ROOT/state"
install -d -m 0700 -o root -g root "$CXW_ROOT/backups"
install -d -m 0700 -o "$CXW_USER" -g "$CXW_USER" "/home/${CXW_USER}/.claude"

for f in cxw.env restic.env; do
  if [[ ! -f "$CXW_ROOT/$f" ]]; then
    if [[ -f "$SCRIPT_DIR/${f}.example" ]]; then
      install -m 0600 -o root -g root "$SCRIPT_DIR/${f}.example" "$CXW_ROOT/$f"
      echo "created $CXW_ROOT/$f from example — fill in the placeholders"
    else
      install -m 0600 -o root -g root /dev/null "$CXW_ROOT/$f"
    fi
  fi
  chmod 0600 "$CXW_ROOT/$f"; chown root:root "$CXW_ROOT/$f"
done

# ------------------------------------------- 5b. cloudflare tunnel (phase 10)
# Only when the installer handed us a tunnel token. We use cloudflared's OWN systemd
# unit on purpose: `cloudflared service install <token>` writes cloudflared.service.
# Phase 8 owns the cxw-tunnel unit under deploy/hetzner/systemd, so adding our own
# copy of that filename here would collide when the two branches merge.
if [[ -n "${CXW_TUNNEL_TOKEN:-}" ]]; then
  log "cloudflared tunnel"
  if ! command -v cloudflared >/dev/null 2>&1; then
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /etc/apt/keyrings/cloudflare-main.gpg
    chmod 0644 /etc/apt/keyrings/cloudflare-main.gpg
    echo "deb [signed-by=/etc/apt/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
      > /etc/apt/sources.list.d/cloudflared.list
    apt-get update -qq
    apt-get install -y -qq cloudflared
  fi
  if [[ ! -f /etc/systemd/system/cloudflared.service ]]; then
    cloudflared service install "$CXW_TUNNEL_TOKEN"
  fi
  systemctl enable --now cloudflared >/dev/null
  merge_env CXW_TUNNEL_TOKEN "$CXW_TUNNEL_TOKEN"
  ufw allow out 7844/tcp comment 'cloudflared' >/dev/null || true
fi

# ------------------------------------------------ 5c. setup wizard (phase 10)
# The installer created the Access application before the box existed, so the console
# can enforce Access on its very first request. Written here, not in the example file,
# because the values are per-install.
if [[ -n "${CXW_SETUP_MODE:-}" ]]; then
  log "setup mode"
  merge_env CXW_SETUP_MODE "$CXW_SETUP_MODE"
  merge_env CONSOLE_REQUIRE_ACCESS true
  merge_env CONSOLE_HOST 127.0.0.1
  merge_env CONSOLE_PORT 7803
  if [[ -n "${CXW_TIMEZONE:-}" ]]; then
    merge_env TZ "$CXW_TIMEZONE"
  fi
fi
if [[ -n "${CXW_CONSOLE_HOSTNAME:-}" ]]; then
  merge_env CXW_CONSOLE_HOSTNAME "$CXW_CONSOLE_HOSTNAME"
fi
if [[ -n "${CF_ACCESS_TEAM:-}" ]]; then
  merge_env CF_ACCESS_TEAM "$CF_ACCESS_TEAM"
fi
if [[ -n "${CF_ACCESS_AUD:-}" ]]; then
  merge_env CF_ACCESS_AUD "$CF_ACCESS_AUD"
fi

# ------------------------------------------------------------ 6. systemd
log "systemd units"
UNIT_SRC="$SCRIPT_DIR/systemd"
[[ -d "$UNIT_SRC" ]] || UNIT_SRC="$CXW_ROOT/repo/deploy/hetzner/systemd"
if [[ -d "$UNIT_SRC" ]]; then
  install -m 0644 -o root -g root "$UNIT_SRC"/cxw-*.service "$UNIT_SRC"/cxw-*.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable cxw-backup.timer cxw-monitor.timer >/dev/null
  systemctl start cxw-backup.timer cxw-monitor.timer
  # app services are enabled but only started when the repo is present
  systemctl enable cxw-bridge.service cxw-brain.service cxw-scheduler.service >/dev/null
  if [[ -f "$CXW_ROOT/repo/package.json" ]]; then
    systemctl restart cxw-bridge.service cxw-brain.service cxw-scheduler.service || true
  else
    echo "repo not present at $CXW_ROOT/repo yet; app services enabled, not started"
  fi
  systemctl list-timers 'cxw-*' --no-pager
else
  echo "no systemd units found at $UNIT_SRC; clone the repo to $CXW_ROOT/repo and re-run"
fi

# --------------------------------------- 7. shred the cloud-init user-data
# Hetzner shows a server's user-data in its own console by design, but the local copy
# does not need to survive first boot. The stamp file makes a re-run a no-op rather
# than a failure, which matters because this script is meant to be re-run.
CLOUD_INIT_STAMP="$CXW_ROOT/state/.user-data-shredded"
if [[ -n "${CXW_SETUP_MODE:-}" && ! -f "$CLOUD_INIT_STAMP" ]]; then
  log "shredding the cloud-init user-data"
  for f in /root/cxw-installer.env /var/lib/cloud/instance/user-data.txt /var/lib/cloud/instances/*/user-data.txt; do
    [[ -f "$f" ]] || continue
    shred -u "$f" 2>/dev/null || rm -f "$f"
  done
  install -m 0600 -o root -g root /dev/null "$CLOUD_INIT_STAMP"
fi

log "done"
cat <<MSG
Next steps (see docs/RUNBOOK.md):
  1. From your Mac:  ssh root@${TS_IP}   (only works over Tailscale)
  2. Clone the repo as ${CXW_USER}:  sudo -u ${CXW_USER} -H git clone <remote> ${CXW_ROOT}/repo && cd ${CXW_ROOT}/repo && sudo -u ${CXW_USER} -H pnpm install
  3. Fill in ${CXW_ROOT}/cxw.env and ${CXW_ROOT}/restic.env
  4. Log Claude Code in as ${CXW_USER}:  sudo -u ${CXW_USER} -H claude auth login   then   sudo -u ${CXW_USER} -H claude -p "hi"
  5. Re-run this script to install units from the clone and start services.
MSG
