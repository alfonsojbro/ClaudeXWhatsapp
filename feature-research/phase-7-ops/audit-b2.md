# Audit — Phase 7, Implementer B (fix loop 1)

Branch `phase-7-ops`, worktree `/Users/alfonsobriceno/ClaudeXWhatsapp/.worktrees/phase-7-ops`.
No git commands were run except two read-only ones (`git status --short`, `git show :<path>`,
see deviation 3). No file under `apps/` was edited. No live server was touched;
`chaos.sh --box` was never run.

## Files changed

Modified:

- `deploy/hetzner/monitor.sh`
- `deploy/hetzner/cxw-ctl`
- `deploy/hetzner/sudoers.d/cxw-ctl`
- `deploy/hetzner/ops.env.example`
- `deploy/hetzner/install-ops.sh`
- `deploy/hetzner/security-check.sh`
- `deploy/hetzner/chaos.sh`
- `deploy/hetzner/test/cxw-ctl.test.sh`
- `docs/RUNBOOK.md`
- `docs/ARCHITECTURE.md`
- `docs/runs/chaos-2026-09-03.md`

Created:

- `feature-research/phase-7-ops/audit-b2.md` (this file)

Not touched: `deploy/hetzner/chaos/*` (no change was needed), `README.md` (no command signature
changed), everything under `apps/`.

---

## Per review item

### B1 — `monitor.sh` reported `fail` on a healthy box

`problem_count()` ran `printf … | grep -c … || echo 0`. On an empty problem list `grep -c` prints
`0` **and** exits 1, so `|| echo 0` appended a second `0`; `count` became the two-line string
`0\n0` and every `[ "$count" -eq 0 ]` errored into the failure branch.

Now it early-returns `0` when `$problems` is empty and otherwise pipes grep's count through
`tr -d ' '`; no arithmetic is ever done on grep's exit status. A comment records why.

**Evidence** — stub `cxw-ops` printing only `OK` lines, exit 0:

```
$ CXW_STATE_DIR=$T/state CXW_OPS_BIN=$T/stub-ops CXW_CTL=/bin/true CXW_SUDO="" \
    bash deploy/hetzner/monitor.sh
OK bridge - up
OK disk - 12%
costs check: ok
ok
rc=0
$ cat $T/state/monitor.status
ok 2026-09-03T03:51:44Z
```

Before the fix this run printed `[: 0\n0: integer expected` and wrote `fail <ts>`.

Regression cover: chaos scenario 1 now asserts `monitor.status` starts with `ok`, and scenario 2
asserts it reads `ok` again after the post-heal re-check.

### B4 — `cxw-ctl status` and the privileged-helper hardening

- `export PATH=/usr/sbin:/usr/bin:/sbin:/bin` plus `SYSTEMD_PAGER=cat` and
  `SYSTEMD_PAGERSECURE=1` are the first statements after `set -euo pipefail`.
- `status` now execs `systemctl status --no-pager --lines=20 cxw-<unit>`; `vacuum-journal` execs
  `journalctl --no-pager --vacuum-size=200M`. No code path can open a pager, so the
  `less` → `!command` / `v` root shell escape is closed independently of systemd's own
  `SYSTEMD_PAGERSECURE` heuristics.
- `SYSTEMCTL` / `JOURNALCTL` are honoured only when `CXW_CTL_TEST=1` **and** `id -u` ≠ 0.
  Otherwise both are the absolute paths `/usr/bin/systemctl` and `/usr/bin/journalctl`.
- `sudoers.d/cxw-ctl` adds `Defaults!/usr/local/bin/cxw-ctl env_reset` and keeps `!requiretty`,
  with a comment saying the helper sets its own `PATH` and uses absolute paths (see deviation 1
  for why no per-command `secure_path` is declared).

**Evidence** — `deploy/hetzner/test/cxw-ctl.test.sh`, 52 passed / 0 failed. New cases:

```
PASS allow: cxw-ctl status bridge -> status --no-pager --lines=20 cxw-bridge   (× 8 units)
PASS allow: cxw-ctl vacuum-journal -> --no-pager --vacuum-size=200M
PASS guard: SYSTEMCTL override ignored without CXW_CTL_TEST (rc=77, no output)
```

The guard case runs `SYSTEMCTL=echo JOURNALCTL=echo bash cxw-ctl status bridge` with no
`CXW_CTL_TEST`: it exits 77 with empty stdout, proving `echo` was never reached. The suite also
fails loudly if it is ever run as root.

