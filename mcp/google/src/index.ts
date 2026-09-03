/**
 * @cxw/mcp-google — MCP server for Gmail, Calendar and Contacts.
 * Entry point: starts the stdio server. Logs go to stderr; stdout is MCP.
 */
import { pathToFileURL } from 'node:url';
import { banner, serviceInfo } from '@cxw/shared';
import { main as startServer } from './server.js';

export const SERVICE = 'mcp-google' as const;

export function describe(): string {
  return banner(serviceInfo(SERVICE));
}

export async function main(): Promise<void> {
  console.error(describe());
  await startServer();
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      console.error(`${SERVICE}: shutting down`);
      resolve();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
}

// `import.meta.url` is percent-encoded; `pathToFileURL` encodes the argv path the same way, so
// this still matches on a checkout whose path contains a space.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
