/**
 * NODE ONLY. Reads `cloud-init.template.yml` off disk at import time.
 *
 * It exists so the `.yml` file stays the readable reference for the payload, and so a
 * test can prove the browser-safe copy in `cloud-init-core.ts` has not drifted from it.
 * Nothing reachable from `src/index.ts` may import this module; `src/no-storage.test.ts`
 * walks that graph and fails if it ever does.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TEMPLATE_PATH = fileURLToPath(new URL('./cloud-init.template.yml', import.meta.url));

/** The template as it sits on disk. */
export const CLOUD_INIT_TEMPLATE_FILE = readFileSync(TEMPLATE_PATH, 'utf8');

export * from './cloud-init-core.js';
