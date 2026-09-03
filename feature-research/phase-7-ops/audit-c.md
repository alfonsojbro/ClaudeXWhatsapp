# Audit — Phase 7, Implementer C (docs)

Branch `phase-7-ops`, worktree `/Users/alfonsobriceno/ClaudeXWhatsapp/.worktrees/phase-7-ops`.
No git commands were run. No file under `apps/` or `deploy/` was edited.

## Files changed

Created:

- `docs/ARCHITECTURE.md`
- `docs/runs/chaos-2026-09-03.md`
- `feature-research/phase-7-ops/audit-c.md` (this file)

Modified:

- `docs/RUNBOOK.md` — sections 1–7 untouched and in place; the intro line rewritten to name both
  phases and link ARCHITECTURE; sections 8–18 appended after 7.
- `README.md` — one `## Operations` section appended; every existing line untouched.

`git status` shows `M README.md`, `M docs/RUNBOOK.md`, `?? docs/ARCHITECTURE.md`,
`?? docs/runs/`. Everything else in the status is Implementer A's and B's work.

## What changed, per file

**`docs/RUNBOOK.md`** — intro rewritten (2 lines → 5) plus new sections:

- **8. Phase 7 install** — `install-ops.sh` after bootstrap, the six things it installs, the
  placeholder secrets to fill, creating `owners.json`, then verification with
  `security-check.sh`, `cxw-ops health`, `systemctl list-timers 'cxw-*'`, `systemctl is-active
cxw-sentinel`.
- **9. Update** — `git pull --ff-only`, `pnpm install --frozen-lockfile`, restart bridge → brain
  → scheduler with sleeps, restart the sentinel, when to re-run `install-ops.sh`.
- **10. Pairing / re-pair** — explicitly marked "(Phase 1)" and sourced from
  IMPLEMENTATION_PLAN §3.1 (`pnpm pair`, QR or pairing code, session in
  `/srv/cxw/data/session/`). Re-pair sequence: stop bridge, move the session aside, pair, start,
  check `cxw-ops health`.
- **11. Restore from restic** — list, scratch restore + integrity + diff, in-place restore with
  the ops units stopped around it, post-restore checks (two `PRAGMA integrity_check` runs,
  bridge journal, `cxw-ops health`, a `status` message), and the "session invalid → re-pair"
  case.
- **12. Rotate tokens** — a table of seven secrets (file, keys, what to restart) plus a
  subsection each for Google, Claude, SMTP/Telegram/BRIDGE_TOKEN, and restic.
- **13. Panic / resume** — the stops-vs-keeps-running table, the WhatsApp path, the sentinel
  path, the SSH path, the flag file and its three effects, and why `resume` is the only correct
  way to clear it.
- **14. Purge and retention** — defaults, the timer, dry-run first, emergency purge, the
  `CXW_RETENTION_OWNER_FOREVER=false` caveat, `CXW_PURGE_VACUUM`.
- **15. Costs and the cap** — the daily line, warn at 80 %, pause at 100 %, `costs unpause`, the
  `TZ` rule.
- **16. Alerts and fallbacks** — the three-channel chain, message format, `CXW_ALERT_TRANSPORT=log`,
  `alert-test`, repeat interval and dedupe, the heal budget.
- **17. Chaos test** — `--local` on the Mac, `--box --i-know` with the explicit warning and a
  post-run verification command.
- **18. Common failures** — 14 rows, symptom → check → fix, covering all 12 required cases.

**`docs/ARCHITECTURE.md`** — new. System diagram (the IMPLEMENTATION_PLAN §2 ASCII extended with
the ops layer: monitor timer, purge timer, sentinel, backup timer, sudo → `cxw-ctl` → systemctl);
the 10-row unit table; contracts C1–C10 with the exact signatures from `apps/ops/src/index.ts`
and the `cxw-ops` CLI contract table from plan §I1; the `essential: true` OR `kind: health`
note under C7 with what ops expects and what the scheduler must do; the alert data flow
(health → reconcile → deliver → heal) and the `panic` data flow (both paths, converging on
`killswitch.panic()`); the 12-row state-file table; the security model with a CAN/CANNOT table
for the ops user; retention and cost tables; and 11 known limitations drawn from the two audits.

