import { defineConfig } from '@playwright/test';

// Not part of `pnpm test:e2e`: the app needs its WASM build, which needs a
// Rust toolchain. Run with `pnpm --filter @osdlabel/ratzilla-poc poc:test:e2e`,
// which builds it first.
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 5191;

export default defineConfig({
  testDir: './tests/e2e',
  reporter: process.env.CI ? [['dot'], ['html', { open: 'never' }]] : 'list',
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 800 },
    // A Chromium other than the one this Playwright version downloads (as
    // apps/bench's BENCH_CHROMIUM).
    ...(process.env['POC_CHROMIUM']
      ? { launchOptions: { executablePath: process.env['POC_CHROMIUM'] } }
      : {}),
  },
});
