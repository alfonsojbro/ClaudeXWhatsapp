import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
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

function hasTestFile(dir: string): boolean {
  const srcDir = join(dir, 'src');
  if (!existsSync(srcDir)) return false;
  const stack = [srcDir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) stack.push(full);
      else if (entry.endsWith('.test.ts')) return true;
    }
  }
  return false;
}

describe('workspace test wiring', () => {
  const packages = workspacePackages();

  it('finds every workspace package', () => {
    expect(packages.length).toBeGreaterThan(0);
  });

  it.each(packages)('%s declares a test script', (pkg) => {
    const manifest = JSON.parse(readFileSync(join(root, pkg, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(manifest.scripts?.test).toBeTruthy();
  });

  it.each(packages)('%s owns a vitest.config.ts if it has any test file', (pkg) => {
    const dir = join(root, pkg);
    if (!hasTestFile(dir)) return;
    expect(
      existsSync(join(dir, 'vitest.config.ts')),
      `${pkg} has src tests but no vitest.config.ts, so its suites never run`,
    ).toBe(true);
  });
});
