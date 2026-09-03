import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Acceptance item 5: the manual path in the guide still works unchanged. With none of
 * the phase 10 variables set, bootstrap.sh must behave exactly as it did before. The
 * script is not run here — it needs root and a fresh Ubuntu box — so the guard is
 * asserted by reading it.
 */

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const scriptPath = join(repoRoot, 'deploy', 'hetzner', 'bootstrap.sh');
const script = readFileSync(scriptPath, 'utf8');
const lines = script.split('\n');

/** The 0-based line where a substring first appears in actual code, not a comment. */
function lineOf(needle: string): number {
  const at = lines.findIndex((l) => !l.trim().startsWith('#') && l.includes(needle));
  expect(at, `bootstrap.sh has no line containing ${JSON.stringify(needle)}`).toBeGreaterThanOrEqual(0);
  return at;
}

/**
 * True when `needle` sits inside an `if` block whose condition tests `variable`.
 * Walks backwards counting `fi` and `if` so a nested block is not mistaken for a guard.
 */
function guardedBy(needle: string, variable: string): boolean {
  let depth = 0;
  for (let i = lineOf(needle); i >= 0; i -= 1) {
    const line = (lines[i] as string).trim();
    if (/^fi\b/.test(line)) depth += 1;
    else if (/^if\s/.test(line)) {
      if (depth > 0) depth -= 1;
      // An enclosing `if` that does not test this variable may still sit inside one
      // that does, so keep walking outwards rather than answering here.
      else if (line.includes(`${variable}:-`)) return true;
    }
  }
  return false;
}

describe('bootstrap.sh keeps its pre-phase-10 behaviour', () => {
  it('is still strict-mode and root-only', () => {
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('[[ $EUID -eq 0 ]] || die "run as root"');
  });

  it('guards the cloudflared install behind CXW_TUNNEL_TOKEN', () => {
    expect(guardedBy('cloudflared service install', 'CXW_TUNNEL_TOKEN')).toBe(true);
    expect(guardedBy('pkg.cloudflare.com', 'CXW_TUNNEL_TOKEN')).toBe(true);
    expect(guardedBy('systemctl enable --now cloudflared', 'CXW_TUNNEL_TOKEN')).toBe(true);
  });

  it('guards the console block behind CXW_SETUP_MODE', () => {
    expect(guardedBy('merge_env CONSOLE_REQUIRE_ACCESS', 'CXW_SETUP_MODE')).toBe(true);
    expect(guardedBy('merge_env CONSOLE_HOST', 'CXW_SETUP_MODE')).toBe(true);
    expect(guardedBy('merge_env CONSOLE_PORT', 'CXW_SETUP_MODE')).toBe(true);
  });

  it('guards each optional variable behind its own set-test', () => {
    expect(guardedBy('merge_env CXW_CONSOLE_HOSTNAME', 'CXW_CONSOLE_HOSTNAME')).toBe(true);
    expect(guardedBy('merge_env CF_ACCESS_TEAM', 'CF_ACCESS_TEAM')).toBe(true);
    expect(guardedBy('merge_env CF_ACCESS_AUD', 'CF_ACCESS_AUD')).toBe(true);
  });

  it('reads every new variable with the :- default, so `set -u` never trips', () => {
    for (const name of [
      'CXW_TUNNEL_TOKEN',
      'CXW_SETUP_MODE',
      'CXW_CONSOLE_HOSTNAME',
      'CF_ACCESS_TEAM',
      'CF_ACCESS_AUD',
    ]) {
      const bare = new RegExp(`\\$\\{${name}\\}|\\$${name}\\b`, 'g');
      const guarded = new RegExp(`\\$\\{${name}:-\\}`);
      expect(guarded.test(script), `${name} is never read with a :- default`).toBe(true);
      // The only bare read allowed is inside a block already guarded by that variable.
      for (const match of script.matchAll(bare)) {
        const at = script.slice(0, match.index).split('\n').length - 1;
        const line = lines[at] as string;
        expect(
          line.includes(`${name}:-`) || guardedBy(line.trim(), name),
          `bare read of ${name} on line ${at + 1}: ${line.trim()}`,
        ).toBe(true);
      }
    }
  });

  it('never merges anything into cxw.env unguarded', () => {
    const calls = lines.filter((l) => /^\s*merge_env\s/.test(l));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const variable = (/^\s*merge_env\s+(\w+)/.exec(call) as RegExpExecArray)[1] as string;
      const guardVariable = variable.startsWith('CONSOLE_') || variable === 'TZ' ? 'CXW_SETUP_MODE' : variable;
      expect(guardedBy(call.trim(), guardVariable), `unguarded merge_env: ${call.trim()}`).toBe(true);
    }
  });
});

describe('the user-data shred', () => {
  it('exists, is stamped, and the stamp guards the re-run', () => {
    expect(script).toContain('/var/lib/cloud/instance/user-data.txt');
    expect(script).toContain('/var/lib/cloud/instances/*/user-data.txt');
    const stamp = /CLOUD_INIT_STAMP="([^"]+)"/.exec(script)?.[1];
    expect(stamp).toBe('$CXW_ROOT/state/.user-data-shredded');
    expect(script).toContain('! -f "$CLOUD_INIT_STAMP"');
    expect(guardedBy('shredding the cloud-init user-data', 'CXW_SETUP_MODE')).toBe(true);
  });

  it('also shreds the installer env fragment the payload wrote', () => {
    expect(script).toContain('/root/cxw-installer.env');
  });
});

describe('systemd units', () => {
  it('adds no cxw-tunnel.service — phase 8 owns that filename', () => {
    const unitDir = join(repoRoot, 'deploy', 'hetzner', 'systemd');
    expect(existsSync(unitDir)).toBe(true);
    expect(readdirSync(unitDir)).not.toContain('cxw-tunnel.service');
    expect(script).not.toContain('cxw-tunnel.service');
  });

  it('uses cloudflared its own unit instead', () => {
    expect(script).toContain('cloudflared service install');
    expect(script).toContain('/etc/systemd/system/cloudflared.service');
  });
});

describe('merge_env', () => {
  it('keeps cxw.env root-owned and 0600', () => {
    const body = /merge_env\(\) \{([\s\S]*?)\n\}/.exec(script)?.[1] ?? '';
    expect(body).toContain('install -m 0600 -o root -g root');
    expect(body).toContain('rm -f "$tmp"');
  });
});
