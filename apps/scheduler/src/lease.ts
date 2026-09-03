/**
 * Per-routine leases: at most one process runs a given routine at a time.
 *
 * The claim is a single statement so it is atomic without an explicit transaction.
 */
import type { Db } from './db.js';

/** A lease row. */
export interface Lease {
  name: string;
  owner: string;
  expiresAt: number;
}

const CLAIM_SQL = `
  INSERT INTO leases (name, owner, expires_at)
  VALUES (@name, @owner, @expires)
  ON CONFLICT (name) DO UPDATE SET
    owner = excluded.owner,
    expires_at = excluded.expires_at
  WHERE leases.expires_at < @now OR leases.owner = excluded.owner
`;

/**
 * Take (or renew) the lease for `name`.
 *
 * Succeeds when the lease is free, expired, or already held by `owner`.
 *
 * @returns true when this owner holds the lease afterwards.
 */
export function claimLease(db: Db, name: string, owner: string, ttlMs: number, now: Date): boolean {
  const nowMs = now.getTime();
  const info = db.prepare(CLAIM_SQL).run({
    name,
    owner,
    expires: nowMs + ttlMs,
    now: nowMs,
  });
  return info.changes === 1;
}

/**
 * Extend a lease this owner already holds.
 *
 * @returns false when the lease was lost to another owner (or never existed).
 */
export function heartbeatLease(
  db: Db,
  name: string,
  owner: string,
  ttlMs: number,
  now: Date,
): boolean {
  const info = db
    .prepare('UPDATE leases SET expires_at = ? WHERE name = ? AND owner = ?')
    .run(now.getTime() + ttlMs, name, owner);
  return info.changes === 1;
}

/** Give the lease up. Returns false when this owner did not hold it. */
export function releaseLease(db: Db, name: string, owner: string): boolean {
  const info = db.prepare('DELETE FROM leases WHERE name = ? AND owner = ?').run(name, owner);
  return info.changes === 1;
}

/** Read the current lease row, if any. */
export function getLease(db: Db, name: string): Lease | null {
  const row = db.prepare('SELECT name, owner, expires_at FROM leases WHERE name = ?').get(name) as
    { name: string; owner: string; expires_at: number } | undefined;
  if (row === undefined) return null;
  return { name: row.name, owner: row.owner, expiresAt: row.expires_at };
}
