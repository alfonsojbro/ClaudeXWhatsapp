import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
  },
  resolve: {
    alias: {
      '@cxw/shared': r('./packages/shared/src/index.ts'),
      '@cxw/vault': r('./mcp/vault/src/index.ts'),
      '@cxw/brain-memory': r('./apps/brain/src/memory/index.ts'),
      '@cxw/scheduler': r('./apps/scheduler/src/index.ts'),
    },
  },
});
