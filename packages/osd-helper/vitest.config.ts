import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // OSD checks for `document` at module evaluation time.
    // Provide a minimal DOM via jsdom so tests can import OSD.
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
});
