import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // OSD checks for `document` at module evaluation time.
    // Provide a minimal DOM via happy-dom so overlay tests can import OSD.
    environment: 'jsdom',
  },
});
