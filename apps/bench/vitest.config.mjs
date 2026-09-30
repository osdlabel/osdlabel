import { defineConfig } from 'vitest/config';

// The analysis scripts are plain Node. This config exists so Vitest does not
// load `vite.config.mjs`, which is the browser page's dev-server config.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.mjs'],
  },
});
