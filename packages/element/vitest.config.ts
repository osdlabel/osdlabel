import { defineConfig } from 'vitest/config';
import solidPlugin from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solidPlugin()],
  resolve: { conditions: ['development', 'browser'] },
  test: {
    server: { deps: { inline: [/solid-js/] } },
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
});
