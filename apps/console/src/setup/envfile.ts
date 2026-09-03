/**
 * Minimal `KEY=value` editing that preserves the file it was given.
 *
 * This is the file that holds the Anthropic token, so the failure mode that matters is not
 * "the value did not land" — that is loud — but "the rest of the file quietly changed".
 * `cxw.env` on a real box carries the operator's own comments and ordering, and a rewrite
 * that reorders or drops them is a silent regression nobody notices until something else
 * breaks. So: replace in place, append only what is genuinely new, touch nothing else.
 *
 * No quoting layer, deliberately. systemd's `EnvironmentFile` and the repo's own example
 * file both use bare `KEY=value`, and inventing shell quoting here would produce values
 * that read back differently than they were written.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * `KEY=value`, allowing leading whitespace and an optional `export `.
 * Groups: 1 indentation, 2 the `export ` prefix if present, 3 the key, 4 the value.
 * The prefix is captured rather than skipped so a replacement can put it back exactly.
 */
const ASSIGNMENT = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/**
 * Every assignment in the text, last one winning, which is what a shell and systemd both do.
 * Comments and blank lines are ignored.
 */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const hit = ASSIGNMENT.exec(line);
    if (hit === null) continue;
    const key = hit[3];
    if (key === undefined) continue;
    out.set(key, (hit[4] ?? '').replace(/\r$/, '').trim());
  }
  return out;
}

/**
 * Replace the value of each key that already has a line, append the rest.
 *
 * A key that appears more than once has *every* occurrence rewritten, not just the last:
 * leaving a stale earlier line behind would mean the file no longer says one thing, and
 * anything reading it with different last-wins semantics would disagree with us.
 */
export function setEnvValues(text: string, updates: Readonly<Record<string, string>>): string {
  const pending = new Map(Object.entries(updates));
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const seen = new Set<string>();

  const lines = text.split('\n').map((line) => {
    const carriage = line.endsWith('\r');
    const bare = carriage ? line.slice(0, -1) : line;
    const hit = ASSIGNMENT.exec(bare);
    if (hit === null) return line;
    const key = hit[3];
    if (key === undefined || !pending.has(key)) return line;
    seen.add(key);
    const replaced = `${hit[1] ?? ''}${hit[2] ?? ''}${key}=${pending.get(key) ?? ''}`;
    return carriage ? `${replaced}\r` : replaced;
  });

  const appended: string[] = [];
  for (const [key, value] of pending) {
    if (!seen.has(key)) appended.push(`${key}=${value}`);
  }

  let out = lines.join('\n');
  if (appended.length > 0) {
    // Keep exactly one trailing newline before the appended block, and one after it.
    if (out !== '' && !out.endsWith('\n')) out += eol;
    out += appended.join(eol) + eol;
  }
  return out;
}

/** Write the file at mode 0600, atomically. Creates the directory when it is missing. */
export function writeEnvFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid.toString(36)}-${Date.now().toString(36)}`;
  try {
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Nothing to clean up.
    }
    throw error;
  }
}

/** Read the file, or the empty string when it does not exist yet. */
export function readEnvFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** Read, apply the updates, write back at 0600. The one entry point the steps use. */
export function updateEnvFile(path: string, updates: Readonly<Record<string, string>>): void {
  writeEnvFile(path, setEnvValues(readEnvFile(path), updates));
}