`security-check.sh` still reports `PASS sudoers: deploy/hetzner/sudoers.d/cxw-ctl parses
(visudo -c)` with the two `Defaults!` lines.

### B5 — no `CHANGEME` in `ops.env.example`

`BRIDGE_TOKEN=`, `SMTP_PASS=` and `TELEGRAM_BOT_TOKEN=` now ship empty, each with an
`# empty = disabled` comment; `BRIDGE_TOKEN` additionally says "no Authorization header is sent".
The header comment explains why a committed placeholder is worse than an empty value: the moment
`install-ops.sh` appends it, the placeholder becomes a real credential published in this repo.

**Evidence** — `grep -c CHANGEME deploy/hetzner/ops.env.example` → 0. The matching config-side
change (empty and `CHANGEME` both treated as unset) is Implementer A's.

### S3 — `install-ops.sh` corrupting a `cxw.env` without a trailing newline

Added `ensure_trailing_newline()`, called before the append loop and again before the
`CXW_ALERT_CMD` append. The example-file loop is now `while IFS= read -r line || [ -n "$line" ]`,
so the last line of `ops.env.example` survives even if that file loses its own trailing newline.

**Evidence** — the same logic against a copy of `cxw.env` written with `printf` and **no**
trailing newline (`…ANTHROPIC_API_KEY=sk-secret` with no `\n`, confirmed with `od -c`):

```
--- after ---
TZ=Europe/Prague
ANTHROPIC_API_KEY=sk-secret
CXW_OPS_DB=/srv/cxw/data/ops.sqlite
CXW_OPS_BIN=/usr/local/bin/cxw-ops
key intact: 1                    # ^ANTHROPIC_API_KEY=sk-secret$
first appended key intact: 1     # ^CXW_OPS_DB=/srv/cxw/data/ops.sqlite$
last example key present: 1      # ^CXW_COST_WARN_PCT=80$
CHANGEME count: 0
```

Before the fix this produced `ANTHROPIC_API_KEY=sk-secretCXW_OPS_DB=/srv/cxw/data/ops.sqlite`,
mangling the API key and losing the first appended key.

### S8 — `security-check.sh` redaction check could pass vacuously

The check now iterates `apps/*/src packages/*/src mcp/*/src`, skips any directory that does not
mention `pino`, and for each remaining package requires a file in **that same directory tree**
containing both `redact` and `paths`. It prints one PASS or FAIL line per package and reaches the
SKIP branch only when no package uses pino at all.

**Evidence**:

```
PASS pino redaction: apps/ops declares `redact` with `paths` (apps/ops/src/logger.ts)
```

`apps/ops` is currently the only pino user, so the line count is one — but a future
`apps/bridge` logging without `redact` now produces its own FAIL instead of riding on ops's PASS.

### `google.env`

`install-ops.sh` gained step 5b: when `/srv/cxw/google.env` is absent it writes a root:root 0600
file whose three `GOOGLE_*` keys are commented out, with a header saying Phase 4 fills them in.
An existing file is never overwritten — only re-chowned and re-chmodded. This closes audit-c's
unverifiable claim 4 (`cxw-monitor.service` reads the file with `EnvironmentFile=-` and
`chaos.sh --box` moves it aside, but nothing created it).

Not executable here: `install-ops.sh` needs root and a real box, so this path is `bash -n`- and
shellcheck-clean only (already known limitation 5 in ARCHITECTURE).

### Chaos assertions on `monitor.status`

Scenario 1 now runs `monitor.sh` after the baseline health check and requires
`$CXW_STATE_DIR/monitor.status` to start with `ok`; scenario 2 requires the same after the heal
and post-heal re-check. A helper `monitor_status()` reads the first word, printing `missing` when
the file does not exist so a missing file fails loudly rather than matching an empty string.

### Scenario 6 — the cost cap

Seeds one row into the throwaway `ops.sqlite` `usage` table (`node:sqlite`, schema as in plan §D4
/ `costs.ts`, `cost_usd = 0.02`, `ts = Date.now()`), then runs `cxw-ops costs check` twice with
`CXW_COST_MONTHLY_CAP_USD=0.01`. Asserts: exactly one `[alert:` line on the first run, its text
matching `cost`, and zero `[alert:` lines on the second.

### Docs

