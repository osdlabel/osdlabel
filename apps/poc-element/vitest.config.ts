import { defineConfig } from 'vitest/config';

// Unit tests for the bench's pure helpers only; tests/e2e is Playwright's.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    passWithNoTests: true,
  },
});
