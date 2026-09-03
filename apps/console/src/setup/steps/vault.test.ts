import { describe, expect, it } from 'vitest';
import { setVaultRemote, SSH_COMMAND, validateRemoteUrl } from './vault.js';
import type { RunGit, RunResult } from './vault.js';

const VAULT = '/srv/cxw/repo/vault';

/** A fake git that answers `remote get-url` from a variable and records every call. */
function fakeGit(initial: string | null): { run: RunGit; calls: string[][]; url: () => string | null } {
  let url = initial;
  const calls: string[][] = [];
  const run: RunGit = (args, cwd) => {
    expect(cwd).toBe(VAULT);
    calls.push([...args]);
    const ok = (stdout = ''): Promise<RunResult> => Promise.resolve({ code: 0, stdout, stderr: '' });
    if (args[0] === 'remote' && args[1] === 'get-url') {
      return url === null
        ? Promise.resolve({ code: 2, stdout: '', stderr: 'No such remote' })
        : ok(`${url}\n`);
    }
    if (args[0] === 'remote' && (args[1] === 'add' || args[1] === 'set-url')) {
      url = args[3] ?? '';
      return ok();
    }
    if (args[0] === 'config') return ok();
    return Promise.resolve({ code: 1, stdout: '', stderr: 'unexpected' });
  };
  return { run, calls, url: () => url };
}

describe('validateRemoteUrl', () => {
  it('accepts the forms GitHub prints', () => {
    expect(validateRemoteUrl('git@github.com:alfonsojbro/vault.git')).toBe(
      'git@github.com:alfonsojbro/vault.git',
    );
    expect(validateRemoteUrl('https://github.com/alfonsojbro/vault.git')).toBe(
      'https://github.com/alfonsojbro/vault.git',
    );
    expect(validateRemoteUrl(' ssh://git@github.com:22/alfonsojbro/vault.git ')).toBe(
      'ssh://git@github.com:22/alfonsojbro/vault.git',
    );
  });

  it('rejects an empty value', () => {
    expect(() => validateRemoteUrl('  ')).toThrow(/Paste the repository URL/);
  });

  it('rejects every shell metacharacter', () => {
    for (const bad of [
      'git@github.com:a/b.git; rm -rf /',
      'git@github.com:a/b.git && curl evil',
      'git@github.com:a/b.git | sh',
      'git@github.com:a/`whoami`.git',
      'git@github.com:a/$(id).git',
      'git@github.com:a/b.git\nnext',
      "git@github.com:a/'b'.git",
    ]) {
      expect(() => validateRemoteUrl(bad), bad).toThrow(/characters a git remote never contains/);
    }
  });

  it('rejects a value that would be read as a git flag', () => {
    expect(() => validateRemoteUrl('--upload-pack=evil')).toThrow(/cannot start with a dash/);
  });

  it('rejects plain http, a bare path and a file URL', () => {
    for (const bad of ['http://github.com/a/b.git', '/tmp/repo', 'file:///tmp/repo']) {
      expect(() => validateRemoteUrl(bad), bad).toThrow(/does not look like a git remote/);
    }
  });
});

describe('setVaultRemote', () => {
  it('adds the remote when there is none, and sets core.sshCommand', async () => {
    const git = fakeGit(null);
    const result = await setVaultRemote(VAULT, 'git@github.com:me/vault.git', git.run);
    expect(result).toEqual({ url: 'git@github.com:me/vault.git', action: 'added' });
    expect(git.calls).toContainEqual(['remote', 'add', 'origin', 'git@github.com:me/vault.git']);
    expect(git.calls).toContainEqual(['config', 'core.sshCommand', SSH_COMMAND]);
  });

  it('uses set-url when a different remote already exists', async () => {
    const git = fakeGit('git@github.com:me/old.git');
    const result = await setVaultRemote(VAULT, 'git@github.com:me/new.git', git.run);
    expect(result.action).toBe('updated');
    expect(git.calls).toContainEqual(['remote', 'set-url', 'origin', 'git@github.com:me/new.git']);
    expect(git.calls.some((c) => c[1] === 'add')).toBe(false);
  });

  it('is a no-op on a second run with the same URL', async () => {
    const git = fakeGit(null);
    await setVaultRemote(VAULT, 'git@github.com:me/vault.git', git.run);
    const before = git.calls.length;
    const second = await setVaultRemote(VAULT, 'git@github.com:me/vault.git', git.run);
    expect(second.action).toBe('unchanged');
    // Only the get-url probe and the idempotent config call.
    expect(git.calls.slice(before).map((c) => c[0])).toEqual(['remote', 'config']);
    expect(git.url()).toBe('git@github.com:me/vault.git');
  });

  it('never passes the URL anywhere but as its own argv element', async () => {
    const git = fakeGit(null);
    await setVaultRemote(VAULT, 'git@github.com:me/vault.git', git.run);
    for (const call of git.calls) {
      expect(call.some((arg) => arg.includes(' git@'))).toBe(false);
    }
  });

  it('reports a git failure rather than claiming success', async () => {
    const failing: RunGit = (args) =>
      args[1] === 'add'
        ? Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: not a git repository' })
        : Promise.resolve({ code: 2, stdout: '', stderr: '' });
    await expect(setVaultRemote(VAULT, 'git@github.com:me/v.git', failing)).rejects.toThrow(
      /not a git repository/,
    );
  });

  it('validates before running any git at all', async () => {
    const git = fakeGit(null);
    await expect(setVaultRemote(VAULT, 'x; rm -rf /', git.run)).rejects.toThrow();
    expect(git.calls).toHaveLength(0);
  });
});
