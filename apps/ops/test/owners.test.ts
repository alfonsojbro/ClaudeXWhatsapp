import fs from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { isOwnerJid, loadOwners, normalizeOwnerJid } from '../src/owners.js';
import { cleanupTempDirs, makeConfig, OWNER } from './helpers.js';

afterAll(cleanupTempDirs);

const LID = '123456789012345@lid';

describe('LID owners', () => {
  // Phase 1 on the live device showed WhatsApp addressing the self-chat by LID, so an
  // owners entry may be a `<digits>@lid` address rather than a phone-number JID.
  it('keeps a LID entry verbatim', () => {
    expect(normalizeOwnerJid(LID)).toBe(LID);
    expect(normalizeOwnerJid(` ${LID} `)).toBe(LID);
    // A Baileys device suffix is still stripped from the local part.
    expect(normalizeOwnerJid('123456789012345:7@lid')).toBe(LID);
  });

  it('loads a LID entry from the owners file and matches it', () => {
    const cfg = makeConfig();
    fs.writeFileSync(cfg.ownersFile, JSON.stringify({ owners: [LID] }));
    const owners = loadOwners(cfg);

    expect(owners).toEqual([LID]);
    expect(isOwnerJid(LID, owners)).toBe(true);
    // The LID and the phone-number JID are different addresses: listing only the LID does
    // not make the phone number an owner. The owner must list both spellings until the
    // bridge resolves LIDs to phone numbers itself.
    expect(isOwnerJid('123456789012345@s.whatsapp.net', owners)).toBe(false);

    fs.writeFileSync(cfg.ownersFile, JSON.stringify({ owners: [LID, OWNER] }));
    const both = loadOwners(cfg);
    expect(isOwnerJid(LID, both)).toBe(true);
    expect(isOwnerJid(OWNER, both)).toBe(true);
  });
});
