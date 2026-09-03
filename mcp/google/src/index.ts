/**
 * @cxw/mcp-google — MCP server for Gmail and Calendar.
 * Phase 0 stub: starts, logs its banner, and waits for SIGTERM.
 */
import { pathToFileURL } from 'node:url';
import { banner, serviceInfo } from '@cxw/shared';

export const SERVICE = 'mcp-google' as const;

export function describe(): string {
  return banner(serviceInfo(SERVICE));
}

export async function main(): Promise<void> {
  console.log(describe());
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      console.log(`${SERVICE}: shutting down`);
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
    console.error(err);
    process.exit(1);
  });
}
