import { pino, destination } from 'pino';

/**
 * Keys that may carry a phone number or a message body. They are censored at every level,
 * so an accidental `logger.info({ text })` can never leak content to the journal.
 */
export const REDACT_PATHS = [
  'jid',
  'chatJid',
  'senderJid',
  'targetJid',
  'remoteJid',
  'text',
  'body',
  'caption',
  'preview',
  '*.jid',
  '*.chatJid',
  '*.senderJid',
  '*.targetJid',
  '*.remoteJid',
  '*.text',
  '*.body',
  '*.caption',
  '*.preview',
];

/**
 * Logs go to **stderr** (fd 2), never stdout: `cxw-ops health --json` and `cxw-ops purge`
 * must leave stdout as pure machine-readable output. Under systemd `StandardError=journal`
 * this is also where the journal expects them. `sync: true` keeps the ordering exact and
 * leaves no stream to flush at exit, so the vitest suite has no open handles.
 */
export const logger = pino(
  {
    level: process.env['LOG_LEVEL'] ?? 'info',
    name: 'cxw-ops',
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  },
  destination({ dest: 2, sync: true }),
);

/** `4201234…89@s.whatsapp.net` → `420…89`. Used when an alert really needs to name a chat. */
export function maskJid(jid: string): string {
  const at = jid.indexOf('@');
  const local = at === -1 ? jid : jid.slice(0, at);
  const suffix = at === -1 ? '' : jid.slice(at);
  if (local.length <= 5) return `***${suffix}`;
  return `${local.slice(0, 3)}…${local.slice(-2)}${suffix}`;
}
