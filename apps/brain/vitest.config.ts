import { defineConfig } from 'vitest/config';

// Package-local config so vitest does not pick up the repo-root config
// (which only runs the cross-package suites under tests/).
export default defineConfig({
  test: {
    // This package keeps its unit suites in tests/ alongside the co-located ones.
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
