#!/usr/bin/env bash
# check-secrets: refuse to commit files that look like they contain credentials.
#
# Usage:
#   scripts/check-secrets.sh          # scan staged files (pre-commit)
#   scripts/check-secrets.sh --all    # scan every tracked file (CI)
#   CXW_ALLOW_SECRETS=1 git commit    # bypass everything, on purpose, once
#
# To excuse one known-safe line (a fixture, a documented example), put the
# marker "check-secrets: allow" in a comment on that line. Prefer that over
# CXW_ALLOW_SECRETS, which turns the whole check off.
set -euo pipefail

mode="staged"
[[ "${1:-}" == "--all" ]] && mode="all"

if [[ "${CXW_ALLOW_SECRETS:-0}" == "1" ]]; then
  echo "check-secrets: bypassed via CXW_ALLOW_SECRETS=1" >&2
  exit 0
fi

# Files that must never be committed, whatever they contain.
forbidden_paths='(^|/)(\.env|\.env\.[^/]+|[^/]*\.env|google\.env|credentials\.json|token\.json|creds\.json)$|(^|/)session/|(^|/)(creds|app-state-sync-[^/]*|pre-key-[^/]*|sender-key-[^/]*|session-[^/]*)\.json$|(^|/)\.obsidian/workspace.*\.json$|(^|/)id_(rsa|ed25519)$'
allowed_paths='\.env\.example$'

# Content patterns for well-known credential shapes.
patterns=(
  'sk-ant-[A-Za-z0-9_-]{20,}'                      # Anthropic API key
  'sk-ant-oat[A-Za-z0-9_-]{10,}'                    # Claude Code OAuth token
  'sk-(proj-|live-|test-)?[A-Za-z0-9]{20,}'          # OpenAI / Stripe style
  'AKIA[0-9A-Z]{16}'                                 # AWS access key
  'AIza[0-9A-Za-z_-]{35}'                            # Google API key
  'ya29\.[0-9A-Za-z_-]{30,}'                         # Google OAuth access token
  '1//0[0-9A-Za-z_-]{20,}'                           # Google OAuth refresh token
  'gh[pousr]_[A-Za-z0-9]{30,}'                       # GitHub tokens
  'xox[baprs]-[0-9A-Za-z-]{10,}'                     # Slack tokens
  'tskey-[a-z]+-[A-Za-z0-9]{10,}'                    # Tailscale auth key
  'GOCSPX-[A-Za-z0-9_-]{20,}'                        # Google OAuth client secret
  '-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----'
  # Baileys writes the owner JID with an optional device suffix (:N before the @).
  '[0-9]{10,15}(:[0-9]{1,3})?@(s\.whatsapp\.net|lid)'  # real WhatsApp JID
  '["'"'"']?(noiseKey|signedIdentityKey|signedPreKey|advSecretKey|registrationId)["'"'"']?[[:space:]]*[:=]'  # Baileys creds
  '\+[1-9][0-9]{9,14}\b'                             # E.164 phone number
  '(RESTIC_PASSWORD|ANTHROPIC_API_KEY|OPENAI_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|TS_AUTHKEY)[[:space:]]*[=:][[:space:]]*["'"'"']?[A-Za-z0-9_./+-]{12,}'
  # Catch-all for named credentials the list above does not know about.
  '[A-Z][A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY)[A-Z0-9_]*[[:space:]]*[=:][[:space:]]*["'"'"']?[A-Za-z0-9_./+=-]{16,}'
)
# Placeholder values that are fine to commit.
placeholder='(changeme|CHANGEME|REPLACE_ME|<[^>]+>|xxxx|your[-_]|e\.g\.|example|\.\.\.)'

if [[ "$mode" == "all" ]]; then
  files=$(git ls-files)
  content() { cat -- "$1"; }
else
  files=$(git diff --cached --name-only --diff-filter=ACM)
  content() { git show ":$1"; }
fi

# One line may opt out, deliberately and visibly, without disabling the whole check.
marker='check-secrets: allow'

# Copy each file to a temp file once. Reading it through a pipe per pattern hid
# a failing producer behind grep's exit status, and command substitution would
# strip the NUL bytes the binary test depends on.
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

status=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if [[ "$f" =~ $forbidden_paths ]] && ! [[ "$f" =~ $allowed_paths ]]; then
    echo "check-secrets: forbidden file path: $f" >&2
    status=1
    continue
  fi
  set +e
  content "$f" > "$tmp"
  crc=$?
  set -e
  if [[ $crc -ne 0 ]]; then
    echo "check-secrets: cannot read $f (rc=$crc)" >&2
    status=1
    continue
  fi
  # Skip binaries. bash cannot hold a NUL in a variable, so count the NUL bytes
  # kept by tr instead of passing NUL to grep as a pattern. Say so out loud: a
  # single stray NUL makes a whole file invisible to this check.
  if [[ $(LC_ALL=C tr -dc '\000' < "$tmp" | wc -c) -gt 0 ]]; then
    echo "check-secrets: skipping binary $f" >&2
    continue
  fi
  for p in "${patterns[@]}"; do
    # -e is required: some patterns start with "-" and would be read as options.
    # -o prints only the matched text, so the placeholder test below applies to
    # the credential itself and not to the whole line. Matching on the line let
    # one unrelated word ("example", "...") excuse a real secret beside it.
    set +e
    hits=$(grep -noE -e "$p" "$tmp")
    rc=$?
    set -e
    # grep exits 0 on a match and 1 on none. Anything higher is a broken
    # pattern, which would otherwise disable this check while CI stayed green.
    if [[ $rc -gt 1 ]]; then
      echo "check-secrets: grep failed (rc=$rc) on pattern: $p" >&2
      status=1
      continue
    fi
    [[ $rc -eq 0 ]] || continue
    while IFS= read -r hit; do
      [[ -z "$hit" ]] && continue
      lineno=${hit%%:*}
      match=${hit#*:}
      [[ "$match" =~ $placeholder ]] && continue
      line=$(sed -n "${lineno}p" "$tmp")
      [[ "$line" == *"$marker"* ]] && continue
      # Never echo the match: on a CI failure that would write the credential
      # into a retained build log.
      echo "check-secrets: possible secret at $f:$lineno matching /$p/" >&2
      status=1
    done <<< "$hits"
  done
done <<< "$files"

if [[ $status -ne 0 ]]; then
  echo "check-secrets: refusing. Remove the secret, or bypass once with CXW_ALLOW_SECRETS=1." >&2
fi
exit $status
