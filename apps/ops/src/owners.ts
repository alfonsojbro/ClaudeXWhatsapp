import fs from 'node:fs';
import { z } from 'zod';
import type { Config } from './config.js';
import { logger } from './logger.js';

const ownersFileSchema = z.union([z.array(z.string()), z.object({ owners: z.array(z.string()) })]);

/**
 * Normalise an owner entry to a full JID. Bare digits become `<digits>@s.whatsapp.net`.
 * Returns null for anything that can never be an owner (group JIDs, empty strings).
 */
export function normalizeOwnerJid(raw: string): string | null {
  const value = raw.trim();
  if (value === '') return null;
  if (value.endsWith('@g.us')) return null;
  if (value.includes('@')) {
    const [local = '', domain = ''] = value.split('@');
    // Strip a Baileys device suffix such as `:12` from `4201234:12@s.whatsapp.net`.
    const bare = local.split(':')[0] ?? local;
    if (bare === '') return null;
    return `${bare}@${domain}`;
  }
  const digits = value.replace(/[^0-9]/g, '');
  if (digits === '') return null;
  return `${digits}@s.whatsapp.net`;
}

/**
 * Owner allowlist: the JSON file (`{ "owners": [...] }` or a bare array) plus the
 * comma-separated `OWNER_JIDS` env override. Group JIDs are never owners.
 */
export function loadOwners(cfg: Config): string[] {
  const out: string[] = [];
  const push = (raw: string): void => {
    const jid = normalizeOwnerJid(raw);
    if (jid !== null && !out.includes(jid)) out.push(jid);
  };

  let fileRaw: string | null = null;
  try {
    fileRaw = fs.readFileSync(cfg.ownersFile, 'utf8');
  } catch {
    fileRaw = null;
  }
  if (fileRaw !== null) {
    try {
      const parsed = ownersFileSchema.parse(JSON.parse(fileRaw));
      const list = Array.isArray(parsed) ? parsed : parsed.owners;
      for (const entry of list) push(entry);
    } catch {
      logger.warn({ file: cfg.ownersFile }, 'owners file is not valid JSON; ignoring');
    }
  }

  for (const entry of cfg.ownerJidsEnv) push(entry);
  return out;
}

export function isOwnerJid(jid: string | null | undefined, owners: string[]): boolean {
  if (jid === null || jid === undefined) return false;
  const normalized = normalizeOwnerJid(jid);
  return normalized !== null && owners.includes(normalized);
}
