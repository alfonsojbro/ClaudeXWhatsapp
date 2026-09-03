import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { DatabaseSync } from '../src/db.js';
import { OpsError, purge, PURGE_EMPTY_OWNERS_MESSAGE, resolveMediaPath } from '../src/retention.js';
import {
  cleanupTempDirs,
  DAY_MS,
  makeConfig,
  makeTempDir,
  OWNER,
  seedBridgeDb,
  STRANGER,
} from './helpers.js';

afterAll(cleanupTempDirs);

const now = Date.now();

function mediaFile(cfg: Config, jid: string, name: string, ageDays: number): string {
  const dir = path.join(cfg.mediaDir, jid);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'x'.repeat(100));
  const t = new Date(now - ageDays * DAY_MS);
  fs.utimesSync(file, t, t);
  return file;
}

function countRows(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  const row = db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
  db.close();
  return Number(row.n);
}

function setup(opts: { seconds?: boolean; media?: boolean } = {}): Config {
  const cfg = makeConfig();
  const stamp = (days: number): number =>
    opts.seconds === true ? Math.floor((now - days * DAY_MS) / 1000) : now - days * DAY_MS;
  const oldMedia = mediaFile(cfg, STRANGER, 'old.jpg', 200);
  const ownerMedia = mediaFile(cfg, OWNER, 'mine.jpg', 400);
  seedBridgeDb(
    cfg.bridgeDb,
    [
      { jid: OWNER, id: 'o1', ts: stamp(400), text: 'owner text' },
      { jid: OWNER, id: 'o2', ts: stamp(400), mediaPath: ownerMedia },
      { jid: STRANGER, id: 's1', ts: stamp(200), text: 'old stranger text' },
      { jid: STRANGER, id: 's2', ts: stamp(200), mediaPath: oldMedia },
      { jid: STRANGER, id: 's3', ts: stamp(1), text: 'recent stranger text' },
    ],
    { media: opts.media === true },
  );
  return cfg;
}

