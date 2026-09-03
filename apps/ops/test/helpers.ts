import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Config } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import { DatabaseSync } from '../src/db.js';

export const OWNER = '10000000000@s.whatsapp.net';
export const STRANGER = '19998887777@s.whatsapp.net';

const tempDirs: string[] = [];

export function makeTempDir(prefix = 'cxw-ops-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir === undefined) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A config rooted at a fresh temp dir, with every external dependency neutralised. */
export function makeConfig(env: Record<string, string> = {}): Config {
  const dir = makeTempDir();
  const state = path.join(dir, 'state');
  const data = path.join(dir, 'data');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  const ownersFile = path.join(state, 'owners.json');
  fs.writeFileSync(ownersFile, JSON.stringify({ owners: [OWNER] }));
  return loadConfig({
    CXW_STATE_DIR: state,
    CXW_DATA_DIR: data,
    CXW_OWNERS_FILE: ownersFile,
    CXW_ALERT_TRANSPORT: 'log',
    CXW_GOOGLE_CHECK: 'off',
    CXW_CLAUDE_AUTH_DEEP_CHECK_MIN: '0',
    CLAUDE_CODE_OAUTH_TOKEN: 'stub',
    CXW_SUDO: '',
    ...env,
  });
}

export interface SeedMessage {
  jid: string;
  id: string;
  ts: number;
  fromMe?: boolean;
  sender?: string;
  text?: string;
  mediaPath?: string;
}

/** Create a bridge-shaped sqlite store and insert the given rows. */
export function seedBridgeDb(file: string, rows: SeedMessage[], opts: { media?: boolean } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE messages (
      jid TEXT NOT NULL, id TEXT NOT NULL, ts INTEGER NOT NULL,
      from_me INTEGER NOT NULL DEFAULT 0, sender TEXT, type TEXT,
      text TEXT, quoted_id TEXT, media_path TEXT,
      PRIMARY KEY (jid, id)
    );
  `);
  if (opts.media === true) {
    db.exec(
      `CREATE TABLE media (jid TEXT, msg_id TEXT, path TEXT, mime TEXT, size INTEGER, downloaded_at INTEGER);`,
    );
  }
  const insert = db.prepare(
    `INSERT INTO messages (jid, id, ts, from_me, sender, type, text, media_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMedia =
    opts.media === true
      ? db.prepare(
          `INSERT INTO media (jid, msg_id, path, mime, size, downloaded_at) VALUES (?, ?, ?, ?, ?, ?)`,
        )
      : null;
  for (const row of rows) {
    insert.run(
      row.jid,
      row.id,
      row.ts,
      row.fromMe === true ? 1 : 0,
      row.sender ?? row.jid,
      row.mediaPath === undefined ? 'text' : 'image',
      row.text ?? null,
      row.mediaPath ?? null,
    );
    if (insertMedia !== null && row.mediaPath !== undefined) {
      insertMedia.run(row.jid, row.id, row.mediaPath, 'image/jpeg', 10, row.ts);
    }
  }
  db.close();
  return file;
}

export interface StubServer {
  url: string;
  close: () => Promise<void>;
  requests: Array<{ method: string; url: string; body: string }>;
  /** Mutable handler so a test can flip a stub from healthy to failing. */
  setHandler: (fn: StubHandler) => void;
}

export type StubHandler = (
  req: http.IncomingMessage,
  body: string,
) => { status: number; json: unknown };

/** Start an http server on an ephemeral port with a swappable JSON handler. */
export async function startStub(initial: StubHandler): Promise<StubServer> {
  let handler = initial;
  const requests: StubServer['requests'] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', body });
      const result = handler(req, body);
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setHandler: (fn: StubHandler) => {
      handler = fn;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export const DAY_MS = 86_400_000;

/** Write a fake `cxw-ctl` that appends its argv to a log file and exits 0. */
export function writeFakeCtl(dir: string): { bin: string; log: string; calls: () => string[] } {
  const bin = path.join(dir, 'fake-ctl.sh');
  const log = path.join(dir, 'ctl.log');
  fs.writeFileSync(bin, `#!/bin/sh\necho "$*" >> "${log}"\nexit 0\n`, { mode: 0o755 });
  return {
    bin,
    log,
    calls: () => {
      try {
        return fs
          .readFileSync(log, 'utf8')
          .split('\n')
          .filter((l) => l.trim() !== '');
      } catch {
        return [];
      }
    },
  };
}

/** Capture everything written to stdout while `fn` runs. */
export async function captureStdout(fn: () => Promise<void> | void): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let captured = '';
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    captured += chunk;
    return true;
  };
  try {
    await fn();
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
  return captured;
}
