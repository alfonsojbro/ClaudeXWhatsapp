/**
 * Step 6: give the vault a git remote. Optional, and skippable.
 *
 * The second and last place anything under the vault is touched, and it touches only the
 * repository's own config: `git remote add|set-url` and `core.sshCommand`. No file in the vault
 * is written. `guardrails.test.ts` asserts that.
 *
 * Every git invocation passes its arguments as an array with no shell, and the remote URL is
 * validated before it gets there. That is belt and braces on purpose: the URL is pasted by a
 * person into a form, and a remote is one of the few strings in this wizard that later ends up
 * as an argument to a program that will happily run whatever it is given.
 */

import type { ChildProcess } from 'node:child_process';

/** The deploy key the installer put on the box, used for the vault too. */
export const SSH_COMMAND = 'ssh -i /root/.ssh/cxw_deploy -o IdentitiesOnly=yes';
export const REMOTE_NAME = 'origin';

export class VaultRemoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultRemoteError';
  }
}

/**
 * Anything that could be read as a shell operator, a flag, or a second command.
 *
 * The leading `-` matters as much as the metacharacters: `--upload-pack=…` in a URL position is
 * a known way to turn a clone into command execution, and a remote beginning with `-` is a
 * flag, not a URL.
 */
const FORBIDDEN = /[;&|`$(){}<>\\\n\r\t"']/;

/**
 * Accept only the two forms a person actually has: `git@host:owner/repo.git`, and
 * `https://host/owner/repo(.git)`. `ssh://` is accepted too, since GitHub prints it.
 */
export function validateRemoteUrl(input: string): string {
  const url = String(input ?? '').trim();
  if (url === '') throw new VaultRemoteError('Paste the repository URL, or skip this step.');
  if (FORBIDDEN.test(url)) {
    throw new VaultRemoteError('That URL has characters a git remote never contains. Paste it again.');
  }
  if (url.startsWith('-')) {
    throw new VaultRemoteError('A repository URL cannot start with a dash.');
  }
  if (/^https:\/\/[A-Za-z0-9.-]+\/[\w.\-~/]+$/.test(url)) return url;
  if (/^ssh:\/\/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+(?::\d+)?\/[\w.\-~/]+$/.test(url)) return url;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[\w.\-~/]+$/.test(url)) return url;
  throw new VaultRemoteError(
    'That does not look like a git remote. Use git@github.com:you/vault.git or ' +
      'https://github.com/you/vault.git.',
  );
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run one git command, arguments as an array, never through a shell. */
export type RunGit = (args: readonly string[], cwd: string) => Promise<RunResult>;

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly stdio: readonly ['ignore', 'pipe', 'pipe'] },
) => ChildProcess;

/** Adapt a `child_process.spawn` into a `RunGit`. */
export function gitRunner(spawn: SpawnLike): RunGit {
  return (args, cwd) =>
    new Promise<RunResult>((resolve) => {
      const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error: Error) => {
        resolve({ code: 127, stdout, stderr: error.message });
      });
      child.on('close', (code: number | null) => {
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
}

export interface SetRemoteResult {
  readonly url: string;
  /** 'added' the first time, 'updated' when a remote already existed, 'unchanged' on a re-run. */
  readonly action: 'added' | 'updated' | 'unchanged';
}

/**
 * Point the vault at a remote and tell git which key to use.
 *
 * `git remote add` fails when the remote exists, so the existing URL is read first and the call
 * branches. A second run with the same URL does nothing at all and says so, which is what makes
 * the step re-runnable.
 */
export async function setVaultRemote(
  vaultDir: string,
  remoteUrl: string,
  runGit: RunGit,
): Promise<SetRemoteResult> {
  const url = validateRemoteUrl(remoteUrl);

  const existing = await runGit(['remote', 'get-url', REMOTE_NAME], vaultDir);
  const current = existing.code === 0 ? existing.stdout.trim() : '';

  let action: SetRemoteResult['action'];
  if (current === '') {
    const added = await runGit(['remote', 'add', REMOTE_NAME, url], vaultDir);
    if (added.code !== 0) {
      throw new VaultRemoteError(`git could not add the remote: ${added.stderr.trim()}`);
    }
    action = 'added';
  } else if (current === url) {
    action = 'unchanged';
  } else {
    const updated = await runGit(['remote', 'set-url', REMOTE_NAME, url], vaultDir);
    if (updated.code !== 0) {
      throw new VaultRemoteError(`git could not update the remote: ${updated.stderr.trim()}`);
    }
    action = 'updated';
  }

  // Always set the ssh command, even on 'unchanged': a restored box can have the remote
  // already and still not know which key to present.
  const configured = await runGit(['config', 'core.sshCommand', SSH_COMMAND], vaultDir);
  if (configured.code !== 0) {
    throw new VaultRemoteError(`git could not set core.sshCommand: ${configured.stderr.trim()}`);
  }
  return { url, action };
}
