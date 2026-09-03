import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeOwnerNumber, ownerJid, saveOwner, writeOwners } from './owner.js';

function ownersPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'cxw-owner-')), 'state', 'owners.json');
}

describe('normalizeOwnerNumber', () => {
  it('strips +, spaces, dashes and brackets', () => {
    expect(normalizeOwnerNumber('+420 123-456 789')).toBe('420123456789');
    expect(normalizeOwnerNumber('(420) 123.456.789')).toBe('420123456789');
    expect(normalizeOwnerNumber('  420123456789  ')).toBe('420123456789');
  });

  it('rejects an empty input', () => {
    expect(() => normalizeOwnerNumber('')).toThrow(/Enter your WhatsApp number/);
    expect(() => normalizeOwnerNumber('   ')).toThrow(/Enter your WhatsApp number/);
  });

  it('rejects letters and other characters with a specific message', () => {
    expect(() => normalizeOwnerNumber('+420 12ab 456')).toThrow(/other than digits/);
  });

  it('rejects the 00 international prefix rather than guessing', () => {
    expect(() => normalizeOwnerNumber('00420123456789')).toThrow(/Drop the 00/);
  });

  it('rejects a number that is too short, and says how short', () => {
    expect(() => normalizeOwnerNumber('1234567')).toThrow(/That is 7 digits/);
  });

  it('rejects a number that is too long', () => {
    expect(() => normalizeOwnerNumber('1234567890123456')).toThrow(/That is 16 digits/);
  });

  it('accepts the boundary lengths', () => {
    expect(normalizeOwnerNumber('12345678')).toBe('12345678');
    expect(normalizeOwnerNumber('123456789012345')).toBe('123456789012345');
  });
});

describe('ownerJid', () => {
  it('appends the individual-chat suffix', () => {
    expect(ownerJid('420123456789')).toBe('420123456789@s.whatsapp.net');
  });

  it('never produces a group JID', () => {
    expect(ownerJid('420123456789')).not.toContain('@g.us');
  });
});

describe('writeOwners', () => {
  it('writes the documented shape at mode 0600', () => {
    const path = ownersPath();
    writeOwners(path, [ownerJid('420123456789')]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      owners: ['420123456789@s.whatsapp.net'],
    });
  });

  it('de-duplicates', () => {
    const path = ownersPath();
    writeOwners(path, ['a@s.whatsapp.net', 'a@s.whatsapp.net']);
    expect(JSON.parse(readFileSync(path, 'utf8')).owners).toEqual(['a@s.whatsapp.net']);
  });

  it('is byte-identical on a second run', () => {
    const path = ownersPath();
    saveOwner(path, '+420 123 456 789');
    const once = readFileSync(path, 'utf8');
    saveOwner(path, '420123456789');
    expect(readFileSync(path, 'utf8')).toBe(once);
  });

  it('replaces the previous owner rather than accumulating', () => {
    const path = ownersPath();
    saveOwner(path, '420123456789');
    saveOwner(path, '447700900123');
    expect(JSON.parse(readFileSync(path, 'utf8')).owners).toEqual(['447700900123@s.whatsapp.net']);
  });
});
