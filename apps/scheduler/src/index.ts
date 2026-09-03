/**
 * @cxw/scheduler — Scheduler: routine files, leases, run logs.
 * Phase 0 stub: starts, logs its banner, and waits for SIGTERM.
 */
import { banner, serviceInfo } from '@cxw/shared';

export const SERVICE = 'scheduler' as const;

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

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === new URL(`file://${entry}`).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
