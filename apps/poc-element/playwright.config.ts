import { defineConfig } from '@playwright/test';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 5470;
/**
 * Playwright's bundled headless shell does not match the sandbox's browser;
 * point at the installed Chromium. On a desktop, set POC_CHROMIUM to Chrome's
 * binary (or leave it unset to use Playwright's own download).
 */
const CHROMIUM = process.env.POC_CHROMIUM ?? '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: './tests/e2e',
  reporter: 'list',
  // Each spec drives OSD + Fabric; four workers on a 4-core box shared with
  // other agents produced load flakes, so keep it to two.
  workers: 2,
  timeout: 60_000,
  webServer: {
    // The production build, so specs exercise what the bench measures.
    command: `pnpm exec vite build && pnpm exec vite preview --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1200, height: 800 },
    launchOptions: { executablePath: CHROMIUM },
  },
});
