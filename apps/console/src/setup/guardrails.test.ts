import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Three properties of the wizard that are invisible in any single file, and that a later
 * change could break without failing any other test. Each is asserted by reading the source.
 *
 *  1. **The wizard cannot approve a confirm token.** Approval is the owner replying `yes <TOKEN>`
 *     in WhatsApp, HMAC-bound to a chat JID. A browser control for it would be a second, weaker
 *     path to the same authority — and one reachable by anyone who ever gets a session cookie.
 *  2. **The wizard writes in four places only.** The state directory, `cxw.env`, `google.env`,
 *     and inside the vault exactly two things: a routine's `enabled:` line and the vault repo's
 *     own git config. No credential, no captured content, nothing else, ever.
 *  3. **No secret reaches a rendered page.** Not into a form value, not into a confirmation, not
 *     into an error. The page shows at most the last four characters of a saved credential.
 */

const setupDir = fileURLToPath(new URL('.', import.meta.url));
const SELF = 'guardrails.test.ts';

interface SourceFile {
  readonly path: string;
  readonly name: string;
  readonly text: string;
  readonly isTest: boolean;
}

function allFiles(): readonly SourceFile[] {
  const found: SourceFile[] = [];
  const stack = [setupDir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      found.push({
        path: full,
        name: relative(setupDir, full),
        text: readFileSync(full, 'utf8'),
        isTest: entry.endsWith('.test.ts'),
      });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

const FILES = allFiles();
/** This file necessarily names the forbidden strings, so it is excluded from its own scan. */
const OTHERS = FILES.filter((file) => !file.name.endsWith(SELF));
const SOURCES = OTHERS.filter((file) => !file.isTest);

describe('the wizard has no confirm-token surface', () => {
  it('found the source tree it is meant to scan', () => {
    expect(OTHERS.length).toBeGreaterThan(20);
    expect(SOURCES.map((f) => f.name)).toContain('router.ts');
  });

  it.each(OTHERS.map((file) => file.name))('%s references no confirm-token machinery', (name) => {
    const file = OTHERS.find((candidate) => candidate.name === name);
    expect(file).toBeDefined();
    const text = file?.text ?? '';
    for (const needle of ['mint(', 'consume(', 'confirms.json', 'CONFIRM_SECRET']) {
      expect(text.includes(needle), `${name} references ${needle}`).toBe(false);
    }
  });

  it('has no route that could approve anything', () => {
    const router = SOURCES.find((file) => file.name === 'router.ts');
    const text = router?.text ?? '';
    for (const needle of ['/approve', 'approve(', 'confirmToken', 'confirm_token']) {
      expect(text.includes(needle), `router.ts references ${needle}`).toBe(false);
    }
  });
});

describe('the only write paths are the four the plan allows', () => {
  const WRITE_CALL = /\b(writeFileSync|writeFile|renameSync|rename|appendFileSync|rmSync|unlinkSync)\s*\(\s*([^,)\s]+)/g;

  /** The only modules allowed to write a file at all. */
  const WRITERS = ['envfile.ts', 'state.ts', 'steps/owner.ts', 'steps/routines.ts'];

  function writeCalls(text: string): readonly { call: string; target: string }[] {
    return [...text.matchAll(WRITE_CALL)].map((match) => ({
      call: match[1] ?? '',
      target: match[2] ?? '',
    }));
  }

  it('no module outside the allowed four writes a file', () => {
    for (const file of SOURCES) {
      const calls = writeCalls(file.text);
      if (calls.length === 0) continue;
      expect(WRITERS, `${file.name} writes files but is not an allowed writer`).toContain(file.name);
    }
  });

  it('every write target is a bare expression, never a hard-coded path', () => {
    for (const file of SOURCES) {
      for (const { call, target } of writeCalls(file.text)) {
        expect(
          /^['"`]/.test(target),
          `${file.name}: ${call} writes to the literal ${target}`,
        ).toBe(false);
        expect(
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(target),
          `${file.name}: ${call} writes to the expression ${target}, which is not a plain identifier`,
        ).toBe(true);
      }
    }
  });

  it('no writing module contains an absolute path at all, so every target flows from a dep', () => {
    for (const name of WRITERS) {
      const file = SOURCES.find((candidate) => candidate.name === name);
      expect(file, name).toBeDefined();
      const literals = [...(file?.text ?? '').matchAll(/['"`](\/[^'"`\n]*)['"`]/g)].map(
        (match) => match[1],
      );
      expect(literals, `${name} hard-codes a path`).toEqual([]);
    }
  });

  it('nothing writes into the vault except the routine flip', () => {
    for (const file of SOURCES) {
      const calls = writeCalls(file.text);
      if (calls.length === 0) continue;
      if (file.name === 'steps/routines.ts') continue;
      expect(
        file.text.includes('/vault/') || file.text.includes('vaultDir'),
        `${file.name} both writes files and knows about the vault`,
      ).toBe(false);
    }
  });

  it('the vault step writes no file at all: it only runs git against the repo config', () => {
    const vault = SOURCES.find((file) => file.name === 'steps/vault.ts');
    expect(vault).toBeDefined();
    expect(writeCalls(vault?.text ?? '')).toEqual([]);
    // Every git subcommand it can reach, so a later edit cannot slip `git add` in beside them.
    const subcommands = [...(vault?.text ?? '').matchAll(/runGit\(\[\s*'([a-z-]+)'/g)].map(
      (match) => match[1],
    );
    expect([...new Set(subcommands)].sort()).toEqual(['config', 'remote']);
  });

  it('the routine flip touches only the enabled line', () => {
    const routines = SOURCES.find((file) => file.name === 'steps/routines.ts');
    const text = routines?.text ?? '';
    // One write call, and the value written is built from the original file's own bytes.
    expect(writeCalls(text)).toHaveLength(1);
    expect(text).toContain('if (next === original) return false;');
  });

  it('the state and env writers set mode 0600 on everything they create', () => {
    for (const name of WRITERS) {
      const file = SOURCES.find((candidate) => candidate.name === name);
      if (name === 'steps/routines.ts') continue; // rewrites an existing file, keeps its mode
      expect(file?.text, name).toContain('0o600');
    }
  });
});

describe('no secret is interpolated into a rendered page', () => {
  /** Names that carry a credential value. `last4` and a command name are not among them. */
  const SECRETISH =
    /(client_?secret|\bsecret\b|password|refresh_?token|api_?key|apikey|oauthToken|\.token\b|\btoken\b\s*[),])/i;

  const RENDERERS = SOURCES.filter(
    (file) => file.name === 'render.ts' || file.name === 'steps/done.ts',
  );

  it('found the renderers', () => {
    expect(RENDERERS.map((file) => file.name).sort()).toEqual(['render.ts', 'steps/done.ts']);
  });

  it.each(RENDERERS.map((file) => file.name))(
    '%s interpolates no secret-bearing expression',
    (name) => {
      const file = RENDERERS.find((candidate) => candidate.name === name);
      const interpolations = [...(file?.text ?? '').matchAll(/\$\{([^}]*)\}/g)].map(
        (match) => match[1] ?? '',
      );
      expect(interpolations.length).toBeGreaterThan(0);
      for (const expression of interpolations) {
        // A SCREAMING_SNAKE module constant is a fixed string this repo wrote, not a value
        // read from a credential store — unless its own name says it holds one.
        const bare = expression.replace(/^String\(|\)$/g, '').trim();
        if (/^[A-Z0-9_]+$/.test(bare) && !/(SECRET|TOKEN|KEY|PASSWORD)$/.test(bare)) continue;
        expect(
          SECRETISH.test(expression),
          `${name} interpolates \`${expression}\`, which names a credential`,
        ).toBe(false);
      }
    },
  );

  it('no renderer view model even has a field that could hold a secret', () => {
    const render = RENDERERS.find((file) => file.name === 'render.ts');
    const fields = [...(render?.text ?? '').matchAll(/readonly\s+([A-Za-z0-9_]+)\s*[?:]/g)].map(
      (match) => match[1] ?? '',
    );
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(
        /secret|password|apikey|api_key|refreshtoken/i.test(field),
        `render.ts declares the field \`${field}\``,
      ).toBe(false);
      // `token` is allowed only as part of a name that cannot be the value itself.
      expect(/^token$/i.test(field), `render.ts declares the field \`${field}\``).toBe(false);
    }
  });

  it('the Claude step returns only a saved flag and four characters', () => {
    const claude = SOURCES.find((file) => file.name === 'steps/claude.ts');
    const text = claude?.text ?? '';
    expect(text).toContain('last4');
    // The save result type carries no field that could hold the value.
    const block = /export interface SaveResult \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? '';
    expect(block).not.toMatch(/secret|apiKey|token\s*:/i);
  });

  it('the router hands the page no credential read back off disk', () => {
    const router = SOURCES.find((file) => file.name === 'router.ts');
    const text = router?.text ?? '';
    // Whatever it reads out of cxw.env for display goes through last4 first.
    expect(text).toContain("return { kind: 'oauth', last4: last4(oauth) };");
    expect(text).toContain("return { kind: 'api-key', last4: last4(key) };");
    expect(text).not.toMatch(/savedLast4:\s*(oauth|key)\b/);
  });
});
