#!/usr/bin/env bash
# check-secrets: refuse to commit files that look like they contain credentials.
#
# Usage:
#   scripts/check-secrets.sh          # scan staged files (pre-commit)
#   scripts/check-secrets.sh --all    # scan every tracked file (CI)
#   CXW_ALLOW_SECRETS=1 git commit    # bypass, on purpose, once
set -euo pipefail

mode="staged"
[[ "${1:-}" == "--all" ]] && mode="all"

if [[ "${CXW_ALLOW_SECRETS:-0}" == "1" ]]; then
  echo "check-secrets: bypassed via CXW_ALLOW_SECRETS=1" >&2
  exit 0
fi

# Files that must never be committed, whatever they contain.
forbidden_paths='(^|/)(\.env|\.env\.[^/]+|[^/]*\.env|google\.env|credentials\.json|token\.json|creds\.json)$|(^|/)session/|(^|/)\.obsidian/workspace.*\.json$|(^|/)id_(rsa|ed25519)$'
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
  '-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----'
  '(RESTIC_PASSWORD|ANTHROPIC_API_KEY|OPENAI_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|TS_AUTHKEY)[[:space:]]*[=:][[:space:]]*["'"'"']?[A-Za-z0-9_./+-]{12,}'
)
# Placeholder values that are fine to commit.
placeholder='(changeme|CHANGEME|REPLACE_ME|<[^>]+>|xxxx|your[-_]|\.\.\.)'

if [[ "$mode" == "all" ]]; then
  files=$(git ls-files)
  content() { cat -- "$1"; }
else
  files=$(git diff --cached --name-only --diff-filter=ACM)
  content() { git show ":$1"; }
fi

status=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if [[ "$f" =~ $forbidden_paths ]] && ! [[ "$f" =~ $allowed_paths ]]; then
    echo "check-secrets: forbidden file path: $f" >&2
    status=1
    continue
  fi
  # Skip binaries. bash cannot hold a NUL in a variable, so match on the byte
  # count of NULs kept by tr instead of passing NUL to grep as a pattern.
  if [[ $(content "$f" | LC_ALL=C tr -dc '\000' | wc -c) -gt 0 ]]; then continue; fi
  for p in "${patterns[@]}"; do
    # -e is required: some patterns start with "-" and would be read as options.
    hits=$(content "$f" | grep -nE -e "$p" | grep -vE -e "$placeholder" || true)
    if [[ -n "$hits" ]]; then
      echo "check-secrets: possible secret in $f:" >&2
      echo "$hits" | sed 's/^/    /' | cut -c1-160 >&2
      status=1
    fi
  done
done <<< "$files"

if [[ $status -ne 0 ]]; then
  echo "check-secrets: refusing. Remove the secret, or bypass once with CXW_ALLOW_SECRETS=1." >&2
fi
exit $status
