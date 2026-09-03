# ClaudeXWhatsapp vault

Obsidian vault owned by the assistant on the Hetzner box. Open this folder in Obsidian on the Mac.

| Folder | Written by | Purpose |
| --- | --- | --- |
| `raw/` | assistant | Captures: `raw/<type>-<kebab-topic>.md` with `source:` and `captured:` first lines |
| `wiki/` | nightly `compile` routine | Compiled topic pages with `[[links]]` |
| `memory/` | assistant | One fact per file + `memory/MEMORY.md` index |
| `routines/` | Alfonso or assistant | One routine per file, cron in frontmatter |
| `runs/` | scheduler | Run logs `runs/<routine>/<timestamp>.md` |

Rules: the box commits after every write and pulls `--rebase` before writing. Never delete `raw/` files.
Never store credentials or verification codes here. Only `.obsidian/app.json` is tracked.
