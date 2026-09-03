import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Vitest resolves its config by walking up from the working directory. A package
 * without its own vitest.config.ts therefore inherits the repo root config, whose
 * `include` only globs `tests/`. It then finds none of its own suites and, because
 * every package runs `vitest run --passWithNoTests`, reports green with zero tests.
 *
 * That failure is silent and survives CI, so it is asserted here rather than left
 * to convention.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const groups = ['apps', 'mcp', 'packages'];

function workspacePackages(): string[] {
  const found: string[] = [];
  for (const group of groups) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir)) {
      const dir = join(groupDir, entry);
      if (!statSync(dir).isDirectory()) continue;
      if (existsSync(join(dir, 'package.json'))) found.push(`${group}/${entry}`);
    }
  }
  return found.sort();
}

/** Paths of every test file under a package, relative to the package root. */
function testFiles(dir: string): string[] {
  const srcDir = join(dir, 'src');
  if (!existsSync(srcDir)) return [];
  const found: string[] = [];
  const stack = [srcDir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) stack.push(full);
      else if (entry.endsWith('.test.ts')) found.push(relative(dir, full));
    }
  }
  return found;
}

/** The quoted globs in the config's `include` array. */
function includeGlobs(configPath: string): string[] {
  const source = readFileSync(configPath, 'utf8');
  const block = /include\s*:\s*\[([^\]]*)\]/.exec(source);
  if (block === null) return [];
  return [...block[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
}

/** Minimal glob matcher covering the ** / * / ? forms vitest configs use here. */
function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` spans zero or more directories; a bare `**` spans anything.
        if (glob[i + 2] === '/') {
          out += '(?:[^/]*/)*';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

describe('workspace test wiring', () => {
  const packages = workspacePackages();

  it('finds every workspace package', () => {
    expect(packages.length).toBeGreaterThan(0);
  });

  it.each(packages)('%s runs vitest from its test script', (pkg) => {
    const manifest = JSON.parse(readFileSync(join(root, pkg, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(manifest.scripts?.test ?? '').toContain('vitest');
  });

  it.each(packages)('%s has a vitest config whose include covers its tests', (pkg) => {
    const dir = join(root, pkg);
    const files = testFiles(dir);
    if (files.length === 0) return;

    const configPath = join(dir, 'vitest.config.ts');
    expect(
      existsSync(configPath),
      `${pkg} has src tests but no vitest.config.ts, so vitest inherits the root ` +
        `config, matches nothing, and --passWithNoTests reports green`,
    ).toBe(true);

    // Existence is not enough: a config with the wrong glob also runs zero tests.
    const globs = includeGlobs(configPath).map(globToRegExp);
    expect(globs.length, `${pkg} vitest.config.ts declares no include globs`).toBeGreaterThan(0);
    for (const file of files) {
      expect(
        globs.some((g) => g.test(file)),
        `${pkg} vitest.config.ts include does not match ${file}`,
      ).toBe(true);
    }
  });
});