- **`docs/RUNBOOK.md`**
  - §11.4 — the `ops.sqlite` integrity check is guarded with `[ -f /srv/cxw/data/ops.sqlite ] &&`,
    plus a paragraph saying an absent `ops.sqlite` on a box that has billed nothing is normal
    (audit-c unverifiable claim 12).
  - §8 — `google.env` added to what `install-ops.sh` installs, and the "fill in the placeholder
    secrets" paragraph rewritten: the optional secrets are appended **empty**, empty means off.
  - §13.1 — the sentinel rule restated as "owner sender, or `from_me = 1` in an owner chat (the
    self-chat)", with the explicit note that "panic" sent to a friend or a group does nothing,
    plus the B3 behaviour (the action runs even when the ack cannot be delivered).
  - §15.1 — a new "Who tells you" paragraph: the monitor tick runs `cxw-ops costs check`, that
    call is what delivers warn/paused down the alert chain, once per month per level, guarded by
    `cost-warned-<YYYY-MM>` and `cost-paused-alerted-<YYYY-MM>`; recording usage never notifies.
- **`docs/ARCHITECTURE.md`**
  - §9 known limitations: dropped the dangling-media item and the busy-timeout item (both fixed
    by A); replaced the "cap warning is consumed by whichever caller crosses first" item with the
    `notifyCap` flow; replaced the `BRIDGE_TOKEN=CHANGEME` item with "optional secrets ship
    empty"; added "a purge refuses to run when the owner allowlist is empty". List renumbered
    1–10, no other item reworded.
  - C1: empty or `CHANGEME` `BRIDGE_TOKEN` both count as unset, so no `Authorization` header is
    sent at all.
  - §7 panic data flow: the sentinel row predicate is now
    `sender ∈ owners OR (from_me = 1 AND jid ∈ owners)`, and `panic(...)` runs before the
    best-effort ack.
- **`docs/runs/chaos-2026-09-03.md`** — the scenario table replaced with the new six-row run
  (`2026-09-03T03:55:53Z`, exit 0), header rows updated to "all six scenarios passed", scenario 1
  and 2 prose extended with the `monitor.status` assertion and why it exists (B1), a new
  "6 — the monthly cost cap" section, and the deviations section kept verbatim — the base
  `CXW_DISK_LIMIT_PCT=100` override did not change.

---

## Verification

All commands run from the worktree root with
`export PATH=$HOME/.nvm/versions/node/v22.23.2/bin:$PATH` (Node v22.23.2), shellcheck 0.11.0.

```
$ shellcheck deploy/hetzner/*.sh deploy/hetzner/cxw-ctl deploy/hetzner/chaos/*.sh deploy/hetzner/test/*.sh
In deploy/hetzner/backup.sh line 22:      SC1090 (pre-existing)
In deploy/hetzner/bootstrap.sh line 26:   SC1091 (pre-existing)
In deploy/hetzner/restore.sh line 18:     SC1090 (pre-existing)
(exit 1 — only the 3 pre-existing findings; cxw-ctl, monitor.sh, chaos.sh, install-ops.sh,
 security-check.sh, chaos/*.sh and test/*.sh are all clean)

$ for f in deploy/hetzner/*.sh deploy/hetzner/cxw-ctl deploy/hetzner/chaos/*.sh deploy/hetzner/test/*.sh; do bash -n "$f"; done
all clean

$ bash deploy/hetzner/test/cxw-ctl.test.sh
cxw-ctl.test.sh: 52 passed, 0 failed          (was 51 passed before this loop)

$ bash deploy/hetzner/security-check.sh --repo
PASS pino redaction: apps/ops declares `redact` with `paths` (apps/ops/src/logger.ts)
SKIP confirm token: no send/create MCP tool implementations exist yet (mcp/*/src)
PASS sudoers: deploy/hetzner/sudoers.d/cxw-ctl parses (visudo -c)
PASS deploy scripts: all of deploy/hetzner/*.sh set -euo/-uo pipefail
security-check: 3 passed, 0 failed, 1 skipped (repo mode)      exit 0
```

B1 reproduction and S3 reproduction: see the B1 and S3 sections above (both run against temp
directories, no repo or system file touched).

