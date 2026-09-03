import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Acceptance scan for the plan's "nothing is stored" and "the browser bundle is
 * browser-only" claims. It reads the shipped files rather than trusting convention.
 */

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCANNED_DIRS = ['src', 'functions', 'public'];

/** Every storage or binding API the installer must never touch. */
const FORBIDDEN_TOKENS: readonly string[] = [
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches.',
  'document.cookie',
  'KVNamespace',
  'D1Database',
  'R2Bucket',
  'DurableObject',
];

function walk(dir: string): string[] {
  const found: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of readdirSync(current)) {
      if (entry === 'assets' || entry === 'node_modules') continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) stack.push(full);
      else found.push(full);
    }
  }
  return found.sort();
}

const shippedFiles = SCANNED_DIRS.flatMap((dir) => walk(join(packageRoot, dir)));

describe('no storage of any kind', () => {
  it('scans a non-trivial number of files', () => {
    expect(shippedFiles.length).toBeGreaterThan(10);
  });

  it.each(FORBIDDEN_TOKENS)('no shipped file mentions %s', (token) => {
    const offenders: string[] = [];
    for (const file of shippedFiles) {
      const source = readFileSync(file, 'utf8');
      // This test file names every token by definition; skip only itself.
      if (file === fileURLToPath(import.meta.url)) continue;
      if (source.includes(token)) offenders.push(`${relative(packageRoot, file)} mentions "${token}"`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

/** Resolve a relative specifier with a .js suffix back to the .ts source on disk. */
function resolveImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const asTs = resolve(dirname(fromFile), specifier.replace(/\.js$/, '.ts'));
  return asTs;
}

/**
 * Walk the runtime import graph from `src/index.ts`.
 *
 * `import type` is skipped on purpose: `verbatimModuleSyntax` erases those statements
 * entirely, so they add no runtime edge. That is what lets `steps.ts` name
 * `CloudInitInput` without pulling the node-only `cloud-init.ts` into the browser.
 */
function runtimeGraph(entry: string): { files: string[]; nodeImports: string[] } {
  const files: string[] = [];
  const nodeImports: string[] = [];
  const stack = [entry];
  const seen = new Set<string>();

  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);

    const source = readFileSync(file, 'utf8');
    const statements = [
      ...source.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/gm),
      ...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
    ];
    for (const match of statements) {
      const isType = match[1]?.trim() === 'type';
      const specifier = (match[2] ?? match[1]) as string;
      if (isType) continue;
      if (specifier.startsWith('node:')) {
        nodeImports.push(`${relative(packageRoot, file)} imports ${specifier}`);
        continue;
      }
      const target = resolveImport(file, specifier);
      if (target !== null) stack.push(target);
    }
  }
  return { files, nodeImports };
}

describe('browser entry point', () => {
  const entry = join(packageRoot, 'src', 'index.ts');
  const graph = runtimeGraph(entry);

  it('reaches the modules the page needs', () => {
    const names = graph.files.map((f) => relative(packageRoot, f));
    for (const expected of [
      'src/index.ts',
      'src/ssh-key.ts',
      'src/cloudflare.ts',
      'src/hetzner.ts',
      'src/health.ts',
      'src/steps.ts',
      'src/redact.ts',
      'src/cloud-init-core.ts',
      'src/bootstrap-command.ts',
      'src/providers/types.ts',
      'src/providers/hetzner.ts',
      'src/providers/manual.ts',
    ]) {
      expect(names, `index.ts does not reach ${expected}`).toContain(expected);
    }
  });

  it('never reaches the node-only cloud-init loader', () => {
    expect(graph.files.map((f) => relative(packageRoot, f))).not.toContain('src/cloud-init.ts');
  });

  it('imports no node: builtin anywhere in that graph', () => {
    expect(graph.nodeImports, graph.nodeImports.join('\n')).toEqual([]);
  });

  it('proves the walker actually finds node: imports, by walking cloud-init.ts', () => {
    const control = runtimeGraph(join(packageRoot, 'src', 'cloud-init.ts'));
    expect(control.nodeImports.join('\n')).toContain('node:fs');
  });
});

/** Drop comments so a prose mention of `env` is not read as a binding. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the Pages Function is stateless', () => {
  const file = join(packageRoot, 'functions', 'api', '[[route]].ts');
  const source = stripComments(readFileSync(file, 'utf8'));

  it('reads no env binding', () => {
    for (const pattern of [/\benv\b/, /context\.env/, /\bEnv\b/]) {
      expect(pattern.test(source), `functions/api/[[route]].ts matches ${pattern}`).toBe(false);
    }
  });

  it('takes only the request off its context', () => {
    const contextType = /interface PagesContext \{([\s\S]*?)\}/.exec(source)?.[1] ?? '';
    const fields = [...contextType.matchAll(/^\s*(?:readonly\s+)?(\w+)\s*:/gm)].map((m) => m[1]);
    expect(fields).toEqual(['request']);
  });

  it('sets no cookie and logs nothing', () => {
    expect(source.includes('Set-Cookie')).toBe(false);
    expect(source.includes('set-cookie')).toBe(false);
    expect(/\bconsole\.\w+\(/.test(source)).toBe(false);
  });
});
