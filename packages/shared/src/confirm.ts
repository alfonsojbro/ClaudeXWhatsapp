/**
 * Owner confirm gate — a file-backed store of pending, dangerous actions.
 *
 * The brain (`apps/brain`), `mcp/google` and later `mcp/whatsapp` are separate
 * processes, so the store lives on disk: one JSON file per pending action, named
 * after its 6-character token. A tool that wants to do something irreversible
 * mints an action (nothing happens yet) and shows the owner a preview plus the
 * token. The owner replies `yes <TOKEN>`; the tool is then called again with the
 * token and executes **the stored payload**, never re-supplied arguments.
 *
 * See `docs/CONFIRM_GATE.md` for the cross-process contract.
 */
import { randomInt } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** How long a minted token stays usable. */
export const CONFIRM_TTL_MS = 10 * 60_000;

/** Token alphabet without the ambiguous characters 0, O, 1 and I. */
export const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Matches exactly what {@link generateToken} produces. */
export const TOKEN_RE = /^[A-HJ-NP-Z2-9]{6}$/;

/** Length of a confirm token. */
export const TOKEN_LENGTH = 6;

/** A dangerous action waiting for the owner's `yes <TOKEN>`. */
export interface PendingAction<P = unknown> {
  /** The 6-character token the owner has to quote back. */
  token: string;
  /** Tool that minted it, e.g. `gmail_send`, `calendar_create_event`. */
  kind: string;
  /** Human-readable text shown to the owner. */
  preview: string;
  /** The exact arguments to execute on confirmation. */
  payload: P;
  /** Which process minted it, e.g. `mcp-google`. */
  source: string;
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp. */
  expiresAt: string;
}

export interface ConfirmStoreOptions {
  /** Lifetime of a minted token. Defaults to {@link CONFIRM_TTL_MS}. */
  ttlMs?: number;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Token generator, injectable for tests. Defaults to {@link generateToken}. */
  token?: () => string;
}

export interface MintInput<P> {
  kind: string;
  preview: string;
  payload: P;
  source: string;
}

/** Generate a 6-character token from the ambiguity-free alphabet. */
export function generateToken(random: (max: number) => number = (max) => randomInt(max)): string {
  let out = '';
  for (let i = 0; i < TOKEN_LENGTH; i += 1) {
    const idx = random(TOKEN_ALPHABET.length);
    out += TOKEN_ALPHABET.charAt(idx);
  }
  return out;
}

