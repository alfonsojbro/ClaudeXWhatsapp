import { defineConfig } from 'vitest/config';

// Package-local config so vitest does not pick up the repo-root config
// (which only runs the cross-package suites under tests/).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