```
$ bash deploy/hetzner/chaos.sh --local
chaos exit=0

## Chaos run — local mode — 2026-09-03T03:55:53Z

| Scenario | Expected | Observed | Result |
| --- | --- | --- | --- |
| 1 baseline | health exit 0, no alert, monitor.status ok | exit 0, no alert line, monitor.status ok | PASS |
| 2 bridge down | email alert, HEAL restart bridge, ctl called, recovery on WhatsApp, monitor.status ok after heal | all five observed | PASS |
| 3 google unplugged | google FAILING then recovered, both via WhatsApp | both observed | PASS |
| 4 disk pressure | HEAL purge --emergency, mediaRows>=1, owner media survives, then recovery | mediaRows=3, owner files=1, third-party files=0 | PASS |
| 5 alert dedupe | exactly 1 alert across 3 failing runs | 1 alert line | PASS |
| 6 cost cap | one cost alert on the first check, none on the second | 1 alert then 0 | PASS |

**All scenarios passed.**
```

Run on the first attempt — Implementer A's `notifyCap`, stderr logging and purge-refusal changes
were already in the tree (verified by grepping `notifyCap` in `costs.ts`/`cli.ts` and
`destination({ dest: 2 … })` in `logger.ts` before the run). No retries were needed.

```
$ pnpm exec prettier --write docs README.md && pnpm exec prettier --check docs README.md
All matched files use Prettier code style!    exit 0
```

See deviation 3: that `--write` also reformatted `docs/IMPLEMENTATION_PLAN.md`, which is outside
my file list; it was restored and the `--check` above was re-run scoped to my four doc files.

---

## Deviations from the plan

1. **The sudoers file declares `env_reset` but not `secure_path`.** The fix plan says
   "add `Defaults!/usr/local/bin/cxw-ctl env_reset`", which is what I did; review-1's B4 sketch
   also showed a per-command `secure_path` on the same line. I left `secure_path` out because a
   per-command `Defaults!` `secure_path` is not honoured by every sudo build, and a privileged
   helper must not depend on it — `cxw-ctl` sets `PATH=/usr/sbin:/usr/bin:/sbin:/bin` itself and
   execs both binaries by absolute path, which is strictly stronger. The sudoers comment says so.

2. **No `CHANGEME`-in-`/srv/cxw/*.env` check was added to `security-check.sh`.** Review-1 B5
   suggests one; the fix plan's Implementer B section lists only S8 for that file, so I stayed in
   scope. Worth a follow-up: a box-mode FAIL when any `/srv/cxw/*.env` still contains `CHANGEME`
   would catch a hand-edited file, which the example-file fix alone cannot.

3. **`prettier --write docs README.md` modified `docs/IMPLEMENTATION_PLAN.md`**, which is not in
   my allowed file list (it was already non-compliant with prettier on `main`). I restored it
   byte-for-byte from the git index with `git show :docs/IMPLEMENTATION_PLAN.md > …` — a read-only
   git command plus a file write, no index or ref was changed — and confirmed with
   `git status --short docs/` that only `ARCHITECTURE.md`, `RUNBOOK.md` and
   `runs/chaos-2026-09-03.md` carry my worktree changes. Reformatting that file is a separate
   decision for the orchestrator.

4. **`README.md` was not touched.** The plan allows it "only if a command changed". No command
   signature changed: `cxw-ops costs check` already existed and is merely now called by the
   monitor, which the RUNBOOK documents.

5. **`deploy/hetzner/chaos/*` was not touched.** Scenario 6 needed no new stub or fake — it seeds
   `ops.sqlite` inline with `node -e`, the same way the existing bridge seeding works.

---

## Open risks

1. **`install-ops.sh` is still unexecuted.** The newline guard, the `|| [ -n "$line" ]` loop
   change and the whole `google.env` block are verified only by shellcheck, `bash -n` and the
   extracted-logic S3 reproduction. The real `install`, `visudo -c -f` and
   `systemctl enable --now` paths need the first box run.

2. **`cxw-ctl` cannot be end-to-end tested as root here.** The test suite proves the allowlist and
   the "override ignored outside test mode" guard as a non-root caller. Whether
   `Defaults!/usr/local/bin/cxw-ctl env_reset` behaves as intended under the box's sudo build is
   unverified; `visudo -c` only proves it parses.

3. **Scenario 6 depends on Implementer A's `notifyCap` marker names.** It asserts on behaviour
   ("one alert then none"), not on marker file names, so it survives a rename — but if the second
   `costs check` ever starts delivering again the scenario fails, which is the point.

4. **The chaos run doc records a run of the working tree, not a commit.** Unchanged from
   audit-c's risk 4: the "Commit" row still reads `phase-7-ops` working tree with base `6508f1c`.