function isValidToken(token: string): boolean {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

function isPending(value: unknown): value is PendingAction {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['token'] === 'string' &&
    typeof v['kind'] === 'string' &&
    typeof v['preview'] === 'string' &&
    typeof v['source'] === 'string' &&
    typeof v['createdAt'] === 'string' &&
    typeof v['expiresAt'] === 'string'
  );
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

/** File-backed store of pending actions. One directory, one file per token. */
export class ConfirmStore {
  readonly dir: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly mintToken: () => string;

  constructor(dir: string, opts: ConfirmStoreOptions = {}) {
    this.dir = dir;
    this.ttlMs = opts.ttlMs ?? CONFIRM_TTL_MS;
    this.now = opts.now ?? ((): number => Date.now());
    this.mintToken = opts.token ?? ((): string => generateToken());
  }

  /** Absolute path of a token's file. Throws for anything that is not a token. */
  private fileFor(token: string): string {
    if (!isValidToken(token)) throw new Error(`invalid confirm token: ${JSON.stringify(token)}`);
    return path.join(this.dir, `${token}.json`);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  private expired(action: PendingAction): boolean {
    return Date.parse(action.expiresAt) <= this.now();
  }

  private async readFile(file: string): Promise<PendingAction | null> {
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err: unknown) {
      if (isEnoent(err)) return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    return isPending(parsed) ? parsed : null;
  }

  /** Create a pending action. Nothing is executed; the caller shows the preview. */
  async mint<P>(input: MintInput<P>): Promise<PendingAction<P>> {
    await this.ensureDir();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const token = this.mintToken();
      if (!isValidToken(token)) throw new Error('token generator produced an invalid token');
      const createdMs = this.now();
      const action: PendingAction<P> = {
        token,
        kind: input.kind,
        preview: input.preview,
        payload: input.payload,
        source: input.source,
        createdAt: new Date(createdMs).toISOString(),
        expiresAt: new Date(createdMs + this.ttlMs).toISOString(),
      };
      const file = this.fileFor(token);
      const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
      await fs.writeFile(tmp, `${JSON.stringify(action, null, 2)}\n`, { mode: 0o600 });
      try {
        // `wx`-style guard: fail if the token is already taken.
        const handle = await fs.open(file, 'wx', 0o600);
        await handle.close();
      } catch (err: unknown) {
        await fs.rm(tmp, { force: true });
        if (
          typeof err === 'object' &&
          err !== null &&
          (err as { code?: string }).code === 'EEXIST'
        ) {
          continue;
        }
        throw err;
      }
      await fs.rename(tmp, file);
      await fs.chmod(file, 0o600);
      return action;
    }
    throw new Error('could not mint a unique confirm token after 5 attempts');
  }

  /** Read a pending action without consuming it. Expired entries are deleted. */
  async peek(token: string): Promise<PendingAction | null> {
    if (!isValidToken(token)) return null;
    const file = this.fileFor(token);
    const action = await this.readFile(file);
    if (action === null) return null;
    if (this.expired(action)) {
      await fs.rm(file, { force: true });
      return null;
    }
    return action;
  }

  /**
   * Consume a pending action exactly once. The rename is the atomic claim: a
   * second caller finds no file and gets `null`.
   */
  async take(token: string): Promise<PendingAction | null> {
    if (!isValidToken(token)) return null;
    const file = this.fileFor(token);
    const claimed = `${file}.taken.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
    try {
      await fs.rename(file, claimed);
    } catch (err: unknown) {
      if (isEnoent(err)) return null;
      throw err;
    }
    const action = await this.readFile(claimed);
    await fs.rm(claimed, { force: true });
    if (action === null) return null;
    return this.expired(action) ? null : action;
  }

  /** Drop a pending action. Returns true when something was removed. */
  async cancel(token: string): Promise<boolean> {
    if (!isValidToken(token)) return false;
    const file = this.fileFor(token);
    try {
      await fs.unlink(file);
      return true;
    } catch (err: unknown) {
      if (isEnoent(err)) return false;
      throw err;
    }
  }

  /** Every unexpired pending action, newest last. */
  async list(): Promise<PendingAction[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch (err: unknown) {
      if (isEnoent(err)) return [];
      throw err;
    }
    const out: PendingAction[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const token = name.slice(0, -'.json'.length);
      if (!isValidToken(token)) continue;
      const action = await this.peek(token);
      if (action !== null) out.push(action);
    }
    out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return out;
  }

  /** Delete expired entries. Returns how many were removed. */
  async sweep(): Promise<number> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch (err: unknown) {
      if (isEnoent(err)) return 0;
      throw err;
    }
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const token = name.slice(0, -'.json'.length);
      if (!isValidToken(token)) continue;
      const file = this.fileFor(token);
      const action = await this.readFile(file);
      if (action === null || this.expired(action)) {
        await fs.rm(file, { force: true });
        removed += 1;
      }
    }
    return removed;
  }
}

/** Default directory for the store, honouring `CXW_CONFIRM_DIR` / `CXW_STATE_DIR`. */
export function defaultConfirmDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['CXW_CONFIRM_DIR'];
  if (explicit !== undefined && explicit.trim() !== '') return explicit;
  const state = env['CXW_STATE_DIR'];
  const base = state !== undefined && state.trim() !== '' ? state : './state';
  return path.join(base, 'confirm');
}

const YES_WORDS = new Set(['yes', 'y', 'ok', 'okay', 'confirm', 'si', 'sí', 'send']);
const NO_WORDS = new Set(['no', 'n', 'cancel', 'abort', 'stop']);

/**
 * Parse an owner reply such as `yes AB3D9K` or `no ab3d9k.`.
 * Returns null unless the whole message is a confirm reply.
 */
export function parseConfirmReply(text: string): { verb: 'yes' | 'no'; token: string } | null {
  if (typeof text !== 'string') return null;
  const cleaned = text
    .trim()
    .replace(/[.!,;:]+$/u, '')
    .trim();
  const parts = cleaned.split(/\s+/u);
  if (parts.length !== 2) return null;
  const [rawVerb, rawToken] = parts;
  if (rawVerb === undefined || rawToken === undefined) return null;
  const verbWord = rawVerb.toLowerCase();
  const token = rawToken.toUpperCase();
  if (!TOKEN_RE.test(token)) return null;
  if (YES_WORDS.has(verbWord)) return { verb: 'yes', token };
  if (NO_WORDS.has(verbWord)) return { verb: 'no', token };
  return null;
}

/** The message the owner sees: the preview plus how to confirm or cancel. */
export function formatConfirmPrompt(action: PendingAction, ttlMs: number = CONFIRM_TTL_MS): string {
  const minutes = Math.max(1, Math.round(ttlMs / 60_000));
  return (
    `${action.preview}\n\n` +
    `Reply \`yes ${action.token}\` within ${minutes} min to go ahead, ` +
    `or \`no ${action.token}\` to cancel.`
  );
}