**`docs/runs/chaos-2026-09-03.md`** — new. Header table (date, mode, command, commit, Node,
result), the scenario table copied verbatim from `chaos-local-output.txt`, a per-scenario "what
was exercised" section naming the stub killed or toggled, whether a heal fired, and which channel
carried each alert; three deviations; and the "next: run `--box`" instruction.

**`README.md`** — `## Operations` with the three doc links, the `cxw-ops` one-liner, the WhatsApp
owner commands, the three env files, and the never-commit reminder.

## Accuracy method

Every command, path, env key, unit name and flag was read out of the repo before it was written:
`apps/ops/src/{index,cli,commands,state,health,alerts,costs,killswitch,sentinel,retention,config}.ts`,
`apps/ops/README.md`, all ten systemd units, `cxw-ctl`, `sudoers.d/cxw-ctl`, `install-ops.sh`,
`monitor.sh`, `security-check.sh`, `chaos.sh`, `backup.sh`, `restore.sh`, `alert.sh`,
`ops.env.example`, `cxw.env.example`, `restic.env.example`, `docs/IMPLEMENTATION_PLAN.md`
§§2, 3.1, 3.2, 3.6, 4, 5, 6, the existing `docs/RUNBOOK.md`, and both audits.

## Verification

```
pnpm exec prettier --write docs/RUNBOOK.md docs/ARCHITECTURE.md docs/runs/chaos-2026-09-03.md README.md
docs/RUNBOOK.md 98ms
docs/ARCHITECTURE.md 97ms
docs/runs/chaos-2026-09-03.md 18ms
README.md 4ms (unchanged)

pnpm exec prettier --check docs/RUNBOOK.md docs/ARCHITECTURE.md docs/runs/chaos-2026-09-03.md README.md
Checking formatting...
All matched files use Prettier code style!
exit=0
```

Node v22.23.2. No tests apply to a docs-only change.

## Deviations from the plan

1. **The plan's §D11 RUNBOOK list is a superset ordering, not a section numbering.** I appended
   8–18 after the existing 7 as instructed, so the Phase 0 "Day-to-day" (6) and "acceptance
   checklist" (7) keep their numbers. Numbering stays monotonic; nothing was renumbered.
2. **`docs/RUNBOOK.md` §9 adds a sentinel restart** that the plan's one-line sketch does not
   mention. `cxw-sentinel` runs `cxw-ops` out of the same checkout, so a `git pull` leaves it on
   stale code until it is restarted.
3. **§11.3 adds "stop the ops units around an in-place restore".** `restore.sh` stops only
   bridge, brain and scheduler; the monitor timer, purge timer and sentinel all write to
   `state/`, which the restore replaces.
4. **§12 documents seven secrets, not the plan's five.** `BRIDGE_TOKEN` and `ANTHROPIC_API_KEY`
   were added because both are live keys in `cxw.env`/`ops.env.example`.

## Claims I could NOT verify against the repo

These are the lines a reviewer should check hardest. Everything not listed here was read out of a
file in this worktree.

1. **restic key rotation (§12.4)** — `restic key list`, `restic key add`, `restic key remove
<id>`, and `restic snapshots --tag cxw --latest 1`. Only `restic snapshots --tag cxw`,
   `restic backup`, `restic forget`, `restic check`, `restic init`, `restic restore` and
   `restic cat config` appear in the repo (`backup.sh`, `restore.sh`). The `key` subcommands and
   `--latest 1` are from restic's own CLI and are not exercised anywhere here. The **reason** for
   the procedure (overwriting `RESTIC_PASSWORD` alone orphans the repository) is a property of
   restic, not of this repo.
