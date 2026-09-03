import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import type { Db } from '../src/db.js';
import { claimLease, getLease, heartbeatLease, releaseLease } from '../src/lease.js';

const TTL = 90_000;
const T0 = new Date('2026-09-03T05:00:00Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
});

describe('claimLease', () => {
  it('claims a free lease', () => {
    expect(claimLease(db, 'morning-brief', 'a', TTL, T0)).toBe(true);
    expect(getLease(db, 'morning-brief')).toEqual({
      name: 'morning-brief',
      owner: 'a',
      expiresAt: T0.getTime() + TTL,
    });
  });

  it('refuses a lease another owner holds', () => {
    expect(claimLease(db, 'morning-brief', 'a', TTL, T0)).toBe(true);
    expect(claimLease(db, 'morning-brief', 'b', TTL, at(1_000))).toBe(false);
    expect(getLease(db, 'morning-brief')?.owner).toBe('a');
  });

  it('lets the same owner re-claim and extend', () => {
    claimLease(db, 'morning-brief', 'a', TTL, T0);
    expect(claimLease(db, 'morning-brief', 'a', TTL, at(1_000))).toBe(true);
    expect(getLease(db, 'morning-brief')?.expiresAt).toBe(at(1_000).getTime() + TTL);
  });

  it('lets another owner take over once the lease expires', () => {
    claimLease(db, 'morning-brief', 'a', TTL, T0);
    expect(claimLease(db, 'morning-brief', 'b', TTL, at(TTL + 1))).toBe(true);
    expect(getLease(db, 'morning-brief')?.owner).toBe('b');
  });

  it('keeps leases for different routines independent', () => {
    expect(claimLease(db, 'one', 'a', TTL, T0)).toBe(true);
    expect(claimLease(db, 'two', 'b', TTL, T0)).toBe(true);
    expect(getLease(db, 'two')?.owner).toBe('b');
  });
});

describe('heartbeatLease', () => {
  it('extends a lease the owner still holds', () => {
    claimLease(db, 'morning-brief', 'a', TTL, T0);
    expect(heartbeatLease(db, 'morning-brief', 'a', TTL, at(30_000))).toBe(true);
    expect(getLease(db, 'morning-brief')?.expiresAt).toBe(at(30_000).getTime() + TTL);
  });

  it('returns false after the lease was lost to another owner', () => {
    claimLease(db, 'morning-brief', 'a', TTL, T0);
    claimLease(db, 'morning-brief', 'b', TTL, at(TTL + 1));
    expect(heartbeatLease(db, 'morning-brief', 'a', TTL, at(TTL + 2))).toBe(false);
  });

  it('returns false when there is no lease at all', () => {
    expect(heartbeatLease(db, 'ghost', 'a', TTL, T0)).toBe(false);
  });
});

describe('releaseLease', () => {
  it('removes the lease so another owner can claim immediately', () => {
    claimLease(db, 'morning-brief', 'a', TTL, T0);
    expect(releaseLease(db, 'morning-brief', 'a')).toBe(true);
    expect(getLease(db, 'morning-brief')).toBeNull();
    expect(claimLease(db, 'morning-brief', 'b', TTL, at(1))).toBe(true);
  });

  it('does nothing for a lease held by someone else', () => {
    claimLease(db, 'morning-brief', 'a', TTL, T0);
    expect(releaseLease(db, 'morning-brief', 'b')).toBe(false);
    expect(getLease(db, 'morning-brief')?.owner).toBe('a');
  });
});
