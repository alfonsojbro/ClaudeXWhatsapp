# Phase 0 — audit

## Files changed

- `.gitignore` — ignore `.worktrees/`; drop the gitlink committed by accident.
- `.prettierignore` — ignore `*.md`.
- `apps/{brain,bridge,scheduler}/vitest.config.ts` — new, package-local include.
- `mcp/{google,vault,whatsapp}/vitest.config.ts` — new, package-local include.
- `packages/shared/vitest.config.ts` — new, package-local include.
- `packages/shared/src/index.ts` — formatting only.
- `deploy/hetzner/update.sh` — new.
- `deploy/hetzner/{backup.sh,restore.sh}` — shellcheck source directives.
- `deploy/hetzner/bootstrap.sh` — shellcheck source directive.
- `docs/RUNBOOK.md` — new §0 checklist; TTY, known_hosts and ordering fixes in §3–§5.
- `package.json` — root `test` also runs the root vitest project; `test:root` added.
- `tsconfig.json`, `vitest.config.ts` — formatting only.
- `scripts/check-secrets.sh` — see below.
- `tests/workspace-test-wiring.test.ts` — new guard test.

## Defects found and fixed

Four of these were live in the staged work. None was caught by CI, because every one of
them fails green.

1. **`check-secrets.sh` scanned nothing.** The binary skip used `$'\x00'` as a grep
   pattern. Bash cannot hold a NUL byte, so the pattern was the empty string, which
   matches every file. Every file was classified as binary and skipped before any
   credential pattern ran. Now counts NUL bytes with `tr`.
2. **Patterns starting with `-` were read as grep options.** The private-key pattern was
   permanently inert. Now passed with `-e`.
3. **The private-key pattern used an empty alternative**, which BSD `grep -E` rejects
   outright. Made it an optional group.
4. **`update.sh` never reinstalled systemd units.** The guard was
   `diff -rq src dst --exclude='*'`, and `--exclude='*'` excludes every file, so diff
   always succeeded and the negated branch never ran. Now compares each unit with `cmp`.

## Review round 2

An independent review returned **block**. Fixed in response:

5. **The placeholder filter excused whole lines.** Any line containing `example`, `...`
   or `your-` was dropped, so a real key next to a spread operator or a comment passed.
   The placeholder now tests the matched credential text (`grep -o`), not the line.
6. **The WhatsApp JID pattern missed the shape Baileys writes.** Baileys stores the owner
   id with a device suffix (`:N` before the `@`), which the pattern rejected. A realistic
   `creds.json` passed clean under any filename not on the forbidden-path list. Pattern
   widened, plus a new pattern for Baileys key material.
7. **grep exit status 2 was masked by `|| true`** — the same class as defects 2 and 3.
   Status is now checked and a broken pattern fails the run.
8. **Matched text was echoed to stderr**, which would write the credential into a
   retained CI log. Reports `file:line` and the pattern only.
9. **New patterns**: Google OAuth client secret, and a catch-all for named
   `*_SECRET` / `*_TOKEN` / `*_PASSWORD` / `*_API_KEY` assignments.
10. **RUNBOOK: several commands needed a terminal** but were wrapped in non-interactive
    `ssh host 'cmd'`. The first `git clone` also had no `known_hosts` entry for
    github.com, so it would die on host key verification at step 10. Added `ssh-keyscan`
    steps and `ssh -t` where needed.
11. **RUNBOOK ordering was self-contradictory.** Bootstrap was re-run, starting
    `cxw-brain`, before the Claude token existed. The brain would crash-loop into
    `failed` and then refuse a plain restart. Bootstrap now runs after §4, with a
    `systemctl reset-failed` note.
12. **`update.sh` accepted any argument.** A typo like `--no-resart` restarted production.
    Now rejects unknown arguments, keeps diagnostics on a failed restart, fails loudly if
    the unit glob matches nothing, and enables newly added units.

## Review round 3

Re-review returned **ship** with no blocking issues. Six cheap non-blocking items taken anyway,
because two are the same silent-failure class as the defects above:

13. **`pipefail` still hid a failing content producer.** `content "$f" | grep ...` reports grep's
    status, so a failed `git show` in staged mode read as "no match" and left the file unscanned.
    Each file is now copied once to a temp file with its own status check, which also stops
    re-reading it once per pattern.
14. **A single NUL byte silently skipped a whole file.** It still does, unavoidably, but now says
    so: `check-secrets: skipping binary <file>`.
15. **No way to excuse one line.** The only escape was `CXW_ALLOW_SECRETS=1`, which disables
    everything, and Phase 1's JID fixtures would have invited exactly that. A line carrying the
    marker `check-secrets: allow` is now skipped.
16. **The Baileys key pattern required double-quoted JSON keys**, so a TypeScript fixture using
    an unquoted key name slipped past it. Relaxed to bare, single- and double-quoted forms.
17. **`update.sh` enabled timer-triggered services** that carry no `[Install]` section. Harmless
    today, but under `set -e` a future non-zero return would abort between `daemon-reload` and the
    restart, leaving new code on disk and old processes running. Those two are skipped and the
    enable is guarded.
18. **The wiring guard only checked that a config file exists.** A config with a wrong include glob
    passed while running zero tests, which is the whole failure it was meant to prevent. It now
    parses the include globs and asserts they match every discovered test file. Verified by
    pointing `apps/brain` at `lib/**` and watching it fail.

Also: fixed dangling prose in RUNBOOK §5, noted that both `ssh-keyscan` steps are trust-on-first-use,
and warned at checklist step 5 that bootstrap enables the app services before their env files exist.

## Verification

Run from the worktree on Node 22.23.2 / pnpm 10.34.5. Every CI step green:
`check-secrets`, `lint`, `format:check`, `typecheck`, `test`, and `shellcheck` on
`deploy/hetzner/*.sh scripts/*.sh .githooks/pre-commit`.

`check-secrets` was tested against planted Anthropic, AWS, Tailscale, OpenSSH, Google
OAuth, Baileys `creds.json`, spread-operator and comment-adjacent secrets. All are
caught. `CHANGEME` and documented `...` placeholders are not flagged.

The wiring guard was tested by removing `apps/brain/vitest.config.ts`; it fails with a
named assertion, and passes again once restored.

## Known gaps, not fixed here

- `docs/IMPLEMENTATION_PLAN.md` §3.7 says the deploy key lives at `/root/.ssh/cxw_deploy`.
  Git runs as `cxw`, which cannot read a root-owned 0600 key, so the runbook uses
  `/home/cxw/.ssh/cxw_deploy`. Alfonso decides which document changes.
- `.prettierignore` now covers every markdown file in the repo, not just prose docs.
- No package declares `vitest` as a devDependency; they rely on the root `.bin`.