2. **`pnpm pair` (§10)** — comes from `docs/IMPLEMENTATION_PLAN.md` §3.1. There is no
   `apps/bridge` and no `pair` script anywhere in the repo yet. Marked "(Phase 1)" in the text.
   The re-pair sequence (stop, move session aside, pair, start) is my construction from that one
   plan line plus the documented session path `/srv/cxw/data/session/`; nothing validates it.
3. **`sudo -u cxw -H claude auth login` / `claude auth status` / `claude setup-token`** — carried
   over from the existing Phase 0 RUNBOOK §4, not re-verified against a `claude` binary.
4. **`/srv/cxw/google.env`** — referenced by `cxw-monitor.service`
   (`EnvironmentFile=-/srv/cxw/google.env`) and by `chaos.sh --box`, but **nothing in the repo
   creates it**. `bootstrap.sh` creates only `cxw.env` and `restic.env`. Section 12.1 tells the
   operator to edit a file that may not exist; the Phase 4 owner should create it, or
   `install-ops.sh` should. Flagged rather than papered over.
5. **`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` live in `google.env`.**
   `config.ts` reads them from the process environment and does not care which file supplies
   them; the file assignment is inferred from `cxw-monitor.service`'s `EnvironmentFile=-` line
   and the plan. They could equally be put in `cxw.env`.
6. **The C7 rule "`essential: true` OR `kind: health`"** — supplied by the orchestrator from the
   Phase 5 plan, which is in a sibling worktree I did not read. `apps/ops` never reads routine
   frontmatter, so nothing in this repo can confirm or refute it. I stated explicitly in
   ARCHITECTURE §C7 that ops publishes only the flags and the classification lives in the
   scheduler.
7. **"`memory-consolidate` has no `kind: health` to fall back on"** (ARCHITECTURE §C7) — inferred
   from plan §C7's parenthetical "(health-check, memory-consolidate)". The Phase 5 routine files
   do not exist yet.
8. **`sqlite3` is installed on the box** (§11.4 runs `sqlite3 … "PRAGMA integrity_check;"`).
   `backup.sh` and `restore.sh` both call `sqlite3`, so it must be, but I did not read
   `bootstrap.sh`'s package list to confirm it is installed there.
9. **The bridge journal shows "WhatsApp reconnecting, not a logout loop"** (§11.4, §18) — a
   behavioural prediction about Phase 1 code that does not exist. Same for "the bridge logging
   out on start" as the session-invalid symptom in §11.5.
10. **Restart timings** — the `sleep 5` between service restarts in §9 is my choice, not a
    documented requirement. `TimeoutStopSec=30` in the units is the only related fact in the repo.
11. **`du -sh /srv/cxw/data/*` and `df -h /srv/cxw/data`** in the failures table — standard tools,
    not referenced anywhere in the repo.
12. **"`ops.sqlite` integrity check"** (§11.4) — `ops.sqlite` is created on demand by
    `costs.ts`. On a fresh box that has recorded no usage the file does not exist yet and the
    command errors. The text does not warn about that.

## Open risks

1. **The `google.env` gap (claim 4 above) is a real operational hole**, not just an unverified
   doc line. Someone should decide whether Phase 4 or `install-ops.sh` creates it, and the
   RUNBOOK should then say so.
2. **§12's "Restart: none" for SMTP and Telegram** is correct only while the sole alert sender is
   the oneshot `cxw-monitor.service`. If a long-running process ever delivers alerts, that column
   becomes wrong.
3. **ARCHITECTURE §9 "Known limitations" restates the two audits' open risks.** If A or B fix any
   of them in a review loop, that list must be updated with them.
4. **The chaos run doc records a run of the working tree, not of a commit.** Once the branch is
   committed, the "Commit" row should be replaced with the real SHA, or the run repeated.
