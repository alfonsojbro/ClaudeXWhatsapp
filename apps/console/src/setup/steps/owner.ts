/**
 * Step 1: who owns this assistant.
 *
 * The owner allowlist is a file, not chat state — that is the repo's security rule, and it is
 * why this step exists before anything else. One number goes in; everything the assistant will
 * ever act on is checked against it.
 */

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** WhatsApp's individual-chat JID suffix. Group JIDs (`@g.us`) are never owners. */
export const OWNER_JID_SUFFIX = '@s.whatsapp.net';

const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

export class OwnerNumberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnerNumberError';
  }
}

/**
 * A phone number as WhatsApp holds it: E.164 digits, no `+`.
 *
 * People paste `+420 123 456 789`, `(420) 123-456-789` and `00420123456789`. The first two are
 * the same number and are accepted. The third is not handled: `00` is an international prefix
 * that only means something from inside a particular country, and silently deleting it would
 * produce a different, valid-looking number. It is rejected with a sentence saying so.
 */
export function normalizeOwnerNumber(input: string): string {
  const raw = String(input ?? '').trim();
  if (raw === '') {
    throw new OwnerNumberError('Enter your WhatsApp number, with the country code.');
  }
  const stripped = raw.replace(/^\+/, '').replace(/[\s\-()./]/g, '');
  if (stripped === '') {
    throw new OwnerNumberError('Enter your WhatsApp number, with the country code.');
  }
  if (!/^[0-9]+$/.test(stripped)) {
    throw new OwnerNumberError(
      'That number has characters other than digits. Use only digits, spaces, dashes and brackets, ' +
        'with an optional leading +.',
    );
  }
  if (stripped.startsWith('00')) {
    throw new OwnerNumberError(
      'Drop the 00 international prefix and write the country code directly, for example 420123456789 ' +
        'or +420 123 456 789.',
    );
  }
  if (stripped.length < MIN_DIGITS) {
    throw new OwnerNumberError(
      `That is ${String(stripped.length)} digits. A full number with its country code is at least ` +
        `${String(MIN_DIGITS)} digits — did you leave the country code off?`,
    );
  }
  if (stripped.length > MAX_DIGITS) {
    throw new OwnerNumberError(
      `That is ${String(stripped.length)} digits. A phone number is at most ${String(MAX_DIGITS)}.`,
    );
  }
  return stripped;
}

/** `420123456789` → `420123456789@s.whatsapp.net`. */
export function ownerJid(digits: string): string {
  return `${digits}${OWNER_JID_SUFFIX}`;
}

export interface OwnersFile {
  readonly owners: readonly string[];
}

/**
 * Write the owners file at mode 0600, atomically. Deterministic output, so running the step
 * twice with the same number leaves the same bytes.
 */
export function writeOwners(path: string, jids: readonly string[]): void {
  const unique = [...new Set(jids)];
  const body: OwnersFile = { owners: unique };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid.toString(36)}`;
  try {
    writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Nothing to clean up.
    }
    throw error;
  }
}

/** The whole step: normalize, then write. Returns the digits for display. */
export function saveOwner(path: string, input: string): { digits: string; jid: string } {
  const digits = normalizeOwnerNumber(input);
  const jid = ownerJid(digits);
  writeOwners(path, [jid]);
  return { digits, jid };
}
