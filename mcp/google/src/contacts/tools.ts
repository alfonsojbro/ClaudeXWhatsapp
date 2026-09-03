/**
 * Contacts lookup (read-only).
 *
 * The People search index is built lazily per session, so Google asks callers to
 * send one warm-up request with an empty query first. We do that once per process.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Deps } from '../deps.js';
import type { TextResult } from '../tools/result.js';
import { guard, ok, untrusted } from '../tools/result.js';

const READ_MASK = 'names,emailAddresses,phoneNumbers,organizations';

export const contactsLookupShape = {
  query: z.string().min(1).describe('Name, e-mail fragment or company to search for.'),
  max_results: z.number().int().min(1).max(30).optional(),
};

export type ContactsLookupArgs = z.infer<z.ZodObject<typeof contactsLookupShape>>;

/** Per-process warm-up latch, reset by tests through {@link resetContactsWarmup}. */
let warmedUp = false;

export function resetContactsWarmup(): void {
  warmedUp = false;
}

async function warmUp(deps: Deps): Promise<void> {
  if (warmedUp) return;
  warmedUp = true;
  try {
    await deps.people.people.searchContacts({ query: '', readMask: READ_MASK });
  } catch {
    // The warm-up is advisory; a failure must not break the real search.
  }
}

export async function contactsLookup(deps: Deps, args: ContactsLookupArgs): Promise<TextResult> {
  return guard(async () => {
    await warmUp(deps);
    const res = await deps.people.people.searchContacts({
      query: args.query,
      pageSize: args.max_results ?? 10,
      readMask: READ_MASK,
    });
    const results = res.data.results ?? [];
    if (results.length === 0) return ok(`No contacts match "${args.query}".`);
    const lines = results.map((result) => {
      const person = result.person ?? {};
      const name = person.names?.[0]?.displayName ?? '(no name)';
      const emails = (person.emailAddresses ?? [])
        .map((e) => e.value ?? '')
        .filter((v) => v !== '')
        .join(', ');
      const phones = (person.phoneNumbers ?? [])
        .map((p) => p.value ?? '')
        .filter((v) => v !== '')
        .join(', ');
      const org = (person.organizations ?? [])
        .map((o) => [o.name, o.title].filter((v) => v != null && v !== '').join(' — '))
        .filter((v) => v !== '')
        .join(', ');
      return `- ${[name, emails, phones, org].filter((v) => v !== '').join(' · ')}`;
    });
    // Display names, addresses and job titles are all third-party text a contact (or
    // whoever synced them in) chose. The count and the echoed query are ours, so the
    // whole result list — and only that — goes inside one fence.
    return ok(
      `${results.length} contact(s) for "${args.query}":\n${untrusted('CONTACTS', lines.join('\n'))}`,
    );
  });
}

export function registerContactsTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    'contacts_lookup',
    {
      title: 'Look up a contact',
      description:
        "Search the owner's Google Contacts by name, e-mail or company. Read-only. " +
        'Use it to turn "mail Ana" into a real address before drafting.',
      inputSchema: contactsLookupShape,
    },
    async (args) => contactsLookup(deps, args),
  );
}
