/**
 * @cxw/mcp-google — MCP server for Gmail, Calendar and Contacts.
 * Entry point: starts the stdio server. Logs go to stderr; stdout is MCP.
 */
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

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === new URL(`file://${entry}`).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
