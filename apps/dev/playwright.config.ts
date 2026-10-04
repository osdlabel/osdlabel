import { defineConfig } from '@playwright/test';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 5173;

export default defineConfig({
  testDir: './tests/e2e',
  // Read by every spec (`tests/e2e/helpers/fixtures.ts`), which fails if the
  // page it drove is the other binding's. `apps/dev-react` runs these same
  // specs against React (#152).
  metadata: { framework: 'solid' },
  // CI keeps an HTML report for the workflow to upload; locally, just a list.
  reporter: process.env.CI ? [['dot'], ['html', { open: 'never' }]] : 'list',
  webServer: {
    // Fail rather than drift to another port, which the React suite may hold.
    command: `pnpm dev --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
});