describe('purge', () => {
  it('keeps owner rows and removes old third-party rows', () => {
    const cfg = setup();
    const result = purge({}, cfg);
    expect(result.textRows).toBe(2); // s1 and s2, both older than 180 days
    expect(result.mediaRows).toBe(1);
    expect(result.files).toBe(1);
    expect(result.bytes).toBe(100);
    expect(countRows(cfg.bridgeDb)).toBe(3); // o1, o2, s3
    expect(fs.existsSync(path.join(cfg.mediaDir, STRANGER, 'old.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(cfg.mediaDir, OWNER, 'mine.jpg'))).toBe(true);
  });

  it('handles timestamps stored in seconds', () => {
    const cfg = setup({ seconds: true });
    const result = purge({}, cfg);
    expect(result.textRows).toBe(2);
    expect(countRows(cfg.bridgeDb)).toBe(3);
  });

  it('emergency mode touches media only', () => {
    const cfg = setup();
    const result = purge({ emergency: true }, cfg);
    expect(result.textRows).toBe(0);
    expect(result.mediaRows).toBe(1);
    expect(countRows(cfg.bridgeDb)).toBe(5);
    expect(fs.existsSync(path.join(cfg.mediaDir, STRANGER, 'old.jpg'))).toBe(false);
  });

  it('dry run changes nothing', () => {
    const cfg = setup();
    const result = purge({ dryRun: true }, cfg);
    expect(result.dryRun).toBe(true);
    expect(result.textRows).toBe(2);
    expect(result.mediaRows).toBe(1);
    expect(result.files).toBe(1);
    expect(countRows(cfg.bridgeDb)).toBe(5);
    expect(fs.existsSync(path.join(cfg.mediaDir, STRANGER, 'old.jpg'))).toBe(true);
  });

  it('removes matching rows from the optional media table', () => {
    const cfg = setup({ media: true });
    purge({}, cfg);
    const db = new DatabaseSync(cfg.bridgeDb, { readOnly: true });
    const row = db.prepare('SELECT COUNT(*) AS n FROM media').get() as { n: number };
    db.close();
    expect(Number(row.n)).toBe(1); // only the owner row survives
  });

  it('unlinks orphan media files in non-owner directories', () => {
    const cfg = setup();
    const orphan = mediaFile(cfg, STRANGER, 'orphan.jpg', 300);
    const result = purge({}, cfg);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(result.files).toBe(2);
  });

  it('writes the result to last-purge.json', () => {
    const cfg = setup();
    purge({}, cfg);
    const raw = fs.readFileSync(path.join(cfg.stateDir, 'last-purge.json'), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ textRows: 2, mediaRows: 1 });
  });

  it('a dry run never overwrites the record of the last real purge', () => {
    const cfg = setup();
    const file = path.join(cfg.stateDir, 'last-purge.json');
    expect(fs.existsSync(file)).toBe(false);
    purge({ dryRun: true }, cfg);
    expect(fs.existsSync(file)).toBe(false);

    purge({}, cfg);
    const real = fs.readFileSync(file, 'utf8');
    purge({ dryRun: true }, cfg);
    expect(fs.readFileSync(file, 'utf8')).toBe(real);
  });
});

describe('purge refuses without an owner allowlist', () => {
  it('throws and touches nothing when the owners file is missing', () => {
    const cfg = setup();
    fs.rmSync(cfg.ownersFile);
    expect(() => purge({}, cfg)).toThrowError(OpsError);
    expect(() => purge({}, cfg)).toThrowError(PURGE_EMPTY_OWNERS_MESSAGE);
    expect(countRows(cfg.bridgeDb)).toBe(5);
    expect(fs.existsSync(path.join(cfg.mediaDir, STRANGER, 'old.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(cfg.stateDir, 'last-purge.json'))).toBe(false);
  });

  it('refuses on a dry run too', () => {
    const cfg = setup();
    fs.writeFileSync(cfg.ownersFile, 'not json at all');
    expect(() => purge({ dryRun: true }, cfg)).toThrowError(PURGE_EMPTY_OWNERS_MESSAGE);
    expect(countRows(cfg.bridgeDb)).toBe(5);
  });

  it('still purges when the owner exemption is switched off on purpose', () => {
    const base = setup();
    const cfg = { ...base, retention: { ...base.retention, ownerForever: false } };
    fs.rmSync(cfg.ownersFile);
    expect(() => purge({}, cfg)).not.toThrow();
  });
});

describe('media path containment', () => {
  it('skips rows whose media_path escapes the media directory', () => {
    const cfg = makeConfig();
    const outside = path.join(path.dirname(cfg.dataDir), 'outside.txt');
    fs.writeFileSync(outside, 'secret');
    const escaping = path.join('..', '..', 'outside.txt');
    seedBridgeDb(cfg.bridgeDb, [
      { jid: STRANGER, id: 'c1', ts: now - 200 * DAY_MS, mediaPath: escaping },
      { jid: STRANGER, id: 'c2', ts: now - 200 * DAY_MS, mediaPath: outside },
    ]);

    const result = purge({ emergency: true }, cfg);
    expect(result.skipped).toBe(2);
    expect(result.files).toBe(0);
    expect(result.mediaRows).toBe(0);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('refuses a media_path that climbs out of the media dir into the data dir', () => {
    // `media_path` comes from the sender-chosen message key id, so `../bridge.sqlite` is
    // reachable input. MEDIA_DIR is the only tree the purge may unlink from.
    const cfg = makeConfig();
    fs.mkdirSync(cfg.mediaDir, { recursive: true });
    const store = path.basename(cfg.bridgeDb);
    seedBridgeDb(
      cfg.bridgeDb,
      [
        { jid: STRANGER, id: 'b1', ts: now - 400 * DAY_MS, mediaPath: `../${store}` },
        { jid: OWNER, id: 'b2', ts: now - 400 * DAY_MS, text: 'keep me' },
      ],
      { media: true },
    );
    expect(resolveMediaPath(cfg, `../${store}`)).toBeNull();

    const result = purge({}, cfg);
    expect(result.skipped).toBe(1);
    expect(result.files).toBe(0);
    expect(result.mediaRows).toBe(0);
    // The message store itself is intact and the owner row survived.
    expect(fs.existsSync(cfg.bridgeDb)).toBe(true);
    expect(countRows(cfg.bridgeDb)).toBe(1);
  });

  it('purges absolute paths normally when the data dir is a symlink', () => {
    // An attached volume is the obvious case: comparing resolved strings alone would
    // refuse every row and silently disable media retention.
    const real = makeTempDir('cxw-vol-');
    const link = path.join(makeTempDir('cxw-link-'), 'data');
    fs.symlinkSync(real, link);
    const cfg = { ...makeConfig(), dataDir: link, mediaDir: path.join(link, 'media') };
    const dir = path.join(real, 'media', STRANGER);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'v.jpg');
    fs.writeFileSync(file, 'x'.repeat(50));
    seedBridgeDb(cfg.bridgeDb, [
      { jid: STRANGER, id: 'v1', ts: now - 200 * DAY_MS, mediaPath: file },
    ]);

    const result = purge({ emergency: true }, cfg);
    expect(result.skipped).toBe(0);
    expect(result.files).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('accepts a relative path whose parent dir does not exist yet under a symlinked media dir', () => {
    // The per-chat sub-directory is created when the first attachment lands, so a purge
    // that runs before it exists must still recognise the path as inside the root. The
    // deepest existing ancestor is what gets realpath'd; the missing tail is re-appended.
    const real = makeTempDir('cxw-vol2-');
    const link = path.join(makeTempDir('cxw-link2-'), 'media');
    fs.symlinkSync(real, link);
    const cfg = { ...makeConfig(), mediaDir: link };

    const resolved = resolveMediaPath(cfg, 'sub/a.jpg');
    expect(resolved).not.toBeNull();
    expect(fs.realpathSync(path.dirname(path.dirname(resolved as string)))).toBe(
      fs.realpathSync(real),
    );

    // The escape check still holds: the data dir is above the media dir.
    const store = path.basename(cfg.bridgeDb);
    expect(resolveMediaPath(cfg, `../${store}`)).toBeNull();
  });

  it('accepts a well-formed relative path under the media dir', () => {
    const cfg = makeConfig();
    mediaFile(cfg, STRANGER, 'ok.jpg', 200);
    seedBridgeDb(cfg.bridgeDb, [
      {
        jid: STRANGER,
        id: 'r1',
        ts: now - 200 * DAY_MS,
        mediaPath: path.join(STRANGER, 'ok.jpg'),
      },
    ]);
    const result = purge({ emergency: true }, cfg);
    expect(result.skipped).toBe(0);
    expect(result.files).toBe(1);
    expect(fs.existsSync(path.join(cfg.mediaDir, STRANGER, 'ok.jpg'))).toBe(false);
  });
});

describe('orphan media walk', () => {
  it('clears the media_path of a surviving row whose file it removed', () => {
    const cfg = makeConfig();
    const orphan = mediaFile(cfg, STRANGER, 'orphan.jpg', 300);
    // The row itself is recent, so only the file is old enough to go.
    seedBridgeDb(cfg.bridgeDb, [{ jid: STRANGER, id: 'r1', ts: now, mediaPath: orphan }]);

    const result = purge({}, cfg);
    expect(result.files).toBe(1);
    expect(fs.existsSync(orphan)).toBe(false);

    const db = new DatabaseSync(cfg.bridgeDb, { readOnly: true });
    const row = db.prepare('SELECT media_path FROM messages WHERE id = ?').get('r1') as {
      media_path: string | null;
    };
    db.close();
    expect(row.media_path).toBeNull();
  });

  it('clears the media-dir-relative spelling too', () => {
    const cfg = makeConfig();
    mediaFile(cfg, STRANGER, 'orphan.jpg', 300);
    const relative = path.join(STRANGER, 'orphan.jpg');
    seedBridgeDb(cfg.bridgeDb, [{ jid: STRANGER, id: 'r1', ts: now, mediaPath: relative }]);

    purge({}, cfg);
    const db = new DatabaseSync(cfg.bridgeDb, { readOnly: true });
    const row = db.prepare('SELECT media_path FROM messages WHERE id = ?').get('r1') as {
      media_path: string | null;
    };
    db.close();
    expect(row.media_path).toBeNull();
  });
});
